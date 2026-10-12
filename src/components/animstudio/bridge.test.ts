// @vitest-environment jsdom
import { beforeAll, describe, expect, it } from "vitest";
import { createStore } from "../../lib/store";
import { handles, type StudioHandle } from "./ui/studios";
import { initialStudioState, type StudioState } from "./ui/state";
import { parseDoc, serialize, getAnimations } from "./core";

const TEXT = `{"format_version":"1.8.0","animations":{"a":{"loop":true,"animation_length":1,"bones":{"armorHead":{"rotation":{"0":[0,0,0],"1":[0,10,0]}}}},"b":{"animation_length":0.5,"bones":{}}}}`;
const bridge = () => window.__aceStudioBridge!;

let committed: { text: string; label: string }[] = [];
let handle: StudioHandle;

beforeAll(async () => {
  const store = createStore<StudioState>({ ...initialStudioState("/p/x.animation.json"), anim: "a", mode: "animate" });
  store.set({ doc: parseDoc(TEXT, "animation") });
  handle = {
    api: {
      store,
      commit(next, label) { committed.push({ text: serialize(next), label }); store.set({ doc: next }); },
      beginGesture() {}, endGesture() {}, undo() {}, redo() {}, revealInText() {},
    },
    docKey: "local:/p/x.animation.json", groupId: "g", kind: "animation", root: { current: null }, syncFromText() {}, text: () => TEXT,
    viewport: { current: null }, dispose() {},
  };
  handles.add(handle);
  await import("./bridge");
});

describe("window.__aceStudioBridge", () => {
  it("is installed and rejects unknown ops", async () => {
    expect(typeof bridge()).toBe("function");
    await expect(bridge()("rm_rf", {})).rejects.toThrow(/unknown bridge op/);
  });
  it("state lists the open Studio", async () => {
    const s = (await bridge()("state", {})) as any;
    expect(s.studios).toHaveLength(1);
    expect(s.studios[0]).toMatchObject({ file: "/p/x.animation.json", anim: "a", mode: "animate", length: 1, anims: ["a", "b"] });
  });
  it("set_time / select change the Studio state, not the document", async () => {
    await bridge()("set_time", { t: 0.35, anim: "b" });
    expect(handle.api.store.get()).toMatchObject({ time: 0.35, anim: "b", playing: false });
    await bridge()("select", { bones: ["armorHead"], keys: [{ bone: "armorHead", channel: "rotation", time: 1 }] });
    expect(handle.api.store.get().bones).toEqual(["armorHead"]);
    expect(handle.api.store.get().keys).toHaveLength(1);
    await expect(bridge()("set_time", { t: 1, anim: "nope" })).rejects.toThrow(/no animation/);
    expect(committed).toHaveLength(0);
  });
  it("apply_text goes through the Studio commit (one undo stop) and refuses unparseable text", async () => {
    const text = TEXT.replace('"loop":true', '"loop":false');
    const r = (await bridge()("apply_text", { file: "/p/x.animation.json", text, label: "Claude: set_loop" })) as any;
    expect(r).toMatchObject({ applied: true, via: "studio" });
    expect(committed).toEqual([{ text, label: "Claude: set_loop" }]);
    expect(getAnimations(handle.api.store.get().doc!)[0].loop).toBe(false);
    await expect(bridge()("apply_text", { file: "/p/x.animation.json", text: "{nope", label: "x" })).rejects.toThrow();
    expect(committed).toHaveLength(1);
  });
});
