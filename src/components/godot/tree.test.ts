import { describe, expect, it } from "vitest";
import { buildRows, DEFAULT_OPEN } from "./tree";

const m = {
  name: "Share", mainScene: "res://scenes/main_menu.tscn", recent: ["res://scenes/a.tscn", "res://scenes/main_menu.tscn"], scenes: ["res://scenes/a.tscn", "res://scenes/b.tscn", "res://scenes/main_menu.tscn"],
  presets: [{ type: "script" as const, script: "res://tools/x.gd", name: "X sim", line: "tools/run_godot.sh 5 --script res://tools/x.gd", comment: "x sim" }],
  scripts: [{ path: "res://tools/sim/arch_check.gd", kind: "SceneTree", doc: "Architecture rules" }],
};
describe("godot tree", () => {
  it("sections and rows", () => {
    const rows = buildRows(m, [{ type: "project" }], new Set(DEFAULT_OPEN));
    expect(rows.map((r) => r.id)).toEqual(["sec:pinned", "pin:0:" + rows[1].id.slice(6), "sec:project", "run", "sec:scenes", "scene:res://scenes/main_menu.tscn", "scene:res://scenes/a.tscn", "more:scenes", "sec:presets", "preset:0", "sec:scripts", "script:res://tools/sim/arch_check.gd"]);
    expect(rows.find((r) => r.id === "run")?.spec?.type).toBe("project");
    expect(rows.find((r) => r.id.startsWith("script:"))?.spec).toMatchObject({ type: "script", headless: true });
  });
  it("all scenes expand and closed sections hide rows", () => {
    const open = new Set([...DEFAULT_OPEN, "more:scenes"]);
    expect(buildRows(m, [], open).some((r) => r.id === "scene:res://scenes/b.tscn")).toBe(true);
    expect(buildRows(m, [], new Set()).every((r) => r.kind === "section")).toBe(true);
  });
});
