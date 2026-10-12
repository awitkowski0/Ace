import { describe, expect, it } from "vitest";
import { getAnimation, parseDoc } from "../../core";
import {
  applyClick, buildRows, dragDelta, fitView, hitKeys, keysInRect, mergeSel, normRect, rowAt, rowTimes, rulerTicks, shiftRefs, snapTick, surroundingTimes,
  timeToX, visibleRows, xToTime, zoomView, keyEq, allKeyTimes,
} from "./layout";

const doc = parseDoc(JSON.stringify({
  format_version: "1.8.0",
  animations: {
    "animation.t": {
      animation_length: 2,
      bones: {
        a: { rotation: { "0.0": [0, 0, 0], "0.5": [10, 0, 0], "1.0": [0, 0, 0] }, position: { "0.5": [0, 1, 0] } },
        b: { rotation: { "0.0": [0, 0, 0], "1.5": [5, 5, 5] } },
      },
    },
  },
}), "animation");
const anim = getAnimation(doc, "animation.t")!;
const v = { t0: 0, pxPerSec: 100 };

describe("view math", () => {
  it("round-trips time and x", () => {
    expect(timeToX(1.5, v)).toBe(150);
    expect(xToTime(timeToX(0.37, v), v)).toBeCloseTo(0.37);
  });
  it("zoom keeps the anchor time fixed", () => {
    const z = zoomView(v, 2, 150);
    expect(xToTime(150, z)).toBeCloseTo(xToTime(150, v));
    expect(z.pxPerSec).toBe(200);
  });
  it("fitView shows the whole clip", () => {
    const f = fitView(2, 440);
    expect(timeToX(2, f)).toBeLessThan(440);
    expect(timeToX(0, f)).toBeGreaterThanOrEqual(0);
  });
  it("snaps to 20 tps", () => {
    expect(snapTick(0.0749)).toBe(0.05);
    expect(snapTick(0.076)).toBe(0.1);
  });
});

describe("ruler", () => {
  it("labels seconds and shows ticks when zoomed in", () => {
    const t = rulerTicks({ t0: 0, pxPerSec: 400 }, 800);
    expect(t.some((x) => x.kind === "major" && x.label === "0.25s")).toBe(true);
    expect(t.filter((x) => x.kind === "tick").length).toBeGreaterThan(5);
  });
  it("hides ticks when zoomed out", () => {
    const t = rulerTicks({ t0: 0, pxPerSec: 40 }, 800);
    expect(t.some((x) => x.kind === "tick")).toBe(false);
    expect(t.filter((x) => x.kind === "major").length).toBeGreaterThan(2);
  });
});

describe("rows", () => {
  it("lists bone rows then channel rows; collapse hides channels", () => {
    const { rows, height } = buildRows(anim, new Set());
    expect(rows.map((r) => `${r.kind}:${r.bone}${r.channel ? "." + r.channel : ""}`)).toEqual(["bone:a", "channel:a.rotation", "channel:a.position", "bone:b", "channel:b.rotation"]);
    expect(height).toBe(5 * 22);
    expect(buildRows(anim, new Set(["a"])).rows.length).toBe(3);
  });
  it("finds visible window and row at y", () => {
    const { rows } = buildRows(anim, new Set());
    expect(visibleRows(rows, 30, 70)).toEqual([1, 4]);
    expect(rowAt(rows, 30)?.channel).toBe("rotation");
    expect(rowAt(rows, 9999)).toBeUndefined();
  });
});

describe("hit testing and box select", () => {
  const { rows } = buildRows(anim, new Set());
  it("hits a channel key within radius", () => {
    const hit = hitKeys(anim, rows, v, 52, 33);
    expect(hit).toEqual([{ bone: "a", channel: "rotation", time: 0.5 }]);
    expect(hitKeys(anim, rows, v, 70, 33)).toBeUndefined();
  });
  it("bone row hit returns every channel key at that time", () => {
    const hit = hitKeys(anim, rows, v, 50, 11)!;
    expect(hit.map((h) => h.channel).sort()).toEqual(["position", "rotation"]);
  });
  it("row times merge channels", () => {
    expect(rowTimes(anim, rows[0])).toEqual([0, 0.5, 1]);
  });
  it("box selects keys inside the rectangle only", () => {
    const r = normRect({ x: 40, y: 24 }, { x: 110, y: 40 });
    const keys = keysInRect(anim, rows, v, r);
    expect(keys).toEqual([{ bone: "a", channel: "rotation", time: 0.5 }, { bone: "a", channel: "rotation", time: 1 }]);
  });
});

describe("selection", () => {
  const k1 = { bone: "a", channel: "rotation" as const, time: 0.5 };
  const k2 = { bone: "a", channel: "rotation" as const, time: 1 };
  it("plain click replaces unless already in multi-selection", () => {
    expect(applyClick([k1], [k2], false)).toEqual([k2]);
    expect(applyClick([k1, k2], [k2], false)).toEqual([k1, k2]);
  });
  it("additive click toggles", () => {
    expect(applyClick([k1], [k2], true)).toEqual([k1, k2]);
    expect(applyClick([k1, k2], [k2], true)).toEqual([k1]);
  });
  it("mergeSel dedups and keyEq tolerates float noise", () => {
    expect(mergeSel([k1], [k1, k2])).toEqual([k1, k2]);
    expect(keyEq(k1, { ...k1, time: 0.50001 })).toBe(true);
  });
  it("shiftRefs rounds", () => {
    expect(shiftRefs([k1], 0.1)[0].time).toBe(0.6);
  });
});

describe("dragDelta", () => {
  it("snaps the grabbed key to ticks", () => {
    expect(dragDelta(0.5, 0.01, 0.62, true, 0.5)).toBeCloseTo(0.1);
  });
  it("is free without snap", () => {
    expect(dragDelta(0.5, 0, 0.5731, false, 0.5)).toBeCloseTo(0.0731);
  });
  it("never moves keys below 0", () => {
    expect(dragDelta(0.5, 0, -2, true, 0.25)).toBe(-0.25);
  });
});

describe("breakdown helpers", () => {
  it("finds surrounding key times", () => {
    expect(surroundingTimes([0, 0.5, 1], 0.7)).toEqual({ a: 0.5, b: 1 });
    expect(surroundingTimes([0, 0.5, 1], 0.5)).toEqual({ a: 0, b: 1 });
    expect(surroundingTimes([0, 0.5, 1], 2)).toEqual({ a: 1, b: undefined });
  });
  it("collects key times per bone scope", () => {
    expect(allKeyTimes(anim)).toEqual([0, 0.5, 1, 1.5]);
    expect(allKeyTimes(anim, ["b"])).toEqual([0, 1.5]);
  });
});
