defmodule WandererApp.Map.AutoLayoutServerTest do
  @moduledoc """
  Auto-layout's server side against a running map server: the batch position update, the two
  admin layout events, the map server's handling of new options, and the pushes that carry the
  results to map clients.
  """
  use WandererAppWeb.IntegrationConnCase, async: false

  import Mox
  import WandererApp.MapTestHelpers

  alias WandererApp.Map.LayoutEngines
  alias WandererApp.Map.Server, as: MapServer
  alias WandererApp.MapRepo
  alias WandererApp.MapSystemRepo
  alias WandererAppWeb.{MapCoreEventHandler, MapSystemsEventHandler}

  @jita 30_000_142
  @amarr 30_002_187
  @dodixie 30_002_659

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

    # Dodixie was on the map and has been deleted: its row is kept, hidden.
    dodixie =
      insert(:map_system, %{
        map_id: map.id,
        solar_system_id: @dodixie,
        position_x: 400,
        position_y: 0
      })

    {:ok, _} = MapSystemRepo.update_visible(dodixie, %{visible: false})

    ensure_map_started(map.id)

    # The map server broadcasts through Test.PubSubMock; forward those broadcasts here.
    test_pid = self()

    forward = fn _server, topic, message ->
      send(test_pid, {:map_broadcast, topic, message})
      :ok
    end

    stub(Test.PubSubMock, :broadcast!, forward)
    stub(Test.PubSubMock, :broadcast, forward)

    flush_messages()
    %{map: map}
  end

  defp socket(assigns),
    do: %Phoenix.LiveView.Socket{assigns: Map.merge(%{__changed__: %{}}, assigns)}

  defp admin(map), do: socket(%{map_id: map.id, user_permissions: %{admin_map: true}})

  defp member(map),
    do: socket(%{map_id: map.id, user_permissions: %{admin_map: false, update_system: true}})

  defp stored(map_id, solar_system_id) do
    {:ok, system} = MapSystemRepo.get_by_map_and_solar_system_id(map_id, solar_system_id)
    {system.position_x, system.position_y, system.visible}
  end

  defp position(solar_system_id, x, y),
    do: %{"solar_system_id" => "#{solar_system_id}", "position" => %{"x" => x, "y" => y}}

  defp flush_messages(acc \\ []) do
    receive do
      message -> flush_messages([message | acc])
    after
      100 -> Enum.reverse(acc)
    end
  end

  defp update_systems_broadcasts(messages, map_id) do
    for {:map_broadcast, ^map_id, %{event: :update_systems, payload: systems}} <- messages,
        do: Enum.map(systems, & &1.solar_system_id)
  end

  defp stored_options(map_id) do
    {:ok, map} = MapRepo.get(map_id)
    {:ok, options} = MapRepo.options_to_form_data(map)
    options
  end

  describe "Map.Server.update_system_positions/2" do
    test "saves changed positions, skips unchanged ones, and broadcasts the changes once", %{
      map: map
    } do
      :ok =
        MapServer.update_system_positions(map.id, [
          %{solar_system_id: @jita, position_x: 50, position_y: 60},
          %{solar_system_id: @amarr, position_x: 200, position_y: 0}
        ])

      assert stored(map.id, @jita) == {50, 60, true}
      assert stored(map.id, @amarr) == {200, 0, true}
      assert update_systems_broadcasts(flush_messages(), map.id) == [[@jita]]

      assert %{position_x: 50, position_y: 60} =
               WandererApp.Map.find_system_by_location(map.id, %{solar_system_id: @jita})
    end

    test "never brings back a deleted system", %{map: map} do
      :ok =
        MapServer.update_system_positions(map.id, [
          %{solar_system_id: @dodixie, position_x: 999, position_y: 999}
        ])

      assert stored(map.id, @dodixie) == {400, 0, false}
      assert update_systems_broadcasts(flush_messages(), map.id) == []
    end

    test "applies the last of several updates for one system", %{map: map} do
      :ok =
        MapServer.update_system_positions(map.id, [
          %{solar_system_id: @jita, position_x: 10, position_y: 10},
          %{solar_system_id: @jita, position_x: 20, position_y: 20}
        ])

      assert stored(map.id, @jita) == {20, 20, true}
    end

    test "does nothing for no updates", %{map: map} do
      assert :ok = MapServer.update_system_positions(map.id, [])
      assert update_systems_broadcasts(flush_messages(), map.id) == []
    end
  end

  describe "position events from map members" do
    defp tracked_member(map),
      do:
        socket(%{
          map_id: map.id,
          main_character_id: Ecto.UUID.generate(),
          has_tracked_characters?: true,
          user_permissions: %{update_system: true}
        })

    test "update_system_positions saves a cluster drag in one batch", %{map: map} do
      payload = [position(@jita, 15, 30), position(@amarr, 215, 30), %{"bad" => "entry"}]

      assert {:noreply, _} =
               MapSystemsEventHandler.handle_ui_event(
                 "update_system_positions",
                 payload,
                 tracked_member(map)
               )

      assert stored(map.id, @jita) == {15, 30, true}
      assert stored(map.id, @amarr) == {215, 30, true}
      assert [ids] = update_systems_broadcasts(flush_messages(), map.id)
      assert Enum.sort(ids) == [@jita, @amarr]
    end

    test "update_system_position saves a single system", %{map: map} do
      assert {:noreply, _} =
               MapSystemsEventHandler.handle_ui_event(
                 "update_system_position",
                 position(@jita, 45, 60),
                 tracked_member(map)
               )

      assert stored(map.id, @jita) == {45, 60, true}
    end

    test "update_system_position ignores a malformed position", %{map: map} do
      assert {:noreply, _} =
               MapSystemsEventHandler.handle_ui_event(
                 "update_system_position",
                 %{"solar_system_id" => "#{@jita}"},
                 tracked_member(map)
               )

      assert stored(map.id, @jita) == {0, 0, true}
    end
  end

  describe "update_layout_settings" do
    test "saves an admin's collected positions first, then the root change", %{map: map} do
      Phoenix.PubSub.subscribe(WandererApp.PubSub, "maps:#{map.id}")

      payload = %{
        "root_system_id" => "#{@jita}",
        # Engine-specific options are only editable in the validated settings form.
        "auto_layout_options" => ~s({"dagre": {"direction": "TB"}}),
        "positions" => [position(@amarr, 230, 15)]
      }

      assert {:reply, %{options: options}, _socket} =
               MapCoreEventHandler.handle_ui_event("update_layout_settings", payload, admin(map))

      assert options["root_system_id"] == "#{@jita}"
      assert options["auto_layout_options"] == LayoutEngines.default_options_json()
      assert stored_options(map.id)["root_system_id"] == "#{@jita}"
      assert stored(map.id, @amarr) == {230, 15, true}

      messages = flush_messages()

      saved_at =
        Enum.find_index(messages, &match?({:map_broadcast, _, %{event: :update_systems}}, &1))

      options_at = Enum.find_index(messages, &match?({:options_updated, _, _}, &1))
      assert saved_at && options_at && saved_at < options_at
      assert {:options_updated, _, ^options} = Enum.at(messages, options_at)
    end

    test "replaces an unknown engine with the default", %{map: map} do
      assert {:reply, %{options: options}, _} =
               MapCoreEventHandler.handle_ui_event(
                 "update_layout_settings",
                 %{"auto_layout_engine" => "bogus"},
                 admin(map)
               )

      assert options["auto_layout_engine"] == "dagre"
    end

    test "refuses non-admins without saving anything", %{map: map} do
      payload = %{"root_system_id" => "#{@jita}", "positions" => [position(@amarr, 230, 15)]}

      assert {:reply, %{success: false, error: "unauthorized"}, _} =
               MapCoreEventHandler.handle_ui_event("update_layout_settings", payload, member(map))

      assert stored_options(map.id)["root_system_id"] == ""
      assert stored(map.id, @amarr) == {200, 0, true}
    end
  end

  describe "save_layout_positions" do
    test "saves an admin's layout", %{map: map} do
      payload = %{"positions" => [position(@jita, 5, 6), position(@amarr, 7, 8)]}

      assert {:reply, %{success: true}, _} =
               MapCoreEventHandler.handle_ui_event("save_layout_positions", payload, admin(map))

      assert stored(map.id, @jita) == {5, 6, true}
      assert stored(map.id, @amarr) == {7, 8, true}

      assert [ids] = update_systems_broadcasts(flush_messages(), map.id)
      assert Enum.sort(ids) == [@jita, @amarr]
    end

    test "refuses members who are not admins, even with update_system", %{map: map} do
      assert {:reply, %{success: false, error: "unauthorized"}, _} =
               MapCoreEventHandler.handle_ui_event(
                 "save_layout_positions",
                 %{"positions" => [position(@jita, 5, 6)]},
                 member(map)
               )

      assert stored(map.id, @jita) == {0, 0, true}
    end
  end

  describe "the map server's options" do
    test "an options update reaches the in-memory map and is re-broadcast to map clients", %{
      map: map
    } do
      options = Map.put(stored_options(map.id), "auto_layout_enabled", "true")

      MapServer.Impl.handle_event({:options_updated, map.id, options})

      assert WandererApp.Map.get_map!(map.id).options == options

      assert Enum.any?(
               flush_messages(),
               &match?({:map_broadcast, _, %{event: :options_updated, payload: ^options}}, &1)
             )
    end
  end

  describe "deleting the root system" do
    setup %{map: map} do
      options = Map.put(stored_options(map.id), "root_system_id", "#{@jita}")
      {:ok, map_record} = MapRepo.get(map.id)
      {:ok, _} = MapRepo.update_options(map_record, options)
      MapServer.Impl.update_options(map.id, options)
      flush_messages()
      :ok
    end

    defp options_broadcasts(messages) do
      for {:map_broadcast, _, %{event: :options_updated, payload: options}} <- messages,
          do: options
    end

    test "clears the root, so a re-added system doesn't pull its old tree around itself", %{
      map: map
    } do
      MapServer.delete_systems(map.id, [@jita], nil, nil)

      assert stored(map.id, @jita) == {0, 0, false}
      assert stored_options(map.id)["root_system_id"] == ""
      assert {:ok, %{"root_system_id" => ""}} = WandererApp.Map.get_options(map.id)
      assert [%{"root_system_id" => ""}] = options_broadcasts(flush_messages())
    end

    test "leaves the root alone when another system is deleted", %{map: map} do
      MapServer.delete_systems(map.id, [@amarr], nil, nil)

      assert stored(map.id, @amarr) == {200, 0, false}
      assert stored_options(map.id)["root_system_id"] == "#{@jita}"
      assert options_broadcasts(flush_messages()) == []
    end
  end

  describe "pushes to map clients" do
    test ":update_systems pushes the systems as one update_systems event", %{map: map} do
      {:ok, jita} = MapSystemRepo.get_by_map_and_solar_system_id(map.id, @jita)
      socket = socket(%{is_version_valid?: true})

      socket =
        MapSystemsEventHandler.handle_server_event(
          %{event: :update_systems, payload: [jita]},
          socket
        )

      assert [["map_event", %{type: "update_systems", body: [body]}]] =
               Phoenix.LiveView.Utils.get_push_events(socket)

      assert body.id == "#{@jita}"
      assert body.position == %{x: 0, y: 0}
    end

    test ":options_updated pushes the options as an update_options event" do
      socket =
        MapCoreEventHandler.handle_server_event(
          %{event: :options_updated, payload: %{"auto_layout_enabled" => "true"}},
          socket(%{is_version_valid?: true})
        )

      assert Phoenix.LiveView.Utils.get_push_events(socket) == [
               ["map_event", %{type: "update_options", body: %{"auto_layout_enabled" => "true"}}]
             ]
    end
  end
end
