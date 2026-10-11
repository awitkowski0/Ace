import { describe, expect, it } from "vitest";
import { parseDevTools, parseGodotLine, pinRecord, pinsOf, specKey, splitComment } from "./presets";

const README = `# X
### Dev tools
\`\`\`
tools/run_godot.sh 450 --headless --script res://tools/sim/sim_match.gd -- 5 8        # all-bot balance sim
tools/run_godot.sh 450 --headless --script res://tools/sim/net_test.gd -- host|client     # LAN test (two processes)
tools/run_godot.sh 120 --script res://tools/sim/perf_probe.gd -- 30                       # real-match fps
tools/run_godot.sh 600 --script res://tools/ui_fit_check.gd                               # UI text-fit check
tools/run_godot.sh 120 --script res://tools/map/zfight_shots.gd -- --out=/tmp/zf name=cx,cy,cz:tx,ty,tz  # grazing-angle screenshots
tools/run_godot.sh 60 --script res://tools/minigame_preview.gd -- --game=snake              # play/test an arcade game
tools/run_godot.sh 60 res://scenes/main_menu.tscn --resolution 1280x720 --fixed-fps 30
python3 tools/audio/generate_all.py                                                    # regenerate audio
\`\`\`
## Other
\`\`\`
tools/run_godot.sh 5 --script res://not/dev.gd
\`\`\`
`;

describe("README presets", () => {
  const p = parseDevTools(README);
  it("only the Dev tools block, only godot lines", () => {
    expect(p.map((x) => x.name)).toEqual(["All-bot balance sim", "LAN test (two processes)", "Real-match fps", "UI text-fit check", "Grazing-angle screenshots", "Play/test an arcade game", "main_menu"]);
  });
  it("script, headless, time limit, user args", () => {
    expect(p[0]).toMatchObject({ type: "script", script: "res://tools/sim/sim_match.gd", headless: true, timeLimit: 450, scriptArgs: "5 8" });
    expect(p[2]).toMatchObject({ type: "script", timeLimit: 120, scriptArgs: "30" });
    expect(p[2].headless).toBeUndefined();
    expect(p[3].scriptArgs).toBeUndefined();
  });
  it("host|client becomes two instances", () => {
    expect(p[1].instanceArgs).toEqual(["host", "client"]);
    expect(p[1].scriptArgs).toBeUndefined();
  });
  it("keeps args with = and :", () => {
    expect(p[4].scriptArgs).toBe("--out=/tmp/zf name=cx,cy,cz:tx,ty,tz");
  });
  it("scene lines and value flags", () => {
    expect(p[6]).toMatchObject({ type: "scene", scene: "res://scenes/main_menu.tscn", resolution: "1280x720", args: "--fixed-fps 30" });
  });
});

describe("helpers", () => {
  it("splitComment ignores # in quotes and words", () => {
    expect(splitComment("a 'b # c' d # note")).toEqual({ code: "a 'b # c' d", comment: "note" });
    expect(splitComment("a#b")).toEqual({ code: "a#b", comment: "" });
  });
  it("godot binary lines and non-godot", () => {
    expect(parseGodotLine("godot --path . --headless --import")).toMatchObject({ type: "project", headless: true, args: "--import" });
    expect(parseGodotLine("npm run x")).toBeNull();
  });
  it("pins round trip and identity", () => {
    const s = { type: "script" as const, script: "res://a.gd", headless: true, timeLimit: 10, name: "A" };
    const rec = pinRecord(s);
    expect(Object.keys(rec)).toEqual(["type", "name", "script", "headless", "timeLimit"]);
    expect(pinsOf({ pinned: [rec, { type: "nope" }, 5] })).toEqual([rec]);
    expect(specKey({ ...s, name: "other" })).toBe(specKey(s));
  });
});
