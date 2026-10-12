import { describe, expect, it } from "vitest";
import type { NumVec3 } from "../../animstudio/core";
import { JET_ANCHORS, jetAnchorFrame } from "./anchors";
import {
  angleMatrix, angleToQuat, armPitchDegrees, baseAim, effectivePose, flameSize, jetFrame, legPitchDegrees, matrixAngle, offsetForDelta,
  antiGravCones, flameCones, glowOn, overrideJets, setGlowEnabled, POSE_DEFAULTS, propelledPose, quatToAngle, setJetVec, setPoseValue, turnDir,
} from "./flight";

const close = (a: readonly number[], b: readonly number[], d = 1e-6) => a.forEach((v, i) => expect(v).toBeCloseTo(b[i], -Math.log10(d)));
const F = (name: string) => jetAnchorFrame(name)!;

describe("jetFrame", () => {
  it("is the anchor and straight down with no offset or angle", () => {
    const f = jetFrame(F("rightFoot"), "down");
    close(f.pos, [-(-0.12) * 16, 0.03 * 1.8 * 16, 0]);
    close(f.dir, [0, -1, 0]);
  });
  it("palm aims out from its side, down and back (JetFlameMath.baseAim), mirrored for the left hand", () => {
    const r = jetFrame(F("rightPalm"), "palm").dir;
    const l = jetFrame(F("leftPalm"), "palm").dir;
    expect(r[0]).toBeGreaterThan(0.4); expect(l[0]).toBeLessThan(-0.4);
    expect(r[1]).toBeLessThan(-0.5); expect(r[2]).toBeGreaterThan(0.5); // scene +Z is behind the wearer
    close([r[0], r[1], r[2]], [-l[0], l[1], l[2]]);
    expect(baseAim("palm", 1)).toEqual([0.5, -0.6, -0.62]);
  });
  it("offset is [right, up, forward] px in the body frame (scene Z is forward negated)", () => {
    const base = jetFrame(F("leftPalm"), "palm").pos;
    const p = jetFrame(F("leftPalm"), "palm", [2, -3, 4]).pos;
    close([p[0] - base[0], p[1] - base[1], p[2] - base[2]], [2, -3, -4]);
  });
  it("angle turns the aim: roll, then pitch, then yaw (JetFlameMath.turn)", () => {
    close(turnDir([0, 0, 1], [90, 0, 0]), [0, -1, 0]); // pitch carries forward toward down
    close(turnDir([0, 0, 1], [0, 90, 0]), [1, 0, 0]); // yaw carries forward toward right
    close(turnDir([0, 1, 0], [0, 0, 90]), [1, 0, 0]); // roll carries up toward right
    close(turnDir([0, -1, 0], [90, 0, 0]), [0, 0, -1]); // a downward flame pitched 90 points back
    close(jetFrame(F("rightFoot"), "down", [0, 0, 0], [90, 0, 0]).dir, [0, 0, 1]); // ... which is +Z in the scene
    close(turnDir([0, 1, 0], [90, 90, 0]), [1, 0, 0]); // JetFlameMathTest: pitch before yaw
    expect(turnDir(baseAim("palm", 1), [0, 0, 0])).toEqual(baseAim("palm", 1)); // JetFlameMathTest: no angle leaves the aim alone
    expect(baseAim("down", 0, true)).toEqual([0, -0.4, -0.917]);
    // JetFlameMath.turn, line by line
    const java = (d: NumVec3, p: number, w: number, r: number): NumVec3 => {
      const R = (r * Math.PI) / 180, P = (p * Math.PI) / 180, W = (w * Math.PI) / 180;
      const x = d[0] * Math.cos(R) + d[1] * Math.sin(R), y = -d[0] * Math.sin(R) + d[1] * Math.cos(R), z = d[2];
      const y2 = y * Math.cos(P) - z * Math.sin(P), z2 = y * Math.sin(P) + z * Math.cos(P);
      return [x * Math.cos(W) + z2 * Math.sin(W), y2, -x * Math.sin(W) + z2 * Math.cos(W)];
    };
    close(turnDir([0.5, -0.6, -0.62], [10, 20, 30]), java([0.5, -0.6, -0.62], 10, 20, 30));
  });
  it("the angle matrix is turnDir", () => {
    for (const a of [[10, 20, 30], [-45, 80, 5], [0, 0, 0], [70, -120, 160]] as NumVec3[]) {
      const m = angleMatrix(a);
      const v: NumVec3 = [0.3, -0.8, 0.5];
      close([0, 1, 2].map((i) => m[i][0] * v[0] + m[i][1] * v[1] + m[i][2] * v[2]), turnDir(v, a));
    }
  });
  it("angle <-> matrix <-> scene quaternion round-trip", () => {
    for (const a of [[10, 20, 30], [-45, 80, 5], [0, 0, 0], [70, -120, 160], [0, 0, -90], [-30, 0, 0]] as NumVec3[]) {
      close(matrixAngle(angleMatrix(a)), a, 1e-4);
      close(quatToAngle(angleToQuat(a)), a, 1e-4);
    }
  });
  it("the quaternion rotates the scene direction the way the angle turns the body direction", () => {
    const a: NumVec3 = [25, -40, 15];
    const [x, y, z, w] = angleToQuat(a);
    const v: NumVec3 = [0.2, -0.9, 0.3]; // scene
    // v' = q v q*
    const t = [2 * (y * v[2] - z * v[1]), 2 * (z * v[0] - x * v[2]), 2 * (x * v[1] - y * v[0])];
    const rot = [v[0] + w * t[0] + (y * t[2] - z * t[1]), v[1] + w * t[1] + (z * t[0] - x * t[2]), v[2] + w * t[2] + (x * t[1] - y * t[0])];
    const body = turnDir([v[0], v[1], -v[2]], a);
    close(rot, [body[0], body[1], -body[2]], 1e-6);
  });
  it("gimbal pitch of +-90 degrees still round-trips to the same direction", () => {
    const a = quatToAngle(angleToQuat([90, 33, 10]));
    close(turnDir([0.1, -1, 0.4], a), turnDir([0.1, -1, 0.4], [90, 33, 10]), 1e-6);
  });
  it("offsetForDelta lands a scene drag back as an offset", () => {
    const start: NumVec3 = [1, 2, 3];
    const d: NumVec3 = [4, -1, 2];
    const o = offsetForDelta(F("rightPalm"), start, d);
    const a = jetFrame(F("rightPalm"), "palm", start).pos;
    const b = jetFrame(F("rightPalm"), "palm", o).pos;
    close([b[0] - a[0], b[1] - a[1], b[2] - a[2]], d);
  });
  it("every jet anchor has a frame", () => { for (const n of JET_ANCHORS) expect(jetAnchorFrame(n)).toBeTruthy(); expect(jetAnchorFrame("nope")).toBeNull(); });
});

describe("flame size and pose", () => {
  it("flame is exactly its length at rest and 2.6x at full speed (JetFlameMath)", () => {
    expect(flameSize({ length: 1, width: 0.1 }, 0)).toEqual({ length: 1, width: 0.1 });
    close([flameSize({ length: 1, width: 0.1 }, 1).length, flameSize({ length: 1, width: 0.1 }, 1).width], [2.6, 0.06]);
    expect(flameSize({ length: 1, hover: 0.5 }, 0).length).toBe(0.5);
  });
  it("arm and leg pitch interpolate with speed", () => {
    expect(armPitchDegrees({ ...POSE_DEFAULTS, armHover: 4, armBack: 24 }, 0.5)).toBe(14);
    expect(legPitchDegrees(16, 0)).toBe(4); expect(legPitchDegrees(16, 1)).toBe(16);
  });
  it("propelledPose mirrors the arms; positive X swings back in the geo file", () => {
    const p = propelledPose({ ...POSE_DEFAULTS, armOut: 20, armTwist: 5, legSpread: 3 }, 1);
    expect(p.armorRightArm.rotation).toEqual([14, 5, 20]);
    expect(p.armorLeftArm.rotation).toEqual([14, -5, -20]);
    expect(p.armorRightLeg.rotation).toEqual([16, 0, 3]);
    expect(p.armorLeftLeg.rotation).toEqual([16, 0, -3]);
  });
  it("effectivePose: own over parent over default", () => {
    const e = effectivePose({ armOut: 10 }, [{ armBack: 30, armOut: 7, style: "propelled" }, { legTilt: 5 }]);
    expect(e.values).toMatchObject({ armOut: 10, armBack: 30, legTilt: 5, bob: 2.5 });
    expect(e.inherited).toEqual({ armOut: 7, armBack: 30, legTilt: 5 });
    expect(e.style).toBe("propelled");
  });
});

const IRON = `{
  "parent": "thematic:jetpack",
  "effects": {
    "jets": [
      { "anchor": "rightPalm", "aim": "palm", "flame": { "core": "#FFF" } },
      { "anchor": "leftPalm", "aim": "palm", "offset": [1, 2, 3] }
    ]
  }
}
`;
describe("flame cones", () => {
  it("outer + core, and the nozzle glow only when glow > 0 (JetFlameRenderer.drawFlame)", () => {
    const f = { core: "#FFFFFF", outer: "#64E9FF", length: 0.85, width: 0.1, hover: 0.18, glow: 0.45 };
    const c = flameCones(f, 0);
    expect(c.length).toBe(3);
    close([c[0].length, c[0].radius, c[0].alpha], [0.85 * 0.18 * 16, 1.6, 0.62]); // hover share shortens it at rest
    close([c[1].length, c[1].radius, c[1].alpha], [c[0].length * 0.62, 1.6 * 0.45, 0.95]);
    close([c[2].length, c[2].radius, c[2].alpha], [1.6 * 1.6, 1.6 * 2.4, 0.35 * 0.45]);
    expect(flameCones({ ...f, glow: 0 }, 0).length).toBe(2);
    expect(flameCones({ length: 1 }, 0).length).toBe(3); // glow defaults to 1
    expect(flameCones(f, 1)[0].length).toBeCloseTo(0.85 * 2.6 * 16);
  });
  it("anti-grav pad, with a streak only in flight", () => {
    expect(antiGravCones({ size: 0.3 }, 0)).toHaveLength(1);
    const c = antiGravCones({ size: 0.3, streak: 1 }, 1);
    expect(c).toHaveLength(2);
    close([c[0].length, c[0].radius], [0.3 * 16 * 0.45, 0.3 * 16]);
  });
});

describe("nozzle glow toggle", () => {
  const T = `{\n  "effects": {\n    "jets": [\n      { "anchor": "rightPalm", "flame": { "length": 0.5, "glow": 0.3 } },\n      { "anchor": "leftPalm" }\n    ]\n  }\n}\n`;
  it("off writes glow 0, on restores the remembered value, else 0.45", () => {
    const off = setGlowEnabled(T, 0, false);
    expect(JSON.parse(off).effects.jets[0].flame).toEqual({ length: 0.5, glow: 0 });
    expect(glowOn(JSON.parse(off).effects.jets[0].flame)).toBe(false);
    expect(JSON.parse(setGlowEnabled(off, 0, true, 0.3)).effects.jets[0].flame.glow).toBe(0.3);
    expect(JSON.parse(setGlowEnabled(off, 0, true)).effects.jets[0].flame.glow).toBe(0.45);
    expect(setGlowEnabled(setGlowEnabled(T, 0, false), 0, true, 0.3)).toBe(T); // on -> off -> on is the same file
  });
  it("a flame without glow counts as on (default 1); a jet without a flame is untouched", () => {
    expect(glowOn({ length: 1 })).toBe(true);
    expect(JSON.parse(setGlowEnabled(`{"effects":{"jets":[{"anchor":"a","flame":{}}]}}`, 0, false)).effects.jets[0].flame.glow).toBe(0);
    expect(setGlowEnabled(T, 1, false)).toBe(T);
  });
});

describe("edits", () => {
  it("adds offset to a jet as a minimal edit and removes it when reset to zero", () => {
    const a = setJetVec(IRON, 0, "offset", [0, -2.5, 1]);
    expect(a).toContain(`"offset": [0, -2.5, 1]`);
    expect(JSON.parse(a).effects.jets[0].offset).toEqual([0, -2.5, 1]);
    expect(a.replace(/, "offset": \[0, -2\.5, 1\]/, "").replace(/\s*"offset": \[0, -2\.5, 1\],?/, "")).toContain(`"aim": "palm"`);
    const b = setJetVec(a, 0, "offset", [0, 0, 0]);
    expect(JSON.parse(b)).toEqual(JSON.parse(IRON));
    expect(b).not.toContain("offset\": [0");
  });
  it("angle is written rounded and zero removes the key; other jets and lines are untouched", () => {
    const a = setJetVec(IRON, 1, "angle", [10.04, 0, -5]);
    expect(JSON.parse(a).effects.jets[1].angle).toEqual([10, 0, -5]);
    expect(JSON.parse(a).effects.jets[1].offset).toEqual([1, 2, 3]);
    expect(a.split("\n")[0]).toBe("{");
    expect(JSON.parse(setJetVec(a, 1, "angle", [0, 0, 0])).effects.jets[1]).toEqual({ anchor: "leftPalm", aim: "palm", offset: [1, 2, 3] });
    expect(setJetVec(IRON, 0, "angle", [0, 0, 0])).toBe(IRON); // nothing to remove: no edit
  });
  it("pose values go into poses (created when missing) and an emptied poses object is removed", () => {
    const a = setPoseValue(IRON, "armOut", 30);
    expect(JSON.parse(a).poses).toEqual({ armOut: 30 });
    const b = setPoseValue(a, "armBack", 20.123);
    expect(JSON.parse(b).poses).toEqual({ armOut: 30, armBack: 20.12 });
    expect(JSON.parse(setPoseValue(b, "armOut", undefined)).poses).toEqual({ armBack: 20.12 });
    expect(setPoseValue(setPoseValue(a, "armOut", undefined), "armOut", undefined)).toBe(IRON);
  });
  it("override copies the inherited jets in", () => {
    const base = `{ "parent": "thematic:repulsor" }\n`;
    const out = overrideJets(base, [{ anchor: "rightFoot", when: "always" }]);
    expect(JSON.parse(out).effects.jets).toEqual([{ anchor: "rightFoot", when: "always" }]);
    expect(JSON.parse(out).parent).toBe("thematic:repulsor");
  });
});
