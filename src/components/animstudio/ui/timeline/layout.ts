/** Pure timeline math: time<->x mapping, ruler ticks, row layout, hit testing, selection and drag helpers. (Unit-tested.) */
import { CHANNELS, sortedKeys, type Animation, type ChannelName, type KeyRef } from "../../core";

export const TPS = 20;
export const TICK = 1 / TPS;
export const ROW_H = 22;
export const RULER_H = 22;
export const LABEL_W = 168;
export const KEY_R = 6;
export const TIME_EPS = 0.0005;

export const r4 = (t: number) => Math.round(t * 10000) / 10000;
export const snapTick = (t: number) => r4(Math.round(t * TPS) / TPS);
export const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

// ---------------------------------------------------------------- view

export interface View {
  /** clip time at grid x = 0 */
  t0: number;
  pxPerSec: number;
}
export const timeToX = (t: number, v: View) => (t - v.t0) * v.pxPerSec;
export const xToTime = (x: number, v: View) => x / v.pxPerSec + v.t0;
export const MIN_PPS = 20;
export const MAX_PPS = 4000;

/** Zoom keeping the time under `anchorX` fixed. */
export function zoomView(v: View, factor: number, anchorX: number): View {
  const pxPerSec = clamp(v.pxPerSec * factor, MIN_PPS, MAX_PPS);
  const t = xToTime(anchorX, v);
  return { pxPerSec, t0: t - anchorX / pxPerSec };
}
/** View showing [0, length] (with a little padding) inside `width` px. */
export function fitView(length: number, width: number): View {
  const len = Math.max(length, 0.1);
  const pxPerSec = clamp((width - 40) / len, MIN_PPS, MAX_PPS);
  return { t0: -12 / pxPerSec, pxPerSec };
}

export interface RulerTick {
  t: number;
  x: number;
  kind: "major" | "minor" | "tick";
  label?: string;
}
const STEPS = [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 30, 60];
/** Ruler marks for the visible range: seconds labels on majors, tick marks (@20tps) when there is room. */
export function rulerTicks(v: View, width: number): RulerTick[] {
  const out: RulerTick[] = [];
  const tA = Math.max(0, xToTime(0, v));
  const tB = xToTime(width, v);
  const major = STEPS.find((s) => s * v.pxPerSec >= 70) ?? 60;
  const minor = major / (major === 0.05 ? 1 : major === 0.1 || major === 0.5 || major === 5 ? 5 : major === 1 || major === 10 ? 10 : 4);
  const showTicks = v.pxPerSec * TICK >= 10;
  if (showTicks) {
    for (let i = Math.ceil(tA * TPS - 1e-6); i * TICK <= tB; i++) {
      const t = r4(i * TICK);
      if (Math.abs(t / major - Math.round(t / major)) < 1e-6) continue;
      out.push({ t, x: timeToX(t, v), kind: "tick", label: v.pxPerSec * TICK >= 30 ? String(i) : undefined });
    }
  }
  if (minor >= TICK - 1e-9) {
    for (let i = Math.ceil(tA / minor - 1e-6); i * minor <= tB; i++) {
      const t = r4(i * minor);
      if (Math.abs(t / major - Math.round(t / major)) < 1e-6) continue;
      if (showTicks && Math.abs(t * TPS - Math.round(t * TPS)) < 1e-6) continue;
      out.push({ t, x: timeToX(t, v), kind: "minor" });
    }
  }
  for (let i = Math.ceil(tA / major - 1e-6); i * major <= tB; i++) {
    const t = r4(i * major);
    out.push({ t, x: timeToX(t, v), kind: "major", label: fmtSeconds(t, major) });
  }
  return out;
}
export function fmtSeconds(t: number, step = 0.05): string {
  const dp = step >= 1 ? 0 : Math.abs(step * 10 - Math.round(step * 10)) < 1e-9 ? 1 : 2;
  return t.toFixed(dp) + "s";
}
export const fmtTime = (t: number) => `${t.toFixed(2)}s · ${Math.round(t * TPS)}t`;

// ---------------------------------------------------------------- rows

export interface Row {
  kind: "bone" | "channel";
  bone: string;
  channel?: ChannelName;
  y: number;
  h: number;
}
export function boneChannels(anim: Animation, bone: string): ChannelName[] {
  const b = anim.bones.get(bone);
  return CHANNELS.filter((c) => b?.[c] && b[c]!.keys.length > 0);
}
/** One bone row per animated bone followed by its channel rows unless the bone is collapsed. */
export function buildRows(anim: Animation | undefined, collapsed: ReadonlySet<string>, rowH = ROW_H): { rows: Row[]; height: number } {
  const rows: Row[] = [];
  let y = 0;
  if (anim) {
    for (const bone of anim.bones.keys()) {
      const chans = boneChannels(anim, bone);
      if (!chans.length) continue;
      rows.push({ kind: "bone", bone, y, h: rowH });
      y += rowH;
      if (collapsed.has(bone)) continue;
      for (const channel of chans) {
        rows.push({ kind: "channel", bone, channel, y, h: rowH });
        y += rowH;
      }
    }
  }
  return { rows, height: y };
}
/** Index range [lo, hi) of rows intersecting the vertical window [y0, y1). */
export function visibleRows(rows: readonly Row[], y0: number, y1: number): [number, number] {
  let lo = 0;
  let hi = rows.length;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (rows[m].y + rows[m].h <= y0) lo = m + 1;
    else hi = m;
  }
  let end = lo;
  while (end < rows.length && rows[end].y < y1) end++;
  return [lo, end];
}
export function rowAt(rows: readonly Row[], y: number): Row | undefined {
  const [lo, hi] = visibleRows(rows, y, y + 0.001);
  return lo < hi ? rows[lo] : undefined;
}

// ---------------------------------------------------------------- keys

export const sameTime = (a: number, b: number) => Math.abs(a - b) < TIME_EPS;
export const keyEq = (a: KeyRef, b: KeyRef) => a.bone === b.bone && a.channel === b.channel && sameTime(a.time, b.time);
export const hasKey = (sel: readonly KeyRef[], k: KeyRef) => sel.some((s) => keyEq(s, k));

/** All key refs of a row (bone rows = every channel of the bone). */
export function rowKeys(anim: Animation, row: Row): KeyRef[] {
  const b = anim.bones.get(row.bone);
  if (!b) return [];
  const chans = row.kind === "channel" ? [row.channel!] : boneChannels(anim, row.bone);
  const out: KeyRef[] = [];
  for (const channel of chans) for (const k of b[channel]?.keys ?? []) out.push({ bone: row.bone, channel, time: k.time });
  return out;
}
/** Distinct key times of a row (bone rows merge all channels), sorted. */
export function rowTimes(anim: Animation, row: Row): number[] {
  const ts: number[] = [];
  for (const r of rowKeys(anim, row)) if (!ts.some((t) => sameTime(t, r.time))) ts.push(r.time);
  return ts.sort((a, b) => a - b);
}

/** Key(s) under the point (x, y in grid coordinates, y already includes vertical scroll). */
export function hitKeys(anim: Animation, rows: readonly Row[], v: View, x: number, y: number, radius = KEY_R + 1): KeyRef[] | undefined {
  const row = rowAt(rows, y);
  if (!row) return undefined;
  let best: { t: number; d: number } | undefined;
  for (const t of rowTimes(anim, row)) {
    const d = Math.abs(timeToX(t, v) - x);
    if (d <= radius && (!best || d < best.d)) best = { t, d };
  }
  if (!best) return undefined;
  return rowKeys(anim, row).filter((r) => sameTime(r.time, best!.t));
}

export interface Rect { x0: number; y0: number; x1: number; y1: number }
export const normRect = (a: { x: number; y: number }, b: { x: number; y: number }): Rect => ({
  x0: Math.min(a.x, b.x), y0: Math.min(a.y, b.y), x1: Math.max(a.x, b.x), y1: Math.max(a.y, b.y),
});
/** Keys whose diamonds fall in the rectangle. Bone rows only select when they hold the key (their channels' keys). */
export function keysInRect(anim: Animation, rows: readonly Row[], v: View, r: Rect): KeyRef[] {
  const out: KeyRef[] = [];
  const [lo, hi] = visibleRows(rows, r.y0, r.y1);
  const t0 = xToTime(r.x0 - KEY_R, v);
  const t1 = xToTime(r.x1 + KEY_R, v);
  const push = (k: KeyRef) => { if (!hasKey(out, k)) out.push(k); };
  for (let i = lo; i < hi; i++) {
    const row = rows[i];
    const cy = row.y + row.h / 2;
    if (cy < r.y0 || cy > r.y1) continue;
    for (const k of rowKeys(anim, row)) if (k.time >= t0 && k.time <= t1) push(k);
  }
  return out;
}

/** Selection update for a click on `hit` with modifiers. `additive` = shift/meta toggles. */
export function applyClick(sel: readonly KeyRef[], hit: readonly KeyRef[], additive: boolean): KeyRef[] {
  if (!additive) return hit.every((h) => hasKey(sel, h)) && sel.length > 0 ? [...sel] : [...hit];
  const allIn = hit.every((h) => hasKey(sel, h));
  if (allIn) return sel.filter((s) => !hit.some((h) => keyEq(h, s)));
  return [...sel, ...hit.filter((h) => !hasKey(sel, h))];
}
export function mergeSel(sel: readonly KeyRef[], add: readonly KeyRef[]): KeyRef[] {
  return [...sel, ...add.filter((a) => !hasKey(sel, a))];
}
/** Selection with every key shifted by delta. */
export const shiftRefs = (refs: readonly KeyRef[], delta: number): KeyRef[] => refs.map((k) => ({ ...k, time: r4(k.time + delta) }));

/**
 * Time delta for dragging keys: the key grabbed at `grabTime` follows the pointer at `pointerTime`
 * (snapped to the tick grid when `snap`), and no key may go below 0.
 */
export function dragDelta(grabTime: number, grabOffset: number, pointerTime: number, snap: boolean, minKeyTime: number): number {
  let target = pointerTime - grabOffset;
  if (snap) target = snapTick(target);
  let d = target - grabTime;
  if (minKeyTime + d < 0) d = -minKeyTime;
  return r4(d);
}

export function keyTimeRange(refs: readonly KeyRef[]): [number, number] | undefined {
  if (!refs.length) return undefined;
  let lo = Infinity;
  let hi = -Infinity;
  for (const r of refs) { lo = Math.min(lo, r.time); hi = Math.max(hi, r.time); }
  return [lo, hi];
}

/** Keys of the animation sorted by time across all channels of `bone` (used for breakdown defaults). */
export function allKeyTimes(anim: Animation, bones?: readonly string[]): number[] {
  const ts: number[] = [];
  for (const [name, b] of anim.bones) {
    if (bones && !bones.includes(name)) continue;
    for (const ch of CHANNELS) for (const k of sortedKeys({ shape: "keys", keys: b[ch]?.keys ?? [] })) if (!ts.some((t) => sameTime(t, k.time))) ts.push(k.time);
  }
  return ts.sort((a, b) => a - b);
}
/** Nearest key times around t: previous (< t) and next (> t). */
export function surroundingTimes(times: readonly number[], t: number): { a?: number; b?: number } {
  let a: number | undefined;
  let b: number | undefined;
  for (const x of times) {
    if (x < t - TIME_EPS) a = x;
    else if (x > t + TIME_EPS) { b = x; break; }
  }
  return { a, b };
}
