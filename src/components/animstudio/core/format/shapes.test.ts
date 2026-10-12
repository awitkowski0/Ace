import { describe, expect, it } from "vitest";
import { addKeyframe, getAnimation, parseDoc, serialize, setKeyValue, addAnimation, duplicateAnimation, renameAnimation, setLoop, setLength, deleteAnimation } from "../doc";
import { readChannel } from "./animation";
import { parseJson } from "./json";
import { sampleChannel } from "../sample";

const SRC = `{
  "format_version": "1.8.0",
  "geckolib_format_version": 2,
  "animations": {
    "animation.x.y": {
      "loop": "hold_on_last_frame",
      "animation_length": 1.0,
      "override_previous_animation": true,
      "_comment": "hello",
      "sound_effects": {"0.5": {"effect": "boom"}},
      "bones": {
        "constant": {"rotation": [1, 2, 3], "position": {"vector": [4, 5, 6]}, "scale": 2},
        "strings": {"rotation": ["linear", "linear", "linear"], "position": {"0.0": [0, 0, 0], "1.0": [0, 1, 0]}},
        "molang": {"position": {"0.0": ["0", "math.sin(query.anim_time*90)", 0], "1.0": [0, 0, 0]}},
        "fancy": {
          "rotation": {
            "0.0": {"vector": [0, 0, 0], "easing": "linear"},
            "0.5": {"pre": [5, 0, 0], "post": [10, 0, 0], "lerp_mode": "catmullrom"},
            "1.0": {"vector": [0, 0, 0], "easing": "easeInBack", "easingArgs": [2]}
          }
        }
      }
    }
  }
}
`;
const doc = () => parseDoc(SRC, "animation");

describe("channel shapes", () => {
  it("reads every shape", () => {
    const a = getAnimation(doc(), "animation.x.y")!;
    expect(a.loop).toBe("hold_on_last_frame");
    const c = a.bones.get("constant")!;
    expect(c.rotation!.shape).toBe("array");
    expect(c.position!.shape).toBe("vector");
    expect(c.scale!.shape).toBe("scalar");
    expect(c.scale!.keys[0].value).toEqual([2, 2, 2]);
    expect(a.bones.get("strings")!.rotation!.shape).toBe("opaque");
    expect(a.bones.get("molang")!.position!.keys[0].value[1]).toBe("math.sin(query.anim_time*90)");
    const f = a.bones.get("fancy")!.rotation!.keys;
    expect(f[0].easing).toBe("linear");
    expect(f[1]).toMatchObject({ pre: [5, 0, 0], value: [10, 0, 0], lerp: "catmullrom" });
    expect(f[2]).toMatchObject({ easing: "easeInBack", easingArgs: [2] });
  });

  it("editing one channel leaves every other shape byte-identical", () => {
    const d = setKeyValue(doc(), { anim: "animation.x.y", bone: "fancy", channel: "rotation", time: 0.5, value: [11, 0, 0] });
    const out = serialize(d);
    expect(out).toBe(SRC.replace('"post": [10, 0, 0]', '"post": [11, 0, 0]'));
  });

  it("editing a constant array keeps the array shape", () => {
    const d = setKeyValue(doc(), { anim: "animation.x.y", bone: "constant", channel: "rotation", time: 0, value: [9, 2, 3] });
    expect(serialize(d)).toBe(SRC.replace('"rotation": [1, 2, 3]', '"rotation": [9, 2, 3]'));
    const v = setKeyValue(doc(), { anim: "animation.x.y", bone: "constant", channel: "position", time: 0, value: [4, 5, 7] });
    expect(serialize(v)).toBe(SRC.replace('{"vector": [4, 5, 6]}', '{"vector": [4, 5, 7]}'));
    const s = setKeyValue(doc(), { anim: "animation.x.y", bone: "constant", channel: "scale", time: 0, value: [3, 3, 3] });
    expect(serialize(s)).toBe(SRC.replace('"scale": 2', '"scale": 3'));
    const s2 = setKeyValue(doc(), { anim: "animation.x.y", bone: "constant", channel: "scale", time: 0, value: [3, 1, 3] });
    expect(serialize(s2)).toContain('"scale": [3, 1, 3]');
  });

  it("opaque string-array channels survive edits to their bone", () => {
    const d = addKeyframe(doc(), { anim: "animation.x.y", bone: "strings", channel: "position", time: 0.5, value: [0, 2, 0] });
    expect(serialize(d)).toContain('"rotation": ["linear", "linear", "linear"]');
    expect(readChannel(parseJson('["linear","linear","linear"]').root)!.shape).toBe("opaque");
  });

  it("molang is evaluated while sampling", () => {
    const a = getAnimation(doc(), "animation.x.y")!;
    const v = sampleChannel(a, "molang", "position", 0.5)!;
    // start 0, end 0 at t=.5 -> end evaluated(0) -> y: start=sin(45 deg... query.anim_time=.5 -> sin(45)) lerp to end 0
    expect(v[1]).toBeCloseTo(Math.sin(Math.PI / 4) * 0.5, 5);
  });

  it("animation-level commands keep unknown keys", () => {
    const d = duplicateAnimation(doc(), { name: "animation.x.y", newName: "animation.x.z" });
    const out = serialize(d);
    expect(out.split('"_comment": "hello"').length).toBe(3);
    expect(serialize(renameAnimation(doc(), { name: "animation.x.y", newName: "q" }))).toBe(SRC.replace("animation.x.y", "q"));
    expect(serialize(setLoop(doc(), { anim: "animation.x.y", loop: undefined }))).toBe(SRC.replace('      "loop": "hold_on_last_frame",\n', ""));
    expect(serialize(setLength(doc(), { anim: "animation.x.y", length: 1.5 }))).toBe(SRC.replace('"animation_length": 1.0', '"animation_length": 1.5'));
    const added = addAnimation(doc(), { name: "fresh", length: 0.5 });
    expect(Object.keys(JSON.parse(serialize(added)).animations)).toEqual(["animation.x.y", "fresh"]);
    expect(serialize(deleteAnimation(addAnimation(doc(), { name: "fresh" }), { name: "fresh" }))).toBe(SRC);
  });
});

describe("bbmodel animation commands", () => {
  const BB = JSON.stringify({
    meta: { format_version: "4.10", model_format: "bedrock" },
    name: "m", elements: [], outliner: [{ name: "arm", origin: [0, 0, 0], uuid: "g1", children: [] }],
    animations: [{ uuid: "a1", name: "walk", loop: "loop", length: 1, animators: { g1: { name: "arm", type: "bone", keyframes: [
      { channel: "rotation", data_points: [{ x: "0", y: "0", z: "0" }], uuid: "k1", time: 0, color: -1, interpolation: "linear", easing: "linear", easingArgs: [] },
      { channel: "position", data_points: [{ x: 1, y: 0, z: 0 }], uuid: "k2", time: 0.5, interpolation: "linear" },
    ] } } }],
  });
  it("adds, edits and deletes keys, preserving other keyframes", () => {
    const d = parseDoc(BB, "bbmodel");
    let out = addKeyframe(d, { anim: "walk", bone: "arm", channel: "rotation", time: 0.5, value: [10, 0, 0], lerp: "catmullrom" });
    const j = JSON.parse(serialize(out));
    const kfs = j.animations[0].animators.g1.keyframes;
    expect(kfs.map((k: { channel: string; time: number }) => `${k.channel}@${k.time}`)).toEqual(["rotation@0", "rotation@0.5", "position@0.5"]);
    expect(kfs[1].interpolation).toBe("catmullrom");
    expect(kfs[1].data_points[0]).toEqual({ x: "10", y: "0", z: "0" });
    expect(kfs[2]).toEqual(JSON.parse(BB).animations[0].animators.g1.keyframes[1]);
    out = setKeyValue(out, { anim: "walk", bone: "arm", channel: "position", time: 0.5, value: [1, 2, 0] });
    expect(JSON.parse(serialize(out)).animations[0].animators.g1.keyframes[2].data_points[0]).toEqual({ x: 1, y: 2, z: 0 });
    const loop = JSON.parse(serialize(setLoop(d, { anim: "walk", loop: false })));
    expect(loop.animations[0].loop).toBe("once");
    const dup = JSON.parse(serialize(duplicateAnimation(d, { name: "walk", newName: "run" })));
    expect(dup.animations.map((a: { name: string }) => a.name)).toEqual(["walk", "run"]);
    expect(dup.animations[1].uuid).not.toBe("a1");
  });
});
