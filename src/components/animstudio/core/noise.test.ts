import { describe, expect, it } from "vitest";
import { addNoise, copyKeys, mirrorBoneName, pasteWithNoise, perlin1, mulberry32, previewPasteWithNoise, applyNoise } from "./noise";
import { getAnimation, parseDoc, serialize } from "./doc";

const mk = () =>
  parseDoc(
    `{"format_version":"1.8.0","animations":{"t":{"animation_length":4.0,"bones":{"armorRightArm":{"rotation":{"0.0":[10,20,30],"0.5":[20,0,0],"1.0":[10,20,30]},"position":{"0.0":[1,0,0],"1.0":[2,0,0]}}}}}}`,
    "animation",
  );
const refs = [0, 0.5, 1].map((time) => ({ bone: "armorRightArm", channel: "rotation" as const, time }));
const opts = { amplitude: { rotation: 5, position: 1, scale: 10 }, kind: "perlin" as const, frequency: 3.1, seed: 42, keepEnds: true };

describe("prng + perlin", () => {
  it("deterministic and bounded", () => {
    expect(mulberry32(1)()).toBe(mulberry32(1)());
    expect(mulberry32(1)()).not.toBe(mulberry32(2)());
    for (let x = -10; x < 10; x += 0.37) {
      expect(Math.abs(perlin1(7, x))).toBeLessThanOrEqual(1.0001);
      expect(perlin1(7, x)).toBe(perlin1(7, x));
    }
    expect(perlin1(7, 3) + 0).toBeCloseTo(0, 12);
  });
});

describe("mirror names", () => {
  it("swaps left/right", () => {
    expect(mirrorBoneName("armorLeftArm")).toBe("armorRightArm");
    expect(mirrorBoneName("armorRightLeg")).toBe("armorLeftLeg");
    expect(mirrorBoneName("bipedLeftArm")).toBe("bipedRightArm");
    expect(mirrorBoneName("leftHand")).toBe("rightHand");
    expect(mirrorBoneName("armorHead")).toBe("armorHead");
  });
});

describe("paste with noise", () => {
  const clip = copyKeys(mk(), "t", refs);
  it("copy is relative", () => {
    expect(clip.duration).toBe(1);
    expect(clip.keys.map((k) => k.key.time)).toEqual([0, 0.5, 1]);
  });
  it("is deterministic for a seed and differs across seeds", () => {
    const a = serialize(pasteWithNoise(mk(), "t", clip, { ...opts, targetTime: 2 }));
    const b = serialize(pasteWithNoise(mk(), "t", clip, { ...opts, targetTime: 2 }));
    const c = serialize(pasteWithNoise(mk(), "t", clip, { ...opts, targetTime: 2, seed: 43 }));
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    const random1 = previewPasteWithNoise(clip, { ...opts, kind: "random", targetTime: 2 });
    const random2 = previewPasteWithNoise(clip, { ...opts, kind: "random", targetTime: 2 });
    expect(random1).toEqual(random2);
  });
  it("keepEnds keeps first/last exact in every copy, middle moves", () => {
    const keys = previewPasteWithNoise(clip, { ...opts, targetTime: 2, repeat: 2, every: 1.5 });
    expect(keys.map((k) => k.key.time)).toEqual([2, 2.5, 3, 3.5, 4, 4.5]);
    expect(keys[0].key.value).toEqual([10, 20, 30]);
    expect(keys[2].key.value).toEqual([10, 20, 30]);
    expect(keys[3].key.value).toEqual([10, 20, 30]);
    expect(keys[5].key.value).toEqual([10, 20, 30]);
    expect(keys[1].key.value).not.toEqual([20, 0, 0]);
    expect(keys[4].key.value).not.toEqual([20, 0, 0]);
    // noise stays within the amplitude
    for (const i of [1, 4]) (keys[i].key.value as number[]).forEach((v, ax) => expect(Math.abs(v - [20, 0, 0][ax])).toBeLessThanOrEqual(5.0001));
    const free = previewPasteWithNoise(clip, { ...opts, keepEnds: false, targetTime: 2 });
    expect(free[0].key.value).not.toEqual([10, 20, 30]);
  });
  it("axes mask", () => {
    const keys = previewPasteWithNoise(clip, { ...opts, axes: [true, false, false], targetTime: 0 });
    expect(keys[1].key.value[1]).toBe(0);
    expect(keys[1].key.value[2]).toBe(0);
    expect(keys[1].key.value[0]).not.toBe(20);
  });
  it("mirrorLR swaps bones and flips yaw/roll", () => {
    const keys = previewPasteWithNoise(clip, { ...opts, amplitude: { rotation: 0, position: 0, scale: 0 }, targetTime: 0, mirrorLR: true });
    expect(keys[0].bone).toBe("armorLeftArm");
    expect(keys[0].key.value).toEqual([10, -20, -30]);
    expect(keys[1].key.value).toEqual([20, 0, 0]);
  });
  it("targetBones remaps", () => {
    const keys = previewPasteWithNoise(clip, { ...opts, targetTime: 0, targetBones: { armorRightArm: "armorLeftLeg" } });
    expect(new Set(keys.map((k) => k.bone))).toEqual(new Set(["armorLeftLeg"]));
    const keys2 = previewPasteWithNoise(clip, { ...opts, targetTime: 0, targetBones: ["armorHead"] });
    expect(keys2[0].bone).toBe("armorHead");
  });
  it("pasted doc re-parses with the keys in place", () => {
    const out = pasteWithNoise(mk(), "t", clip, { ...opts, targetTime: 2 });
    const ks = getAnimation(parseDoc(serialize(out), "animation"), "t")!.bones.get("armorRightArm")!.rotation!.keys;
    expect(ks.map((k) => k.time)).toEqual([0, 0.5, 1, 2, 2.5, 3]);
  });
});

describe("addNoise in place", () => {
  it("is deterministic and respects keepEnds", () => {
    const a = getAnimation(mk(), "t")!;
    const sel = a.bones.get("armorRightArm")!.rotation!.keys.map((key) => ({ bone: "armorRightArm", channel: "rotation" as const, key }));
    const n1 = addNoise(sel, opts);
    expect(addNoise(sel, opts)).toEqual(n1);
    expect(n1[0]).toBe(sel[0]);
    expect(n1[2]).toBe(sel[2]);
    expect(n1[1].key.value).not.toEqual(sel[1].key.value);
    const doc = applyNoise(mk(), "t", refs, opts);
    const ks = getAnimation(doc, "t")!.bones.get("armorRightArm")!.rotation!.keys;
    expect(ks[0].value).toEqual([10, 20, 30]);
    expect(ks[1].value).toEqual(n1[1].key.value);
  });
});

describe("perlin noise on integer-aligned key times", () => {
  it("is not pinned to zero when time × frequency lands on integers", async () => {
    const { addNoise } = await import("./noise");
    const keys = [0, 0.5, 1, 1.5].map((time) => ({ bone: "armorRightArm", channel: "rotation" as const, key: { time, value: [0, 0, 0] as [number, number, number] } }));
    const out = addNoise(keys as never, { amplitude: { rotation: 10, position: 0, scale: 0 }, kind: "perlin", frequency: 2, seed: 7 });
    const moved = out.filter((k: { key: { value: unknown[] } }) => k.key.value.some((c) => typeof c === "number" && Math.abs(c) > 1e-6));
    expect(moved.length).toBe(keys.length);
  });
});
