import { describe, expect, it } from "vitest";
import { effectiveBeam, fromHands, hexColor, layerOf, readBeamVisuals, setBeamOption, setSuitBeam, suitAbilityIndex, suitBeamOwn } from "./beam";

// The shape of Thematic's unibeam.js, reproduced here, never read from the repo.
const UNI = `component(component => {
    component.cooldown();
    component.visual("thematic:beam", { from: { point: "chest", offset: [0, 0, -0.384] }, when: { state: "firing" } });
    component.visual("thematic:aim_arm", { emptyHand: true });
});
`;

describe("readBeamVisuals", () => {
  it("finds only thematic:beam visuals, with their literal options and anchors", () => {
    const v = readBeamVisuals(UNI);
    expect(v).toHaveLength(1);
    expect(v[0].line).toBe(3);
    expect(v[0].opts.when).toEqual({ state: "firing" });
    expect(v[0].from[0].point).toBe("chest");
    expect(v[0].editable).toBe(true);
  });
  it("keeps expressions as read-only source", () => {
    const v = readBeamVisuals(`c.visual("thematic:beam", { scale: SCALE, length: tuned("x") + 1, count: 3 });`);
    expect(v[0].raw).toEqual({ scale: "SCALE", length: 'tuned("x") + 1' });
    expect(v[0].opts.count).toBe(3);
  });
  it("a visual with an options variable is not editable", () => {
    expect(readBeamVisuals(`c.visual("thematic:beam", OPTS);`)[0].editable).toBe(false);
  });
});

describe("setBeamOption", () => {
  it("adds a key to the literal, nothing else changes", () => {
    const out = setBeamOption(UNI, 0, "scale", 2.5);
    expect(out).toBe(UNI.replace(`when: { state: "firing" } }`, `when: { state: "firing" }, scale: 2.5 }`));
  });
  it("replaces an existing value in place", () => {
    const a = setBeamOption(UNI, 0, "scale", 2.5);
    expect(setBeamOption(a, 0, "scale", 4)).toBe(a.replace("scale: 2.5", "scale: 4"));
  });
  it("empty removes the key; the last key takes the object with it", () => {
    const a = setBeamOption(UNI, 0, "scale", 2.5);
    expect(setBeamOption(a, 0, "scale", undefined)).toBe(UNI);
    const solo = `c.visual("thematic:beam", { scale: 2 });`;
    expect(setBeamOption(solo, 0, "scale", undefined)).toBe(`c.visual("thematic:beam");`);
  });
  it("a visual without options gets an object; strings use the file's quotes", () => {
    expect(setBeamOption(`c.visual("thematic:beam");`, 0, "style", "cone")).toBe(`c.visual("thematic:beam", { style: "cone" });`);
    expect(setBeamOption(`c.visual('thematic:beam', { count: 1 });`, 0, "style", "cone")).toBe(`c.visual('thematic:beam', { count: 1, style: 'cone' });`);
  });
  it("targets the n-th beam visual", () => {
    const two = `c.visual("thematic:beam", { a: 1 });\nc.visual("thematic:beam", { b: 2 });`;
    expect(setBeamOption(two, 1, "scale", 3)).toBe(`c.visual("thematic:beam", { a: 1 });\nc.visual("thematic:beam", { b: 2, scale: 3 });`);
  });
  it("leaves a non-literal options argument alone", () => {
    const t = `c.visual("thematic:beam", OPTS);`;
    expect(setBeamOption(t, 0, "scale", 2)).toBe(t);
  });
  it("multiline literals get the key on its own line", () => {
    const t = `c.visual("thematic:beam", {\n    from: "chest",\n    when: "held",\n});`;
    expect(setBeamOption(t, 0, "scale", 2)).toBe(`c.visual("thematic:beam", {\n    from: "chest",\n    when: "held",\n    scale: 2,\n});`);
  });
});

const SUIT = `{
  "tier": 8,
  "abilities": [
    {"identifier": "flight"},
    {"identifier": "unibeam", "keybind": "key.thematic.ability_0", "assets": {"beam": {"startColor": "#FFFFFF", "endColor": "#00AAFF", "size": 0.05}}}
  ]
}`;

describe("suit layer", () => {
  it("finds the ability entry however the id is written", () => {
    expect(suitAbilityIndex(SUIT, "thematic", "unibeam")).toBe(1);
    expect(suitAbilityIndex(SUIT.replace('"unibeam"', '"thematic:unibeam"'), "thematic", "unibeam")).toBe(1);
    expect(suitAbilityIndex(SUIT, "my_pack", "unibeam")).toBe(-1);
    expect(suitAbilityIndex("{", "thematic", "unibeam")).toBe(-1);
  });
  it("edits one assets.beam key, the rest of the file stays", () => {
    const out = setSuitBeam(SUIT, 1, "glowSize", 0.4);
    expect(JSON.parse(out).abilities[1].assets.beam).toEqual({ startColor: "#FFFFFF", endColor: "#00AAFF", size: 0.05, glowSize: 0.4 });
    expect(out.startsWith(`{\n  "tier": 8,\n  "abilities": [\n    {"identifier": "flight"},`)).toBe(true);
    expect(suitBeamOwn(out, 1).glowSize).toBe(0.4);
  });
  it("creates assets.beam when the entry has none, and removes it again when emptied", () => {
    const a = setSuitBeam(SUIT, 0, "size", 0.1);
    expect(JSON.parse(a).abilities[0]).toEqual({ identifier: "flight", assets: { beam: { size: 0.1 } } });
    const b = setSuitBeam(a, 0, "size", undefined);
    expect(JSON.parse(b).abilities[0]).toEqual({ identifier: "flight" });
  });
  it("removing one key keeps the others", () => {
    const out = setSuitBeam(SUIT, 1, "size", undefined);
    expect(JSON.parse(out).abilities[1].assets.beam).toEqual({ startColor: "#FFFFFF", endColor: "#00AAFF" });
  });
});

describe("effectiveBeam", () => {
  const suit = { endColor: "#00AAFF", size: 0.05 };
  it("visual option beats the suit beats the default", () => {
    const e = effectiveBeam({ size: 0.1, scale: 2 }, suit, false);
    expect(e.size).toEqual({ value: 0.1, layer: "visual" });
    expect(e.glowColor).toEqual({ value: "#00AAFF", layer: "suit" });
    expect(e.glowSize).toEqual({ value: 0.25, layer: "default" });
    expect(e.count).toEqual({ value: 2, layer: "default" });
    expect(e.coreColor.value).toBe("#FFFFFF");
  });
  it("the suit layer only applies to the options the docs say fall back to it", () => {
    expect(effectiveBeam({}, { size: 0.5 }, false).scale.layer).toBe("default");
    expect(layerOf("scale", {}, { scale: 3 })).toBe("default");
    expect(layerOf("size", {}, { size: 0.5 })).toBe("suit");
    expect(layerOf("size", { size: 1 }, { size: 0.5 })).toBe("visual");
  });
  it("length defaults by style: layered 80, cylinder 15, cone 30, filament 64; hands default to a cylinder", () => {
    expect(effectiveBeam({}, undefined, false).length.value).toBe(80);
    expect(effectiveBeam({}, undefined, true).style.value).toBe("cylinder");
    expect(effectiveBeam({}, undefined, true).length.value).toBe(15);
    expect(effectiveBeam({ style: "cone" }, undefined, false).length.value).toBe(30);
    expect(effectiveBeam({ style: "filament" }, undefined, false).length.value).toBe(64);
  });
  it("scale multiplies width and length (a filament only thickens), the drawn length is capped", () => {
    const a = effectiveBeam({ scale: 2, style: "cylinder", size: 0.05 }, undefined, false);
    expect(a.drawn.radius).toBeCloseTo(0.1);
    expect(a.drawn.full).toBe(30);
    expect(a.drawn.length).toBe(15);
    expect(a.drawn.cut).toBe(true);
    const b = effectiveBeam({ scale: 0.5, style: "cylinder" }, undefined, false);
    expect(b.drawn.full).toBe(7.5);
    expect(b.drawn.cut).toBe(false);
    expect(effectiveBeam({ scale: 2, style: "filament", length: 10 }, undefined, false).drawn.full).toBe(10);
  });
  it("colours may be ints or hex with alpha", () => {
    expect(hexColor(16711680)).toBe("#FF0000");
    expect(hexColor("#80ff8800")).toBe("#FF8800");
    expect(hexColor("red")).toBeNull();
    expect(effectiveBeam({ color: 255 }, undefined, false).glowColor).toEqual({ value: "#0000FF", layer: "visual" });
  });
  it("fromHands", () => {
    expect(fromHands([{ kind: "point", point: "right_hand", offset: [0, 0, 0], relative: "facing" }])).toBe(true);
    expect(fromHands([])).toBe(false);
  });
});
