import { describe, expect, it } from "vitest";
import { advance, strideAdvance } from "./playback";

describe("advance", () => {
  it("moves by dt*speed", () => {
    expect(advance(0.5, 0.05, 2, 2, false)).toEqual({ time: 0.6, playing: true });
  });
  it("wraps on loop", () => {
    const r = advance(1.95, 0.1, 1, 2, true);
    expect(r.playing).toBe(true);
    expect(r.time).toBeCloseTo(0.05);
  });
  it("stops and holds on the last frame when not looping", () => {
    expect(advance(1.95, 0.1, 1, 2, false)).toEqual({ time: 2, playing: false });
  });
  it("clamps huge dt (tab was asleep)", () => {
    expect(advance(0, 5, 1, 10, false).time).toBeCloseTo(0.1);
  });
  it("ignores empty clips", () => {
    expect(advance(0, 0.1, 1, 0, true)).toEqual({ time: 0, playing: false });
  });
  it("plays backwards-safe at negative speed", () => {
    expect(advance(0.05, 0.1, -1, 2, false).playing).toBe(false);
    expect(advance(0.05, 0.1, -1, 2, true).time).toBeCloseTo(1.95);
  });
});

describe("startPlayback loop", () => {
  it("keeps exactly one rAF chain while playing (no per-frame doubling)", async () => {
    const { startPlayback } = await import("./playback");
    const { createStore } = await import("../../../../lib/store");
    const { parseDoc } = await import("../../core");
    const doc = parseDoc(JSON.stringify({ format_version: "1.8.0", animations: { a: { loop: true, animation_length: 1, bones: { b: { rotation: { "0.0": [0, 0, 0], "1.0": [90, 0, 0] } } } } } }), "animation");
    const store = createStore<any>({ doc, anim: "a", time: 0, playing: false, speed: 1, loopPreview: true });
    const queue: FrameRequestCallback[] = [];
    let pending = 0;
    const g = globalThis as any;
    const [oldRaf, oldCancel] = [g.requestAnimationFrame, g.cancelAnimationFrame];
    g.requestAnimationFrame = (cb: FrameRequestCallback) => { queue.push(cb); pending++; return queue.length; };
    g.cancelAnimationFrame = () => {};
    try {
      const stop = startPlayback({ store } as any);
      store.set({ playing: true });
      let now = 0;
      for (let i = 0; i < 20; i++) {
        const batch = queue.splice(0);
        expect(batch.length).toBe(1);
        now += 16;
        batch.forEach((cb) => cb(now));
      }
      expect(store.get().time).toBeGreaterThan(0);
      store.set({ playing: false });
      queue.splice(0).forEach((cb) => cb(now + 16));
      expect(queue.length).toBe(0);
      stop();
      expect(pending).toBeGreaterThan(0);
    } finally {
      g.requestAnimationFrame = oldRaf;
      g.cancelAnimationFrame = oldCancel;
    }
  });
});

describe("strideAdvance (phase follows distance, not time)", () => {
  it("one crawl stride (0.875 blocks at 3 b/s) is one clip length, whatever the clip's own duration", () => {
    // 0.875 blocks at 3 b/s = 0.2917 s; dt is clamped to 0.1 per frame, so walk it in frames
    let t = 0, dist = 0;
    for (let i = 0; i < 3; i++) { const r = strideAdvance(t, 0.1, 3, 0.8, "gait"); t = r.time; dist += r.dist; }
    expect(dist).toBeCloseTo(0.9, 9);
    expect(t / 0.8).toBeCloseTo((0.9 / 0.875) % 1, 9);
  });
  it("faster walking covers the same phase in less time; speed 0 freezes the pose", () => {
    const slow = strideAdvance(0, 0.05, 1, 1, "walk"), fast = strideAdvance(0, 0.05, 4, 1, "walk");
    expect(fast.time).toBeGreaterThan(slow.time);
    expect(strideAdvance(0.3, 0.1, 0, 1, "gait").time).toBeCloseTo(0.3, 9);
  });
});
