/** Multi-key selection helpers shared by the dope sheet and graph editor (pure, unit-tested). */
import { CHANNELS, type Animation, type KeyRef } from "../../core";
import { hasKey, keyEq, mergeSel, rowKeys, TIME_EPS, type Row } from "./layout";

/** Every key whose time lies in [t0, t1] (any bone, any channel, collapsed or not). */
export function keysInTimeRange(anim: Animation, t0: number, t1: number): KeyRef[] {
  const lo = Math.min(t0, t1) - TIME_EPS, hi = Math.max(t0, t1) + TIME_EPS;
  const out: KeyRef[] = [];
  for (const [bone, b] of anim.bones) for (const channel of CHANNELS) for (const k of b[channel]?.keys ?? []) if (k.time >= lo && k.time <= hi) out.push({ bone, channel, time: k.time });
  return out;
}

/** Clicking a row label: replace the selection with the row's keys; additive toggles them (all selected -> remove, else add). */
export function selectRowKeys(sel: readonly KeyRef[], anim: Animation, row: Row, additive: boolean): KeyRef[] {
  const refs = rowKeys(anim, row);
  if (!additive) return refs;
  if (refs.length && refs.every((r) => hasKey(sel, r))) return sel.filter((s) => !refs.some((r) => keyEq(r, s)));
  return mergeSel(sel, refs);
}

/** ⌘-click on a key: toggle membership of `hit`. */
export function toggleKeys(sel: readonly KeyRef[], hit: readonly KeyRef[]): KeyRef[] {
  return hit.every((h) => hasKey(sel, h)) ? sel.filter((s) => !hit.some((h) => keyEq(h, s))) : mergeSel(sel, hit);
}

export const selectionLabel = (n: number) => (n === 0 ? "" : n === 1 ? "1 key selected" : `${n} keys selected`);
