/**
 * How Thematic's game code plays a Spider-Man clip, as pure functions (no UI). Everything here is a port of the Java in the
 * main checkout `~/IdeaProjects/Thematic-Collections` (read-only reference); each block cites file:line (lines as of 2026-10).
 * `game.test.ts` pins the numbers. Paths are relative to `src/common/java/bond/thematic/api/`.
 *
 * Frames used below:
 *  - FILE        the .animation.json value (degrees for rotation, model px for position).
 *  - MODEL PART  vanilla `ModelPart` (radians, y down, forward = -z, the player's right = -x).
 *  - BODY        the renderer's body frame, `LimbDriver.BodyFrame` (LimbDriver.java:1342-1356): +x the player's right, +y up,
 *                +z BEHIND, unscaled blocks. The model is drawn through `scale(-1, -1, 1)`, so BODY = (-x, -y, z) of MODEL PART.
 *  - SCENE       Ace's viewport = Blockbench's Bedrock scene (rigView.ts): x = -file x, so the right arm (file x = -5) sits at
 *                +5, forward is -z. That is the BODY frame (x right, y up, z behind), in model px.
 * Because SCENE == BODY, the file -> scene mapping Ace uses for the normal view IS what the game shows for limb rotations and
 * positions; only the *selection* of channels the game reads differs (see `positionUse`).
 */
import type { NumVec3 } from "../format/animation";
import { quatFromAxisAngle, quatMul, quatRotate, type Quat } from "../math";
import type { PoseSet } from "./poseSet";

const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;

// ================================================================== file -> model part -> body frame

/**
 * Loader, rotation: `GeckoLibSerializer.readCollection` (core/data/gson/GeckoLibSerializer.java:294-299) negates X and Y of
 * armorHead / armorBody(torso) on the way IN; `AnimationApplier.updatePart` (animation/AnimationApplier.java:52-56) negates them
 * again on the way OUT. Degrees -> radians is KeyframeAnimation.java:645. Net: ModelPart rotation = FILE rotation (radians),
 * for every bone. (ClipPoseLibrary.java:195-199 repeats the head negation to undo the serializer's.)
 */
export function serializerRotation(bone: string, file: NumVec3): NumVec3 {
  const inverted = bone === "armorHead" || bone === "armorBody";
  return inverted ? [-file[0], -file[1], file[2]] : [file[0], file[1], file[2]];
}
export function applierRotation(bone: string, stored: NumVec3): NumVec3 {
  const inverted = bone === "armorHead" || bone === "armorBody";
  return inverted ? [-stored[0], -stored[1], stored[2]] : [stored[0], stored[1], stored[2]];
}
/** FILE degrees -> vanilla ModelPart radians (xRot, yRot, zRot). */
export function fileRotationToModelPart(bone: string, file: NumVec3): NumVec3 {
  const r = applierRotation(bone, serializerRotation(bone, file));
  return [r[0] * D2R, r[1] * D2R, r[2] * D2R];
}
/**
 * Loader, position: GeckoLibSerializer.java:288-293 negates Y for every bone but the body (and divides body by 16);
 * ClipPoseLibrary.java:184-187 reads it back as the offset added to the ModelPart's pivot (LimbDriver.blend, LimbDriver.java:629-631).
 * FILE px -> ModelPart px offset: (x, -y, z).
 */
export function filePositionToModelPart(file: NumVec3): NumVec3 {
  return [file[0], -file[1], file[2]];
}
/** ModelPart rotation (radians) as the renderer shows it in the BODY frame: scale(-1,-1,1) conjugation -> (-x, -y, z), still Rz Ry Rx. */
export function modelPartToBodyRotation(mp: NumVec3): NumVec3 {
  return [-mp[0], -mp[1], mp[2]];
}
/** ModelPart px offset in the BODY frame: x and y flip with the model's scale(-1,-1,1). */
export function modelPartToBodyPosition(mp: NumVec3): NumVec3 {
  return [-mp[0], -mp[1], mp[2]];
}
/** What Ace's viewport does with a FILE rotation (degrees) / position: rigView.ts applyPose. */
export const sceneRotation = (file: NumVec3): NumVec3 => [-file[0], -file[1], file[2]];
export const scenePosition = (file: NumVec3): NumVec3 => [-file[0], file[1], file[2]];
/** FILE -> BODY frame, the long way round through the Java (degrees / px). */
export function fileToBody(bone: string, rot: NumVec3 | undefined, pos: NumVec3 | undefined): { rot: NumVec3 | undefined; pos: NumVec3 | undefined } {
  const r = rot ? modelPartToBodyRotation(fileRotationToModelPart(bone, rot)) : undefined;
  return { rot: r ? [r[0] * R2D, r[1] * R2D, r[2] * R2D] : undefined, pos: pos ? modelPartToBodyPosition(filePositionToModelPart(pos)) : undefined };
}

// ================================================================== which channels / kinds the game reads

/** The three ways the game plays a clip. */
export type PlaybackKind = "drawn" | "pose" | "stride";
/** How position keys of a clip reach the model. */
export type PositionUse = "playback" | "limb-driver" | "ignored";

/**
 * `when`s whose modes pose the limbs with `LimbDriver.plantCrawlLimbs` (the wall crawl): drawn rotations AND position keys,
 * for the mode's `clip` and its `cling` hold (LimbDriver.java:990-1002, 1627-1664: `crawl.offset(part, a)`, `hold.offset(part, a)`).
 */
export const CRAWL_WHENS: readonly string[] = ["wall_crawling", "wall_ceiling"];

export function crawlClipNames(set: PoseSet | undefined): Set<string> {
  const out = new Set<string>();
  if (!set) return out;
  for (const m of set.modes) if (CRAWL_WHENS.includes(m.when)) for (const c of [m.clip, m.cling]) if (c) out.add(c);
  return out;
}

export interface KindArgs {
  /** The clip has an entry in a pose set `clips` table (or a mode names it). */
  inPoseSet: boolean;
  playback?: string;
  /** The clip is also broadcast to everyone by an ability (`TetherMoves.play`), so the animation system plays it too. */
  broadcast: boolean;
  isCrawl: boolean;
}
/**
 * (1) drawn  : ability clips and `playback: whole` (flips, twists, tricks, glide flourishes). The animation system plays them,
 *              limb driver stays out (PoseSet.java Playback.WHOLE): rotations and positions as drawn.
 * (2) pose   : a pose-set clip (loop / one_shot): rotations as drawn, `aimed` limbs' pitch+yaw replaced by live aim, positions per `positionUse`.
 * (3) stride : walked by distance (LimbDriver.stridePhase / CrawlGait.phase), one clip per stride; a kind of pose clip.
 */
export function playbackKind(a: KindArgs): PlaybackKind {
  if (!a.inPoseSet || a.playback === "whole") return "drawn";
  if (a.playback === "stride") return "stride";
  return "pose";
}
/**
 * Position keys:
 *  - drawn kind: the animation system applies them (AnimationApplier.java:44-47).
 *  - crawl clips (+ their hold): the limb driver applies them, timed to the stride.
 *  - other pose-set clips an ability also broadcasts: ordinary playback still applies them under the limb driver
 *    (LimbDriver.blend only ADDS its own offset, which is zero outside the crawl: LimbDriver.java:91, 629).
 *  - other pose-set clips that nothing broadcasts: nothing plays them; the pose pass reads rotations only.
 */
export function positionUse(a: KindArgs): PositionUse {
  if (playbackKind(a) === "drawn") return "playback";
  if (a.isCrawl) return "limb-driver";
  return a.broadcast ? "playback" : "ignored";
}

// ================================================================== stride (distance-driven phase)

/**
 * The plain wall crawl clips (web_crawl, web_ceiling_crawl) are walked by `CrawlGait.phase()` (LimbDriver.java:1649), which
 * advances `moved / stride(pace)` per tick (CrawlGait.java:99-109); `pace` is blocks per tick, eased toward the measured speed.
 * stride(pace) = max(SWEEP + SWING_TICKS * pace, CYCLE_MIN_TICKS * pace)   (CrawlGait.java:22-24, 109-111).
 */
export const CRAWL_GAIT = { SWEEP: 0.5, SWING_TICKS: 2.5, CYCLE_MIN_TICKS: 4.0 } as const;
export function crawlStrideBlocks(speedBps: number): number {
  const pace = Math.max(0, speedBps) / 20;
  return Math.max(CRAWL_GAIT.SWEEP + CRAWL_GAIT.SWING_TICKS * pace, CRAWL_GAIT.CYCLE_MIN_TICKS * pace);
}
/**
 * Every other stride clip (web_run, web_climb, web_wall_run, ...) is sampled at vanilla's walk cycle:
 * `position * 0.6662 / 2pi` (LimbDriver.java:892-895). Vanilla advances `position` by `min(4 * blocksPerTick, 1)` a tick
 * (LivingEntity.updateWalkAnimation: not in this repo, vanilla 1.20), the Spider kit tops the cycle up for climbs
 * (TetherClient.java:2409-2412 driveRunCycle). One clip = one cycle of 2pi / 0.6662 position units.
 */
export const WALK = { FREQUENCY: 0.6662, POSITION_PER_BLOCK: 4, MAX_POSITION_PER_TICK: 1 } as const;
export function walkStrideBlocks(speedBps: number): number {
  const d = Math.max(1e-6, speedBps) / 20;
  const positionPerTick = Math.min(WALK.POSITION_PER_BLOCK * d, WALK.MAX_POSITION_PER_TICK);
  const cyclesPerTick = (positionPerTick * WALK.FREQUENCY) / (2 * Math.PI);
  return d / cyclesPerTick;
}
export type StrideGait = "gait" | "walk";
export const strideBlocks = (gait: StrideGait, speedBps: number) => (gait === "gait" ? crawlStrideBlocks(speedBps) : walkStrideBlocks(speedBps));
/** Phase (0..1, wrapped) after walking `distance` blocks at a steady `speedBps`. */
export function stridePhase(gait: StrideGait, distance: number, speedBps: number): number {
  const cycles = distance / strideBlocks(gait, speedBps);
  return cycles - Math.floor(cycles);
}

// ================================================================== whole-body spin (BodyAttitude)

/** Angular-speed knots (progress, relative speed): BodyAttitude.java:301-303. */
export type Profile = ReadonlyArray<readonly [number, number]>;
export const FLIP_PROFILE: Profile = [[0, 0], [0.15, 0.35], [0.3, 1.7], [0.65, 1.7], [0.8, 0.7], [1, 0]];
export const TWIST_PROFILE: Profile = [[0, 0], [0.1, 0.6], [0.2, 1.5], [0.7, 1.5], [0.85, 0.6], [1, 0]];

/** Integral of the speed profile 0..p; each segment eases between its knots' speeds with a SMOOTHSTEP (BodyAttitude.java:321-331). */
export function profileArea(knots: Profile, p: number): number {
  let sum = 0;
  for (let i = 0; i + 1 < knots.length && p > knots[i][0]; i++) {
    const length = knots[i + 1][0] - knots[i][0];
    const t = Math.min(1, (p - knots[i][0]) / length);
    const from = knots[i][1];
    const to = knots[i + 1][1];
    sum += length * (from * t + (to - from) * (t * t * t - (t * t * t * t) / 2));
  }
  return sum;
}
/** Speed at progress p (smoothstep between knots; the derivative of `profileArea`). */
export function profileSpeed(knots: Profile, p: number): number {
  const x = Math.min(1, Math.max(0, p));
  for (let i = 0; i + 1 < knots.length; i++) {
    if (x <= knots[i + 1][0]) {
      const t = (x - knots[i][0]) / (knots[i + 1][0] - knots[i][0]);
      return knots[i][1] + (knots[i + 1][1] - knots[i][1]) * (t * t * (3 - 2 * t));
    }
  }
  return knots[knots.length - 1][1];
}
export interface TrickAxisDef {
  /** Signs of the X (pitch, + = head goes back), Y (yaw, + = twist left) and Z (roll, + = head over to the left) spins, BODY frame. */
  pitch: number;
  yaw: number;
  roll: number;
}
/** BodyAttitude.TrickAxis (BodyAttitude.java:108-135), keyed by the pose set's `spin.axis`. */
export const TRICK_AXES: Readonly<Record<string, TrickAxisDef>> = {
  front_flip: { pitch: -1, yaw: 0, roll: 0 },
  back_flip: { pitch: 1, yaw: 0, roll: 0 },
  twist_left: { pitch: 0, yaw: 1, roll: 0 },
  twist_right: { pitch: 0, yaw: -1, roll: 0 },
  cartwheel_left: { pitch: 0, yaw: 0, roll: 1 },
  cartwheel_right: { pitch: 0, yaw: 0, roll: -1 },
  corkscrew_left: { pitch: 1, yaw: 1, roll: 0 },
  corkscrew_right: { pitch: 1, yaw: -1, roll: 0 },
  twist_dive_left: { pitch: -1, yaw: 1, roll: 0 },
  twist_dive_right: { pitch: -1, yaw: -1, roll: 0 },
};
export const twistOnly = (a: TrickAxisDef) => a.yaw !== 0 && a.pitch === 0 && a.roll === 0;
/** `BodyAttitude.trickAngle`: monotonic, exactly 360 * turns at progress 1 (BodyAttitude.java:314-318). */
export function trickAngle(axis: string, turns: number, progress: number): number {
  const a = TRICK_AXES[axis];
  if (!a) return 0;
  const profile = twistOnly(a) ? TWIST_PROFILE : FLIP_PROFILE;
  const p = Math.min(1, Math.max(0, progress));
  return 360 * turns * (profileArea(profile, p) / profileArea(profile, 1));
}
/** `BodyAttitude.trickRotation`: JOML `rotateX(pitchSign r)`, `rotateZ(rollSign r)`, `rotateY(yawSign r)` post-multiplied = Rx * Rz * Ry (BodyAttitude.java:158-164). BODY/SCENE frame. */
export function trickRotation(axis: string, trickDeg: number): Quat {
  const a = TRICK_AXES[axis];
  if (!a) return [0, 0, 0, 1];
  let q: Quat = [0, 0, 0, 1];
  if (a.pitch) q = quatMul(q, quatFromAxisAngle([1, 0, 0], a.pitch * trickDeg));
  if (a.roll) q = quatMul(q, quatFromAxisAngle([0, 0, 1], a.roll * trickDeg));
  if (a.yaw) q = quatMul(q, quatFromAxisAngle([0, 1, 0], a.yaw * trickDeg));
  return q;
}

// ---- the hinge the spin turns about: TrickHinge (the tucked body's centre of mass) + the clip's swing_pivot offset

/** `PlayerEntityRenderer.scale` and the root shift (TrickHinge.java:11-13). */
export const MODEL_SCALE = 0.9375;
export const ROOT_OFFSET = 1.501;
/** Rough mass shares: head, trunk, each arm, each leg (TrickHinge.java:14). */
const HEAD = 0.08, TRUNK = 0.46, ARM = 0.05, LEG = 0.18;
/** Limb order everywhere below: head, right arm, left arm, right leg, left leg. */
export const HINGE_LIMBS = ["armorHead", "armorRightArm", "armorLeftArm", "armorRightLeg", "armorLeftLeg"] as const;

/** `new Quaternionf().rotationZYX(roll, yaw, pitch)` applied to v (Rz * Ry * Rx), angles in radians. */
function rotZYX(v: NumVec3, pitch: number, yaw: number, roll: number): NumVec3 {
  const qz = quatFromAxisAngle([0, 0, 1], roll * R2D);
  const qy = quatFromAxisAngle([0, 1, 0], yaw * R2D);
  const qx = quatFromAxisAngle([1, 0, 0], pitch * R2D);
  return quatRotate(quatMul(qz, quatMul(qy, qx)), v);
}
/**
 * `TrickHinge.centre` (TrickHinge.java:24-36): centre of mass of the posed body as {y, z} in blocks (above the feet, behind the body's
 * front), from the five limbs' ModelPart angles in RADIANS (head, right arm, left arm, right leg, left leg). The trunk stays upright.
 */
export function trickCentre(pitch: readonly number[], yaw: readonly number[], roll: readonly number[]): { y: number; z: number } {
  let sy = 0, sz = 0;
  const add = (mass: number, px: number, py: number, pz: number, cx: number, cy: number, cz: number, p: number, yw: number, r: number) => {
    const c = rotZYX([cx, cy, cz], p, yw, r);
    sy += mass * (py + c[1]);
    sz += mass * (pz + c[2]);
    void px;
  };
  add(HEAD, 0, 0, 0, 0, -4, 0, pitch[0], yaw[0], roll[0]);
  add(TRUNK, 0, 0, 0, 0, 6, 0, 0, 0, 0);
  add(ARM, -5, 2, 0, -1, 4, 0, pitch[1], yaw[1], roll[1]);
  add(ARM, 5, 2, 0, 1, 4, 0, pitch[2], yaw[2], roll[2]);
  add(LEG, -1.9, 12, 0, 0, 6, 0, pitch[3], yaw[3], roll[3]);
  add(LEG, 1.9, 12, 0, 0, 6, 0, pitch[4], yaw[4], roll[4]);
  return { y: MODEL_SCALE * (ROOT_OFFSET - sy / 16), z: (MODEL_SCALE * sz) / 16 };
}
/** blocks (the world the renderer translates in) -> model px of Ace's unscaled rig. */
export const blocksToPx = (b: number) => (b * 16) / MODEL_SCALE;

/**
 * The hinge the running trick turns about (TetherClient.java:2455-2470 `trickCentre`): centre of mass of the clip's pose at this
 * progress, plus the clip's authored `swing_pivot` offset (blocks, +up: the file Y / 16, ClipPoseLibrary.java:278).
 * `limbDeg` = file rotations of the five limbs (missing -> 0, as an unauthored limb), `pivotY` = swing_pivot position Y in px.
 */
export function trickHinge(limbDeg: ReadonlyArray<NumVec3 | undefined>, pivotYpx: number | undefined): { y: number; z: number } {
  const p = limbDeg.map((v) => (v ? v[0] * D2R : 0));
  const y = limbDeg.map((v) => (v ? v[1] * D2R : 0));
  const r = limbDeg.map((v) => (v ? v[2] * D2R : 0));
  const c = trickCentre(p, y, r);
  return { y: c.y + (pivotYpx === undefined ? 0 : pivotYpx / 16), z: c.z };
}

export interface SpinFrame {
  /** Whole-body rotation in the SCENE frame. */
  quat: Quat;
  /** Where the live hinge sits in the unrotated body / where it is held (scene px; x = 0). */
  live: NumVec3;
  base: NumVec3;
  /** Spin angle (degrees) at this progress. */
  angle: number;
  /** p -> base + R (p - live) */
  position: NumVec3;
}
/**
 * `BodyAttitudeRenderer.apply` (BodyAttitudeRenderer.java:44-52) with no lean / bank / spine spin: translate(0, base, baseZ), turn by
 * the trick rotation, translate(0, -live, -liveZ) -> p' = base + R (p - live). `base` is the hinge at the trick's first frame,
 * `live` the hinge now.
 */
export function spinFrame(axis: string, turns: number, progress: number, base: { y: number; z: number }, live: { y: number; z: number }): SpinFrame {
  const angle = trickAngle(axis, turns, progress);
  const quat = trickRotation(axis, angle);
  const L: NumVec3 = [0, blocksToPx(live.y), blocksToPx(live.z)];
  const B: NumVec3 = [0, blocksToPx(base.y), blocksToPx(base.z)];
  const rl = quatRotate(quat, L);
  return { quat, live: L, base: B, angle, position: [B[0] - rl[0], B[1] - rl[1], B[2] - rl[2]] };
}
/** Tick length of a spin: the pose set's `spin.ticks`, else the clip's own length (the trick's clip is walked 0..1 across it). */
export const spinSeconds = (spinTicks: number, clipLength: number) => (spinTicks > 0 ? spinTicks / 20 : clipLength);

// ================================================================== live aim (LimbDriver.aimFrom)

/** Below this |sin pitch| the arm is along its own yaw axis; above YAW_TRUSTED the pointing yaw is fully trusted (LimbDriver.java:1335-1337). */
const YAW_DEGENERATE = 0.08, YAW_TRUSTED = 0.35;
/** How far round the shoulder an arm may swing (LimbDriver.java:1519-1520, 1530-1536). */
const SHOULDER_BEHIND = 150 * D2R, SHOULDER_ACROSS = 40 * D2R;
const wrap = (a: number) => { let r = a % (2 * Math.PI); if (r > Math.PI) r -= 2 * Math.PI; if (r < -Math.PI) r += 2 * Math.PI; return r; };

/** `LimbDriver.stableYaw` (LimbDriver.java:1784-1788). */
export function stableYaw(raw: number, sinPitch: number, held: number): number {
  let t = Math.min(1, Math.max(0, (sinPitch - YAW_DEGENERATE) / (YAW_TRUSTED - YAW_DEGENERATE)));
  t = t * t * (3 - 2 * t);
  return held + wrap(raw - held) * t;
}
/** `LimbDriver.shoulderYaw` (LimbDriver.java:1530-1536). */
export function shoulderYaw(yaw: number, rightArm: boolean, current: number): number {
  const low = rightArm ? -SHOULDER_ACROSS : -SHOULDER_BEHIND;
  const high = rightArm ? SHOULDER_BEHIND : SHOULDER_ACROSS;
  const w = wrap(yaw);
  if (w >= low && w <= high) return w;
  return Math.abs(wrap(current - low)) <= Math.abs(wrap(current - high)) ? low : high;
}
export type AimKind = "right_arm" | "left_arm" | "right_leg" | "left_leg";
/**
 * ModelPart pitch / yaw (DEGREES, the same numbers a file holds) that point a limb hanging from `joint` at `target`, both in SCENE
 * px (= the upright body frame, no lean or bank). `LimbDriver.aimFrom` (LimbDriver.java:1768-1781): flip x and y into model space, then
 * pitch = -acos(ty), yaw = atan2(-tx, -tz) eased in from the held yaw; arms get the shoulder's range (LimbDriver.point, :1490-1497).
 */
export function aimAngles(kind: AimKind, joint: NumVec3, target: NumVec3, heldYawDeg = 0): { pitch: number; yaw: number } {
  const d: NumVec3 = [target[0] - joint[0], target[1] - joint[1], target[2] - joint[2]];
  const len = Math.hypot(d[0], d[1], d[2]);
  if (len < 1e-6) return { pitch: -90, yaw: heldYawDeg };
  const tx = -d[0] / len, ty = -d[1] / len, tz = d[2] / len;
  const pitch = -Math.acos(Math.min(1, Math.max(-1, ty)));
  const held = heldYawDeg * D2R;
  let yaw = stableYaw(Math.atan2(-tx, -tz), Math.abs(Math.sin(pitch)), held);
  if (kind === "right_arm" || kind === "left_arm") yaw = shoulderYaw(yaw, kind === "right_arm", held);
  return { pitch: pitch * R2D, yaw: yaw * R2D };
}
