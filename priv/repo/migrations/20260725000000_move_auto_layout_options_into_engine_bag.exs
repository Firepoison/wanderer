defmodule WandererApp.Repo.Migrations.MoveAutoLayoutOptionsIntoEngineBag do
  @moduledoc """
  Auto-layout's engine-specific settings used to be top-level `Map.options` keys —
  "auto_layout_direction", "auto_layout_rank_sep", "auto_layout_node_sep", "auto_layout_ranker".
  They now live in a single "auto_layout_options" key holding one bag per engine, so engines that
  don't share dagre's vocabulary can carry their own settings without adding option keys.

  Without this, a map that had customised those settings would silently fall back to the
  defaults, since the new code never looks at the old keys.

  The key names are inlined rather than read from `WandererApp.Map.LayoutEngines` so this
  migration keeps doing the same thing if that catalog later changes.
  """

  use Ecto.Migration

  # Legacy top-level option key -> key inside the engine's bag.
  @legacy_keys %{
    "auto_layout_direction" => "direction",
    "auto_layout_rank_sep" => "rank_sep",
    "auto_layout_node_sep" => "node_sep",
    "auto_layout_ranker" => "ranker"
  }

  @default_engine "dagre"

  def up do
    for {id, options} <- _maps_with_options() do
      case Map.take(options, Map.keys(@legacy_keys)) do
        legacy when map_size(legacy) == 0 ->
          :ok

        legacy ->
          engine = Map.get(options, "auto_layout_engine", @default_engine)
          bag = for {old, new} <- @legacy_keys, value = legacy[old], into: %{}, do: {new, value}

          bags = _bags(options)
          merged = bags |> Map.get(engine, %{}) |> Map.merge(bag)

          options
          |> Map.drop(Map.keys(@legacy_keys))
          |> Map.put("auto_layout_options", Jason.encode!(Map.put(bags, engine, merged)))
          |> then(&_update(id, &1))
      end
    end
  end

  def down do
    for {id, options} <- _maps_with_options() do
      engine = Map.get(options, "auto_layout_engine", @default_engine)

      case options |> _bags() |> Map.get(engine, %{}) do
        bag when map_size(bag) == 0 ->
          :ok

        bag ->
          @legacy_keys
          |> Enum.reduce(Map.delete(options, "auto_layout_options"), fn {old, new}, acc ->
            case Map.fetch(bag, new) do
              {:ok, value} -> Map.put(acc, old, value)
              :error -> acc
            end
          end)
          |> then(&_update(id, &1))
      end
    end
  end

  defp _maps_with_options do
    %{rows: rows} =
      repo().query!("SELECT id::text, options FROM maps_v1 WHERE options IS NOT NULL", [])

    for [id, options] <- rows,
        {:ok, %{} = decoded} <- [Jason.decode(options)],
        do: {id, decoded}
  end

  defp _bags(options) do
    case options |> Map.get("auto_layout_options") |> _decode() do
      %{} = bags -> bags
      _ -> %{}
    end
  end

  defp _decode(blob) when is_binary(blob) do
    case Jason.decode(blob) do
      {:ok, decoded} -> decoded
      _ -> %{}
    end
  end

  defp _decode(_), do: %{}

  # `id = $2::uuid` would make Postgres infer $2 as a uuid, which Postgrex then expects as a raw
  # 16-byte binary; comparing as text keeps the parameter a plain string.
  defp _update(id, options) do
    repo().query!("UPDATE maps_v1 SET options = $1 WHERE id::text = $2", [
      Jason.encode!(options),
      id
    ])
  end
end
