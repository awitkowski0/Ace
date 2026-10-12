/**
 * Gizmo drags in Animate / Pose with several keys selected (Blockbench): when the playhead sits on one of the selected keys of the
 * dragged channel, the drag's value delta is applied to EVERY selected key of that channel (each keeps its own value), as one undo step.
 * Pure helpers, no three.js.
 */
import { TIME_EPS, type ChannelName, type KeyRef } from "../../core";

export type V3 = [number, number, number];

/**
 * The keys a drag of `channel` at playhead `time` should offset, or null when the normal "auto-key at the playhead" path applies
 * (fewer than two keys selected, or the playhead is not on a selected key of that channel).
 */
export function multiKeyTargets(keys: readonly KeyRef[], channel: ChannelName, time: number, eps = TIME_EPS): KeyRef[] | null {
  if (keys.length < 2) return null;
  const same = keys.filter((k) => k.channel === channel);
  if (!same.some((k) => Math.abs(k.time - time) < eps)) return null;
  return same.length > 1 ? same : null;
}

/** Component-wise `after - before`, rounded to 4 dp (drag deltas are tiny floats). */
export function valueDelta(before: readonly number[], after: readonly number[]): V3 {
  const r = (v: number) => { const x = Math.round(v * 1e4) / 1e4; return x === 0 ? 0 : x; };
  return [r(after[0] - before[0]), r(after[1] - before[1]), r(after[2] - before[2])];
}

/** Group keys by bone (offsetKeys takes one delta, so a drag with several bones calls it once per bone). */
export function groupByBone(keys: readonly KeyRef[]): Map<string, KeyRef[]> {
  const m = new Map<string, KeyRef[]>();
  for (const k of keys) m.set(k.bone, [...(m.get(k.bone) ?? []), k]);
  return m;
}
