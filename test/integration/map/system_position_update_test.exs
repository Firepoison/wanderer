defmodule WandererApp.Map.SystemPositionUpdateTest do
  @moduledoc """
  Position updates from map clients against a running map server: malformed entries are
  dropped without crashing the LiveView, and a value the database rejects never reaches the
  in-memory map.
  """
  use WandererAppWeb.IntegrationConnCase, async: false

  import Mox
  import WandererApp.MapTestHelpers

  alias WandererApp.MapSystemRepo
  alias WandererAppWeb.MapSystemsEventHandler

  @jita 30_000_142
  @amarr 30_002_187

  setup :verify_on_exit!

  setup do
    setup_ddrt_mocks()
    setup_system_static_info_cache()

    user = insert(:user)
    character = insert(:character, %{user_id: user.id})
    map = insert(:map, %{owner_id: character.id})
    ensure_map_stopped(map.id)

    insert(:map_system, %{map_id: map.id, solar_system_id: @jita, position_x: 0, position_y: 0})

    insert(:map_system, %{map_id: map.id, solar_system_id: @amarr, position_x: 200, position_y: 0})

    ensure_map_started(map.id)

    test_pid = self()

    forward = fn _server, topic, message ->
      send(test_pid, {:map_broadcast, topic, message})
      :ok
    end

    stub(Test.PubSubMock, :broadcast!, forward)
    stub(Test.PubSubMock, :broadcast, forward)

    %{map: map}
  end

  defp member(map),
    do: %Phoenix.LiveView.Socket{
      assigns: %{
        __changed__: %{},
        map_id: map.id,
        main_character_id: Ecto.UUID.generate(),
        has_tracked_characters?: true,
        user_permissions: %{update_system: true}
      }
    }

  defp position(id, x, y), do: %{"solar_system_id" => id, "position" => %{"x" => x, "y" => y}}

  defp stored(map_id, solar_system_id) do
    {:ok, system} = MapSystemRepo.get_by_map_and_solar_system_id(map_id, solar_system_id)
    {system.position_x, system.position_y}
  end

  defp in_memory(map_id, solar_system_id) do
    system = WandererApp.Map.find_system_by_location(map_id, %{solar_system_id: solar_system_id})
    {system.position_x, system.position_y}
  end

  test "update_system_positions saves the well-formed entries and drops the rest", %{map: map} do
    payload = [
      position("#{@jita}", 15, 30),
      position("J123", 1, 1),
      position("#{@amarr}", "abc", 1),
      %{"bad" => "entry"}
    ]

    assert {:noreply, _} =
             MapSystemsEventHandler.handle_ui_event(
               "update_system_positions",
               payload,
               member(map)
             )

    assert stored(map.id, @jita) == {15, 30}
    assert in_memory(map.id, @jita) == {15, 30}
    assert stored(map.id, @amarr) == {200, 0}
    assert in_memory(map.id, @amarr) == {200, 0}
  end

  test "update_system_positions ignores a payload that isn't a list", %{map: map} do
    assert {:noreply, _} =
             MapSystemsEventHandler.handle_ui_event(
               "update_system_positions",
               position("#{@jita}", 15, 30),
               member(map)
             )

    assert stored(map.id, @jita) == {0, 0}
  end

  test "update_system_position drops a malformed id instead of crashing", %{map: map} do
    assert {:noreply, _} =
             MapSystemsEventHandler.handle_ui_event(
               "update_system_position",
               position("J123", 15, 30),
               member(map)
             )

    assert {:noreply, _} =
             MapSystemsEventHandler.handle_ui_event(
               "update_system_position",
               position("#{@jita}", 45.4, 60),
               member(map)
             )

    assert stored(map.id, @jita) == {45, 60}
    assert in_memory(map.id, @jita) == {45, 60}
  end

  test "a value the database rejects never reaches the in-memory map or clients", %{map: map} do
    assert :ok =
             WandererApp.Map.Server.update_system_position(map.id, %{
               solar_system_id: @jita,
               position_x: "abc",
               position_y: 7
             })

    assert stored(map.id, @jita) == {0, 0}
    assert in_memory(map.id, @jita) == {0, 0}
    refute_received {:map_broadcast, _, %{event: :update_system}}
  end
end
