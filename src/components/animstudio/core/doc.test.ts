import { describe, expect, it } from "vitest";
import {
  addAnimation, addBone, addCube, addKeyframe, deleteAnimation, deleteBone, deleteCube, deleteKeyframes, duplicateAnimation, getAnimation, getGeo,
  moveCube, minimalEdit, moveKeyframes, parseDoc, renameAnimation, renameBone, reparentBone, resizeCube, serialize, setCube, setInflate, setKeyEasing,
  setKeyLerp, setKeyPrePost, setKeyValue, setLength, setLoop, setMirror, setPivot, setRotation, setUv, snapKeysToTicks, retimeKeyframe,
} from "./doc";

const ANIM = `{
\t"format_version": "1.8.0",
\t"animations": {
\t\t"a": {
\t\t\t"loop": true,
\t\t\t"animation_length": 1.0,
\t\t\t"bones": {
\t\t\t\t"armorHead": {
\t\t\t\t\t"rotation": [0, 0, 0],
\t\t\t\t\t"position": {
\t\t\t\t\t\t"0.0": [0, 0, 0],
\t\t\t\t\t\t"0.5": [0, 1, 0],
\t\t\t\t\t\t"1.0": [0, 0, 0]
\t\t\t\t\t}
\t\t\t\t},
\t\t\t\t"armorBody": {
\t\t\t\t\t"scale": 1
\t\t\t\t}
\t\t\t}
\t\t},
\t\t"b": {
\t\t\t"animation_length": 0.5,
\t\t\t"bones": {}
\t\t}
\t}
}
`;
const doc0 = () => parseDoc(ANIM, "animation");

describe("animation commands", () => {
  it("no-op serialize is identical", () => expect(serialize(doc0())).toBe(ANIM));

  it("setKeyValue changes one line", () => {
    const d = setKeyValue(doc0(), { anim: "a", bone: "armorHead", channel: "position", time: 0.5, value: [0, 2.5, 0] });
    expect(serialize(d)).toBe(ANIM.replace('"0.5": [0, 1, 0]', '"0.5": [0, 2.5, 0]'));
  });

  it("addKeyframe inserts in time order with matching formatting", () => {
    const d = addKeyframe(doc0(), { anim: "a", bone: "armorHead", channel: "position", time: 0.25, value: [1, 0, 0] });
    expect(serialize(d)).toBe(ANIM.replace('\t\t\t\t\t\t"0.5"', '\t\t\t\t\t\t"0.25": [1, 0, 0],\n\t\t\t\t\t\t"0.5"'));
  });

  it("addKeyframe default value samples the curve", () => {
    const d = addKeyframe(doc0(), { anim: "a", bone: "armorHead", channel: "position", time: 0.25 });
    expect(getAnimation(d, "a")!.bones.get("armorHead")!.position!.keys.find((k) => k.time === 0.25)!.value).toEqual([0, 0.5, 0]);
  });

  it("adding a second key to a constant array promotes it to a key map", () => {
    const d = addKeyframe(doc0(), { anim: "a", bone: "armorHead", channel: "rotation", time: 0.5, value: [10, 0, 0] });
    const out = serialize(d);
    expect(out).toContain('"rotation": {\n\t\t\t\t\t\t"0.0": [0, 0, 0],\n\t\t\t\t\t\t"0.5": [10, 0, 0]\n\t\t\t\t\t}');
    expect(getAnimation(parseDoc(out, "animation"), "a")!.bones.get("armorHead")!.rotation!.keys.length).toBe(2);
  });

  it("creates new bones and channels", () => {
    const d = addKeyframe(doc0(), { anim: "b", bone: "armorLeg", channel: "rotation", time: 0, value: [1, 2, 3] });
    const re = parseDoc(serialize(d), "animation");
    expect(getAnimation(re, "b")!.bones.get("armorLeg")!.rotation!.keys[0].value).toEqual([1, 2, 3]);
  });

  it("deleteKeyframes", () => {
    const d = deleteKeyframes(doc0(), { anim: "a", keys: [{ bone: "armorHead", channel: "position", time: 0.5 }] });
    expect(serialize(d)).toBe(ANIM.replace('\t\t\t\t\t\t"0.5": [0, 1, 0],\n', ""));
    const e = deleteKeyframes(doc0(), { anim: "a", keys: [{ bone: "armorBody", channel: "scale", time: 0 }] });
    expect(getAnimation(e, "a")!.bones.get("armorBody")?.scale).toBeUndefined();
  });

  it("moveKeyframes, retime and anchor", () => {
    const d = moveKeyframes(doc0(), { anim: "a", keys: [{ bone: "armorHead", channel: "position", time: 0.5 }], delta: 0.25 });
    expect(serialize(d)).toBe(ANIM.replace('"0.5"', '"0.75"'));
    const r = retimeKeyframe(doc0(), { anim: "a", bone: "armorHead", channel: "position", time: 0.5, newTime: 0.0833 });
    expect(serialize(r)).toContain('"0.0833": [0, 1, 0]');
    const an = moveKeyframes(doc0(), { anim: "a", keys: [{ bone: "armorHead", channel: "position", time: 0.5 }], delta: 0.1, anchor: true });
    expect(getAnimation(an, "a")!.bones.get("armorHead")!.position!.keys.map((k) => k.time)).toEqual([0.1, 0.6, 1.1]);
  });

  it("easing / lerp / pre-post", () => {
    const ref = { anim: "a", bone: "armorHead", channel: "position" as const, time: 0.5 };
    const e = setKeyEasing(doc0(), { ...ref, easing: "easeInOutSine" });
    expect(serialize(e)).toContain('"0.5": {\n\t\t\t\t\t\t\t"vector": [0, 1, 0],\n\t\t\t\t\t\t\t"easing": "easeInOutSine"\n\t\t\t\t\t\t}');
    const re = getAnimation(parseDoc(serialize(e), "animation"), "a")!.bones.get("armorHead")!.position!.keys[1];
    expect(re.easing).toBe("easeInOutSine");
    const back = setKeyEasing(e, { ...ref, easing: undefined });
    expect(getAnimation(back, "a")!.bones.get("armorHead")!.position!.keys[1].easing).toBeUndefined();
    const l = setKeyLerp(doc0(), { ...ref, lerp: "catmullrom" });
    expect(serialize(l)).toContain('"lerp_mode": "catmullrom"');
    expect(serialize(l)).toContain('"post"');
    const pp = setKeyPrePost(doc0(), { ...ref, pre: [0, 3, 0], post: [0, 5, 0] });
    const k = getAnimation(parseDoc(serialize(pp), "animation"), "a")!.bones.get("armorHead")!.position!.keys[1];
    expect(k.pre).toEqual([0, 3, 0]);
    expect(k.value).toEqual([0, 5, 0]);
    const vv = setKeyValue(doc0(), { ...ref, value: ["math.sin(query.anim_time)", 1, 0] });
    expect(serialize(vv)).toContain('"math.sin(query.anim_time)"');
  });

  it("snapKeysToTicks", () => {
    let d = addKeyframe(doc0(), { anim: "a", bone: "armorHead", channel: "position", time: 0.0833, value: [1, 1, 1] });
    d = snapKeysToTicks(d, { anim: "a" });
    expect(getAnimation(d, "a")!.bones.get("armorHead")!.position!.keys.map((k) => k.time)).toEqual([0, 0.1, 0.5, 1]);
  });

  it("animation level commands", () => {
    expect(Object.keys(JSON.parse(serialize(addAnimation(doc0(), { name: "c", length: 2, loop: true })).replace(/\n/g, "")).animations)).toEqual(["a", "b", "c"]);
    const r = renameAnimation(doc0(), { name: "a", newName: "z" });
    expect(serialize(r)).toBe(ANIM.replace('"a": {', '"z": {'));
    expect(serialize(deleteAnimation(doc0(), { name: "b" }))).toContain('"a"');
    expect(getAnimation(deleteAnimation(doc0(), { name: "b" }), "b")).toBeUndefined();
    const dup = duplicateAnimation(doc0(), { name: "a", newName: "a2" });
    expect(getAnimation(parseDoc(serialize(dup), "animation"), "a2")!.bones.size).toBe(2);
    expect(serialize(setLoop(doc0(), { anim: "a", loop: false }))).toBe(ANIM.replace('"loop": true', '"loop": false'));
    expect(serialize(setLoop(doc0(), { anim: "b", loop: "hold_on_last_frame" }))).toContain('"loop": "hold_on_last_frame"');
    expect(serialize(setLength(doc0(), { anim: "a", length: 2.5 }))).toBe(ANIM.replace('"animation_length": 1.0', '"animation_length": 2.5'));
    expect(() => addAnimation(doc0(), { name: "a" })).toThrow();
  });
});

const GEO = `{
  "format_version": "1.12.0",
  "minecraft:geometry": [
    {
      "description": {"identifier": "geometry.t", "texture_width": 64, "texture_height": 64},
      "bones": [
        {
          "name": "root",
          "pivot": [0, 0, 0]
        },
        {
          "name": "armorHead",
          "parent": "root",
          "pivot": [0, 24, 0],
          "cubes": [
            {"origin": [-4, 24, -4], "size": [8, 8, 8], "uv": [0, 0]}
          ]
        },
        {
          "name": "hat",
          "parent": "armorHead",
          "pivot": [0, 32, 0]
        }
      ]
    }
  ]
}
`;
const g0 = () => parseDoc(GEO, "geo");

describe("geometry commands", () => {
  it("round trip", () => expect(serialize(g0())).toBe(GEO));
  it("bones", () => {
    const a = addBone(g0(), { name: "tail", parent: "root", pivot: [0, 10, 4] });
    const out = serialize(a);
    expect(out).toContain('{\n          "name": "tail",\n          "parent": "root",\n          "pivot": [0, 10, 4]\n        }');
    expect(getGeo(parseDoc(out, "geo")).geometries[0].bones.length).toBe(4);
    expect(() => addBone(g0(), { name: "root" })).toThrow();
    const r = renameBone(g0(), { from: "armorHead", to: "head" });
    const gb = getGeo(parseDoc(serialize(r), "geo")).geometries[0].bones;
    expect(gb[1].name).toBe("head");
    expect(gb[2].parent).toBe("head");
    const d = deleteBone(g0(), { name: "armorHead" });
    expect(getGeo(parseDoc(serialize(d), "geo")).geometries[0].bones.map((b) => [b.name, b.parent])).toEqual([["root", undefined], ["hat", "root"]]);
    const dc = deleteBone(g0(), { name: "armorHead", cascade: true });
    expect(getGeo(dc).geometries[0].bones.map((b) => b.name)).toEqual(["root"]);
    const rp = reparentBone(g0(), { name: "hat", parent: null });
    expect(serialize(rp)).toBe(GEO.replace('"name": "hat",\n          "parent": "armorHead",', '"name": "hat",'));
    expect(() => reparentBone(g0(), { name: "root", parent: "hat" })).toThrow();
  });
  it("cubes", () => {
    const a = addCube(g0(), { bone: "hat", cube: { origin: [-4, 32, -4], size: [8, 2, 8], uv: { kind: "box", uv: [32, 0] }, inflate: 0.5 } });
    const re = getGeo(parseDoc(serialize(a), "geo")).geometries[0].bones[2].cubes[0];
    expect(re.origin).toEqual([-4, 32, -4]);
    expect(re.inflate).toBe(0.5);
    expect(re.uv).toEqual({ kind: "box", uv: [32, 0] });
    const m = moveCube(g0(), { bone: "armorHead", index: 0, delta: [1, 0, 0] });
    expect(serialize(m)).toBe(GEO.replace("[-4, 24, -4]", "[-3, 24, -4]"));
    const rs = resizeCube(g0(), { bone: "armorHead", index: 0, size: [8, 10, 8] });
    expect(serialize(rs)).toBe(GEO.replace('"size": [8, 8, 8]', '"size": [8, 10, 8]'));
    expect(serialize(setPivot(g0(), { bone: "hat", pivot: [0, 33, 0] }))).toBe(GEO.replace("[0, 32, 0]", "[0, 33, 0]"));
    expect(serialize(setRotation(g0(), { bone: "hat", rotation: [15, 0, 0] }))).toContain('"pivot": [0, 32, 0],\n          "rotation": [15, 0, 0]');
    expect(serialize(setInflate(g0(), { bone: "armorHead", index: 0, inflate: 0.25 }))).toBe(GEO.replace('"size": [8, 8, 8], "uv"', '"size": [8, 8, 8], "inflate": 0.25, "uv"'));
    expect(serialize(setMirror(g0(), { bone: "armorHead", index: 0, mirror: true }))).toContain('"mirror": true');
    const uv = setUv(g0(), { bone: "armorHead", index: 0, uv: { kind: "faces", faces: { north: { uv: [8, 8], uvSize: [8, 8] }, up: { uv: [8, 8], uvSize: [8, -8] } } } });
    const cu = getGeo(parseDoc(serialize(uv), "geo")).geometries[0].bones[1].cubes[0];
    expect(cu.uv).toEqual({ kind: "faces", faces: { north: { uv: [8, 8], uvSize: [8, 8], material: undefined }, up: { uv: [8, 8], uvSize: [8, -8], material: undefined } } });
    const dcu = deleteCube(g0(), { bone: "armorHead", index: 0 });
    expect(getGeo(dcu).geometries[0].bones[1].cubes.length).toBe(0);
    expect(serialize(setCube(g0(), { bone: "armorHead", index: 0, patch: { origin: [-4, 24, -4] } }))).toBe(GEO);
  });
});

describe("minimalEdit", () => {
  it("finds the changed region", () => {
    expect(minimalEdit("abcdef", "abXXef")).toEqual({ start: 2, end: 4, text: "XX" });
    expect(minimalEdit("abc", "abc")).toEqual({ start: 3, end: 3, text: "" });
  });
});
