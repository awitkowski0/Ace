import { describe, expect, it } from "vitest";
import { getAnimation, getAnimations, parseDoc, serialize, validateSpidey, type Doc, type Problem } from "../../core";
import { createStudioStore, type StudioApi } from "../state";
import { copySelectedKeys, deleteSelectedKeys, duplicateSelectedKeys, insertKeyAtPlayhead, pasteKeys, playheadTime } from "../timeline/ops";
import { parseComp } from "../timeline/KeyframeInspector";
import { uniqueName } from "../timeline/AnimationsPanel";
import { graphChannels, niceStep } from "../timeline/GraphEditor";
import { countProblems, sortProblems } from "./ProblemsStrip";
import { defaultAB, breakdownPose } from "./BreakdownPanel";
import { DEFAULT_FORM, pasteOptions } from "./NoiseDialog";
import { copyKeys, previewPasteWithNoise } from "../../core";

const TEXT = JSON.stringify({
  format_version: "1.8.0",
  animations: {
    "animation.t": {
      loop: true,
      animation_length: 1,
      bones: {
        armorRightArm: { rotation: { "0.0": [0, 0, 0], "0.5": [40, 0, 0], "1.0": [0, 0, 0] } },
        armorLeftArm: { rotation: { "0.0": [0, 0, 0], "1.0": [20, 0, 0] } },
      },
    },
  },
}, null, 2);

function fake(): { api: StudioApi; commits: string[] } {
  const store = createStudioStore("/x/t.animation.json");
  const commits: string[] = [];
  let doc = parseDoc(TEXT, "animation");
  store.set({ doc, anim: "animation.t" });
  const api: StudioApi = {
    store,
    commit(next: Doc, label: string) { doc = parseDoc(serialize(next), "animation"); commits.push(label); store.set({ doc }); },
    beginGesture() {}, endGesture() {}, undo() {}, redo() {}, revealInText() {},
  };
  return { api, commits };
}
const anim = (api: StudioApi) => getAnimation(api.store.get().doc!, "animation.t")!;
const times = (api: StudioApi, bone: string) => anim(api).bones.get(bone)!.rotation!.keys.map((k) => k.time);

describe("timeline ops", () => {
  it("insert key at snapped playhead for selected bones, one undo stop", () => {
    const { api, commits } = fake();
    api.store.set({ bones: ["armorLeftArm"], time: 0.512 });
    expect(insertKeyAtPlayhead(api)).toBe(true);
    expect(commits).toEqual(["Insert Keyframe"]);
    expect(times(api, "armorLeftArm")).toEqual([0, 0.5, 1]);
    expect(anim(api).bones.get("armorLeftArm")!.rotation!.keys[1].value[0]).toBeCloseTo(10);
    expect(api.store.get().keys).toEqual([{ bone: "armorLeftArm", channel: "rotation", time: 0.5 }]);
  });
  it("copy / paste / duplicate / delete", () => {
    const { api } = fake();
    api.store.set({ keys: [{ bone: "armorRightArm", channel: "rotation", time: 0.5 }] });
    expect(copySelectedKeys(api)).toBe(true);
    api.store.set({ time: 0.1 });
    expect(pasteKeys(api)).toBe(true);
    expect(times(api, "armorRightArm")).toEqual([0, 0.1, 0.5, 1]);
    expect(duplicateSelectedKeys(api)).toBe(true);
    expect(times(api, "armorRightArm").length).toBe(5);
    expect(deleteSelectedKeys(api)).toBe(true);
    expect(times(api, "armorRightArm").length).toBe(4);
    expect(api.store.get().keys).toEqual([]);
  });
  it("playheadTime snaps only when snapTicks", () => {
    const { api } = fake();
    api.store.set({ time: 0.37 });
    expect(playheadTime(api, anim(api))).toBe(0.35);
    api.store.set({ snapTicks: false });
    expect(playheadTime(api, anim(api))).toBe(0.37);
  });
});

describe("breakdown panel logic", () => {
  it("default A/B around the playhead, or two selected keys", () => {
    const { api } = fake();
    expect(defaultAB(anim(api), [], undefined, 0.3)).toEqual({ tA: 0, tB: 0.5 });
    expect(defaultAB(anim(api), [1, 0.5], undefined, 0.3)).toEqual({ tA: 0.5, tB: 1 });
  });
  it("preview pose blends A and B", () => {
    const { api } = fake();
    const pose = breakdownPose(api.store.get().doc!, "animation.t", "between", { tA: 0, tB: 0.5, factor: 0.5 }, 0.5, 0.25, 0)!;
    expect(pose.armorRightArm.rotation![0]).toBeCloseTo(20, 3);
    const over = breakdownPose(api.store.get().doc!, "animation.t", "between", { tA: 0, tB: 0.5, factor: 1.5 }, 1.5, 0.25, 0)!;
    expect(over.armorRightArm.rotation![0]).toBeCloseTo(60, 3);
  });
});

describe("noise dialog logic", () => {
  it("is deterministic for a seed and differs across seeds", () => {
    const { api } = fake();
    const clip = copyKeys(api.store.get().doc!, "animation.t", [{ bone: "armorRightArm", channel: "rotation", time: 0.5 }, { bone: "armorRightArm", channel: "rotation", time: 1 }]);
    const o = pasteOptions({ ...DEFAULT_FORM, repeat: 2, rot: 5, keepEnds: false, frequency: 1.3 }, 1, []);
    const a = JSON.stringify(previewPasteWithNoise(clip, o));
    expect(JSON.stringify(previewPasteWithNoise(clip, o))).toBe(a);
    expect(JSON.stringify(previewPasteWithNoise(clip, { ...o, seed: 99 }))).not.toBe(a);
    expect(previewPasteWithNoise(clip, o).length).toBe(4);
  });
  it("maps target modes to options", () => {
    expect(pasteOptions({ ...DEFAULT_FORM, target: "mirror" }, 0, []).mirrorLR).toBe(true);
    expect(pasteOptions({ ...DEFAULT_FORM, target: "selected" }, 0, ["x"]).targetBones).toEqual(["x"]);
  });
});

describe("misc helpers", () => {
  it("parseComp keeps molang strings", () => {
    expect(parseComp("12.5")).toBe(12.5);
    expect(parseComp("math.sin(query.anim_time*90)*5")).toBe("math.sin(query.anim_time*90)*5");
    expect(parseComp("  ")).toBeUndefined();
  });
  it("uniqueName increments", () => {
    expect(uniqueName("a", ["a"])).toBe("a_2");
    expect(uniqueName("a_2", ["a", "a_2"])).toBe("a_3");
    expect(uniqueName("b", ["a"])).toBe("b");
  });
  it("graph channels follow bone then key selection", () => {
    const { api } = fake();
    expect(graphChannels(anim(api), ["armorLeftArm"], []).map((c) => c.bone)).toEqual(["armorLeftArm"]);
    expect(graphChannels(anim(api), [], [{ bone: "armorRightArm", channel: "rotation", time: 0 }]).length).toBe(1);
    expect(graphChannels(anim(api), [], []).length).toBe(2);
    expect(niceStep(4)).toBe(10);
  });
  it("problem sort and counts", () => {
    const ps = [
      { severity: "warning", code: "w", anim: "b", message: "w" },
      { severity: "error", code: "e", anim: "b", time: 1, message: "e" },
      { severity: "error", code: "e", anim: "a", time: 2, message: "e" },
    ] as Problem[];
    expect(sortProblems(ps).map((p) => p.anim + p.severity[0])).toEqual(["ae", "be", "bw"]);
    expect(countProblems(ps)).toEqual({ error: 2, warning: 1, info: 0 });
  });
  it("quick-fix from a real validator problem applies through the doc", () => {
    const doc = parseDoc(JSON.stringify({ format_version: "1.8.0", animations: { t: { animation_length: 1, bones: { armorHead: { rotation: { "0.0": [0, 0, 0], "0.07": [5, 0, 0] } } } } } }), "animation");
    const probs = validateSpidey(doc, []);
    const fixable = probs.find((p) => p.fix);
    if (fixable) {
      const next = fixable.fix!.apply(doc);
      expect(getAnimations(next).length).toBe(1);
      expect(serialize(next)).not.toBe(serialize(doc));
    }
  });
});
