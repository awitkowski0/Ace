import { describe, expect, it } from "vitest";
import { parseDoc, getAnimation, type KeyRef } from "../../core";
import { buildRows, keysInRect, rowKeys, type View } from "./layout";
import { keysInTimeRange, selectRowKeys, selectionLabel, toggleKeys } from "./selection";

const DOC = parseDoc(JSON.stringify({
  format_version: "1.8.0",
  animations: { t: { animation_length: 2, bones: {
    a: { rotation: { "0.0": [0, 0, 0], "0.5": [1, 1, 1], "1.0": [2, 2, 2] }, position: { "0.5": [0, 1, 0] } },
    b: { rotation: { "0.0": [0, 0, 0], "1.0": [9, 9, 9] }, scale: { "1.5": [2, 2, 2] } },
  } } },
}), "animation");
const anim = getAnimation(DOC, "t")!;
const V: View = { t0: 0, pxPerSec: 100 };

describe("multi-key selection", () => {
  it("time range selects across bones and channels", () => {
    const r = keysInTimeRange(anim, 0.5, 1.0);
    expect(r.map((k) => `${k.bone}.${k.channel}@${k.time}`).sort()).toEqual(["a.position@0.5", "a.rotation@0.5", "a.rotation@1", "b.rotation@1"]);
    expect(keysInTimeRange(anim, 1.0, 0.5)).toHaveLength(4); // order-insensitive
  });
  it("row label click selects the row's keys (bone row = all channels); additive toggles", () => {
    const { rows } = buildRows(anim, new Set());
    const boneA = rows.find((r) => r.kind === "bone" && r.bone === "a")!;
    const chan = rows.find((r) => r.kind === "channel" && r.bone === "a" && r.channel === "rotation")!;
    const all = selectRowKeys([], anim, boneA, false);
    expect(all).toHaveLength(4);
    expect(selectRowKeys(all, anim, chan, true)).toHaveLength(1); // rotation keys all selected -> removed, position remains
    expect(selectRowKeys([], anim, chan, false)).toHaveLength(3);
    const some: KeyRef[] = [{ bone: "b", channel: "rotation", time: 0 }];
    expect(selectRowKeys(some, anim, chan, true)).toHaveLength(4);
  });
  it("box select spans bones, and works in collapsed bone rows", () => {
    for (const collapsed of [new Set<string>(), new Set(["a", "b"])]) {
      const { rows } = buildRows(anim, collapsed);
      const top = rows[0].y, bottom = rows[rows.length - 1].y + rows[rows.length - 1].h;
      const got = keysInRect(anim, rows, V, { x0: 40, y0: top, x1: 110, y1: bottom });
      // times 0.5 .. 1.0 (x 50..100) in every row -> a: rot@0.5, pos@0.5, rot@1; b: rot@1
      expect(got.map((k) => `${k.bone}.${k.channel}@${k.time}`).sort()).toEqual(["a.position@0.5", "a.rotation@0.5", "a.rotation@1", "b.rotation@1"]);
    }
    const { rows } = buildRows(anim, new Set(["a", "b"]));
    expect(rowKeys(anim, rows[0])).toHaveLength(4);
  });
  it("cmd-click toggles", () => {
    const k: KeyRef = { bone: "a", channel: "rotation", time: 0.5 };
    expect(toggleKeys([], [k])).toEqual([k]);
    expect(toggleKeys([k], [k])).toEqual([]);
  });
  it("label", () => {
    expect(selectionLabel(0)).toBe("");
    expect(selectionLabel(1)).toBe("1 key selected");
    expect(selectionLabel(7)).toBe("7 keys selected");
  });
});
