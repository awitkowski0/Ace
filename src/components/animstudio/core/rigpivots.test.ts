import { describe, expect, it } from "vitest";
import { MASS_SHARE, centreOfMass } from "./trick";
import { PLAYER_RIG, RIG_BONE_NAMES, playerRigGeometry, transformPoint } from "./rig";

describe("PLAYER_RIG = vanilla Bedrock player pivots", () => {
  const piv = (n: string) => PLAYER_RIG.find((b) => b.name === n)!.pivot;
  it("pivots", () => {
    expect(piv("armorHead")).toEqual([0, 24, 0]);
    expect(piv("armorBody")).toEqual([0, 24, 0]);
    expect(piv("armorRightArm")).toEqual([-5, 22, 0]);
    expect(piv("armorLeftArm")).toEqual([5, 22, 0]);
    expect(piv("armorRightLeg")).toEqual([-1.9, 12, 0]);
    expect(piv("armorLeftLeg")).toEqual([1.9, 12, 0]);
  });
  it("trick math uses the same rig: every bone has a mass share (sum 1) and the rest pose centre is symmetric", () => {
    expect(RIG_BONE_NAMES.every((n) => MASS_SHARE[n] > 0)).toBe(true);
    expect(Object.values(MASS_SHARE).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 9);
    const c = centreOfMass({});
    expect(c[0]).toBeCloseTo(0, 6);
    expect(c[1]).toBeGreaterThan(10);
    expect(c[1]).toBeLessThan(20);
  });
  it("a rotation about a limb's pivot leaves the pivot fixed (kinematics use the rig pivots)", () => {
    for (const b of PLAYER_RIG) expect(transformPoint(PLAYER_RIG, b.name, b.pivot, { [b.name]: { rotation: [40, 20, 10] } })).toEqual(b.pivot.map((v) => expect.closeTo(v, 9)));
    expect(playerRigGeometry().bones.map((b) => b.pivot)).toEqual(PLAYER_RIG.map((b) => [...b.pivot]));
  });
});
