import { describe, expect, it } from "vitest";
import { godotArgv, instanceCount, instanceLabel, specFields } from "./cmdline";

describe("godot command line", () => {
  it("script run with user args", () => {
    expect(godotArgv("script", { headless: true, script: "res://tools/sim/sim_match.gd", scriptArgs: "5 8" }, "/p")).toEqual(["--path", "/p", "--headless", "--script", "res://tools/sim/sim_match.gd", "--", "5", "8"]);
  });
  it("scene run with engine flags", () => {
    expect(godotArgv("scene", { scene: "res://scenes/a.tscn", resolution: "1280x720", position: "10,20", verbose: true, args: "--fixed-fps 30" }, "/p"))
      .toEqual(["--path", "/p", "--verbose", "--resolution", "1280x720", "--position", "10,20", "--fixed-fps", "30", "res://scenes/a.tscn"]);
  });
  it("instances pick their own line", () => {
    const cfg = { script: "res://n.gd", instanceArgs: "host\nclient --port 1\n", scriptArgs: "-x" };
    expect(instanceCount(cfg)).toBe(2);
    expect(godotArgv("script", cfg, "/p", 1).slice(-5)).toEqual(["--", "-x", "client", "--port", "1"]);
    expect([instanceLabel(cfg, 0), instanceLabel(cfg, 1), instanceLabel({ instanceArgs: "--x\n" }, 0)]).toEqual(["host", "client", "#1"]);
    expect(instanceCount({ instances: "3" })).toBe(3);
    expect(instanceCount({})).toBe(1);
  });
  it("spec fields", () => {
    const f = specFields({ type: "script", script: "res://a.gd", instanceArgs: ["host", "client"], timeLimit: 450 });
    expect(f).toMatchObject({ type: "godot-script", instances: "2", instanceArgs: "host\nclient", timeLimit: "450", liveReload: false });
  });
});
