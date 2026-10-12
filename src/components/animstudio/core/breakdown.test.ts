import { describe, expect, it } from "vitest";
import { breakdown, pushRelax, insertBreakdown } from "./breakdown";
import { getAnimation, parseDoc, serialize } from "./doc";
import { eulerToQuat, nearestEuler, quatToEuler, slerp } from "./math";
import { sampleChannel } from "./sample";

const mk = (bones: string) => parseDoc(`{"format_version":"1.8.0","animations":{"t":{"animation_length":2.0,"bones":{${bones}}}}}`, "animation");

describe("math", () => {
  it("euler <-> quat round trip", () => {
    for (const e of [[10, 20, 30], [-170, 45, 80], [0, 0, 0], [89, -30, 100]] as Array<[number, number, number]>) {
      const r = nearestEuler(eulerToQuat(e), e);
      r.forEach((v, i) => expect(v).toBeCloseTo(e[i], 6));
    }
    expect(quatToEuler(eulerToQuat([0, 90, 0]))[1]).toBeCloseTo(90, 5);
  });
  it("slerp extrapolates", () => {
    const q = slerp(eulerToQuat([0, 0, 0]), eulerToQuat([0, 0, 90]), 1.5);
    expect(nearestEuler(q, [0, 0, 120])[2]).toBeCloseTo(135, 5);
  });
});

describe("breakdown", () => {
  const d = mk('"b":{"rotation":{"0.0":[0,0,0],"1.0":[0,0,90]},"position":{"0.0":[0,0,0],"1.0":[10,20,30]}},"c":{"scale":{"0.0":[1,1,1],"1.0":[2,2,2]}}');
  it("blends rotation (slerp), position and scale", () => {
    const p = breakdown(d, "t", { tA: 0, tB: 1, factor: 0.5 });
    expect(p.b.rotation).toEqual([0, 0, 45]);
    expect(p.b.position).toEqual([5, 10, 15]);
    expect(p.c.scale).toEqual([1.5, 1.5, 1.5]);
    expect(breakdown(d, "t", { tA: 0, tB: 1, factor: 0 }).b.rotation).toEqual([0, 0, 0]);
    expect(breakdown(d, "t", { tA: 0, tB: 1, factor: 1 }).b.rotation).toEqual([0, 0, 90]);
  });
  it("overshoot extrapolates", () => {
    const p = breakdown(d, "t", { tA: 0, tB: 1, factor: 1.5, bones: ["b"] });
    expect(p.b.rotation![2]).toBeCloseTo(135, 4);
    expect(p.b.position).toEqual([15, 30, 45]);
    expect(p.c).toBeUndefined();
    expect(breakdown(d, "t", { tA: 0, tB: 1, factor: -0.5, bones: ["b"] }).b.rotation![2]).toBeCloseTo(-45, 4);
  });
  it("takes the short way round with no >180 wrap", () => {
    const w = mk('"b":{"rotation":{"0.0":[0,170,0],"1.0":[0,-170,0]}}');
    const p = breakdown(w, "t", { tA: 0, tB: 1, factor: 0.5 });
    // short way: through 180 -> ±180
    expect(Math.abs(Math.abs(p.b.rotation![1]) - 180)).toBeLessThan(1e-4);
    const q = breakdown(w, "t", { tA: 0, tB: 1, factor: 0.25 });
    expect(q.b.rotation![1]).toBeCloseTo(175, 4);
    const r = breakdown(w, "t", { tA: 0, tB: 1, factor: 0.75 });
    expect(r.b.rotation![1]).toBeCloseTo(-175, 4);
  });
  it("followCurve uses the easing at B", () => {
    const e = mk('"b":{"position":{"0.0":[0,0,0],"1.0":{"vector":[10,0,0],"easing":"easeInQuad"}}}');
    expect(breakdown(e, "t", { tA: 0, tB: 1, factor: 0.5 }).b.position![0]).toBe(5);
    expect(breakdown(e, "t", { tA: 0, tB: 1, factor: 0.5, followCurve: true }).b.position![0]).toBe(2.5);
  });
  it("insertBreakdown commits keys at a time", () => {
    const out = insertBreakdown(d, "t", { tA: 0, tB: 1, factor: 0.5, bones: ["b"] }, 0.5);
    const a = getAnimation(parseDoc(serialize(out), "animation"), "t")!;
    expect(a.bones.get("b")!.rotation!.keys.map((k) => k.time)).toEqual([0, 0.5, 1]);
    expect(sampleChannel(a, "b", "rotation", 0.5)).toEqual([0, 0, 45]);
    expect(a.bones.get("c")!.scale!.keys.length).toBe(2);
  });
  it("pushRelax exaggerates / relaxes relative to the neighbour line", () => {
    const k = mk('"b":{"position":{"0.0":[0,0,0],"0.5":[8,0,0],"1.0":[10,0,0]},"rotation":{"0.0":[0,0,0],"0.5":[0,0,60],"1.0":[0,0,100]}}');
    // line at 0.5 is 5 (pos) / 50 (rot); current 8 / 60
    expect(pushRelax(k, "t", { t: 0.5, amount: 0 }).b.position![0]).toBe(8);
    expect(pushRelax(k, "t", { t: 0.5, amount: -1 }).b.position![0]).toBe(5);
    expect(pushRelax(k, "t", { t: 0.5, amount: 1 }).b.position![0]).toBe(11);
    expect(pushRelax(k, "t", { t: 0.5, amount: -1 }).b.rotation![2]).toBeCloseTo(50, 4);
    expect(pushRelax(k, "t", { t: 0.5, amount: 1 }).b.rotation![2]).toBeCloseTo(70, 4);
    expect(pushRelax(k, "t", { t: 0.25, amount: 1 }).b.position![0]).toBe(4); // on the line already
    expect(pushRelax(k, "t", { t: 0, amount: 1 }).b).toBeUndefined(); // no key before t=0
  });
});
