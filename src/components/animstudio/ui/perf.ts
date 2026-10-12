/**
 * Studio performance meter (FPS readout in the viewport corner, View toolbar toggle "FPS"). Module singleton shared by every Studio.
 *
 * Zero cost when off: every hook below starts with `if (!on) return` and `now()` is only taken behind that check, so a hidden
 * meter adds no timers, no rAF loop and no allocations. When on, a single rAF loop closes one "frame" per display refresh and
 * the sample ring keeps the last second. A frame records where its time went:
 *   store  - `store.set` (every subscriber that runs synchronously: canvas schedulers, playback, engine schedule)
 *   flush  - microtasks queued by that set: React re-renders + commit and the engine's `sync`
 *   pose   - sampling + constraints + rig bone transforms (a slice of `flush`)
 *   render - three.js `renderer.render`
 *   canvas - 2D redraws of the dope sheet / graph editor
 * plus `renders` (React component renders per frame, by name) and `calls` / `tris` of the last three.js render.
 */
import { useSyncExternalStore } from "react";

export type PerfBin = "store" | "flush" | "pose" | "render" | "canvas";
const BINS: PerfBin[] = ["store", "flush", "pose", "render", "canvas"];
const KEY = "ace.animstudio.fps";

export interface Sample { t: number; dt: number; bins: Record<PerfBin, number>; draws: number; renders: Record<string, number> }
export interface PerfStats {
  on: boolean;
  fps: number;
  avgMs: number;
  worstMs: number;
  /** average ms per frame spent in each bin (over the frames that happened in the last second) */
  bins: Record<PerfBin, number>;
  /** viewport draws per second */
  drawsPerSec: number;
  /** React component renders per frame, by component name */
  renders: Record<string, number>;
  calls: number;
  triangles: number;
  /** last ~60 frame times (ms) for the sparkline */
  spark: number[];
}

const zeroBins = (): Record<PerfBin, number> => ({ store: 0, flush: 0, pose: 0, render: 0, canvas: 0 });
const EMPTY: PerfStats = { on: false, fps: 0, avgMs: 0, worstMs: 0, bins: zeroBins(), drawsPerSec: 0, renders: {}, calls: 0, triangles: 0, spark: [] };

let on = false;
let cur: { bins: Record<PerfBin, number>; draws: number; renders: Record<string, number> } = { bins: zeroBins(), draws: 0, renders: {} };
let ring: Sample[] = [];
let calls = 0, tris = 0;
let raf = 0, lastT = 0, lastPub = 0;
let snap: PerfStats = EMPTY;
const subs = new Set<() => void>();
const emit = () => subs.forEach((f) => f());

function load(): boolean {
  try { return localStorage.getItem(KEY) === "1"; } catch { return false; }
}

const now = () => performance.now();

function tick(t: number) {
  raf = requestAnimationFrame(tick);
  if (lastT) perfCloseFrame(t, t - lastT);
  lastT = t;
  if (t - lastPub >= 250) { lastPub = t; snap = compute(); emit(); }
}

/** end the current frame at time `t` (the meter's rAF loop; the QA bench drives it with synthetic frames) */
export function perfCloseFrame(t: number, dt: number): Sample {
  const smp: Sample = { t, dt, bins: cur.bins, draws: cur.draws, renders: cur.renders };
  ring.push(smp);
  cur = { bins: zeroBins(), draws: 0, renders: {} };
  while (ring.length && t - ring[0].t > 1000) ring.shift();
  return smp;
}

function compute(): PerfStats {
  const n = ring.length;
  if (!n) return { ...EMPTY, on };
  const span = Math.max(1, ring[n - 1].t - ring[0].t + ring[0].dt);
  let sum = 0, worst = 0, draws = 0;
  const bins = zeroBins();
  const renders: Record<string, number> = {};
  for (const s of ring) {
    sum += s.dt;
    if (s.dt > worst) worst = s.dt;
    draws += s.draws;
    for (const b of BINS) bins[b] += s.bins[b];
    for (const k in s.renders) renders[k] = (renders[k] ?? 0) + s.renders[k];
  }
  for (const b of BINS) bins[b] /= n;
  for (const k in renders) renders[k] /= n;
  return { on, fps: (n * 1000) / span, avgMs: sum / n, worstMs: worst, bins, drawsPerSec: (draws * 1000) / span, renders, calls, triangles: tris, spark: ring.slice(-60).map((s) => s.dt) };
}

/** Meter control. `persist: false` is for the QA bench (turns it on without touching the saved setting). */
export function setPerf(enable: boolean, persist = true) {
  if (persist) { try { localStorage.setItem(KEY, enable ? "1" : "0"); } catch { /* storage blocked */ } }
  if (enable === on) return;
  on = enable;
  if (on) {
    ring = []; cur = { bins: zeroBins(), draws: 0, renders: {} }; lastT = 0; lastPub = 0;
    raf = requestAnimationFrame(tick);
    snap = { ...EMPTY, on };
  } else {
    cancelAnimationFrame(raf); raf = 0;
    ring = []; snap = EMPTY;
  }
  emit();
}
export const perfOn = () => on;
export const togglePerf = () => setPerf(!on);
/** call once at Studio start: restores the persisted setting */
export function initPerf() { if (!on && load()) setPerf(true, false); }

/** current stats (QA / bridge); computed fresh so it works even when no rAF runs (hidden webview) */
export function perfStats(): PerfStats { return on ? compute() : { ...EMPTY }; }

export function usePerf(): PerfStats {
  return useSyncExternalStore(subscribePerf, () => snap);
}
export function usePerfOn(): boolean {
  return useSyncExternalStore(subscribePerf, perfOn);
}
function subscribePerf(f: () => void) { subs.add(f); return () => subs.delete(f); }

// ---------------------------------------------------------------- recording hooks (all no-ops while off)

/** time `fn` into `bin` */
export function perfTime<T>(bin: PerfBin, fn: () => T): T {
  if (!on) return fn();
  const t0 = now();
  try { return fn(); } finally { cur.bins[bin] += now() - t0; }
}
/** manual start/stop pair for code that cannot be wrapped: `const t = perfStart(); ...; perfEnd("pose", t)` */
export const perfStart = (): number => (on ? now() : 0);
export function perfEnd(bin: PerfBin, t0: number) { if (on && t0) cur.bins[bin] += now() - t0; }
/** count one React render of component `name` (call in the component body) */
export function perfRender(name: string) { if (on) cur.renders[name] = (cur.renders[name] ?? 0) + 1; }
/** one viewport draw finished */
export function perfDraw(c: number, t: number) { if (on) { cur.draws++; calls = c; tris = t; } }
/** call right after a `store.set`: charges the microtasks it queued (React's flush, the engine sync) to `flush` */
export function perfFlush() {
  if (!on) return;
  const t0 = now();
  queueMicrotask(() => { cur.bins.flush += now() - t0; });
}
