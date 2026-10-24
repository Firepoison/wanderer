defmodule WandererApp.Map.AutoLayoutPayloadsTest do
  @moduledoc """
  The pure server-side pieces auto-layout relies on: parsing position updates, the connection
  payload sent to clients, and the option defaults maps start with.
  """
  use ExUnit.Case, async: true

  alias WandererApp.MapRepo
  alias WandererAppWeb.{MapEventHandler, MapSystemsEventHandler}

  describe "MapSystemsEventHandler.parse_system_positions/1" do
    test "parses the client's position updates and drops malformed ones" do
      positions = [
        %{"solar_system_id" => "31000448", "position" => %{"x" => 10, "y" => 20}},
        %{"solar_system_id" => "30002659", "position" => %{"x" => nil, "y" => 20}},
        %{"solar_system_id" => nil, "position" => %{"x" => 1, "y" => 2}},
        %{"position" => %{"x" => 1, "y" => 2}},
        %{"solar_system_id" => "30002813"}
      ]

      assert MapSystemsEventHandler.parse_system_positions(positions) == [
               %{solar_system_id: 31_000_448, position_x: 10, position_y: 20}
             ]
    end

    test "treats anything but a list as no updates" do
      assert MapSystemsEventHandler.parse_system_positions(nil) == []
      assert MapSystemsEventHandler.parse_system_positions(%{"not" => "a list"}) == []
    end
  end

  describe "MapEventHandler.map_ui_connection/1" do
    test "sends the connection's creation time, which auto-layout anchors on" do
      inserted_at = ~U[2026-10-24 12:00:00.000000Z]

      payload =
        MapEventHandler.map_ui_connection(%{
          solar_system_source: 31_000_448,
          solar_system_target: 30_002_659,
          mass_status: 0,
          time_status: 0,
          type: 0,
          ship_size_type: 2,
          locked: false,
          inserted_at: inserted_at
        })

      assert payload.id == "31000448_30002659"
      assert payload.inserted_at == inserted_at
      assert Jason.encode!(payload) =~ ~s("inserted_at":"2026-10-24T12:00:00.000000Z")
    end
  end

  describe "MapRepo.options_to_form_data/1" do
    test "gives maps without stored auto-layout settings the defaults" do
      {:ok, options} =
        MapRepo.options_to_form_data(%{options: Jason.encode!(%{"layout" => "left_to_right"})})

      assert options["auto_layout_enabled"] == "false"
      assert options["auto_layout_engine"] == "dagre"
      assert options["root_system_id"] == ""

      assert Jason.decode!(options["auto_layout_options"]) == %{
               "dagre" => WandererApp.Map.LayoutEngines.default_options("dagre")
             }
    end

    test "keeps stored settings over the defaults" do
      stored = %{"auto_layout_enabled" => "true", "root_system_id" => "31000448"}

      {:ok, options} = MapRepo.options_to_form_data(%{options: Jason.encode!(stored)})

      assert options["auto_layout_enabled"] == "true"
      assert options["root_system_id"] == "31000448"
    end

    test "uses the defaults for maps with no options at all" do
      assert {:ok, %{"auto_layout_enabled" => "false"}} =
               MapRepo.options_to_form_data(%{options: nil})
    end
  end
end
