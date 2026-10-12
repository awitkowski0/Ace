/**
 * Flight profiles (data/<ns>/flight_profiles/*.json), as the pack editor places things: where a jet's flame comes out and which
 * way it points, how big it is at a given speed, how the propelled pose holds the arms and legs, and the minimal edits that
 * write a jet's `offset` / `angle` or a pose value. All of the math is here, pure, so it can be tested.
 *
 * Ported from the game (Thematic-Collections, src/common/java/bond/thematic/api):
 *   - jet position:   flight/FlightJets.java `anchor` (~l.176): body-frame (right, up, forward) = (-OFFSETS[0] + offset.right/16,
 *                     OFFSETS[1]*height + offset.up/16, OFFSETS[2] + offset.forward/16)
 *   - jet direction:  content/flight/JetFlameMath.java `baseAim` (l.127) then `turn` (l.147)
 *   - flame size:     JetFlameMath.length / width (l.43-59)
 *   - propelled pose: client/appearance/BipedGeoPoser.java `poseFlight` (~l.98), content/flight/FlightProfile.Poses
 *
 * ASSUMPTION (jet `offset` / `angle`): as implemented in the Thematic working tree at the time of writing, and still to be
 * confirmed by the Thematic session. `offset` is [right, up, forward] in model pixels, `angle` is [pitch, yaw, roll] degrees
 * that turn the aim (after `aim` picked the base direction): roll first (up toward right), then pitch (forward toward down),
 * then yaw (forward toward right). A jet anchored on a body (head / body) is fixed in the body frame; one anchored on a limb
 * (arm, palm, leg, foot) is carried by that limb's live pose, so its offset and angle are relative to the limb (`followLimb`).
 * If the confirmed semantics differ, only `jetFrame`, `turnDir`, `followLimb` and the angle/quaternion pair change.
 *
 * Scene space is the Studio's (anchors.ts): model pixels, +X the wearer's right, +Y up, -Z forward. The game's body frame is
 * (right, up, forward), so scene = (right, up, -forward).
 */
import type { NumVec3 } from "../../animstudio/core";
import type { Pose } from "../../animstudio/core/sample";
import { getIn, parseJson, toValue } from "../../animstudio/core/format/json";
import { minimalEdit } from "../../animstudio/core";
import { setJson } from "./suit";

export type Aim = "down" | "palm";
export const AIMS: readonly Aim[] = ["down", "palm"];
/** A jet anchor's frame in the scene: where it sits and the axes `offset` is written along (identity: the body frame). */
export interface JetAnchorFrame { origin: NumVec3; x: NumVec3; y: NumVec3; z: NumVec3 }
export interface JetPlacement { pos: NumVec3; dir: NumVec3 }

const D2R = Math.PI / 180;
const PX = 16;
const ZERO: NumVec3 = [0, 0, 0];
export const isZero3 = (v: readonly number[] | undefined) => !v || v.every((n) => n === 0);

/** JetFlameMath.baseAim: (right, up, forward) before `angle`. `side` is 1 on the body's right, -1 on its left. */
export function baseAim(aim: Aim | string | undefined, side: number, groundDash = false): NumVec3 {
  if (aim === "palm") return [side * 0.5, -0.6, -0.62];
  if (groundDash) return [0, -0.4, -0.917]; // a `dash` jet with the feet on the ground
  return [0, -1, 0];
}

/** JetFlameMath.turn: turns (right, up, forward) by pitch, yaw, roll degrees - roll, then pitch, then yaw. */
export function turnDir(dir: NumVec3, angle: NumVec3): NumVec3 {
  const [pitch, yaw, roll] = angle;
  const r = roll * D2R;
  const x = dir[0] * Math.cos(r) + dir[1] * Math.sin(r);
  const y = -dir[0] * Math.sin(r) + dir[1] * Math.cos(r);
  const z = dir[2];
  const p = pitch * D2R;
  const y2 = y * Math.cos(p) - z * Math.sin(p);
  const z2 = y * Math.sin(p) + z * Math.cos(p);
  const w = yaw * D2R;
  return [x * Math.cos(w) + z2 * Math.sin(w), y2, -x * Math.sin(w) + z2 * Math.cos(w)];
}

const norm = (v: NumVec3): NumVec3 => {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
};

/**
 * Where a jet's flame starts and which way it points, in scene space.
 * `anchor` is the jet anchor's frame, `aim` the jet's `aim`, `offset` [right, up, forward] px and `angle` [pitch, yaw, roll]
 * degrees (both default to zero). The direction is a unit vector (the game's palm vector is 0.997 long; the flame cone does not
 * care).
 */
export function jetFrame(anchor: JetAnchorFrame, aim: Aim | string | undefined, offset: NumVec3 = ZERO, angle: NumVec3 = ZERO): JetPlacement {
  // body frame (right, up, forward) -> scene
  const toScene = (v: NumVec3): NumVec3 => {
    const s: NumVec3 = [v[0], v[1], -v[2]];
    return [0, 1, 2].map((i) => anchor.x[i] * s[0] + anchor.y[i] * s[1] + anchor.z[i] * s[2]) as NumVec3;
  };
  const o = toScene(offset);
  const side = Math.sign(anchor.origin[0]);
  const dir = toScene(turnDir(baseAim(aim, side), angle));
  return { pos: [anchor.origin[0] + o[0], anchor.origin[1] + o[1], anchor.origin[2] + o[2]], dir: norm(dir) };
}

/** The `offset` a gizmo drag of `delta` scene px lands on, from the offset the drag started at. Inverse of jetFrame's offset. */
export function offsetForDelta(anchor: JetAnchorFrame, start: NumVec3, delta: NumVec3): NumVec3 {
  const d = [0, 1, 2].map((k) => {
    const ax = k === 0 ? anchor.x : k === 1 ? anchor.y : anchor.z;
    return ax[0] * delta[0] + ax[1] * delta[1] + ax[2] * delta[2];
  });
  return [start[0] + d[0], start[1] + d[1], start[2] - d[2]];
}

// ---------------------------------------------------------------- angle <-> rotation (for the rotate gizmo)

export type M3 = [NumVec3, NumVec3, NumVec3];

/** The rotation `turnDir` applies, as a matrix on (right, up, forward): yaw * pitch * roll. */
export function angleMatrix(angle: NumVec3): M3 {
  const [p, w, r] = angle.map((a) => a * D2R);
  const [cp, sp, cw, sw, cr, sr] = [Math.cos(p), Math.sin(p), Math.cos(w), Math.sin(w), Math.cos(r), Math.sin(r)];
  return [
    [cw * cr - sw * sp * sr, cw * sr + sw * sp * cr, sw * cp],
    [-cp * sr, cp * cr, -sp],
    [-sw * cr - cw * sp * sr, -sw * sr + cw * sp * cr, cw * cp],
  ];
}

/** The angle [pitch, yaw, roll] of a rotation matrix on (right, up, forward). Inverse of angleMatrix. */
export function matrixAngle(m: M3): NumVec3 {
  const sp = Math.max(-1, Math.min(1, -m[1][2]));
  const pitch = Math.asin(sp);
  let yaw: number, roll: number;
  if (Math.abs(sp) > 0.999999) { yaw = 0; roll = Math.atan2(m[0][1], m[0][0]); } // looking straight along the up axis: yaw and roll are one turn
  else { yaw = Math.atan2(m[0][2], m[2][2]); roll = Math.atan2(-m[1][0], m[1][1]); }
  return [pitch / D2R, yaw / D2R, roll / D2R];
}

// scene = body with forward negated, a reflection S; a rotation R of the body frame is S R S in the scene
const refl = (m: M3): M3 => m.map((row, i) => row.map((v, j) => ((i === 2 ? -1 : 1) * (j === 2 ? -1 : 1)) * v)) as M3;

export type Quat = [number, number, number, number];

function matQuat(m: M3): Quat {
  const t = m[0][0] + m[1][1] + m[2][2];
  let q: Quat;
  if (t > 0) { const s = Math.sqrt(t + 1) * 2; q = [(m[2][1] - m[1][2]) / s, (m[0][2] - m[2][0]) / s, (m[1][0] - m[0][1]) / s, s / 4]; }
  else if (m[0][0] > m[1][1] && m[0][0] > m[2][2]) { const s = Math.sqrt(1 + m[0][0] - m[1][1] - m[2][2]) * 2; q = [s / 4, (m[0][1] + m[1][0]) / s, (m[0][2] + m[2][0]) / s, (m[2][1] - m[1][2]) / s]; }
  else if (m[1][1] > m[2][2]) { const s = Math.sqrt(1 + m[1][1] - m[0][0] - m[2][2]) * 2; q = [(m[0][1] + m[1][0]) / s, s / 4, (m[1][2] + m[2][1]) / s, (m[0][2] - m[2][0]) / s]; }
  else { const s = Math.sqrt(1 + m[2][2] - m[0][0] - m[1][1]) * 2; q = [(m[0][2] + m[2][0]) / s, (m[1][2] + m[2][1]) / s, s / 4, (m[1][0] - m[0][1]) / s]; }
  return q;
}

function quatMat([x, y, z, w]: Quat): M3 {
  const n = Math.hypot(x, y, z, w) || 1;
  [x, y, z, w] = [x / n, y / n, z / n, w / n];
  return [
    [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
    [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
    [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)],
  ];
}

/** The scene-space orientation (x, y, z, w) a rotate gizmo shows for `angle`; `limb` is the rotation of the limb carrying the jet (`limbRotation`). */
export const angleToQuat = (angle: NumVec3, limb?: M3 | null): Quat => matQuat(refl(limb ? mul3(limb, angleMatrix(angle)) : angleMatrix(angle)));
/** The `angle` for a scene-space orientation the rotate gizmo ended on (undoing the limb's rotation first). */
export const quatToAngle = (q: Quat, limb?: M3 | null): NumVec3 => matrixAngle(limb ? mul3(tr3(limb), refl(quatMat(q))) : refl(quatMat(q)));

// ---------------------------------------------------------------- jets that ride a limb

export type Limb = "rightArm" | "leftArm" | "rightLeg" | "leftLeg";
const LIMB_OF: Record<string, Limb> = { rightArm: "rightArm", rightPalm: "rightArm", leftArm: "leftArm", leftPalm: "leftArm", rightLeg: "rightLeg", rightFoot: "rightLeg", leftLeg: "leftLeg", leftFoot: "leftLeg" };
/** The limb a jet anchor hangs from; head and body (and anything unknown) stay in the body frame. */
export const limbOf = (anchor: string): Limb | null => LIMB_OF[anchor] ?? null;
/** Rest pivots in the jet frame G = (right, up, forward), px, feet at y = 0: shoulders at (+-5, 22), hips at (+-1.9, 12). */
export const LIMB_PIVOT: Record<Limb, NumVec3> = { rightArm: [5, 22, 0], leftArm: [-5, 22, 0], rightLeg: [1.9, 12, 0], leftLeg: [-1.9, 12, 0] };
/** The preview Pose's bone of a limb (the armor bones of the geo file). */
const limbBone = (l: Limb) => "armor" + l[0].toUpperCase() + l.slice(1);

const mul3 = (a: M3, b: M3): M3 => a.map((r) => [0, 1, 2].map((j) => r[0] * b[0][j] + r[1] * b[1][j] + r[2] * b[2][j])) as M3;
const tr3 = (m: M3): M3 => [0, 1, 2].map((j) => [m[0][j], m[1][j], m[2][j]]) as M3;
const app3 = (m: M3, v: NumVec3): NumVec3 => [m[0][0] * v[0] + m[0][1] * v[1] + m[0][2] * v[2], m[1][0] * v[0] + m[1][1] * v[1] + m[1][2] * v[2], m[2][0] * v[0] + m[2][1] * v[1] + m[2][2] * v[2]];

/**
 * R = Rz(zRot) Ry(yRot) Rx(xRot) of a limb's file rotation [x, y, z] degrees, standard right-handed matrices applied in G.
 * The file's limb angles ARE the game's vanilla ModelPart angles (GeckoLibSerializer.readCollection only negates the body, torso
 * and head; poseFlight / thematic$propelledLimbs write the same numbers for the arms and legs), and vanilla's model frame is
 * M = -G (x right to left, y up to down, z front to back), which cancels out of a rotation: G = -M so R_G = R_M.
 * Checks: right leg xRot > 0 swings the foot backward, right arm zRot > 0 swings the hand out to the right.
 */
export function limbMatrix(rot: NumVec3): M3 {
  const [x, y, z] = rot.map((a) => a * D2R);
  const [cx, sx, cy, sy, cz, sz] = [Math.cos(x), Math.sin(x), Math.cos(y), Math.sin(y), Math.cos(z), Math.sin(z)];
  const rx: M3 = [[1, 0, 0], [0, cx, -sx], [0, sx, cx]];
  const ry: M3 = [[cy, 0, sy], [0, 1, 0], [-sy, 0, cy]];
  const rz: M3 = [[cz, -sz, 0], [sz, cz, 0], [0, 0, 1]];
  return mul3(rz, mul3(ry, rx));
}

/** How a pose moves a jet anchor's limb: `R` (G frame) about the rest pivot, and the pivot's own displacement `shift` (G px). Null: it stays put. */
export interface LimbMove { R: M3; pivot: NumVec3; shift: NumVec3 }
/**
 * `pose` is the preview Pose (file convention: rotation degrees, position px). The pivot's displacement is the part's
 * position delta: a file position [x, y, z] is the vanilla ModelPart delta (x, -y, z) (GeckoLibSerializer negates Y), and G = -M,
 * so in G it is (-x, y, -z) px - the same move RigView.setPose makes in the scene.
 */
export function limbMove(anchor: string, pose: Pose | null | undefined): LimbMove | null {
  const limb = limbOf(anchor);
  const b = limb ? pose?.[limbBone(limb)] : undefined;
  if (!limb || (!b?.rotation && !b?.position)) return null;
  const p = b.position ?? ZERO;
  return { R: limbMatrix(b.rotation ?? ZERO), pivot: LIMB_PIVOT[limb], shift: [-p[0], p[1], -p[2]] };
}
/** The limb's rotation alone (for the rotate gizmo); null when the jet does not ride a limb or the limb is not turned. */
export const limbRotation = (anchor: string, pose: Pose | null | undefined): M3 | null => limbMove(anchor, pose)?.R ?? null;

/**
 * Carry a jet by its limb. `point` (px) and `aim` (unit) are in the jet frame G = (right, up, forward) at rest - anchor plus
 * offset, and the base aim turned by `angle` - and come back as posedPivot + R (P - restPivot) and R aim.
 */
export function followLimb(anchor: string, pose: Pose | null | undefined, point: NumVec3, aim: NumVec3): { point: NumVec3; aim: NumVec3 } {
  const m = limbMove(anchor, pose);
  if (!m) return { point, aim };
  const d = app3(m.R, [point[0] - m.pivot[0], point[1] - m.pivot[1], point[2] - m.pivot[2]]);
  return { point: [m.pivot[0] + m.shift[0] + d[0], m.pivot[1] + m.shift[1] + d[1], m.pivot[2] + m.shift[2] + d[2]], aim: app3(m.R, aim) };
}

/** `followLimb` for a scene-space placement (scene = G with forward negated). */
export function followPlacement(anchor: string, pose: Pose | null | undefined, p: JetPlacement): JetPlacement {
  if (!limbMove(anchor, pose)) return p;
  const r = followLimb(anchor, pose, [p.pos[0], p.pos[1], -p.pos[2]], [p.dir[0], p.dir[1], -p.dir[2]]);
  return { pos: [r.point[0], r.point[1], -r.point[2]], dir: norm([r.aim[0], r.aim[1], -r.aim[2]]) };
}

/** A drag of `delta` scene px of a posed jet, as the same move in the limb's rest frame (inverse R), where `offset` is written. */
export function restDelta(anchor: string, pose: Pose | null | undefined, delta: NumVec3): NumVec3 {
  const R = limbRotation(anchor, pose);
  if (!R) return delta;
  const g = app3(tr3(R), [delta[0], delta[1], -delta[2]]);
  return [g[0], g[1], -g[2]];
}

// ---------------------------------------------------------------- flame size

export const FULL_SPEED = 0.9; // blocks per tick (JetFlameMath.FULL_SPEED)
const STRETCH = 1.6;
const NARROW = 0.4;
export interface FlameSize { length: number; width: number }
/** JetFlameMath.length (with the `hover` share) and width, in blocks, for a flame at `speed01` (0 hover .. 1 full speed). */
export function flameSize(flame: { length?: number; width?: number; hover?: number } | undefined, speed01: number): FlameSize {
  const base = flame?.length ?? 0.9;
  const w = flame?.width ?? 0.12;
  const rest = Math.max(0, Math.min(1, flame?.hover ?? 1));
  return { length: base * (rest + (1 + STRETCH - rest) * speed01), width: w * (1 - NARROW * speed01) };
}

/** One cone of a drawn flame: apex `length` px out from the nozzle along the jet's direction, `radius` px at its base. */
export interface Cone { length: number; radius: number; color: string; alpha: number }
export const FLAME_DEFAULTS = { core: "#FFF3B0", outer: "#FF4A1C", length: 0.9, width: 0.12, flicker: 0.25, glow: 1, hover: 1 } as const; // FlightProfile.Flame.fromJson (~l.452)
export const GLOW_ON_DEFAULT = 0.45; // what the shipped repulsor uses

/**
 * The cones JetFlameRenderer.drawFlame (l.267-295) draws for a flame at `speed01`, without the flicker: the outer cone
 * (l.288: alpha 0.62), the core inside it (l.289: 0.62 as long, 0.45 as wide, alpha 0.95) and the nozzle's heat glow
 * (l.291-294: a short, wide cone - 1.6 and 2.4 radii - in the outer colour, only when `glow` > 0). Lengths in px.
 */
export function flameCones(flame: { core?: string; outer?: string; length?: number; width?: number; glow?: number; hover?: number }, speed01: number): Cone[] {
  const { length, width } = flameSize(flame, speed01);
  const [L, r] = [length * PX, width * PX];
  const core = flame.core ?? FLAME_DEFAULTS.core, outer = flame.outer ?? FLAME_DEFAULTS.outer;
  const glow = flame.glow ?? FLAME_DEFAULTS.glow;
  const out: Cone[] = [{ length: L, radius: r, color: outer, alpha: 0.62 }, { length: L * 0.62, radius: r * 0.45, color: core, alpha: 0.95 }];
  if (glow > 0) out.push({ length: r * 1.6, radius: r * 2.4, color: outer, alpha: 0.35 * glow });
  return out;
}

/**
 * The anti-gravity pad under each foot (JetFlameRenderer.drawAntiGrav l.203-230): a short wide faint cone pointing down off the sole
 * (l.216: length 0.45 size, radius size, alpha 0.38), and in flight a streak (l.224-228). The breathing and the ripples move, so
 * they are left out. Sizes in blocks in the profile, px here.
 */
export function antiGravCones(ag: { color?: string; size?: number; streak?: number }, speed01: number): Cone[] {
  const size = (ag.size ?? 0.3) * PX, color = ag.color ?? "#FF1F3F", streak = ag.streak ?? 0.6;
  const out: Cone[] = [{ length: size * 0.45, radius: size, color, alpha: 0.38 }];
  if (streak > 0 && speed01 > 0.05) out.push({ length: streak * speed01 * PX, radius: size * 0.3, color, alpha: 0.3 * Math.min(1, speed01 * 1.5) });
  return out;
}

// ---------------------------------------------------------------- the propelled pose

export const POSE_KEYS = ["armOut", "armHover", "armBack", "armTwist", "legSpread", "legTilt", "bob"] as const;
export type PoseKey = (typeof POSE_KEYS)[number];
/** FlightProfile.Poses.DEFAULT_*: what a profile gets for any value neither it nor its parents write. */
export const POSE_DEFAULTS: Record<PoseKey, number> = { legSpread: 0, legTilt: 16, bob: 2.5, armBack: 14, armOut: 2, armHover: 0, armTwist: 0 };
export const POSE_INFO: Record<PoseKey, { label: string; doc: string; min: number; max: number; step: number }> = {
  armOut: { label: "Arms out (sideways)", doc: "Degrees each arm swings out from the body sideways. The 'arms angle left and right' of a propelled flyer.", min: -90, max: 90, step: 0.5 },
  armHover: { label: "Arms back at hover", doc: "Arm pitch in degrees at rest (hovering). Positive swings the arms back.", min: -90, max: 90, step: 0.5 },
  armBack: { label: "Arms back at full speed", doc: "Arm pitch in degrees at full speed. Positive swings the arms back.", min: -90, max: 90, step: 0.5 },
  armTwist: { label: "Arm twist", doc: "Turns each arm about its own length, degrees (palms inward / outward).", min: -90, max: 90, step: 0.5 },
  legSpread: { label: "Leg spread", doc: "Degrees the legs splay apart.", min: -45, max: 45, step: 0.5 },
  legTilt: { label: "Leg tilt", doc: "Degrees both legs trail back (a quarter of it at rest, all of it at full speed).", min: -45, max: 90, step: 0.5 },
  bob: { label: "Bob", doc: "Degrees the legs bob up and down over time (not shown in the preview).", min: 0, max: 15, step: 0.1 },
};

export type PoseValues = Record<PoseKey, number>;
/** FlightProfile.Poses.armPitchDegrees: `armHover` at rest, `armBack` at full speed. */
export const armPitchDegrees = (p: PoseValues, speed01: number) => p.armHover + (p.armBack - p.armHover) * speed01;
/** JetFlameMath.legPitchDegrees: a quarter of the tilt at rest, all of it at full speed. */
export const legPitchDegrees = (tilt: number, speed01: number) => tilt * (0.25 + 0.75 * speed01);

/**
 * The preview pose of the `propelled` style (BipedGeoPoser.poseFlight), in the geo file's rotation convention (what
 * RigView.setPose takes, Blockbench's). BoneHandle values are GeckoLib's, negated on X and Y against the file, and poseFlight
 * writes them as -pitch / -twist, so in the file a positive X swings the limb back (the game's own vanilla-convention degrees),
 * the right arm's Y is +armTwist, and Z is as the game writes it (the right arm's `armOut`, the left's `-armOut`).
 */
export function propelledPose(p: PoseValues, speed01: number): Pose {
  const arm = armPitchDegrees(p, speed01);
  const leg = legPitchDegrees(p.legTilt, speed01);
  return {
    armorRightArm: { rotation: [arm, p.armTwist, p.armOut] },
    armorLeftArm: { rotation: [arm, -p.armTwist, -p.armOut] },
    armorRightLeg: { rotation: [leg, 0, p.legSpread] },
    armorLeftLeg: { rotation: [leg, 0, -p.legSpread] },
    armorBody: { rotation: [0, 0, 0] },
  };
}

/** Pose values: this profile's own over its parents' (nearest first) over the defaults, FlightInheritance's per-key merge. */
export function effectivePose(own: Record<string, unknown> | undefined, chain: Array<Record<string, unknown> | undefined>): { values: PoseValues; inherited: Partial<Record<PoseKey, number>>; style?: string } {
  const values = { ...POSE_DEFAULTS };
  const inherited: Partial<Record<PoseKey, number>> = {};
  for (const k of POSE_KEYS) {
    const up = chain.find((c) => typeof c?.[k] === "number")?.[k] as number | undefined;
    if (up !== undefined) inherited[k] = up;
    const mine = own?.[k];
    values[k] = typeof mine === "number" ? mine : up ?? POSE_DEFAULTS[k];
  }
  const style = [own, ...chain].find((c) => typeof c?.style === "string")?.style as string | undefined;
  return { values, inherited, style };
}

/**
 * The player-animator clip ids a profile plays while hovering (`poses.hoverIdle`) and in fast flight (`poses.loop`): the nearest
 * profile up the chain that writes the key wins, and an explicit null clears it (undefined here), like FlightInheritance.
 */
export function effectiveClips(own: Record<string, unknown> | undefined, chain: Array<Record<string, unknown> | undefined>): { hoverIdle?: string; loop?: string } {
  const pick = (k: string) => {
    const hit = [own, ...chain].find((c) => c && Object.prototype.hasOwnProperty.call(c, k));
    const v = hit?.[k];
    return typeof v === "string" && v ? v : undefined;
  };
  return { hoverIdle: pick("hoverIdle"), loop: pick("loop") };
}

/** What a new flight profile id needs: lowercase `a-z 0-9 _`, and a name no profile of the namespace has. Null when it is fine. */
export function flightIdProblem(id: string, taken: readonly string[]): string | null {
  if (!id) return "Enter an id.";
  if (!/^[a-z0-9_]+$/.test(id)) return "Use lowercase letters, digits and _ only.";
  if (taken.some((t) => (t.includes(":") ? t.slice(t.indexOf(":") + 1) : t) === id)) return `A flight profile named ${id} already exists.`;
  return null;
}

/** The text of a new flight profile that only names its parent. */
export const newFlightProfileText = (parent: string) => `{\n  "parent": ${JSON.stringify(parent)}\n}\n`;

// ---------------------------------------------------------------- edits

const r2 = (n: number) => Math.round(n * 100) / 100;
const r1 = (n: number) => Math.round(n * 10) / 10;

/** The numbers of a jet's `offset` / `angle`, or zeros when the key is missing or malformed. */
export function readVec3(v: unknown): NumVec3 {
  return Array.isArray(v) && v.length === 3 && v.every((n) => typeof n === "number") ? [v[0], v[1], v[2]] : [0, 0, 0];
}

/** Write jet `index`'s `offset` or `angle`: the key is added when non-zero and removed when every value is zero. */
export function setJetVec(text: string, index: number, key: "offset" | "angle", v: NumVec3): string {
  const round = key === "offset" ? r2 : r1;
  const next = v.map(round) as NumVec3;
  const path = ["effects", "jets", index, key];
  return compactTriples(text, setJson(text, path, isZero3(next) ? undefined : next));
}

/** setJson writes a new array as `[ 1, 2, 3 ]`; inside the changed span only, write it the way jets are written: `[1, 2, 3]`. */
function compactTriples(before: string, after: string): string {
  if (before === after) return after;
  const e = minimalEdit(before, after);
  return after.slice(0, e.start) + after.slice(e.start, e.start + e.text.length).replace(/\[ ([^\[\]\n]*?) \]/g, "[$1]") + after.slice(e.start + e.text.length);
}

/** Write (or with undefined, remove) one pose value; an emptied `poses` object goes with its last key. */
export function setPoseValue(text: string, key: PoseKey, v: number | undefined): string {
  const out = setJson(text, ["poses", key], v === undefined ? undefined : Math.round(v * 100) / 100);
  if (v !== undefined) return out;
  const node = getIn(parseJson(out).root, ["poses"]);
  const poses = node ? toValue(node) : undefined;
  return poses && typeof poses === "object" && !Array.isArray(poses) && Object.keys(poses).length === 0 ? setJson(out, ["poses"], undefined) : out;
}

/** Whether a flame draws its nozzle glow (JetFlameRenderer l.291: only when glow > 0; the default is 1). */
export const glowOn = (flame: Record<string, unknown> | undefined) => (typeof flame?.glow === "number" ? flame.glow : FLAME_DEFAULTS.glow) > 0;

/**
 * Switch jet `index`'s nozzle glow: off writes `glow: 0`; on writes back `remembered` (the last non-zero glow the designer saw
 * for it) or 0.45 when there is none. A jet without a flame is left alone.
 */
export function setGlowEnabled(text: string, index: number, on: boolean, remembered?: number): string {
  const flame = getIn(parseJson(text).root, ["effects", "jets", index, "flame"]);
  if (!flame) return text;
  return setJson(text, ["effects", "jets", index, "flame", "glow"], on ? (remembered && remembered > 0 ? remembered : GLOW_ON_DEFAULT) : 0);
}

/** Copy the inherited jets into this profile (`effects.jets` replaces the parent's list whole, so all of them come along). */
export const overrideJets = (text: string, jets: Array<Record<string, unknown>>) => setJson(text, ["effects", "jets"], jets);
