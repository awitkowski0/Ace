import { describe, expect, it } from "vitest";
import { evalMolang } from "./molang";
import { applyEasing, clipTime, sampleChannel, samplePose } from "./sample";
import { getAnimation, parseDoc } from "./doc";

const anim = (bones: string, extra = '"loop": false, "animation_length": 4.0,') => {
  const doc = parseDoc(`{"format_version":"1.8.0","animations":{"t":{${extra}"bones":{${bones}}}}}`, "animation");
  return getAnimation(doc, "t")!;
};
const near = (a: number[] | undefined, b: number[], d = 1e-6) => {
  expect(a).toBeDefined();
  b.forEach((x, i) => expect(a![i]).toBeCloseTo(x, 5 + 0 * d));
};

describe("molang", () => {
  it("evaluates the supported subset", () => {
    expect(evalMolang("math.sin(90)")).toBeCloseTo(1);
    expect(evalMolang("math.cos(0)*2+1")).toBeCloseTo(3);
    expect(evalMolang("-(2+3)*2")).toBe(-10);
    expect(evalMolang("math.clamp(5,0,3)")).toBe(3);
    expect(evalMolang("math.lerp(0,10,0.25)")).toBe(2.5);
    expect(evalMolang("query.anim_time*2", { anim_time: 1.5 })).toBe(3);
    expect(evalMolang("query.life_time", { life_time: 7 })).toBe(7);
    expect(evalMolang("math.abs(-4)")).toBe(4);
    expect(evalMolang("math.pi")).toBeCloseTo(Math.PI);
    expect(evalMolang("1/0")).toBe(0);
    expect(evalMolang("garbage((")).toBe(0);
    expect(evalMolang("10 - 4 - 3")).toBe(3);
  });
});

describe("easings (GeckoLib EasingType)", () => {
  it("matches hand-computed values", () => {
    expect(applyEasing("easeInQuad", 0.5)).toBe(0.25);
    expect(applyEasing("easeOutQuad", 0.5)).toBe(0.75);
    expect(applyEasing("easeInOutSine", 0.25)).toBeCloseTo((1 - Math.cos(Math.PI / 4)) / 2, 9);
    expect(applyEasing("easeInBack", 0.5)).toBeCloseTo(0.25 * (2.70158 * 0.5 - 1.70158), 9);
    expect(applyEasing("EASEINCUBIC", 0.5)).toBe(0.125);
    expect(applyEasing("easeInExpo", 1)).toBe(1);
    expect(applyEasing("nonsense", 0.3)).toBe(0.3);
    expect(applyEasing("easeInBounce", 0.5)).toBeCloseTo(Math.min(121 / 16 * 0.25, 121 / 4 * 0.5 * (0.5 - 6 / 11) ** 2 + 0.5, 121 * 0.25 * (0.5 - 9 / 11) ** 2 + 0.75, 484 * 0.125 * (0.5 - 10.5 / 11) ** 2 + 0.875), 9);
  });
});

describe("sampler", () => {
  it("linear", () => {
    const a = anim('"b":{"rotation":{"0.0":[0,0,0],"1.0":[10,20,30]}}');
    near(sampleChannel(a, "b", "rotation", 0.25), [2.5, 5, 7.5]);
    near(sampleChannel(a, "b", "rotation", 0), [0, 0, 0]);
    near(sampleChannel(a, "b", "rotation", 3), [10, 20, 30]); // holds last key
    expect(sampleChannel(a, "b", "position", 0)).toBeUndefined();
    expect(sampleChannel(a, "zzz", "rotation", 0)).toBeUndefined();
  });
  it("holds the first key's value before it", () => {
    const a = anim('"b":{"position":{"1.0":[4,0,0],"2.0":[8,0,0]}}');
    near(sampleChannel(a, "b", "position", 0.2), [4, 0, 0]);
    near(sampleChannel(a, "b", "position", 1.5), [6, 0, 0]);
  });
  it("easing belongs to the segment ENDING at the eased key", () => {
    const a = anim('"b":{"position":{"0.0":[0,0,0],"1.0":{"vector":[10,0,0],"easing":"easeInQuad"},"2.0":[10,0,0]}}');
    near(sampleChannel(a, "b", "position", 0.5), [2.5, 0, 0]); // 10 * 0.5^2
    near(sampleChannel(a, "b", "position", 1.5), [10, 0, 0]);
    // easing on the first key has nothing to ease (segment 0 -> 0)
    const b = anim('"b":{"position":{"0.0":{"vector":[0,0,0],"easing":"easeInQuad"},"1.0":[10,0,0]}}');
    near(sampleChannel(b, "b", "position", 0.5), [5, 0, 0]);
  });
  it("easing args (back overshoot)", () => {
    const a = anim('"b":{"position":{"0.0":[0,0,0],"1.0":{"vector":[10,0,0],"easing":"easeInBack","easingArgs":[2]}}}');
    const n2 = 2 * 1.70158;
    near(sampleChannel(a, "b", "position", 0.5), [10 * (0.25 * ((n2 + 1) * 0.5 - n2)), 0, 0]);
  });
  it("step (GeckoLib quirk: 2 steps -> 0 then 0.5)", () => {
    const a = anim('"b":{"position":{"0.0":[0,0,0],"1.0":{"vector":[10,0,0],"easing":"step"}}}');
    near(sampleChannel(a, "b", "position", 0.4), [0, 0, 0]);
    near(sampleChannel(a, "b", "position", 0.6), [5, 0, 0]);
    near(sampleChannel(a, "b", "position", 1), [10, 0, 0]);
  });
  it("catmullrom uses neighbours", () => {
    const k = (v: number) => `{"post":[${v},0,0],"lerp_mode":"catmullrom"}`;
    const a = anim(`"b":{"position":{"0.0":${k(0)},"1.0":${k(10)},"2.0":${k(0)},"3.0":${k(10)}}}`);
    near(sampleChannel(a, "b", "position", 1.5), [5, 0, 0]);
    // p0=0 p1=10 p2=0 p3=10 at d=.25
    near(sampleChannel(a, "b", "position", 1.25), [8.4375, 0, 0]);
  });
  it("pre/post makes a jump", () => {
    const a = anim('"b":{"position":{"0.0":[0,0,0],"1.0":{"pre":[5,0,0],"post":[10,0,0]},"2.0":[10,0,0]}}');
    near(sampleChannel(a, "b", "position", 0.5), [5 * (0.5 / 0.999), 0, 0]);
    near(sampleChannel(a, "b", "position", 1.0), [10, 0, 0]);
    near(sampleChannel(a, "b", "position", 1.5), [10, 0, 0]);
  });
  it("constant shapes", () => {
    const a = anim('"b":{"rotation":[1,2,3],"position":{"vector":[4,5,6]},"scale":2}');
    near(sampleChannel(a, "b", "rotation", 9), [1, 2, 3]);
    near(sampleChannel(a, "b", "position", 9), [4, 5, 6]);
    near(sampleChannel(a, "b", "scale", 9), [2, 2, 2]);
  });
  it("molang components", () => {
    const a = anim('"b":{"position":{"0.0":["0","0","0"],"2.0":["query.anim_time*10",0,"math.sin(90)"]}}');
    near(sampleChannel(a, "b", "position", 1), [5, 0, 0.5]); // start 0, end evaluated at t=1 -> 10 -> halfway
  });
  it("loop wrap, hold and clamp", () => {
    const loop = anim('"b":{"position":{"0.0":[0,0,0],"1.0":[10,0,0]}}', '"loop": true, "animation_length": 1.0,');
    expect(clipTime(loop, 1.25)).toBeCloseTo(0.25);
    near(sampleChannel(loop, "b", "position", 1.25), [2.5, 0, 0]);
    const hold = anim('"b":{"position":{"0.0":[0,0,0],"1.0":[10,0,0]}}', '"loop": "hold_on_last_frame", "animation_length": 1.0,');
    near(sampleChannel(hold, "b", "position", 7), [10, 0, 0]);
    const once = anim('"b":{"position":{"0.0":[0,0,0],"1.0":[10,0,0]}}', '"animation_length": 1.0,');
    near(sampleChannel(once, "b", "position", -3), [0, 0, 0]);
  });
  it("samplePose lists animated bones", () => {
    const a = anim('"x":{"rotation":[1,2,3]},"y":{"position":{"0.0":[0,0,0],"1.0":[2,0,0]}}');
    const p = samplePose(a, 0.5);
    near(p.x.rotation, [1, 2, 3]);
    near(p.y.position, [1, 0, 0]);
  });
});
