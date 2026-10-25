defmodule WandererAppWeb.SystemPositionParsingTest do
  use ExUnit.Case, async: true

  alias WandererAppWeb.MapSystemsEventHandler

  defp position(id, x, y), do: %{"solar_system_id" => id, "position" => %{"x" => x, "y" => y}}

  describe "parse_system_position/1" do
    test "parses the solar system id a client sends as a string of digits" do
      assert MapSystemsEventHandler.parse_system_position(position("30000142", 15, 30)) ==
               {:ok, %{solar_system_id: 30_000_142, position_x: 15, position_y: 30}}
    end

    test "accepts an integer solar system id" do
      assert {:ok, %{solar_system_id: 30_000_142}} =
               MapSystemsEventHandler.parse_system_position(position(30_000_142, 15, 30))
    end

    test "rounds fractional positions to whole pixels" do
      assert {:ok, %{position_x: 16, position_y: -30}} =
               MapSystemsEventHandler.parse_system_position(position("30000142", 15.6, -30.2))
    end

    for {label, entry} <- [
          {"a non-numeric id",
           %{"solar_system_id" => "J123", "position" => %{"x" => 1, "y" => 2}}},
          {"a fractional id", %{"solar_system_id" => "1.5", "position" => %{"x" => 1, "y" => 2}}},
          {"an id with trailing text",
           %{"solar_system_id" => "30000142x", "position" => %{"x" => 1, "y" => 2}}},
          {"a missing id", %{"position" => %{"x" => 1, "y" => 2}}},
          {"a non-numeric x",
           %{"solar_system_id" => "30000142", "position" => %{"x" => "abc", "y" => 2}}},
          {"a null y", %{"solar_system_id" => "30000142", "position" => %{"x" => 1, "y" => nil}}},
          {"a missing position", %{"solar_system_id" => "30000142"}},
          {"a list", [1, 2]},
          {"a string", "30000142"}
        ] do
      test "rejects #{label}" do
        assert MapSystemsEventHandler.parse_system_position(unquote(Macro.escape(entry))) ==
                 :error
      end
    end
  end
end
