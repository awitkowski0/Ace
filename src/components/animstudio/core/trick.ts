/**
 * Whole-body trick preview for clips with a pose-set `spin`. The game math lives in `spidey/game.ts` (a port of BodyAttitude /
 * BodyAttitudeRenderer / TrickHinge with file:line citations); this file wires it to a sampled animation.
 *
 * What the game does (main checkout, 2026-10): the model turns about a HINGE that is the tucked body's live centre of mass
 * (`TrickHinge`) PLUS the clip's `swing_pivot` Y offset (TetherClient.java:2466-2469), held where the first frame put it
 * (BodyAttitudeRenderer.java:48-52). `swing_pivot` alone sets the hinge for lean, bank and spine turns (BodyAttitude.pivot);
 * the old centre-of-mass-only preview is replaced by both combined. Angular speed follows the smoothstepped FLIP / TWIST profiles.
 * Lean / bank / the live-physics tuck are not previewable from a clip, so the preview is the untilted body.
 */
import type { Animation, NumVec3 } from "./format/animation";
import { PLAYER_RIG, canonicalBone, transformPoint, type RigBone } from "./rig";
import { quatRotate, type Quat } from "./math";
import { samplePose, type Pose } from "./sample";
import { HINGE_LIMBS, spinFrame, spinSeconds, trickAngle, trickHinge, type SpinFrame } from "./spidey/game";

export {
  FLIP_PROFILE, TWIST_PROFILE, TRICK_AXES, profileArea, profileSpeed, trickAngle, trickRotation, trickCentre, trickHinge, spinFrame, spinSeconds,
} from "./spidey/game";
export type { Profile, SpinFrame } from "./spidey/game";

/** Geometric mass shares of the six rig bones, kept for the generic centre-of-mass helper below (the game's own is `trickCentre`). */
export const MASS_SHARE: Readonly<Record<string, number>> = {
  armorHead: 0.08,
  armorBody: 0.46,
  armorRightArm: 0.05,
  armorLeftArm: 0.05,
  armorRightLeg: 0.18,
  armorLeftLeg: 0.18,
};

function partCentre(b: RigBone): NumVec3 {
  let sx = 0, sy = 0, sz = 0, n = 0;
  for (const c of b.cubes) {
    sx += c.origin[0] + c.size[0] / 2;
    sy += c.origin[1] + c.size[1] / 2;
    sz += c.origin[2] + c.size[2] / 2;
    n++;
  }
  return n ? [sx / n, sy / n, sz / n] : b.pivot;
}
/** Mass-weighted centre of the posed rig (model px, Bedrock coordinates). Geometry-based; the spin preview uses `trickHinge`. */
export function centreOfMass(pose: Pose, rig: readonly RigBone[] = PLAYER_RIG): NumVec3 {
  let x = 0, y = 0, z = 0, m = 0;
  for (const b of rig) {
    const w = MASS_SHARE[canonicalBone(b.name)] ?? 0;
    if (!w) continue;
    const p = transformPoint(rig, b.name, partCentre(b), pose);
    x += p[0] * w;
    y += p[1] * w;
    z += p[2] * w;
    m += w;
  }
  return m ? [x / m, y / m, z / m] : [0, 12, 0];
}

const limbRotations = (pose: Pose): Array<NumVec3 | undefined> => HINGE_LIMBS.map((b) => pose[b]?.rotation);
/** `swing_pivot` position Y in px at this pose, undefined when the clip does not author one (ClipPoseLibrary.pivotOffset returns null). */
const pivotY = (anim: Animation, pose: Pose): number | undefined => (anim.bones.get("swing_pivot")?.position ? pose["swing_pivot"]?.position?.[1] : undefined);

export interface SpinPreview extends SpinFrame {
  /** 0..1 across the spin. */
  progress: number;
  /** The clip time the hinge was sampled at (progress x clip length). */
  clipTime: number;
}
/**
 * The whole-body turn of a spin clip `time` seconds in. The spin runs over `spin.ticks` (else the clip's length); the hinge samples the
 * clip at the same progress (TetherClient.java:2455-2463: `trickCentre(clip, trickProgress())`), pinned at the first frame's.
 */
export function spinPreview(anim: Animation, spin: { axis: string; turns: number; ticks: number }, time: number, clipLength: number): SpinPreview {
  const secs = spinSeconds(spin.ticks, clipLength);
  const progress = Math.min(1, Math.max(0, secs > 0 ? time / secs : 1));
  const clipTime = progress * clipLength;
  const now = samplePose(anim, clipTime);
  const first = samplePose(anim, 0);
  const live = trickHinge(limbRotations(now), pivotY(anim, now));
  const base = trickHinge(limbRotations(first), pivotY(anim, first));
  return { ...spinFrame(spin.axis, spin.turns, progress, base, live), progress, clipTime };
}
/** Apply a spin frame to a scene point. */
export function applySpin(f: Pick<SpinFrame, "quat" | "position">, p: NumVec3): NumVec3 {
  const r = quatRotate(f.quat as Quat, p);
  return [r[0] + f.position[0], r[1] + f.position[1], r[2] + f.position[2]];
}
export { trickAngle as spinAngle };
