import { describe, expect, it } from "vitest";
import { addHudElement, elementRect, offsetForRect, readHud, removeHudElement, setHudProp, nearestAnchor } from "./hud";
import { clampRect, readConsole, setConsoleProps, themeTokens } from "./console";
import { beamOf, readRenderSources, readSuit, setJson, setRenderFrom } from "./suit";
import { anchorFrame, anchorValue, jetPosition, offsetForSceneDelta, parseAnchor } from "./anchors";
import { guideKind, parseMarkup, plainMarkup } from "./guide";
import { packKind, packRoot, stem } from "./kinds";

const HUD_JS = `// The ammo counter
hud(hud => {
    hud.text("{ammo} / {capacity}", {
        anchor: "BOTTOM_RIGHT",
        x: -12,
        y: -22,
        scale: 1.5,
    });
    hud.bar("reloadProgress", { anchor: "BOTTOM_CENTER", x: 0, y: -46, width: 62, height: 3, when: "reloading" });
});
`;
const HUD_JSON = `{
  "elements": [
    { "type": "TEXT", "anchor": "TOP_LEFT", "x": 4, "y": 4, "text": "{gunName}" }
  ]
}
`;

describe("hud", () => {
  it("reads both forms", () => {
    const js = readHud(HUD_JS, "js");
    expect(js.elements.map((e) => [e.kind, e.primary])).toEqual([["TEXT", "{ammo} / {capacity}"], ["BAR", "reloadProgress"]]);
    expect(js.elements[0].props).toMatchObject({ anchor: "BOTTOM_RIGHT", x: -12, scale: 1.5 });
    const json = readHud(HUD_JSON, "json");
    expect(json.elements[0]).toMatchObject({ kind: "TEXT", primary: "{gunName}" });
  });
  it("lays out like HudLayout (right/bottom aligned, offsets after)", () => {
    const [text, bar] = readHud(HUD_JS, "js").elements;
    // "18 / 30" = 7 chars -> 41 px * 1.5 = 61.5 -> 61; 9 * 1.5 = 13.5 -> 13
    expect(elementRect(text, 427, 240)).toEqual({ x: 427 - 61 - 12, y: 240 - 13 - 22, w: 61, h: 13 });
    expect(elementRect(bar, 427, 240)).toEqual({ x: Math.trunc((427 - 62) / 2), y: 240 - 3 - 46, w: 62, h: 3 });
    expect(offsetForRect(text, 300, 150, 427, 240)).toEqual([-12 + (300 - 354), -22 + (150 - 205)]);
    expect(nearestAnchor({ x: 400, y: 220, w: 10, h: 10 }, 427, 240)).toBe("BOTTOM_RIGHT");
  });
  it("edits values in place (js and json)", () => {
    const js = setHudProp(HUD_JS, "js", 0, "x", -20);
    expect(js).toBe(HUD_JS.replace("x: -12,", "x: -20,"));
    const prim = setHudProp(HUD_JS, "js", 1, "@primary", "ammo");
    expect(prim).toContain(`hud.bar("ammo", {`);
    const json = setHudProp(HUD_JSON, "json", 0, "y", 10);
    expect(json).toBe(HUD_JSON.replace('"y": 4', '"y": 10'));
  });
  it("adds and removes elements in the file's own form", () => {
    const added = addHudElement(HUD_JS, "js", "TEXT", { text: "{fireMode}", anchor: "TOP_LEFT", x: 4, y: 4 });
    expect(added).toContain(`    hud.text("{fireMode}", { anchor: "TOP_LEFT", x: 4, y: 4 });`);
    expect(readHud(added, "js").elements).toHaveLength(3);
    const removed = removeHudElement(added, "js", 2);
    expect(removed).toBe(HUD_JS);
    const j = addHudElement(HUD_JSON, "json", "BAR", { value: "reloadProgress", width: 40, height: 2 });
    expect(readHud(j, "json").elements.map((e) => e.kind)).toEqual(["TEXT", "BAR"]);
  });
});

const ULTRON = `component(component => {
    component.console({ group: GROUP, defaultMode: "overlay" }, con => {
        con.theme({ background: "#0B0D12", accent: "#D91F3A", opacity: 0.86 });
        con.page("command", { label: "thematic.ultron.console.page.command", icon: "minecraft:iron_block" }, page => {
            page.window("command_window", { title: "t.command", x: 0.04, y: 0.08, w: 0.30, h: 0.62 }, win => {
                win.button("deploy", { label: "thematic.ultron.deploy", hotkey: "1" }, a => {
                    a.setFlag(HIVE_ON);
                    a.sound("thematic:ultron.legion_cutin", { volume: 0.8, world: true });
                });
                win.choice("formation", { label: "f", options: [{ id: "surround", label: "s" }] }, (a, option) => {});
            });
        });
        con.window("map_window", { title: "t.map", x: 0.36, y: 0.55, w: 0.33, h: 0.43, minimized: false }, win => {
            win.map("tactical", { label: "m", radius: 64 });
        });
    });
    component.wheel({ color: "#8A0F14", accent: "#FF3B30" }, wheel => {
        wheel.entry("ultron_deploy", { icon: "minecraft:iron_block", label: "thematic.ultron.deploy" }, pick => {});
        SLOTS.forEach(n => {
            wheel.entry("ultron_upload_" + n, { icon: "minecraft:observer" }, pick => upload(pick, n));
        });
    });
});`;

describe("console", () => {
  it("reads pages, windows, widgets, theme and wheel", () => {
    const m = readConsole(ULTRON)!;
    expect(m.pages.map((p) => p.id)).toEqual(["command"]);
    expect(m.windows.map((w) => [w.id, w.page, w.rect])).toEqual([
      ["command_window", "command", { x: 0.04, y: 0.08, w: 0.3, h: 0.62 }],
      ["map_window", undefined, { x: 0.36, y: 0.55, w: 0.33, h: 0.43 }],
    ]);
    expect(m.windows[0].widgets.map((w) => [w.kind, w.id])).toEqual([["button", "deploy"], ["choice", "formation"]]);
    expect(m.theme).toMatchObject({ background: "#0B0D12", opacity: 0.86 });
    expect(m.wheel!.entries.map((e) => [e.id, e.dynamic])).toEqual([["ultron_deploy", false], ['"ultron_upload_" + n', true]]);
  });
  it("moves a window and recolours the theme in place", () => {
    const moved = setConsoleProps(ULTRON, { t: "window", id: "map_window" }, { x: 0.4, y: 0.5 });
    expect(moved).toBe(ULTRON.replace("x: 0.36, y: 0.55", "x: 0.4, y: 0.5"));
    const themed = setConsoleProps(ULTRON, { t: "theme" }, { accent: "#00FF00", text: "#FFFFFF" });
    expect(themed).toContain(`con.theme({ background: "#0B0D12", accent: "#00FF00", opacity: 0.86, text: "#FFFFFF" });`);
    const w = setConsoleProps(ULTRON, { t: "widget", window: "command_window", id: "deploy" }, { hotkey: "9" });
    expect(w).toContain(`win.button("deploy", { label: "thematic.ultron.deploy", hotkey: "9" }`);
    expect(readConsole(themed)!.windows).toHaveLength(2);
  });
  it("derives the stock tokens like UiTokens", () => {
    const t = themeTokens({});
    expect(t.background).toBe("#0e1117");
    expect(t.accent).toBe("#58a6ff");
    expect(themeTokens({ accent: "#D91F3A" }).borderActive).toBe("#d91f3a");
    expect(clampRect({ x: 0.9, y: -0.2, w: 0.3, h: 0.4 })).toEqual({ x: 0.7, y: 0, w: 0.3, h: 0.4 });
  });
});

describe("suit + render sources", () => {
  const SUIT = `{
  "tier": 8,
  "abilities": [
    { "identifier": "hand_beam", "keybind": "key.thematic.ability_0", "assets": { "beam": { "endColor": "#32C932" } } },
    { "identifier": "flight", "keybind": "key.thematic.passive" }
  ],
  "flight_profile": "thematic:repulsor"
}
`;
  it("reads a suit and merges beam defaults", () => {
    const s = readSuit(SUIT);
    expect(s.abilities.map((a) => a.id)).toEqual(["hand_beam", "flight"]);
    expect(s.flightProfile).toBe("thematic:repulsor");
    expect(beamOf(s.abilities[0])).toMatchObject({ endColor: "#32C932", size: 0.025, thirdPersonTranslation: [0, 0, 0] });
  });
  it("writes a beam translation without touching the rest", () => {
    const out = setJson(SUIT, ["abilities", 0, "assets", "beam", "thirdPersonTranslation"], [0, -0.3, 0.4]);
    expect(readSuit(out).abilities[0].assets!.beam).toEqual({ endColor: "#32C932", thirdPersonTranslation: [0, -0.3, 0.4] });
    expect(out.split("\n")[1]).toBe(`  "tier": 8,`);
  });
  it("finds where an ability's renders come out of and moves one", () => {
    const js = `component(c => {
    c.visual("thematic:aim_arm", { emptyHand: true });
    c.visual("thematic:beam", { style: "model", from: "right_hand", when: "held" });
    c.phase("firing", f => f.every(e => e.beam({ effects: ["x"], from: { point: "eyes", offset: [0, -0.1, 0] } })));
});`;
    const src = readRenderSources(js);
    expect(src.map((s) => [s.method, s.kind, s.from.map((a) => a.point)])).toEqual([
      ["visual", "thematic:aim_arm", []], ["visual", "thematic:beam", ["right_hand"]], ["beam", undefined, ["eyes"]],
    ]);
    const moved = setRenderFrom(js, 1, { point: "right_hand", offset: [0, 0.1, 0] });
    expect(moved).toContain(`from: { point: "right_hand", offset: [0, 0.1, 0] }, when: "held"`);
    const added = setRenderFrom(js, 0, "eyes");
    expect(added).toContain(`c.visual("thematic:aim_arm", { emptyHand: true, from: "eyes" });`);
  });
});

describe("anchors", () => {
  it("parses every form and writes the shortest one back", () => {
    expect(parseAnchor("eyes")).toMatchObject({ kind: "point", point: "eyes" });
    expect(parseAnchor({ bone: "armorRightArm", offset: [0.35, 0.6, 0] })).toMatchObject({ kind: "bone", bone: "armorRightArm" });
    expect(parseAnchor("nope")).toBeNull();
    expect(anchorValue(parseAnchor("chest")!)).toBe("chest");
    expect(anchorValue({ ...parseAnchor("chest")!, offset: [0, 0.5, 0] })).toEqual({ point: "chest", offset: [0, 0.5, 0] });
  });
  it("places points like AnchorsClient and inverts drags", () => {
    const eyes = anchorFrame(parseAnchor("eyes")!);
    expect(eyes.origin[1]).toBeCloseTo(24 + 0.2275 * 16);
    const rh = anchorFrame(parseAnchor("right_hand")!);
    expect(rh.origin).toEqual([5.6, 9.6, 0]);
    expect(anchorFrame(parseAnchor("left_hand")!).origin[0]).toBe(-5.6);
    const a = { ...parseAnchor("eyes")!, offset: [0, 0, 0.5] as [number, number, number] };
    expect(anchorFrame(a).origin[2]).toBe(-8); // forward is -Z
    expect(offsetForSceneDelta(a, [16, 0, -16])).toEqual([1, 0, 1.5]);
    expect(jetPosition("rightFoot")).toEqual([0.12 * 16, 0.03 * 1.8 * 16, -0]);
  });
});

describe("guide + kinds", () => {
  it("parses markup like GuideMarkup", () => {
    const runs = parseMarkup("**Tier** {gold}9{/}\n- [Collection](thematic:x): *Marvel*");
    expect(runs.map((r) => [r.text, r.bold, r.italic, r.color, r.link])).toEqual([
      ["Tier", true, false, -1, null], [" ", false, false, -1, null], ["9", false, false, 0xffaa00, null], ["\n", false, false, -1, null],
      ["• ", false, false, -1, null], ["Collection", false, false, -1, "thematic:x"], [": ", false, false, -1, null], ["Marvel", false, true, -1, null],
    ]);
    expect(plainMarkup("a\nb **c**")).toBe("a b c");
  });
  it("classifies pack files", () => {
    expect(packKind("/r/src/packs/heroes/resources/data/thematic/armors/avengers/iron_man.json")).toBe("suit");
    expect(packKind("/r/data/thematic/abilities/ultron/hive_control.js")).toBe("ability");
    expect(packKind("/r/data/thematic/huds/gun_default.js")).toBe("hud");
    expect(packKind("/r/data/thematic/flight_profiles/repulsor.json")).toBe("flight");
    expect(packKind("/r/assets/thematic/guide/thematic/en_us/entries/suits/ultron.json")).toBe("guide");
    expect(guideKind("/r/assets/thematic/guide/thematic/en_us/categories/x.json")).toBe("category");
    expect(packKind("/r/data/thematic/recipe/x.json")).toBeNull();
    expect(packRoot("/r/res/data/thematic/armors/a.json")).toEqual({ root: "/r/res", side: "data", ns: "thematic" });
    expect(stem("/a/iron_man.json")).toBe("iron_man");
    expect(stem("/a/hive_control.js")).toBe("hive_control");
  });
});
