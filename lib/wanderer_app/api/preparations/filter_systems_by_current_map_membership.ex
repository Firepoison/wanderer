defmodule WandererApp.Api.Preparations.FilterSystemsByCurrentMapMembership do
  @moduledoc """
  Filters systems to the current in-memory map membership when available.
  """

  use Ash.Resource.Preparation

  require Ash.Query

  alias WandererApp.Api.ActorHelpers

  @impl true
  def prepare(query, _opts, context) do
    case ActorHelpers.get_map(context) do
      %{id: map_id} ->
        case WandererApp.Map.get_map(map_id) do
          {:ok, %{systems: systems}} when is_map(systems) ->
            member_system_ids = Map.keys(systems)

            case member_system_ids do
              [] -> Ash.Query.filter(query, false)
              ids -> Ash.Query.filter(query, solar_system_id in ^ids)
            end

          _ ->
            query
        end

      _ ->
        query
    end
  end
end
