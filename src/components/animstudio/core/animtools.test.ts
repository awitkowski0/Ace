import { describe, expect, it } from "vitest";
import {
  addMarker, addToComp, bakeAnimation, bezierAt, deleteMarker, flipAnimation, getAnimation, mapKeyValues, offsetKeys, scaleKeyValues, getBb, getMarkers, mirrorKeys, moveMarker, parseDoc, patchKeyframes, sampleChannelRaw,
  scaleAnimation, serialize, setBezierHandles, setKeyInterpolation, setMarker, type Doc, type KeyRef,
} from "./index";

const near = (a: readonly number[] | undefined, b: readonly number[], d = 6) => {
  expect(a).toBeDefined();
  b.forEach((x, i) => expect(a![i]).toBeCloseTo(x, d));
};

// ---------------------------------------------------------------- fixtures
const kf = (uuid: string, channel: string, time: number, v: number[], extra: Record<string, unknown> = {}) => ({
  channel, data_points: [{ x: String(v[0]), y: String(v[1]), z: String(v[2]) }], uuid, time, color: -1, interpolation: "linear", ...extra,
});
const BZ = (rt: number[], rv: number[], lt: number[], lv: number[]) => ({ bezier_linked: true, bezier_left_time: lt, bezier_left_value: lv, bezier_right_time: rt, bezier_right_value: rv });
const bbmodel = (pretty: boolean) => {
  const o = {
    meta: { format_version: "4.10", model_format: "free", box_uv: false }, name: "m", resolution: { width: 16, height: 16 },
    elements: [],
    outliner: [
      { name: "leftArm", origin: [0, 0, 0], uuid: "g-l", children: [] },
      { name: "rightArm", origin: [0, 0, 0], uuid: "g-r", children: [] },
      { name: "head", origin: [0, 0, 0], uuid: "g-h", children: [] },
    ],
    textures: [],
    animations: [
      {
        uuid: "a1", name: "wave", loop: "once", override: false, length: 1, snapping: 20,
        animators: {
          "g-h": {
            name: "head", type: "bone",
            keyframes: [
              kf("h1", "rotation", 0, [0, 0, 0], { interpolation: "bezier", ...BZ([0.3, 0.3, 0.3], [10, 10, 10], [-0.3, -0.3, -0.3], [-10, -10, -10]) }),
              kf("h2", "rotation", 1, [0, 0, 0], { interpolation: "bezier", ...BZ([0.3, 0.3, 0.3], [0, 0, 0], [-0.3, -0.3, -0.3], [0, 0, 0]) }),
              kf("h3", "position", 0, [1, 2, 3]),
            ],
          },
          "g-l": { name: "leftArm", type: "bone", keyframes: [kf("l1", "rotation", 0, [10, 20, 30]), kf("l2", "rotation", 0.5, [0, 5, 0]), kf("l3", "position", 0.5, [1, 2, 3]), kf("l4", "scale", 0.5, [2, 1, 1])] },
        },
      },
    ],
  };
  return pretty ? JSON.stringify(o, null, 2) + "\n" : JSON.stringify(o);
};
const ANIM = `{
\t"format_version": "1.8.0",
\t"animations": {
\t\t"t": {
\t\t\t"animation_length": 1.0,
\t\t\t"bones": {
\t\t\t\t"armorLeftArm": {
\t\t\t\t\t"rotation": { "0.0": [10, 20, 30], "0.5": { "post": [0, 5, 0], "lerp_mode": "catmullrom" }, "1.0": [10, 0, 0] },
\t\t\t\t\t"position": { "0.0": [1, 2, 3], "0.5": [0, 0, 0] }
\t\t\t\t},
\t\t\t\t"armorRightArm": { "rotation": [0, 0, 0] },
\t\t\t\t"armorHead": {
\t\t\t\t\t"rotation": { "0.0": [0, 0, 0], "0.5": { "vector": [30, 0, 0], "easing": "easeInOutSine" }, "1.0": [0, 0, 0] },
\t\t\t\t\t"scale": [1, 2, 3]
\t\t\t\t}
\t\t\t}
\t\t}
\t}
}
`;
const jdoc = () => parseDoc(ANIM, "animation");
const bdoc = (pretty = true) => parseDoc(bbmodel(pretty), "bbmodel");
const keysOf = (d: Doc, bone: string, ch: "rotation" | "position" | "scale", anim = getAnimation(d, "t") ? "t" : "wave") => getAnimation(d, anim)!.bones.get(bone)![ch]!.keys;

describe("bezier keyframes", () => {
  it("bezierAt: x-linear handles reduce to a Bernstein polynomial", () => {
    // P0=(0,0) P1=(1/3,10) P2=(2/3,0) P3=(1,10): x(u)=u, y(0.25)=4.375, y(0.5)=5
    expect(bezierAt(0, 1, 0.25, 0, 10, 1 / 3, 10, -1 / 3, -10)).toBeCloseTo(4.375, 6);
    expect(bezierAt(0, 1, 0.5, 0, 10, 1 / 3, 10, -1 / 3, -10)).toBeCloseTo(5, 6);
    // symmetric ease: midpoint is 5, quarter point is below linear
    expect(bezierAt(0, 1, 0.5, 0, 10, 0.1, 0, -0.1, 0)).toBeCloseTo(5, 6);
    expect(bezierAt(0, 1, 0.25, 0, 10, 0.1, 0, -0.1, 0)).toBeLessThan(2.5);
    expect(bezierAt(0, 2, 5, 3, 7, 0.1, 0, -0.1, 0)).toBe(7);
    // handle times outside the segment are clamped (no NaN / non-monotonic blowups)
    expect(Number.isFinite(bezierAt(0, 1, 0.3, 0, 1, 5, 0, -5, 0))).toBe(true);
  });

  it("reads handles from the file and samples the segment", () => {
    const a = getAnimation(bdoc(), "wave")!;
    const k = a.bones.get("head")!.rotation!.keys[0];
    expect(k.bezier).toEqual({ linked: true, leftTime: [-0.3, -0.3, -0.3], leftValue: [-10, -10, -10], rightTime: [0.3, 0.3, 0.3], rightValue: [10, 10, 10] });
    const c = a.bones.get("head")!.rotation!;
    // P0=(0,0) P1=(.3,10) P2=(.7,0) P3=(1,0): at t=.5 x(.5)=.5 -> y = (0+30+0+0)/8 = 3.75
    near(sampleChannelRaw(c, 0.5), [3.75, 3.75, 3.75]);
    near(sampleChannelRaw(c, 0), [0, 0, 0]);
    near(sampleChannelRaw(c, 1), [0, 0, 0]);
    // a non-bezier channel is untouched by the new code
    near(sampleChannelRaw(a.bones.get("leftArm")!.rotation!, 0.25), [5, 12.5, 15]);
  });

  it("setKeyInterpolation writes interpolation + default handles; bezier on animation.json throws", () => {
    const d = bdoc();
    const ref: KeyRef = { bone: "leftArm", channel: "rotation", time: 0 };
    const d1 = setKeyInterpolation(d, { anim: "wave", keys: [ref], interpolation: "bezier" });
    const k = getAnimation(d1, "wave")!.bones.get("leftArm")!.rotation!.keys[0];
    expect(k.bb!.interpolation).toBe("bezier");
    expect(k.bezier).toEqual({ linked: true, leftTime: [-0.1, -0.1, -0.1], leftValue: [0, 0, 0], rightTime: [0.1, 0.1, 0.1], rightValue: [0, 0, 0] });
    const j = JSON.parse(serialize(d1));
    const kj = j.animations[0].animators["g-l"].keyframes[0];
    expect(kj.interpolation).toBe("bezier");
    expect(kj.bezier_right_time).toEqual([0.1, 0.1, 0.1]);
    expect(kj.bezier_linked).toBe(true);
    // back to linear / catmullrom / step
    const d2 = setKeyInterpolation(d1, { anim: "wave", keys: [ref], interpolation: "linear" });
    expect(JSON.parse(serialize(d2)).animations[0].animators["g-l"].keyframes[0].interpolation).toBe("linear");
    const d3 = setKeyInterpolation(d, { anim: "wave", keys: [ref], interpolation: "catmullrom" });
    expect(JSON.parse(serialize(d3)).animations[0].animators["g-l"].keyframes[0].interpolation).toBe("catmullrom");
    const d4 = setKeyInterpolation(d, { anim: "wave", keys: [ref], interpolation: "step" });
    expect(JSON.parse(serialize(d4)).animations[0].animators["g-l"].keyframes[0].interpolation).toBe("step");
    expect(setKeyInterpolation(d, { anim: "wave", keys: [ref], interpolation: "linear" })).toBe(d);
    expect(() => setKeyInterpolation(jdoc(), { anim: "t", keys: [], interpolation: "bezier" })).toThrow("Bezier is baked on export; use bakeAnimation");
  });

  it("setKeyInterpolation on animation.json maps to lerp_mode / easing", () => {
    const d = jdoc();
    const ref: KeyRef = { bone: "armorLeftArm", channel: "position", time: 0 };
    const c = setKeyInterpolation(d, { anim: "t", keys: [ref], interpolation: "catmullrom" });
    expect(keysOf(c, "armorLeftArm", "position")[0].lerp).toBe("catmullrom");
    expect(serialize(c)).toContain('"lerp_mode": "catmullrom"');
    const s = setKeyInterpolation(d, { anim: "t", keys: [ref], interpolation: "step" });
    expect(keysOf(s, "armorLeftArm", "position")[0].easing).toBe("step");
    const l = setKeyInterpolation(c, { anim: "t", keys: [ref], interpolation: "linear" });
    expect(keysOf(l, "armorLeftArm", "position")[0].lerp).toBeUndefined();
    const mid: KeyRef = { bone: "armorLeftArm", channel: "rotation", time: 0.5 };
    expect(keysOf(setKeyInterpolation(d, { anim: "t", keys: [mid], interpolation: "linear" }), "armorLeftArm", "rotation")[1].lerp).toBeUndefined();
    expect(setKeyInterpolation(d, { anim: "t", keys: [ref], interpolation: "linear" })).toBe(d);
  });

  it("setBezierHandles keeps linked handles mirrored and round-trips", () => {
    const d = bdoc();
    const ref: KeyRef = { bone: "head", channel: "rotation", time: 0 };
    const d1 = setBezierHandles(d, { anim: "wave", key: ref, patch: { rightTime: [0.2, 0.2, 0.2], rightValue: [1, 2, 3] } });
    const k = getAnimation(parseDoc(serialize(d1), "bbmodel"), "wave")!.bones.get("head")!.rotation!.keys[0];
    expect(k.bezier!.leftTime).toEqual([-0.2, -0.2, -0.2]);
    expect(k.bezier!.leftValue).toEqual([-1, -2, -3]);
    expect(k.bezier!.rightValue).toEqual([1, 2, 3]);
    const d2 = setBezierHandles(d1, { anim: "wave", key: ref, patch: { linked: false } });
    const d3 = setBezierHandles(d2, { anim: "wave", key: ref, patch: { leftTime: [-0.05, -0.05, -0.05] } });
    const k3 = getAnimation(d3, "wave")!.bones.get("head")!.rotation!.keys[0];
    expect(k3.bezier!.linked).toBe(false);
    expect(k3.bezier!.rightTime).toEqual([0.2, 0.2, 0.2]);
    expect(setBezierHandles(d1, { anim: "wave", key: ref, patch: { rightTime: [0.2, 0.2, 0.2] } })).toBe(d1);
    expect(() => setBezierHandles(jdoc(), { anim: "t", key: ref, patch: {} })).toThrow();
  });
});

describe("bakeAnimation", () => {
  it("full bake produces grid keys that sample like the original (json)", () => {
    const d = jdoc();
    const orig = getAnimation(d, "t")!;
    const b = bakeAnimation(d, { anim: "t", step: 0.125 });
    const baked = getAnimation(b, "t")!;
    for (const bone of ["armorHead", "armorLeftArm"] as const) {
      const rot = baked.bones.get(bone)!.rotation!.keys;
      expect(rot.map((k) => k.time)).toEqual([0, 0.125, 0.25, 0.375, 0.5, 0.625, 0.75, 0.875, 1]);
      expect(rot.every((k) => !k.easing && !k.lerp)).toBe(true);
      for (const k of rot) near(sampleChannelRaw(baked.bones.get(bone)!.rotation!, k.time), sampleChannelRaw(orig.bones.get(bone)!.rotation!, k.time)!);
      // linear interpolation between the baked keys equals the sampled value at the midpoints of the grid too (within the curve error)
    }
    // single-key / constant channels stay as they were
    expect(serialize(b)).toContain('"armorRightArm": { "rotation": [0, 0, 0] }');
    // restricting bones
    const only = bakeAnimation(d, { anim: "t", step: 0.25, bones: ["armorHead"] });
    expect(keysOf(only, "armorHead", "rotation").length).toBe(5);
    expect(keysOf(only, "armorLeftArm", "rotation").length).toBe(3);
    // idempotent
    expect(bakeAnimation(b, { anim: "t", step: 0.125 })).toBe(b);
    // onlyBezier does nothing on animation.json
    expect(bakeAnimation(d, { anim: "t", onlyBezier: true })).toBe(d);
    expect(() => bakeAnimation(d, { anim: "t", step: 0 })).toThrow();
  });

  it("bbmodel: onlyBezier bakes the bezier segment only; sampling matches on the grid", () => {
    const d = bdoc();
    const o = getAnimation(d, "wave")!;
    const b = bakeAnimation(d, { anim: "wave", step: 0.1, onlyBezier: true });
    const ba = getAnimation(b, "wave")!;
    const ks = ba.bones.get("head")!.rotation!.keys;
    expect(ks.map((k) => k.time)).toEqual([0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1]);
    expect(ks.every((k) => k.bb!.interpolation === "linear")).toBe(true);
    for (const k of ks) near(sampleChannelRaw(ba.bones.get("head")!.rotation!, k.time), sampleChannelRaw(o.bones.get("head")!.rotation!, k.time)!, 5);
    // non-bezier channels are not touched
    expect(ba.bones.get("leftArm")!.rotation!.keys.length).toBe(2);
    expect(serialize(bakeAnimation(b, { anim: "wave", onlyBezier: true }))).toBe(serialize(b));
    const full = bakeAnimation(d, { anim: "wave", step: 0.25 });
    expect(getAnimation(full, "wave")!.bones.get("leftArm")!.rotation!.keys.map((k) => k.time)).toEqual([0, 0.25, 0.5]);
    JSON.parse(serialize(full));
  });
});

describe("scaleAnimation", () => {
  it("scales key times and length (json)", () => {
    const s = scaleAnimation(jdoc(), { anim: "t", factor: 2 });
    expect(keysOf(s, "armorLeftArm", "rotation").map((k) => k.time)).toEqual([0, 1, 2]);
    expect(getAnimation(s, "t")!.length).toBe(2);
    expect(serialize(s)).toContain('"animation_length": 2');
    const same = jdoc();
    expect(scaleAnimation(same, { anim: "t", factor: 1 })).toBe(same);
    const half = scaleAnimation(jdoc(), { anim: "t", factor: 0.3333 });
    expect(keysOf(half, "armorHead", "rotation").map((k) => k.time)).toEqual([0, 0.1667, 0.3333]);
  });
  it("scales bbmodel keys, bezier handle times and markers", () => {
    let d = addMarker(bdoc(), { anim: "wave", time: 0.5, color: 2 });
    d = scaleAnimation(d, { anim: "wave", factor: 2 });
    const a = getAnimation(d, "wave")!;
    expect(a.length).toBe(2);
    expect(a.bones.get("head")!.rotation!.keys[1].time).toBe(2);
    expect(a.bones.get("head")!.rotation!.keys[0].bezier!.rightTime).toEqual([0.6, 0.6, 0.6]);
    expect(getMarkers(d, "wave")).toEqual([{ color: 2, time: 1 }]);
  });
});

describe("flipAnimation / mirrorKeys", () => {
  it("flip x negates position.x and rotation y/z, scale unchanged", () => {
    const f = flipAnimation(jdoc(), { anim: "t", axis: "x" });
    near(keysOf(f, "armorLeftArm", "rotation")[0].value as number[], [10, -20, -30]);
    near(keysOf(f, "armorLeftArm", "position")[0].value as number[], [-1, 2, 3]);
    near(keysOf(f, "armorHead", "scale")[0].value as number[], [1, 2, 3]);
    near(keysOf(f, "armorLeftArm", "rotation")[1].value as number[], [0, -5, 0]);
    expect(keysOf(f, "armorLeftArm", "rotation")[1].lerp).toBe("catmullrom");
    const y = flipAnimation(jdoc(), { anim: "t", axis: "y" });
    near(keysOf(y, "armorLeftArm", "rotation")[0].value as number[], [-10, 20, -30]);
    near(keysOf(y, "armorLeftArm", "position")[0].value as number[], [1, -2, 3]);
    const z = flipAnimation(jdoc(), { anim: "t", axis: "z" });
    near(keysOf(z, "armorLeftArm", "rotation")[0].value as number[], [-10, -20, 30]);
    near(keysOf(z, "armorLeftArm", "position")[0].value as number[], [1, 2, -3]);
    // flip twice = identity values
    const ff = flipAnimation(f, { anim: "t", axis: "x" });
    near(keysOf(ff, "armorLeftArm", "rotation")[0].value as number[], [10, 20, 30]);
  });
  it("swapSides exchanges left and right bones", () => {
    const f = flipAnimation(jdoc(), { anim: "t", axis: "x", swapSides: true });
    const a = getAnimation(f, "t")!;
    near(a.bones.get("armorRightArm")!.rotation!.keys[0].value as number[], [10, -20, -30]);
    expect(a.bones.get("armorRightArm")!.rotation!.keys.length).toBe(3);
    near(a.bones.get("armorRightArm")!.position!.keys[0].value as number[], [-1, 2, 3]);
    // old right arm was a constant [0,0,0] -> now on the left bone
    expect(a.bones.get("armorLeftArm")!.rotation!.keys.length).toBe(1);
    expect(a.bones.get("armorLeftArm")!.position).toBeUndefined();
    expect(JSON.parse(serialize(f)).animations.t.bones.armorLeftArm.position).toBeUndefined();
  });
  it("bbmodel flip: rotation, handles and swap", () => {
    const f = flipAnimation(bdoc(), { anim: "wave", axis: "x" });
    const a = getAnimation(f, "wave")!;
    near(a.bones.get("leftArm")!.rotation!.keys[0].value as number[], [10, -20, -30]);
    near(a.bones.get("head")!.position!.keys[0].value as number[], [-1, 2, 3]);
    expect(a.bones.get("head")!.rotation!.keys[0].bezier!.rightValue).toEqual([10, -10, -10]);
    const s = flipAnimation(bdoc(), { anim: "wave", axis: "x", swapSides: true });
    const sa = getAnimation(s, "wave")!;
    near(sa.bones.get("rightArm")!.rotation!.keys[0].value as number[], [10, -20, -30]);
    expect(sa.bones.get("leftArm")?.rotation).toBeUndefined();
    const m = getBb(s).animations[0].animators.map((x) => x.key).sort();
    expect(m).toEqual(["g-h", "g-l", "g-r"]);
    JSON.parse(serialize(s));
  });
  it("mirrorKeys writes the X-mirrored key on the counterpart bone", () => {
    const r = mirrorKeys(jdoc(), { anim: "t", keys: [{ bone: "armorLeftArm", channel: "rotation", time: 0 }, { bone: "armorHead", channel: "rotation", time: 0 }] });
    expect(r.added).toEqual([{ bone: "armorRightArm", channel: "rotation", time: 0 }]);
    const ks = keysOf(r.doc, "armorRightArm", "rotation");
    expect(ks.length).toBe(1);
    near(ks[0].value as number[], [10, -20, -30]);
    const b = mirrorKeys(bdoc(), { anim: "wave", keys: [{ bone: "leftArm", channel: "rotation", time: 0.5 }, { bone: "leftArm", channel: "position", time: 0.5 }] });
    expect(b.added.length).toBe(2);
    const ba = getAnimation(b.doc, "wave")!;
    near(ba.bones.get("rightArm")!.rotation!.keys[0].value as number[], [0, -5, 0]);
    near(ba.bones.get("rightArm")!.position!.keys[0].value as number[], [-1, 2, 3]);
    const uu = getBb(b.doc).animations[0].animators.flatMap((an) => (getBb(b.doc).animations[0].node && an.node ? (JSON.parse(serialize(b.doc)).animations[0].animators[an.key].keyframes as Array<{ uuid: string }>).map((k) => k.uuid) : []));
    expect(new Set(uu).size).toBe(uu.length);
  });
});

describe("markers", () => {
  it("add / move / set / delete round-trip byte-identically", () => {
    for (const pretty of [true, false]) {
      const d = bdoc(pretty);
      const text = serialize(d);
      let m = addMarker(d, { anim: "wave", time: 0.5, color: 3, name: "hit" });
      m = addMarker(m, { anim: "wave", time: 0.2 });
      expect(getMarkers(m, "wave")).toEqual([{ color: 3, time: 0.5, name: "hit" }, { color: 0, time: 0.2 }]);
      const j = JSON.parse(serialize(m)).animations[0];
      expect(Object.keys(j).indexOf("markers")).toBeLessThan(Object.keys(j).indexOf("animators"));
      m = moveMarker(m, { anim: "wave", index: 1, time: 0.75 });
      m = setMarker(m, { anim: "wave", index: 0, patch: { color: 5, name: "slam" } });
      expect(getMarkers(m, "wave")).toEqual([{ color: 5, time: 0.5, name: "slam" }, { color: 0, time: 0.75 }]);
      expect(setMarker(m, { anim: "wave", index: 0, patch: { color: 5 } })).toBe(m);
      m = setMarker(m, { anim: "wave", index: 0, patch: { name: null } });
      expect(getMarkers(m, "wave")[0]).toEqual({ color: 5, time: 0.5 });
      m = deleteMarker(m, { anim: "wave", index: 0 });
      m = deleteMarker(m, { anim: "wave", index: 0 });
      expect(getMarkers(m, "wave")).toEqual([]);
      expect(serialize(m)).toBe(text);
      expect(() => deleteMarker(m, { anim: "wave", index: 0 })).toThrow();
    }
  });
  it("non-bbmodel docs: getMarkers is empty, commands throw", () => {
    expect(getMarkers(jdoc(), "t")).toEqual([]);
    expect(() => addMarker(jdoc(), { anim: "t", time: 0 })).toThrow("markers are stored in .bbmodel files only");
    expect(() => moveMarker(jdoc(), { anim: "t", index: 0, time: 0 })).toThrow("markers are stored in .bbmodel files only");
    expect(() => setMarker(jdoc(), { anim: "t", index: 0, patch: {} })).toThrow("markers are stored in .bbmodel files only");
    expect(() => deleteMarker(jdoc(), { anim: "t", index: 0 })).toThrow("markers are stored in .bbmodel files only");
  });
});

describe("multi-key value edits (offsetKeys / scaleKeyValues / mapKeyValues)", () => {
  const R = (bone: string, time: number): KeyRef => ({ bone, channel: "rotation", time });
  const P = (bone: string, time: number): KeyRef => ({ bone, channel: "position", time });
  const vals = (d: Doc, bone: string, ch: "rotation" | "position" | "scale") => keysOf(d, bone, ch).map((k) => [...k.value]);

  it("offsetKeys adds the delta to each key's OWN value, only on the given channels and only on selected keys", () => {
    const d = jdoc();
    const out = offsetKeys(d, { anim: "t", keys: [R("armorLeftArm", 0), R("armorLeftArm", 0.5), R("armorHead", 0.5), P("armorLeftArm", 0)], delta: { rotation: [10, 0, 0] } });
    expect(vals(out, "armorLeftArm", "rotation")).toEqual([[20, 20, 30], [10, 5, 0], [10, 0, 0]]);
    expect(vals(out, "armorHead", "rotation")).toEqual([[0, 0, 0], [40, 0, 0], [0, 0, 0]]);
    expect(vals(out, "armorLeftArm", "position")).toEqual(vals(d, "armorLeftArm", "position")); // position delta not given
    expect(keysOf(out, "armorLeftArm", "rotation")[1].lerp).toBe("catmullrom"); // other key props survive
  });
  it("offsetKeys: per-channel deltas, zero/empty deltas are a no-op that returns the same doc", () => {
    const d = jdoc();
    const keys = [R("armorLeftArm", 0), P("armorLeftArm", 0)];
    const out = offsetKeys(d, { anim: "t", keys, delta: { rotation: [0, 5, 0], position: [1, 1, 1] } });
    expect(vals(out, "armorLeftArm", "rotation")[0]).toEqual([10, 25, 30]);
    expect(vals(out, "armorLeftArm", "position")[0]).toEqual([2, 3, 4]);
    expect(offsetKeys(d, { anim: "t", keys, delta: {} })).toBe(d);
    expect(offsetKeys(d, { anim: "t", keys, delta: { rotation: [0, 0, 0] } })).toBe(d);
    expect(offsetKeys(d, { anim: "t", keys: [], delta: { rotation: [1, 1, 1] } })).toBe(d);
  });
  it("offsetKeys moves pre AND post of split keys; molang components become (expr)+n; undo-style round trip is exact", () => {
    let d = jdoc();
    d = patchKeyframes(d, { anim: "t", keys: [R("armorLeftArm", 0)], patch: { pre: [1, 2, 3], value: ["math.sin(query.anim_time)", 0, 0] } });
    const out = offsetKeys(d, { anim: "t", keys: [R("armorLeftArm", 0)], delta: { rotation: [5, 5, 5] } });
    const k = keysOf(out, "armorLeftArm", "rotation")[0];
    expect(k.value).toEqual(["(math.sin(query.anim_time))+5", 5, 5]);
    expect(k.pre).toEqual([6, 7, 8]);
    const back = offsetKeys(out, { anim: "t", keys: [R("armorLeftArm", 0)], delta: { rotation: [-5, -5, -5] } });
    expect(keysOf(back, "armorLeftArm", "rotation")[0].pre).toEqual([1, 2, 3]);
  });
  it("offsetKeys rounds to 4 decimals and is a minimal text edit (one line changes per touched key)", () => {
    const d = jdoc();
    const out = offsetKeys(d, { anim: "t", keys: [R("armorHead", 0.5)], delta: { rotation: [0.1 + 0.2, 0, 0] } });
    expect(keysOf(out, "armorHead", "rotation")[1].value[0]).toBe(30.3);
    const a = serialize(d).split("\n"), b = serialize(out).split("\n");
    expect(b.length).toBe(a.length);
    expect(b.filter((l, i) => l !== a[i]).length).toBe(1);
  });
  it("offsetKeys works across bones in a bbmodel (several animators, one commit)", () => {
    const d = bdoc();
    const out = offsetKeys(d, { anim: "wave", keys: [R("leftArm", 0), R("leftArm", 0.5)], delta: { rotation: [10, 10, 10] } });
    expect(vals(out, "leftArm", "rotation")).toEqual([[20, 30, 40], [10, 15, 10]]);
    expect(vals(out, "head", "rotation")).toEqual(vals(d, "head", "rotation"));
  });
  it("scaleKeyValues around zero multiplies values; factor 1 or NaN returns the same doc", () => {
    const d = jdoc();
    const keys = [R("armorLeftArm", 0), R("armorHead", 0.5)];
    const out = scaleKeyValues(d, { anim: "t", keys, factor: 2 });
    expect(vals(out, "armorLeftArm", "rotation")[0]).toEqual([20, 40, 60]);
    expect(vals(out, "armorHead", "rotation")[1]).toEqual([60, 0, 0]);
    expect(vals(out, "armorHead", "rotation")[0]).toEqual([0, 0, 0]);
    expect(scaleKeyValues(d, { anim: "t", keys, factor: 1 })).toBe(d);
    expect(scaleKeyValues(d, { anim: "t", keys, factor: NaN })).toBe(d);
  });
  it("scaleKeyValues around the average keeps the mean and scales the spread (per channel and axis)", () => {
    const d = jdoc();
    // x values of armorLeftArm rotation @0 / @1.0 head... use two keys on one channel: x = 10 and 10 (arm @0, @1.0) -> unchanged mean
    const keys = [R("armorLeftArm", 0), R("armorLeftArm", 1)];
    let d2 = patchKeyframes(d, { anim: "t", keys: [R("armorLeftArm", 1)], patch: { value: [30, 0, 0] } });
    const out = scaleKeyValues(d2, { anim: "t", keys, factor: 2, pivot: "average" });
    // x: 10 and 30 -> mean 20, spread doubled -> 0 and 40
    expect(vals(out, "armorLeftArm", "rotation")[0][0]).toBe(0);
    expect(vals(out, "armorLeftArm", "rotation")[2][0]).toBe(40);
    expect(vals(out, "armorLeftArm", "rotation")[1]).toEqual(vals(d2, "armorLeftArm", "rotation")[1]); // unselected key untouched
    d2 = out;
  });
  it("mapKeyValues: channel filter + which=pre", () => {
    let d = jdoc();
    d = patchKeyframes(d, { anim: "t", keys: [R("armorLeftArm", 0)], patch: { pre: [1, 1, 1] } });
    const keys = [R("armorLeftArm", 0), P("armorLeftArm", 0)];
    const out = mapKeyValues(d, { anim: "t", keys, channel: "rotation", which: "pre", map: (c) => (typeof c === "number" ? c + 100 : c) });
    expect(keysOf(out, "armorLeftArm", "rotation")[0].pre).toEqual([101, 101, 101]);
    expect(keysOf(out, "armorLeftArm", "rotation")[0].value).toEqual([10, 20, 30]);
    expect(vals(out, "armorLeftArm", "position")).toEqual(vals(d, "armorLeftArm", "position"));
    expect(addToComp(3, 0)).toBe(3);
    expect(addToComp("q", -2)).toBe("(q)-2");
  });
});
