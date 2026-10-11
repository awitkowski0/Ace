import { describe, expect, it } from "vitest";
import { parseScene } from "./outline";

const TSCN = `[gd_scene load_steps=3 format=3 uid="uid://abc"]

[ext_resource type="Script" path="res://scripts/main.gd" id="1_a"]
[ext_resource type="PackedScene" uid="uid://x" path="res://scenes/ui.tscn" id="2_b"]

[node name="Main" type="Node2D"]
script = ExtResource("1_a")

[node name="Hud" parent="." instance=ExtResource("2_b")]

[node name="World" type="Node" parent="." groups=["a", "b"]]

[node name="Tile" type="Sprite2D" parent="World"]
position = Vector2(1, 2)

[node name="Deep" type="Label" parent="World/Tile"]

[node name="Late" type="Node" parent="."]

[connection signal="x" from="." to="Hud" method="y"]
`;

describe("scene outline", () => {
  const n = parseScene(TSCN);
  it("tree order and depth", () => {
    expect(n.map((x) => [x.depth, x.name, x.type])).toEqual([[0, "Main", "Node2D"], [1, "Hud", ""], [1, "World", "Node"], [2, "Tile", "Sprite2D"], [3, "Deep", "Label"], [1, "Late", "Node"]]);
  });
  it("script, instance, groups and header lines", () => {
    expect(n[0].script).toBe("res://scripts/main.gd");
    expect(n[1].instance).toBe("res://scenes/ui.tscn");
    expect(n[2].groups).toEqual(["a", "b"]);
    expect(n.map((x) => x.line)).toEqual([6, 9, 11, 13, 16, 18]);
  });
});
