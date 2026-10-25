defmodule WandererAppWeb.MapsLiveAutoLayoutTest do
  @moduledoc """
  The map settings page's auto-layout handling: the layout tab renders the selected engine's
  options, its changes fold into the per-engine bag, and no tab can wipe or forge the root node
  the map canvas sets.
  """
  use WandererAppWeb.IntegrationConnCase, async: false

  import Mox
  import Phoenix.LiveViewTest

  alias WandererApp.MapRepo

  setup :verify_on_exit!

  setup %{conn: conn} do
    user = insert(:user)
    character = insert(:character, %{user_id: user.id})
    map = insert(:map, %{owner_id: character.id})

    # MapsLive broadcasts option changes through Test.PubSubMock; forward them here.
    test_pid = self()

    stub(Test.PubSubMock, :broadcast, fn _server, topic, message ->
      send(test_pid, {:broadcast, topic, message})
      :ok
    end)

    %{conn: init_test_session(conn, %{"user_id" => user.id}), map: map}
  end

  defp open_layout_tab(conn, map) do
    {:ok, view, _html} = live(conn, ~p"/maps/#{map.slug}/settings")
    render_click(view, "change_settings_tab", %{"tab" => "layout"})
    view
  end

  defp stored_options(map_id) do
    {:ok, map} = MapRepo.get(map_id)
    {:ok, options} = MapRepo.options_to_form_data(map)
    options
  end

  defp set_stored_options(map_id, changes) do
    {:ok, map} = MapRepo.get(map_id)
    {:ok, _} = MapRepo.update_options(map, Map.merge(stored_options(map_id), changes))
  end

  defp layout_form(overrides \\ %{}) do
    Map.merge(
      %{
        "auto_layout_enabled" => "true",
        "auto_layout_engine" => "dagre",
        "auto_layout_opt_direction" => "LR",
        "auto_layout_opt_rank_sep" => "normal",
        "auto_layout_opt_node_sep" => "normal",
        "auto_layout_opt_ranker" => "network-simplex"
      },
      overrides
    )
  end

  test "renders the selected engine's options on the layout tab", %{conn: conn, map: map} do
    html = conn |> open_layout_tab(map) |> render()

    assert html =~ "Enable automatic tree layout (dragging a system moves its whole tree)"
    assert html =~ "Auto layout direction"
    assert html =~ "Level spacing (between tree levels)"
    assert html =~ "Node spacing (between sibling systems)"
    assert html =~ "Node arrangement"
  end

  test "folds the layout tab's engine fields into auto_layout_options and broadcasts the result",
       %{conn: conn, map: map} do
    view = open_layout_tab(conn, map)

    render_change(
      view,
      "update_options",
      layout_form(%{"auto_layout_opt_direction" => "TB", "auto_layout_opt_rank_sep" => "compact"})
    )

    options = stored_options(map.id)
    assert options["auto_layout_enabled"] == "true"
    assert options["auto_layout_engine"] == "dagre"

    assert Jason.decode!(options["auto_layout_options"])["dagre"] == %{
             "direction" => "TB",
             "rank_sep" => "compact",
             "node_sep" => "normal",
             "ranker" => "network-simplex"
           }

    topic = "maps:#{map.id}"
    assert_received {:broadcast, ^topic, {:options_updated, _, ^options}}
  end

  test "scrubs layout values that are not in the catalog", %{conn: conn, map: map} do
    view = open_layout_tab(conn, map)

    render_change(
      view,
      "update_options",
      layout_form(%{"auto_layout_opt_direction" => "sideways"})
    )

    assert Jason.decode!(stored_options(map.id)["auto_layout_options"])["dagre"]["direction"] ==
             "LR"
  end

  test "another tab's change keeps the auto-layout settings and the root", %{conn: conn, map: map} do
    view = open_layout_tab(conn, map)
    render_change(view, "update_options", layout_form(%{"auto_layout_opt_direction" => "TB"}))
    set_stored_options(map.id, %{"root_system_id" => "31000448"})
    before = stored_options(map.id)

    # The general tab submits only its own fields.
    render_change(view, "update_options", %{"layout" => "top_to_bottom"})

    options = stored_options(map.id)
    assert options["layout"] == "top_to_bottom"

    for key <- [
          "auto_layout_enabled",
          "auto_layout_engine",
          "auto_layout_options",
          "root_system_id"
        ] do
      assert options[key] == before[key], "#{key} changed"
    end
  end

  test "does not write back a root the canvas set after the page was opened", %{
    conn: conn,
    map: map
  } do
    view = open_layout_tab(conn, map)

    # Set from the map canvas while the settings page stays open.
    set_stored_options(map.id, %{"root_system_id" => "31000448"})
    render_change(view, "update_options", layout_form())

    assert stored_options(map.id)["root_system_id"] == "31000448"
  end

  test "ignores a root_system_id in the form, which only the canvas may set", %{
    conn: conn,
    map: map
  } do
    view = open_layout_tab(conn, map)

    render_change(view, "update_options", layout_form(%{"root_system_id" => "30000142"}))

    assert stored_options(map.id)["root_system_id"] == ""
  end

  test "is only open to the map's owner", %{map: map} do
    other = insert(:user)
    insert(:character, %{user_id: other.id})
    conn = init_test_session(build_conn(), %{"user_id" => other.id})

    assert {:error, {_redirect, %{to: "/maps"}}} = live(conn, ~p"/maps/#{map.slug}/settings")
  end
end
