/**
 * Pins core/spidey/game.ts to the Java in the MAIN Thematic checkout (read-only; real-file tests use a temp copy). Citations are
 * file:line as of 2026-10 under src/common/java/bond/thematic/api/.
 */
import { describe, expect, it } from "vitest";
import { eulerToQuat, quatRotate, type Quat } from "../math";
import { getAnimations, parseDoc } from "../doc";
import { samplePose } from "../sample";
import { parsePoseSet } from "./poseSet";
import { clipInfos, channelUse } from "./clips";
import { validateSpidey } from "./validate";
import {
  CRAWL_GAIT, TRICK_AXES, aimAngles, applierRotation, crawlClipNames, crawlStrideBlocks, fileRotationToModelPart, filePositionToModelPart,
  fileToBody, modelPartToBodyPosition, modelPartToBodyRotation, playbackKind, positionUse, profileArea, profileSpeed, FLIP_PROFILE, TWIST_PROFILE,
  sceneRotation, scenePosition, serializerRotation, stridePhase, trickAngle, trickCentre, trickRotation, walkStrideBlocks, blocksToPx, MODEL_SCALE,
} from "./game";
import { webKitCopy } from "../testutil";

const R2D = 180 / Math.PI;
const BONES = ["armorHead", "armorBody", "armorRightArm", "armorLeftArm", "armorRightLeg", "armorLeftLeg"];
const close = (a: ArrayLike<number>, b: ArrayLike<number>, p = 6) => { for (let i = 0; i < a.length; i++) expect(a[i]).toBeCloseTo(b[i], p); };
/** conjugation by the renderer's scale(-1, -1, 1): a proper rotation (det +1), so a quaternion maps (x,y,z,w) -> (-x,-y,z,w) */
const conj = (q: Quat): Quat => [-q[0], -q[1], q[2], q[3]];
const sameRotation = (a: Quat, b: Quat) => { const s = Math.sign(a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]) || 1; close(a, b.map((v) => v * s)); };

describe("axes: file -> ModelPart -> what the renderer shows == Ace's scene (Blockbench) conversion", () => {
  it("head / torso are negated on load and again on apply: GeckoLibSerializer.java:294-299 + AnimationApplier.java:52-56 cancel out", () => {
    for (const bone of BONES) {
      const v: [number, number, number] = [31.5, -47.25, 12.125];
      expect(applierRotation(bone, serializerRotation(bone, v))).toEqual(v);
      // ModelPart rotation = file rotation in radians, for every bone (KeyframeAnimation.java:645 degrees -> radians)
      close(fileRotationToModelPart(bone, v), v.map((x) => (x * Math.PI) / 180));
    }
    expect(serializerRotation("armorHead", [10, 20, 30])).toEqual([-10, -20, 30]);
    expect(serializerRotation("armorRightArm", [10, 20, 30])).toEqual([10, 20, 30]);
  });
  it("position: y is flipped on load for every bone but the body (GeckoLibSerializer.java:288-293) and added to the pivot (LimbDriver.java:629-631)", () => {
    expect(filePositionToModelPart([1, 2, 3])).toEqual([1, -2, 3]);
  });
  it("rotation: ModelPart Rz Ry Rx seen through scale(-1,-1,1) == Ace's (-x,-y,z) ZYX euler, for random values", () => {
    let seed = 7;
    const rnd = () => { seed = (seed * 16807) % 2147483647; return (seed / 2147483647) * 360 - 180; };
    for (let i = 0; i < 50; i++) {
      const file: [number, number, number] = [rnd(), rnd(), rnd()];
      const mp = fileRotationToModelPart("armorRightArm", file).map((r) => r * R2D) as [number, number, number];
      const qModel = eulerToQuat(mp); // JOML rotationZYX(roll, yaw, pitch) == qz*qy*qx
      sameRotation(conj(qModel), eulerToQuat(sceneRotation(file)));
      // and the long-hand formula
      close(modelPartToBodyRotation(fileRotationToModelPart("armorRightArm", file)).map((r) => r * R2D), sceneRotation(file));
      // vector check: carry a point through both
      const u: [number, number, number] = [0.3, -1, 0.5];
      const viaGame = quatRotate(conj(qModel), u);
      close(viaGame, quatRotate(eulerToQuat(sceneRotation(file)), u));
    }
  });
  it("position: ModelPart offset (x,-y,z) through scale(-1,-1,1) == Ace's (-x,+y,+z)", () => {
    const file: [number, number, number] = [1.5, -2.25, 0.75];
    close(modelPartToBodyPosition(filePositionToModelPart(file)), scenePosition(file));
    expect(fileToBody("armorLeftLeg", [10, 20, 30], file)).toEqual({ rot: expect.anything(), pos: scenePosition(file) });
    close(fileToBody("armorLeftLeg", [10, 20, 30], file).rot!, sceneRotation([10, 20, 30]));
  });
  it("a raised arm: pitch -90 lifts the right arm forward in both (forward = -z in the scene)", () => {
    const q = eulerToQuat(sceneRotation([-90, 0, 0]));
    const tip = quatRotate(q, [0, -12, 0]);
    close(tip, [0, 0, -12]);
  });
  const kit = webKitCopy();
  it("real keys of web_sling.animation.json convert identically along both paths", async () => {
    const k = await kit;
    if (!k) return;
    const doc = parseDoc(k.animText, "animation");
    let n = 0;
    for (const a of getAnimations(doc)) {
      for (const [bone, b] of a.bones) {
        if (!BONES.includes(bone)) continue;
        for (const key of b.rotation?.keys ?? []) {
          if (!key.value.every((x) => typeof x === "number")) continue;
          const v = key.value as [number, number, number];
          sameRotation(conj(eulerToQuat(fileRotationToModelPart(bone, v).map((r) => r * R2D) as [number, number, number])), eulerToQuat(sceneRotation(v)));
          n++;
        }
        for (const key of b.position?.keys ?? []) {
          if (!key.value.every((x) => typeof x === "number")) continue;
          const v = key.value as [number, number, number];
          close(modelPartToBodyPosition(filePositionToModelPart(v)), scenePosition(v));
          n++;
        }
      }
    }
    expect(n).toBeGreaterThan(500);
  });
});

describe("playback kinds, position use and stride gaits derived from the real pose set", async () => {
  const k = await webKitCopy();
  const set = k ? parsePoseSet(k.posesText, "web") : undefined;
  const doc = k ? parseDoc(k.animText, "animation") : undefined;
  it.skipIf(!k)("labels", () => {
    const info = clipInfos(getAnimations(doc!), [set!]);
    const kind = (n: string) => `${info.get(n)!.kind}/${info.get(n)!.positions}${info.get(n)!.strideGait ? "/" + info.get(n)!.strideGait : ""}`;
    // (1) plays as drawn: whole clips and ability clips that are not in the pose set at all
    for (const n of ["web_flip_front", "web_flip_back", "web_twist_left", "web_twist_right", "web_cartwheel_left", "web_corkscrew_right", "web_tuck", "web_air_dive", "web_air_spread", "web_air_tuck", "web_twist_dive_left", "web_ambush_flip"]) expect(kind(n)).toBe("drawn/playback");
    for (const n of getAnimations(doc!).map((a) => a.name).filter((n) => !set!.clips[n] && !/_\d$/.test(n) && !crawlClipNames(set).has(n))) expect(info.get(n)!.kind, n).toBe("drawn");
    // (2) pose-set clips: swing / zip / air are broadcast so their positions still play; pose-only ones ignore them
    expect(kind("web_sling_right")).toBe("pose/playback");
    expect(kind("web_land")).toBe("pose/ignored");
    expect(kind("web_hook")).toBe("pose/ignored");
    expect(kind("web_perch_back")).toBe("pose/ignored");
    // (3) stride: crawl clips by the CrawlGait, the rest by vanilla's walk cycle; only the crawl clips (and their holds) read positions
    expect(kind("web_crawl")).toBe("stride/limb-driver/gait");
    expect(kind("web_ceiling_crawl")).toBe("stride/limb-driver/gait");
    expect(kind("web_wall_run")).toBe("stride/ignored/walk");
    expect(kind("web_run")).toBe("stride/ignored/walk");
    expect(kind("web_climb")).toBe("stride/playback/walk");
    expect(info.get("web_wall_hold")!.positions).toBe("limb-driver");
    expect(info.get("web_ceiling_still")!.positions).toBe("limb-driver");
    expect([...crawlClipNames(set)].sort()).toEqual(["web_ceiling_crawl", "web_ceiling_still", "web_crawl", "web_wall_hold"]);
    expect(info.get("web_flip_front")!.extraUses[0]).toMatch(/slingshot/);
  });
  it.skipIf(!k)("dimming: crawl positions are live, other pose-only positions are greyed, aimed pitch/yaw flagged", () => {
    const info = clipInfos(getAnimations(doc!), [set!]);
    expect(channelUse(info.get("web_crawl"), "armorRightLeg", "position").dim).toBe(false);
    expect(channelUse(info.get("web_crawl"), "armorBody", "position").dim).toBe(true);
    expect(channelUse(info.get("web_run"), "armorRightLeg", "position").dim).toBe(true);
    expect(channelUse(info.get("web_run"), "armorRightLeg", "rotation").dim).toBe(false);
    expect(channelUse(info.get("web_sling_right"), "armorRightLeg", "position").dim).toBe(false);
    expect(channelUse(info.get("web_sling_right"), "armorRightArm", "rotation").aimedXY).toBe(true);
    expect(channelUse(info.get("web_sling_right"), "armorLeftArm", "rotation").aimedXY).toBe(false);
    expect(channelUse(undefined, "armorRightLeg", "position").dim).toBe(false);
  });
  it("kind / position rules", () => {
    const a = { inPoseSet: true, broadcast: false, isCrawl: false };
    expect(playbackKind({ ...a, playback: "whole" })).toBe("drawn");
    expect(playbackKind({ ...a, inPoseSet: false })).toBe("drawn");
    expect(playbackKind({ ...a, playback: "loop" })).toBe("pose");
    expect(playbackKind({ ...a, playback: "stride" })).toBe("stride");
    expect(positionUse({ ...a, playback: "loop" })).toBe("ignored");
    expect(positionUse({ ...a, playback: "loop", broadcast: true })).toBe("playback");
    expect(positionUse({ ...a, playback: "stride", isCrawl: true })).toBe("limb-driver");
  });
  it.skipIf(!k)("'position-ignored' warns on pose-only clips, with a fix that removes exactly those keys", () => {
    const withPos = parseDoc(JSON.stringify({ format_version: "1.8.0", animations: {
      web_land: { animation_length: 0.5, bones: { armorRightArm: { rotation: { "0.0": [0, 0, 0], "0.5": [10, 0, 0] }, position: { "0.0": [0, 0, 0], "0.5": [0, 1, 0] } }, swing_pivot: { position: [0, 0, 0] } } },
      web_crawl: { loop: true, animation_length: 0.8, bones: { armorRightLeg: { position: { "0.0": [0, 0, 0], "0.8": [0, 0, 0] } }, armorBody: { position: { "0.0": [0, 1, 0], "0.8": [0, 1, 0] } }, swing_pivot: { position: [0, 6.4, 0] } } },
      web_sling_right: { loop: true, animation_length: 1, bones: { armorRightLeg: { position: { "0.0": [0, 0, 0], "1.0": [0, 0, 0] } }, swing_pivot: { position: [0, 0, 0] } } },
    } }), "animation");
    const ps = validateSpidey(withPos, [set!]).filter((p) => p.code === "position-ignored");
    expect(ps.map((p) => p.anim).sort()).toEqual(["web_crawl", "web_land"]);
    expect(ps.find((p) => p.anim === "web_crawl")!.message).toMatch(/armorBody/);
    expect(ps.find((p) => p.anim === "web_crawl")!.message).not.toMatch(/armorRightLeg/);
    const fixed = ps.reduce((d, p) => p.fix!.apply(d), withPos);
    expect(validateSpidey(fixed, [set!]).filter((p) => p.code === "position-ignored")).toEqual([]);
    const land = getAnimations(fixed).find((a) => a.name === "web_land")!;
    expect(land.bones.get("armorRightArm")?.position).toBeUndefined();
    expect(land.bones.get("armorRightArm")?.rotation?.keys).toHaveLength(2);
    expect(land.bones.get("swing_pivot")?.position).toBeDefined();
  });
});

describe("stride: phase follows distance (CrawlGait.java:99-111, LimbDriver.java:892-895)", () => {
  it("crawl stride length: max(0.5 + 2.5 pace, 4 pace) blocks, pace = blocks per tick", () => {
    expect(CRAWL_GAIT).toEqual({ SWEEP: 0.5, SWING_TICKS: 2.5, CYCLE_MIN_TICKS: 4.0 });
    expect(crawlStrideBlocks(0)).toBeCloseTo(0.5, 9);
    expect(crawlStrideBlocks(3)).toBeCloseTo(0.875, 9); // pace .15: max(.875, .6)
    expect(crawlStrideBlocks(20)).toBeCloseTo(4.0, 9); // pace 1: max(.5 + 2.5, 4 * 1) - the fastest crawl takes at least 4 ticks a cycle
  });
  it("walk cycle: 2pi / (0.6662 * 4) blocks per cycle until the amplitude saturates at 5 blocks/s", () => {
    expect(walkStrideBlocks(2)).toBeCloseTo((2 * Math.PI) / (0.6662 * 4), 6);
    expect(walkStrideBlocks(5)).toBeCloseTo((2 * Math.PI) / (0.6662 * 4), 6);
    expect(walkStrideBlocks(10)).toBeCloseTo(2 * (2 * Math.PI) / (0.6662 * 4), 6);
  });
  it("phase wraps and scales with distance", () => {
    expect(stridePhase("gait", 0.875, 3)).toBeCloseTo(0, 9);
    expect(stridePhase("gait", 0.4375, 3)).toBeCloseTo(0.5, 9);
    expect(stridePhase("gait", 0.875 * 2.25, 3)).toBeCloseTo(0.25, 9);
  });
});

describe("spin (BodyAttitude.java / BodyAttitudeRenderer.java / TrickHinge.java)", () => {
  it("axis table, BodyAttitude.java:108-135", () => {
    expect(TRICK_AXES.front_flip).toEqual({ pitch: -1, yaw: 0, roll: 0 });
    expect(TRICK_AXES.corkscrew_left).toEqual({ pitch: 1, yaw: 1, roll: 0 });
    expect(TRICK_AXES.twist_dive_right).toEqual({ pitch: -1, yaw: -1, roll: 0 });
    expect(TRICK_AXES.cartwheel_right).toEqual({ pitch: 0, yaw: 0, roll: -1 });
  });
  it("trickRotation composes rotateX, rotateZ, rotateY post-multiplied: Rx * Rz * Ry (BodyAttitude.java:158-164), not yaw-last", () => {
    // corkscrew_left at 90 deg: the yaw acts first on the vector (0,0,1): Ry(90) -> (1,0,0); Rx(90) leaves x alone.
    close(quatRotate(trickRotation("corkscrew_left", 90), [0, 0, 1]), [1, 0, 0]);
    // the other order (Ry * Rx) would have sent it to (0,-1,0)
  });
  it("trickAngle: exact turns at the end, FLIP profile for flips and the quicker TWIST profile for pure twists (BodyAttitude.java:301-318)", () => {
    expect(trickAngle("cartwheel_left", 1, 1)).toBeCloseTo(360, 9);
    expect(trickAngle("twist_left", 3, 1)).toBeCloseTo(1080, 9);
    expect(trickAngle("web_x", 1, 1)).toBe(0);
    // at 30% progress the twist is further along than a flip
    expect(trickAngle("twist_left", 1, 0.3)).toBeGreaterThan(trickAngle("front_flip", 1, 0.3));
    // smoothstep between the knots: speed at the knot midpoint (0.075 of the first segment, .35 at the end) is .175
    expect(profileSpeed(FLIP_PROFILE, 0.075)).toBeCloseTo(0.175, 9);
    expect(profileSpeed(TWIST_PROFILE, 0.2)).toBeCloseTo(1.5, 9);
    expect(profileArea(FLIP_PROFILE, 1)).toBeCloseTo(1.025, 9);
  });
  it("TrickHinge.centre: the rest pose sits at 0.849 blocks, a tucked pose lifts it (TrickHinge.java:24-36)", () => {
    const z = [0, 0, 0, 0, 0];
    const c = trickCentre(z, z, z);
    expect(c.y).toBeCloseTo(MODEL_SCALE * (1.501 - 9.52 / 16), 9);
    expect(c.z).toBeCloseTo(0, 9);
    // knees to the chest (legs pitched -90 deg): the legs' mass moves up and forward -> centre rises, z moves forward (negative = in front... model z)
    const tucked = trickCentre([0, 0, 0, -Math.PI / 2, -Math.PI / 2], z, z);
    expect(tucked.y).toBeGreaterThan(c.y);
    expect(blocksToPx(c.y)).toBeCloseTo(((MODEL_SCALE * (1.501 - 9.52 / 16)) * 16) / MODEL_SCALE, 9);
  });
});

describe("live aim (LimbDriver.aimFrom, LimbDriver.java:1768-1781)", () => {
  // the arm tip the game would draw, LimbDriver.limbTip (LimbDriver.java:1480-1485), in the upright body frame, px
  const tipOf = (joint: [number, number, number], pitch: number, yaw: number, roll: number, rightArm: boolean) => {
    const tip = quatRotate(eulerToQuat([pitch, yaw, roll]), [rightArm ? -1 : 1, 10, 0]); // ModelPart space, arm hangs down +y
    return [joint[0] - tip[0], joint[1] - tip[1], joint[2] + tip[2]];
  };
  it("straight ahead at shoulder height: pitch -90, yaw 0", () => {
    const a = aimAngles("right_arm", [5, 22, 0], [5, 22, -40]);
    expect(a.pitch).toBeCloseTo(-90, 6);
    expect(a.yaw).toBeCloseTo(0, 6);
  });
  it("the aimed arm lands on the target direction for a spread of targets (replayed through the model transform)", () => {
    for (const rightArm of [true, false]) {
      const joint: [number, number, number] = [rightArm ? 5 : -5, 22, 0];
      for (const t0 of [[0, 60, -30], [20, 50, -10], [-15, 40, -40], [30, 30, 20]] as Array<[number, number, number]>) {
        const t: [number, number, number] = [rightArm ? t0[0] : -t0[0], t0[1], t0[2]]; // mirrored for the left shoulder (its range across the chest is only 40 degrees)
        const a = aimAngles(rightArm ? "right_arm" : "left_arm", joint, t);
        const tip = tipOf(joint, a.pitch, a.yaw, 0, rightArm);
        const want = [t[0] - joint[0], t[1] - joint[1], t[2] - joint[2]];
        const got = [tip[0] - joint[0], tip[1] - joint[1], tip[2] - joint[2]];
        // the fingertip sits 1 px outboard of the arm axis: compare directions loosely
        const dot = (want[0] * got[0] + want[1] * got[1] + want[2] * got[2]) / (Math.hypot(...want) * Math.hypot(...got));
        expect(dot, JSON.stringify({ rightArm, t, a })).toBeGreaterThan(0.99);
      }
    }
  });
});
