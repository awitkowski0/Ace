/**
 * Playback driver. `startPlayback(api)` subscribes to the store and runs a rAF loop ONLY while `state.playing` is true.
 * Semantics: time advances by dt*speed (dt clamped to 100 ms). At the end of the clip the playhead wraps when the
 * animation's `loop` is true or the "loop preview" toggle is on; otherwise (false / hold_on_last_frame) it stops and holds
 * the last frame. Idempotent per Studio: several callers share one loop (ref-counted).
 */
import { animLength, getAnimation, strideBlocks, type StrideGait } from "../../core";
import type { StudioApi } from "../state";
import { perfEnd, perfFlush, perfStart } from "../perf";

export interface Advance { time: number; playing: boolean }
/** Pure step used by the loop (unit-tested). */
export function advance(time: number, dt: number, speed: number, len: number, wrap: boolean): Advance {
  if (!(len > 0)) return { time: 0, playing: false };
  let t = time + Math.min(dt, 0.1) * speed;
  if (t >= len) {
    if (wrap) {
      t = t % len;
      return { time: t, playing: true };
    }
    return { time: len, playing: false };
  }
  if (t < 0) return { time: wrap ? len + (t % len) : 0, playing: wrap };
  return { time: t, playing: true };
}

/**
 * Stride clips are walked by DISTANCE, not time: one clip length per stride (CrawlGait.phase / LimbDriver.stridePhase). Walking at
 * `speedBps` blocks/s for `dt` seconds advances the phase by dt * speed / strideBlocks(speed). Pure; the playhead wraps (a stride clip loops).
 */
export function strideAdvance(time: number, dt: number, speedBps: number, len: number, gait: StrideGait): { time: number; dist: number } {
  if (!(len > 0)) return { time: 0, dist: 0 };
  const dist = Math.max(0, speedBps) * Math.min(dt, 0.1);
  const phase = time / len + dist / strideBlocks(gait, speedBps);
  return { time: (phase - Math.floor(phase)) * len, dist };
}

/** One playback tick: advance the playhead through the store. Shared by the rAF loop and the QA bench (`stepPlayback`). */
export function stepOnce(api: StudioApi, dt: number): boolean {
  const s = api.store.get();
  const anim = s.doc && s.anim ? getAnimation(s.doc, s.anim) : undefined;
  if (!anim) { api.store.set({ playing: false }); return false; }
  const wrap = anim.loop === true || s.loopPreview;
  const info = s.clipInfo?.[anim.name];
  const stride = s.mode === "animate" && info?.kind === "stride" && info.strideGait ? info.strideGait : null;
  const sa = stride ? strideAdvance(s.time, dt, s.strideSpeed, animLength(anim), stride) : null;
  const next: Advance = sa ? { time: sa.time, playing: true } : advance(s.time, dt, s.speed, animLength(anim), wrap);
  const t0 = perfStart();
  if (sa) api.store.set({ time: next.time, strideDist: s.strideDist + sa.dist });
  else api.store.set(next.playing ? { time: next.time } : { time: next.time, playing: false });
  perfEnd("store", t0);
  perfFlush();
  return next.playing;
}

const running = new WeakMap<object, { refs: number; stop: () => void }>();

export function startPlayback(api: StudioApi): () => void {
  const prev = running.get(api.store);
  if (prev) {
    prev.refs++;
    return () => release(api);
  }
  let raf = 0;
  let last = 0;
  // `inFrame` keeps `sync` (which runs synchronously inside our own store.set) from scheduling a second loop:
  // without it every frame spawned one more rAF chain, doubling each frame until the webview froze.
  let inFrame = false;
  const frame = (now: number) => {
    raf = 0;
    const s = api.store.get();
    if (!s.playing) return;
    const dt = last ? (now - last) / 1000 : 0;
    last = now;
    inFrame = true;
    let playing = false;
    try {
      playing = stepOnce(api, dt);
    } finally {
      inFrame = false;
    }
    // re-read: a subscriber may have paused playback during the set
    if (playing && api.store.get().playing && !raf) raf = requestAnimationFrame(frame);
  };
  const sync = () => {
    if (inFrame) return;
    const playing = api.store.get().playing;
    if (playing && !raf) {
      const s = api.store.get();
      const anim = s.doc && s.anim ? getAnimation(s.doc, s.anim) : undefined;
      // pressing play at the end restarts
      if (anim && !(anim.loop === true || s.loopPreview) && s.time >= animLength(anim) - 1e-6) api.store.set({ time: 0 });
      last = 0;
      raf = requestAnimationFrame(frame);
    } else if (!playing && raf) {
      cancelAnimationFrame(raf);
      raf = 0;
    }
  };
  const unsub = api.store.subscribe(sync);
  running.set(api.store, {
    refs: 1,
    stop: () => {
      unsub();
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
    },
  });
  sync();
  return () => release(api);
}
function release(api: StudioApi) {
  const r = running.get(api.store);
  if (!r) return;
  if (--r.refs <= 0) {
    r.stop();
    running.delete(api.store);
  }
}
