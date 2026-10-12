import { describe, expect, it } from "vitest";
import { parseDoc, getAnimation, type KeyRef } from "../../core";
import { boneSelectionState, channelSelectionState, rowSelectionState, selBadgeText, selBadgeTip, selBadgeWidth, toggleRowKeys } from "./rowSelection";
import { buildRows, rowKeys } from "./layout";

const DOC = parseDoc(JSON.stringify({
  format_version: "1.8.0",
  animations: { t: { animation_length: 2, bones: {
    a: { rotation: { "0.0": [0, 0, 0], "0.5": [1, 1, 1], "1.0": [2, 2, 2] }, position: { "0.5": [0, 1, 0] } },
    b: { rotation: { "0.0": [0, 0, 0], "1.0": [9, 9, 9] } },
    c: {},
  } } },
}), "animation");
const anim = getAnimation(DOC, "t")!;
const rows = buildRows(anim, new Set()).rows;
const boneA = rows.find((r) => r.kind === "bone" && r.bone === "a")!;
const rotA = rows.find((r) => r.kind === "channel" && r.bone === "a" && r.channel === "rotation")!;

describe("row selection state", () => {
  it("none / partial / all for a bone (all channels)", () => {
    expect(boneSelectionState([], anim, "a")).toEqual({ state: "none", selected: 0, total: 4 });
    const some: KeyRef[] = [{ bone: "a", channel: "rotation", time: 0 }, { bone: "a", channel: "rotation", time: 0.5 }, { bone: "a", channel: "rotation", time: 1 }];
    expect(boneSelectionState(some, anim, "a")).toEqual({ state: "partial", selected: 3, total: 4 });
    expect(boneSelectionState(rowKeys(anim, boneA), anim, "a")).toEqual({ state: "all", selected: 4, total: 4 });
  });
  it("a channel row is judged on its own keys; other bones' keys do not count", () => {
    const some: KeyRef[] = [{ bone: "a", channel: "rotation", time: 0 }, { bone: "b", channel: "rotation", time: 0 }];
    expect(channelSelectionState(some, anim, "a", "rotation")).toEqual({ state: "partial", selected: 1, total: 3 });
    expect(channelSelectionState(rowKeys(anim, rotA), anim, "a", "rotation").state).toBe("all");
    expect(channelSelectionState(rowKeys(anim, rotA), anim, "a", "position").state).toBe("none");
  });
  it("tolerates times a hair off and rows without keys", () => {
    expect(rowSelectionState([{ bone: "a", channel: "position", time: 0.50004 }], anim, { kind: "channel", bone: "a", channel: "position" }).state).toBe("all");
    expect(boneSelectionState(rowKeys(anim, boneA), anim, "c")).toEqual({ state: "none", selected: 0, total: 0 });
    expect(boneSelectionState([], undefined, "a").state).toBe("none");
  });
  it("badge text, width and tooltip", () => {
    expect(selBadgeText({ state: "none", selected: 0, total: 9 })).toBe("");
    expect(selBadgeText({ state: "partial", selected: 3, total: 9 })).toBe("3/9");
    expect(selBadgeText({ state: "all", selected: 9, total: 9 })).toBe("all 9");
    expect(selBadgeWidth("all 9")).toBeGreaterThan(selBadgeWidth("3/9"));
    expect(selBadgeTip({ kind: "bone", bone: "a" }, { state: "partial", selected: 3, total: 9 })).toMatch(/3 of 9 keyframes of a/);
    expect(selBadgeTip({ kind: "channel", bone: "a", channel: "rotation" }, { state: "all", selected: 3, total: 3 })).toMatch(/All 3 rotation keyframes of a/);
    expect(selBadgeTip({ kind: "bone", bone: "a" }, { state: "none", selected: 0, total: 4 })).toBe("");
  });
  it("toggle: partial/none -> all; all -> none; other rows keep their keys", () => {
    const other: KeyRef = { bone: "b", channel: "rotation", time: 1 };
    const all = toggleRowKeys([other], anim, boneA);
    expect(boneSelectionState(all, anim, "a").state).toBe("all");
    expect(all).toContainEqual(other);
    const none = toggleRowKeys(all, anim, boneA);
    expect(boneSelectionState(none, anim, "a").state).toBe("none");
    expect(none).toEqual([other]);
    expect(boneSelectionState(toggleRowKeys([{ bone: "a", channel: "rotation", time: 0 }], anim, boneA), anim, "a").state).toBe("all");
    expect(toggleRowKeys([other], anim, { kind: "bone", bone: "c" })).toEqual([other]);
  });
});
