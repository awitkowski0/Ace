import { describe, expect, it } from "vitest";
import { BONE_ALIASES, PLAYER_RIG, canonicalBone, canonicalizePose, playerRigGeometry, transformPoint } from "./rig";
import { FLIP_PROFILE, TWIST_PROFILE, applySpin, centreOfMass, MASS_SHARE, profileArea, spinPreview, trickAngle } from "./trick";

describe("rig", () => {
  it("has the six armor bones with Steve proportions", () => {
    expect(PLAYER_RIG.map((b) => b.name)).toEqual(["armorHead", "armorBody", "armorRightArm", "armorLeftArm", "armorRightLeg", "armorLeftLeg"]);
    expect(PLAYER_RIG[2].pivot).toEqual([-5, 22, 0]);
    expect(PLAYER_RIG[3].pivot).toEqual([5, 22, 0]);
    expect(PLAYER_RIG[2].cubes[0].size).toEqual([4, 12, 4]);
    expect(playerRigGeometry().bones).toHaveLength(6);
  });
  it("aliases", () => {
    expect(BONE_ALIASES.bipedLeftArm).toBe("armorLeftArm");
    expect(BONE_ALIASES.armorHead).toBe("bipedHead");
    expect(canonicalBone("bipedRightLeg")).toBe("armorRightLeg");
    expect(canonicalBone("swing_pivot")).toBe("swing_pivot");
    expect(Object.keys(canonicalizePose({ bipedHead: {}, armorBody: {} }))).toEqual(["armorHead", "armorBody"]);
  });
  it("rotates about the shoulder pivot", () => {
    // arm hanging down: point (-6, 12, 0) is the bottom of the right arm; pitch 90 about X swings it forward/back by 10 units
    const p = transformPoint(PLAYER_RIG, "armorRightArm", [-6, 12, 0], { armorRightArm: { rotation: [90, 0, 0] } });
    expect(p[0]).toBeCloseTo(-6, 6);
    expect(Math.abs(p[1] - 22)).toBeLessThan(1e-6);
    expect(Math.abs(Math.abs(p[2]) - 10)).toBeLessThan(1e-6);
  });
});

describe("trick math (game-exact; see spidey/game.test.ts for the Java checks)", () => {
  it("mass shares sum to 1", () => {
    expect(Object.values(MASS_SHARE).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 9);
  });
  it("profile areas (hand computed: the speed between knots is smoothstepped, so the integral of a segment is length * (a t + (b-a)(t^3 - t^4/2)))", () => {
    // flip: segments (0,0)->(.15,.35) (.15,.35)->(.3,1.7) (.3,1.7)->(.65,1.7) (.65,1.7)->(.8,.7) (.8,.7)->(1,0); each eased segment integrates to length * (a + b) / 2 exactly
    // (the smoothstep's mean is 1/2), so the total equals the piecewise-linear trapezoid sum.
    expect(profileArea(FLIP_PROFILE, 1)).toBeCloseTo(1.025, 9);
    expect(profileArea(TWIST_PROFILE, 1)).toBeCloseTo(1.0875, 9);
    expect(trickAngle("front_flip", 1, 1)).toBeCloseTo(360, 9);
    expect(trickAngle("front_flip", 1, 0)).toBe(0);
    // mid-segment the smoothstep is behind the linear ramp: 0.075 into the first segment (half way) the area is length*(0 + .35*(1/8 - 1/32))
    expect(profileArea(FLIP_PROFILE, 0.075)).toBeCloseTo(0.15 * 0.35 * (0.125 - 0.0625 / 2), 9);
  });
  it("a spin completes its turns and the preview holds the hinge", () => {
    expect(trickAngle("twist_right", 3, 1)).toBeCloseTo(1080, 9);
    expect(trickAngle("web_x", 3, 0.5)).toBe(0);
    const anim = { name: "t", bones: new Map(), length: 0.5 } as unknown as Parameters<typeof spinPreview>[0];
    const f = spinPreview(anim, { axis: "front_flip", turns: 1, ticks: 0 }, 0.25, 0.5);
    expect(f.progress).toBeCloseTo(0.5, 9);
    // the hinge point is a fixed point of the transform when base == live
    const c = applySpin(f, f.live);
    expect(c[1]).toBeCloseTo(f.base[1], 6);
    expect(c[2]).toBeCloseTo(f.base[2], 6);
    const head = applySpin(f, [0, 28, 0]);
    expect(head[1]).not.toBeCloseTo(28, 1);
  });
  it("centre of mass of the rest pose is near the hips/chest (geometry helper)", () => {
    const com = centreOfMass({});
    expect(com[0]).toBeCloseTo(0, 6);
    expect(com[1]).toBeGreaterThan(14);
    expect(com[1]).toBeLessThan(20);
  });
});
