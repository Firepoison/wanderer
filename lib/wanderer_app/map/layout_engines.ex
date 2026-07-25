defmodule WandererApp.Map.LayoutEngines do
  @moduledoc """
  Catalog of auto-layout engines and the options each one accepts.

  Auto-layout has exactly three *universal* settings, stored as their own `Map.options` keys:
  `auto_layout_enabled`, `auto_layout_engine` and `root_system_id`. Everything else — direction,
  spacing, ranking — is engine-specific vocabulary and lives in a single `auto_layout_options`
  key holding one bag per engine:

      %{"dagre" => %{"direction" => "LR", "ranker" => "network-simplex", ...}}

  Keeping the bags side by side means switching engines doesn't discard the other engine's
  settings, and adding an engine doesn't add option keys to the defaults or to the two
  parameter whitelists that guard option updates.

  This module is the source of truth for what the settings form renders. The client-side
  engines (`assets/js/hooks/Mapper/components/map/layout/engines/`) each validate and default
  their own options independently, so a value that drifts from this catalog degrades to that
  engine's default rather than producing a broken layout.
  """

  @spacing_choices [{"Compact", "compact"}, {"Normal", "normal"}, {"Spacious", "spacious"}]

  @raw_engines [
    %{
      id: "dagre",
      label: "Tree",
      options: [
        %{
          key: "direction",
          label: "Auto layout direction",
          default: "LR",
          choices: [
            {"Left → Right", "LR"},
            {"Top → Down", "TB"},
            {"Right → Left", "RL"},
            {"Bottom → Up", "BT"}
          ]
        },
        %{
          key: "rank_sep",
          label: "Level spacing (between tree levels)",
          default: "normal",
          choices: @spacing_choices
        },
        %{
          key: "node_sep",
          label: "Node spacing (between sibling systems)",
          default: "normal",
          choices: @spacing_choices
        },
        %{
          key: "ranker",
          label: "Node arrangement",
          default: "network-simplex",
          choices: [
            {"Balanced", "network-simplex"},
            {"Compact", "tight-tree"},
            {"Layered by depth", "longest-path"}
          ]
        }
      ]
    }
  ]

  # Each option also carries the atom the settings form addresses it by, derived once at compile
  # time so the template can render specs generically without calling String.to_atom/1 on input.
  @engines Enum.map(@raw_engines, fn engine ->
             Map.update!(engine, :options, fn options ->
               Enum.map(options, &Map.put(&1, :field, :"auto_layout_opt_#{&1.key}"))
             end)
           end)

  @default_engine_id "dagre"
  @field_prefix "auto_layout_opt_"

  def engines, do: @engines

  def default_engine_id, do: @default_engine_id

  @doc "`{label, value}` pairs for the engine picker."
  def engine_choices, do: Enum.map(@engines, &{&1.label, &1.id})

  @doc "The named engine, falling back to the default when the id is unknown."
  def engine(id) do
    Enum.find(@engines, &(&1.id == id)) || Enum.find(@engines, &(&1.id == @default_engine_id))
  end

  def options_for(engine_id), do: engine(engine_id).options

  @doc "Default option bag for one engine."
  def default_options(engine_id) do
    for %{key: key, default: default} <- options_for(engine_id), into: %{}, do: {key, default}
  end

  @doc "Encoded default `auto_layout_options` value covering every engine."
  def default_options_json do
    Jason.encode!(for engine <- @engines, into: %{}, do: {engine.id, default_options(engine.id)})
  end

  @doc """
  Option bag for `engine_id`: unknown keys dropped, values outside the catalog replaced by the
  option's default, missing keys filled in. Accepts the encoded blob or an already-decoded map.
  """
  def normalize(blob, engine_id) do
    stored =
      case blob |> decode() |> Map.get(engine_id) do
        %{} = bag -> bag
        _ -> %{}
      end

    for %{key: key, default: default, choices: choices} <- options_for(engine_id), into: %{} do
      valid = Enum.map(choices, fn {_label, value} -> value end)
      value = Map.get(stored, key)
      {key, if(value in valid, do: value, else: default)}
    end
  end

  @doc "Replace `engine_id`'s bag in `blob`, leaving every other engine's settings untouched."
  def put(blob, engine_id, bag) do
    blob |> decode() |> Map.put(engine_id, bag) |> Jason.encode!()
  end

  @doc "Flat `auto_layout_opt_*` fields for the engine currently selected in `options`."
  def to_form_fields(options) do
    engine_id = selected_engine_id(options)

    options
    |> Map.get("auto_layout_options")
    |> normalize(engine_id)
    |> Enum.into(%{}, fn {key, value} -> {@field_prefix <> key, value} end)
  end

  @doc """
  Fold submitted `auto_layout_opt_*` params back into the encoded blob.

  `params` may still carry the *previous* engine's fields — `phx-change` fires on the engine
  select before the form re-renders — but normalizing against the newly selected engine drops
  anything it doesn't recognise, so the bag self-heals.
  """
  def from_form_fields(params, current_options) do
    engine_id = selected_engine_id(Map.merge(current_options, params))

    submitted =
      for %{key: key} <- options_for(engine_id),
          value = params[@field_prefix <> key],
          not is_nil(value),
          into: %{},
          do: {key, value}

    bag =
      current_options
      |> Map.get("auto_layout_options")
      |> decode()
      |> Map.get(engine_id, %{})
      |> Map.merge(submitted)

    normalized = normalize(%{engine_id => bag}, engine_id)

    put(Map.get(current_options, "auto_layout_options"), engine_id, normalized)
  end

  defp selected_engine_id(options) do
    engine(Map.get(options, "auto_layout_engine")).id
  end

  defp decode(blob) when is_binary(blob) do
    case Jason.decode(blob) do
      {:ok, %{} = decoded} -> decoded
      _ -> %{}
    end
  end

  defp decode(%{} = blob), do: blob
  defp decode(_), do: %{}
end
