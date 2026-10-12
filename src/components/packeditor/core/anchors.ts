/**
 * Where things come out of a suit: Thematic's anchor specs (`from:` of a beam / spray / projectile, AnchorSpec.java) and
 * flight-jet anchors (FlightProfile.Anchor), placed on a standing, rest-pose wearer the way the client draws them
 * (AnchorsClient.bonePose). Scene space is the Studio's: model pixels, +X the wearer's right, +Y up, -Z forward, feet at 0.
 */
import type { NumVec3 } from "../../animstudio/core";

export const POINTS = ["eyes", "head", "mouth", "chest", "main_hand", "off_hand", "right_hand", "left_hand", "feet", "arm"] as const;
export type PointName = (typeof POINTS)[number];
export type Relative = "facing" | "look" | "world";

export const POINT_DOC: Record<PointName, string> = {
  eyes: "Eye line, middle of the head",
  head: "Middle of the head",
  mouth: "Just under the eyes",
  chest: "Middle of the chest",
  main_hand: "The hand items are held in",
  off_hand: "The other hand",
  right_hand: "Right hand",
  left_hand: "Left hand",
  feet: "The ground under the wearer",
  arm: "End of an arm held out sideways",
};

export interface AnchorSpec {
  kind: "point" | "bone";
  point?: PointName;
  bone?: string;
  /** point: [right, up, forward] blocks; bone: [x, y, z] blocks in the bone's space */
  offset: NumVec3;
  relative: Relative;
  side?: "right" | "left";
  sweep?: number;
}

/** AnchorSpec.parse: a point name, `{point, offset?, relative?, side?, sweep?}` or `{bone, offset?}`. Null if unreadable. */
export function parseAnchor(v: unknown): AnchorSpec | null {
  if (typeof v === "string") return (POINTS as readonly string[]).includes(v) ? { kind: "point", point: v as PointName, offset: [0, 0, 0], relative: "facing" } : null;
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const off = Array.isArray(o.offset) && o.offset.length === 3 && o.offset.every((n) => typeof n === "number") ? (o.offset as NumVec3) : [0, 0, 0] as NumVec3;
  if (typeof o.bone === "string") return { kind: "bone", bone: o.bone, offset: off, relative: "facing" };
  if (typeof o.point === "string" && (POINTS as readonly string[]).includes(o.point)) {
    return {
      kind: "point", point: o.point as PointName, offset: off,
      relative: o.relative === "look" || o.relative === "world" ? o.relative : "facing",
      side: o.side === "left" ? "left" : o.side === "right" ? "right" : undefined,
      sweep: typeof o.sweep === "number" ? o.sweep : undefined,
    };
  }
  return null;
}

/** The plain JSON/JS value for a spec, as short as it can be written (a bare name when there is no offset). */
export function anchorValue(a: AnchorSpec): unknown {
  const zero = a.offset.every((n) => n === 0);
  if (a.kind === "bone") return zero ? { bone: a.bone } : { bone: a.bone, offset: a.offset };
  if (zero && a.relative === "facing" && !a.side && a.sweep === undefined) return a.point;
  const out: Record<string, unknown> = { point: a.point };
  if (!zero) out.offset = a.offset;
  if (a.relative !== "facing") out.relative = a.relative;
  if (a.side) out.side = a.side;
  if (a.sweep !== undefined) out.sweep = a.sweep;
  return out;
}

/** An anchor's frame in scene space: origin, and the local axes the client turns into (beam goes along `out`). */
export interface AnchorFrame { origin: NumVec3; x: NumVec3; y: NumVec3; z: NumVec3; out: NumVec3; bone: string }

const PX = 16;
const NECK = 24; // px
const EYE_LIFT = 0.2275 * PX;
const MOUTH_DROP = -0.12 * PX;
const HAND_SIDE = 0.35 * PX;
const HAND_HEIGHT = 0.6 * PX;
const CHEST = 1.3 * PX;

/**
 * Rest-pose frame of an anchor (AnchorsClient.bonePose, third person, no animation). `bonePivot` resolves a bone anchor's
 * bone (only used to label it; bone offsets are in model space from the feet).
 */
export function anchorFrame(a: AnchorSpec, mainRight = true): AnchorFrame {
  const p = a.point;
  if (a.kind === "bone") {
    const [x, y, z] = a.offset;
    return { origin: [x * PX, y * PX, z * PX], x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1], out: [0, 0, -1], bone: a.bone ?? "" };
  }
  const [r, u, f] = a.offset;
  if (p === "eyes" || p === "head" || p === "mouth") {
    // turned half about Y: +X the wearer's left, +Y up, +Z forward (out of the face)
    const y = NECK + EYE_LIFT + (p === "mouth" ? MOUTH_DROP : 0);
    return { origin: [r * PX, y + u * PX, -f * PX], x: [-1, 0, 0], y: [0, 1, 0], z: [0, 0, -1], out: [0, 0, -1], bone: "armorHead" };
  }
  if (p === "main_hand" || p === "off_hand" || p === "right_hand" || p === "left_hand" || p === "arm") {
    const left = p === "left_hand" || (p === "main_hand" && !mainRight) || (p === "off_hand" && mainRight) || (p === "arm" && a.side === "left");
    const sx = left ? -HAND_SIDE : HAND_SIDE;
    // turned half about X: +X right, +Y down (out of the hand), +Z backward; the arm form takes no offset
    const off: NumVec3 = p === "arm" ? [0, 0, 0] : [r * PX, -u * PX, f * PX];
    return { origin: [sx + off[0], HAND_HEIGHT - off[1], off[2]], x: [1, 0, 0], y: [0, -1, 0], z: [0, 0, 1], out: [0, -1, 0], bone: left ? "armorLeftArm" : "armorRightArm" };
  }
  const base = p === "chest" ? CHEST : 0;
  return { origin: [r * PX, base + u * PX, -f * PX], x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1], out: [0, 0, -1], bone: p === "feet" ? "" : "armorBody" };
}

/** A point in an anchor's local frame (blocks) to scene px. */
export function localToScene(fr: AnchorFrame, local: NumVec3): NumVec3 {
  const [a, b, c] = local.map((n) => n * PX);
  return [0, 1, 2].map((i) => fr.origin[i] + fr.x[i] * a + fr.y[i] * b + fr.z[i] * c) as NumVec3;
}

/**
 * Change of a point anchor's `offset` for a drag of `delta` scene px: the inverse of anchorFrame's mapping, so a gizmo
 * drag in the viewport lands back as `[right, up, forward]` blocks (or bone-space blocks).
 */
export function offsetForSceneDelta(a: AnchorSpec, delta: NumVec3): NumVec3 {
  const [dx, dy, dz] = delta.map((n) => n / PX);
  if (a.kind === "bone") return [a.offset[0] + dx, a.offset[1] + dy, a.offset[2] + dz];
  const p = a.point;
  if (p === "arm") return a.offset;
  if (p === "main_hand" || p === "off_hand" || p === "right_hand" || p === "left_hand") return [a.offset[0] + dx, a.offset[1] + dy, a.offset[2] + dz];
  return [a.offset[0] + dx, a.offset[1] + dy, a.offset[2] - dz];
}

// ---------------------------------------------------------------- flight jets

export const JET_ANCHORS = ["head", "body", "rightArm", "leftArm", "rightLeg", "leftLeg", "rightFoot", "leftFoot", "rightPalm", "leftPalm"] as const;
export type JetAnchor = (typeof JET_ANCHORS)[number];
/** FlightJets.OFFSETS: [side, share of height, forward]; negative side is the wearer's right. */
const JET_OFFSETS: Record<JetAnchor, NumVec3> = {
  head: [0, 0.92, 0], body: [0, 0.55, 0], rightArm: [-0.32, 0.7, 0], leftArm: [0.32, 0.7, 0], rightLeg: [-0.12, 0.2, 0], leftLeg: [0.12, 0.2, 0],
  rightFoot: [-0.12, 0.03, 0], leftFoot: [0.12, 0.03, 0], rightPalm: [-0.4, 0.4, 0], leftPalm: [0.4, 0.4, 0],
};
const REFERENCE_HEIGHT = 1.8;

/** Scene position of a jet anchor on a 1.8-block wearer. */
export function jetPosition(a: string): NumVec3 | null {
  const o = JET_OFFSETS[a as JetAnchor];
  if (!o) return null;
  return [-o[0] * PX, o[1] * REFERENCE_HEIGHT * PX, -o[2] * PX];
}
