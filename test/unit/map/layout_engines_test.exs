defmodule WandererApp.Map.LayoutEnginesTest do
  use ExUnit.Case, async: true

  alias WandererApp.Map.LayoutEngines

  @defaults %{
    "direction" => "LR",
    "rank_sep" => "normal",
    "node_sep" => "normal",
    "ranker" => "network-simplex"
  }

  describe "catalog" do
    test "lists dagre as the default engine, labelled for the picker" do
      assert LayoutEngines.default_engine_id() == "dagre"
      assert LayoutEngines.engine_choices() == [{"Tree", "dagre"}]
    end

    test "gives every option the form field it is addressed by" do
      fields = LayoutEngines.options_for("dagre") |> Enum.map(&{&1.key, &1.field})

      assert fields == [
               {"direction", :auto_layout_opt_direction},
               {"rank_sep", :auto_layout_opt_rank_sep},
               {"node_sep", :auto_layout_opt_node_sep},
               {"ranker", :auto_layout_opt_ranker}
             ]
    end

    test "falls back to the default engine for unknown or missing ids" do
      assert LayoutEngines.engine("dagre").id == "dagre"
      assert LayoutEngines.engine("unknown").id == "dagre"
      assert LayoutEngines.engine(nil).id == "dagre"
    end

    test "builds default bags per engine and for the stored default" do
      assert LayoutEngines.default_options("dagre") == @defaults
      assert Jason.decode!(LayoutEngines.default_options_json()) == %{"dagre" => @defaults}
    end
  end

  describe "normalize/2" do
    test "keeps valid values, fills in missing keys and drops unknown ones" do
      blob = ~s({"dagre": {"direction": "TB", "colour": "red"}})

      assert LayoutEngines.normalize(blob, "dagre") == %{@defaults | "direction" => "TB"}
    end

    test "replaces values outside the catalog with the default" do
      blob = Jason.encode!(%{"dagre" => %{"rank_sep" => "huge", "ranker" => "constructor"}})

      assert LayoutEngines.normalize(blob, "dagre") == @defaults
    end

    test "accepts an already-decoded map" do
      assert LayoutEngines.normalize(%{"dagre" => %{"node_sep" => "compact"}}, "dagre") ==
               %{@defaults | "node_sep" => "compact"}
    end

    for {label, blob} <- [
          {"nil", nil},
          {"an empty string", ""},
          {"invalid JSON", "{{"},
          {"a JSON array", "[1, 2]"},
          {"a null bag", ~s({"dagre": null})},
          {"a list bag", ~s({"dagre": [1, 2]})},
          {"a string bag", ~s({"dagre": "TB"})},
          {"another engine's bag only", ~s({"other": {"direction": "TB"}})}
        ] do
      test "degrades #{label} to the defaults" do
        assert LayoutEngines.normalize(unquote(blob), "dagre") == @defaults
      end
    end
  end

  describe "put/3" do
    test "replaces one engine's bag and leaves the others untouched" do
      blob = Jason.encode!(%{"dagre" => %{"direction" => "LR"}, "other" => %{"x" => "1"}})

      assert Jason.decode!(LayoutEngines.put(blob, "dagre", %{"direction" => "TB"})) == %{
               "dagre" => %{"direction" => "TB"},
               "other" => %{"x" => "1"}
             }
    end

    test "starts from an empty blob when the stored one is unusable" do
      assert Jason.decode!(LayoutEngines.put("{{", "dagre", %{"direction" => "TB"})) == %{
               "dagre" => %{"direction" => "TB"}
             }
    end
  end

  describe "to_form_fields/1" do
    test "flattens the selected engine's normalized bag into auto_layout_opt_* fields" do
      options = %{
        "auto_layout_engine" => "dagre",
        "auto_layout_options" => ~s({"dagre": {"direction": "BT", "rank_sep": "bogus"}})
      }

      assert LayoutEngines.to_form_fields(options) == %{
               "auto_layout_opt_direction" => "BT",
               "auto_layout_opt_rank_sep" => "normal",
               "auto_layout_opt_node_sep" => "normal",
               "auto_layout_opt_ranker" => "network-simplex"
             }
    end

    test "uses the default engine and defaults when nothing is stored" do
      assert LayoutEngines.to_form_fields(%{}) ==
               Map.new(@defaults, fn {key, value} -> {"auto_layout_opt_" <> key, value} end)
    end
  end

  describe "from_form_fields/2" do
    defp current(bag), do: %{"auto_layout_engine" => "dagre", "auto_layout_options" => bag}

    test "folds submitted fields over the stored bag" do
      stored = Jason.encode!(%{"dagre" => %{"direction" => "TB", "rank_sep" => "compact"}})

      result =
        LayoutEngines.from_form_fields(
          %{"auto_layout_opt_rank_sep" => "spacious"},
          current(stored)
        )

      assert Jason.decode!(result)["dagre"] == %{
               @defaults
               | "direction" => "TB",
                 "rank_sep" => "spacious"
             }
    end

    test "scrubs submitted values that are not in the catalog" do
      result =
        LayoutEngines.from_form_fields(%{"auto_layout_opt_direction" => "sideways"}, current(nil))

      assert Jason.decode!(result)["dagre"]["direction"] == "LR"
    end

    test "keeps other engines' bags" do
      stored = Jason.encode!(%{"dagre" => %{}, "radial" => %{"spread" => "wide"}})

      result =
        LayoutEngines.from_form_fields(
          %{"auto_layout_opt_ranker" => "longest-path"},
          current(stored)
        )

      assert Jason.decode!(result)["radial"] == %{"spread" => "wide"}
    end

    test "self-heals when the engine select changes before the form re-renders" do
      # The payload carries the selected engine plus fields the newly selected engine may not
      # know; anything it doesn't declare is dropped.
      params = %{"auto_layout_engine" => "unknown", "auto_layout_opt_other" => "x"}

      result = LayoutEngines.from_form_fields(params, current(nil))

      assert Jason.decode!(result) == %{"dagre" => @defaults}
    end

    for {label, bag} <- [
          {"null", ~s({"dagre": null})},
          {"a list", ~s({"dagre": [1, 2]})},
          {"a string", ~s({"dagre": "x"})},
          {"invalid JSON", "{{"}
        ] do
      test "does not crash when the stored bag is #{label}" do
        result =
          LayoutEngines.from_form_fields(
            %{"auto_layout_opt_direction" => "TB"},
            current(unquote(bag))
          )

        assert Jason.decode!(result)["dagre"] == %{@defaults | "direction" => "TB"}
      end
    end
  end
end
