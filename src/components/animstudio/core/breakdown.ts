/**
 * Pose between frames ("breakdowner") and push/relax.
 *
 * Rotations blend by quaternion slerp (so a 170° -> -170° pair goes the short way) and are converted
 * back to the euler triple closest to the reference key, so there are no >180° wraps in the output.
 * Positions and scales lerp. All times are clip seconds.
 */
import { CHANNELS, sortedKeys, type Animation, type ChannelName, type Keyframe, type NumVec3 } from "./format/animation";
import { getAnimation, insertPoseKeys, type Doc } from "./doc";
import { lerp3, eulerToQuat, nearestEuler, slerp } from "./math";
import { evalMolang } from "./molang";
import { applyEasing, sampleChannel, type Pose } from "./sample";
import { javaEase, keyEase } from "./playersample";

export interface BreakdownOptions {
  /** Bones to pose; default every bone of the animation that has a channel. */
  bones?: string[];
  channels?: ChannelName[];
  tA: number;
  tB: number;
  /** 0 = pose A, 1 = pose B; -0.5..1.5 overshoots (extrapolates). */
  factor: number;
  /** Use the easing of the span between the poses instead of linear: the key at B (GeckoLib: the segment ending at B) or, for player clips, the key at/before A (the segment leaving it). */
  followCurve?: boolean;
}

const r5 = (v: number) => Math.round(v * 1e5) / 1e5;
const round3 = (v: NumVec3): NumVec3 => [r5(v[0]), r5(v[1]), r5(v[2])];

function blend(ch: ChannelName, a: NumVec3, b: NumVec3, f: number): NumVec3 {
  if (f === 0) return a;
  if (f === 1) return b;
  if (ch === "rotation") {
    const q = slerp(eulerToQuat(a), eulerToQuat(b), f);
    return round3(nearestEuler(q, f < 0.5 ? a : b));
  }
  return round3(lerp3(a, b, f));
}

function easedFactor(anim: Animation, bone: string, ch: ChannelName, tA: number, tB: number, f: number): number {
  if (f <= 0 || f >= 1) return f;
  const keys = anim.bones.get(bone)?.[ch]?.keys ?? [];
  if (anim.semantics === "player") {
    // player rules: the EARLIER key's (java) ease governs the span leaving it
    const sorted = sortedKeys({ shape: "keys", keys });
    let from: Keyframe | undefined;
    for (const x of sorted) if (x.time <= tA + 1e-4) from = x;
    const name = from && keyEase(from, ch);
    return name ? javaEase(name)(f) : f;
  }
  const k = sortedKeys({ shape: "keys", keys }).find((x) => x.time >= tB - 1e-4);
  const name = k?.lerp ?? k?.easing;
  return name ? applyEasing(name, f, k?.easingArgs) : f;
}

/** Blend between the sampled poses at tA and tB for every selected bone/channel. */
export function breakdownAnim(anim: Animation, o: BreakdownOptions): Pose {
  const bones = o.bones ?? [...anim.bones.keys()];
  const chans = o.channels ?? CHANNELS;
  const pose: Pose = {};
  for (const bone of bones) {
    const b = anim.bones.get(bone);
    if (!b) continue;
    for (const ch of chans) {
      if (!b[ch]) continue;
      const a = sampleChannel(anim, bone, ch, o.tA, { wrap: false });
      const bb = sampleChannel(anim, bone, ch, o.tB, { wrap: false });
      if (!a || !bb) continue;
      const f = o.followCurve ? easedFactor(anim, bone, ch, o.tA, o.tB, o.factor) : o.factor;
      (pose[bone] ??= {})[ch] = blend(ch, a, bb, f);
    }
  }
  return pose;
}

export function breakdown(doc: Doc, animName: string, o: BreakdownOptions): Pose {
  const a = getAnimation(doc, animName);
  if (!a) throw new Error(`No animation "${animName}"`);
  return breakdownAnim(a, o);
}

/** The keys of the selected bones surrounding `t`: nearest key before and after, per channel. */
export function neighbours(anim: Animation, bone: string, ch: ChannelName, t: number): { prev?: Keyframe; next?: Keyframe } {
  const keys = sortedKeys({ shape: "keys", keys: anim.bones.get(bone)?.[ch]?.keys ?? [] });
  let prev: Keyframe | undefined;
  let next: Keyframe | undefined;
  for (const k of keys) {
    if (k.time < t - 1e-4) prev = k;
    else if (k.time > t + 1e-4) {
      next = k;
      break;
    }
  }
  return { prev, next };
}

const keyNum = (k: Keyframe, which: "pre" | "post"): NumVec3 => {
  const v = which === "pre" ? k.pre ?? k.value : k.value;
  const env = { anim_time: k.time };
  return [evalMolang(v[0], env), evalMolang(v[1], env), evalMolang(v[2], env)];
};

export interface PushRelaxOptions {
  bones?: string[];
  channels?: ChannelName[];
  t: number;
  /** > 0 pushes away from the straight A->B blend (exaggerate); < 0 relaxes toward it; -1 = exactly on the line. */
  amount: number;
}

/** Pose breakdowner's push/relax: current pose at t versus the straight blend of its neighbouring keys. */
export function pushRelaxAnim(anim: Animation, o: PushRelaxOptions): Pose {
  const bones = o.bones ?? [...anim.bones.keys()];
  const chans = o.channels ?? CHANNELS;
  const pose: Pose = {};
  for (const bone of bones) {
    const b = anim.bones.get(bone);
    if (!b) continue;
    for (const ch of chans) {
      if (!b[ch]) continue;
      const { prev, next } = neighbours(anim, bone, ch, o.t);
      if (!prev || !next) continue;
      const cur = sampleChannel(anim, bone, ch, o.t, { wrap: false });
      if (!cur) continue;
      const A = keyNum(prev, "post");
      const B = keyNum(next, "pre");
      const line = blend(ch, A, B, (o.t - prev.time) / (next.time - prev.time));
      const k = 1 + o.amount;
      let out: NumVec3;
      if (ch === "rotation") {
        const q = slerp(eulerToQuat(line), eulerToQuat(cur), k);
        out = round3(nearestEuler(q, cur));
      } else out = round3(lerp3(line, cur, k));
      (pose[bone] ??= {})[ch] = out;
    }
  }
  return pose;
}

export function pushRelax(doc: Doc, animName: string, o: PushRelaxOptions): Pose {
  const a = getAnimation(doc, animName);
  if (!a) throw new Error(`No animation "${animName}"`);
  return pushRelaxAnim(a, o);
}

/** Commit a breakdown: insert its keys at `time` (default tB-ish is up to the caller; usually the playhead). */
export function insertBreakdown(doc: Doc, animName: string, o: BreakdownOptions, time: number, easing?: string): Doc {
  return insertPoseKeys(doc, { anim: animName, time, pose: breakdown(doc, animName, o), easing });
}
export function insertPushRelax(doc: Doc, animName: string, o: PushRelaxOptions, easing?: string): Doc {
  return insertPoseKeys(doc, { anim: animName, time: o.t, pose: pushRelax(doc, animName, o), easing });
}
