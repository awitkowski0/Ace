/** Timeline document operations shared by the dope sheet, graph editor, context menus and keyboard actions. */
import {
  CHANNELS, addKeyframe, animLength, copyKeys, deleteKeyframes, getAnimation, insertKeys, moveKeyframes, offsetKeys, snapKeysToTicks,
  type Animation, type ChannelName, type Doc, type KeyRef, type Keyframe, type Vec3,
} from "../../core";
import type { StudioApi } from "../state";
import { TICK, clamp, hasKey, r4, snapTick } from "./layout";

export interface Cur { doc: Doc; anim: Animation; name: string }
export function cur(api: StudioApi): Cur | null {
  const s = api.store.get();
  if (!s.doc || !s.anim) return null;
  const anim = getAnimation(s.doc, s.anim);
  return anim ? { doc: s.doc, anim, name: s.anim } : null;
}

/** Playhead as a clip time (tick-snapped when snapping is on). */
export function playheadTime(api: StudioApi, anim: Animation): number {
  const s = api.store.get();
  const len = animLength(anim);
  const t = clamp(s.time, 0, len > 0 ? len : s.time);
  return s.snapTicks ? snapTick(t) : r4(t);
}

export function setTime(api: StudioApi, t: number): void {
  const c = cur(api);
  const len = c ? animLength(c.anim) : Infinity;
  api.store.set({ time: clamp(t, 0, len > 0 ? len : Infinity) });
}

/** Insert (or refresh) keys at the playhead for the selected bones (or every animated bone when none selected). */
export function insertKeyAtPlayhead(api: StudioApi, resetValues = false): boolean {
  const c = cur(api);
  if (!c) return false;
  const s = api.store.get();
  const t = playheadTime(api, c.anim);
  const bones = s.bones.length ? s.bones : [...c.anim.bones.keys()];
  let doc = c.doc;
  const added: KeyRef[] = [];
  for (const bone of bones) {
    const b = c.anim.bones.get(bone);
    const chans = CHANNELS.filter((ch) => b?.[ch]);
    for (const channel of chans.length ? chans : (["rotation"] as ChannelName[])) {
      doc = addKeyframe(doc, { anim: c.name, bone, channel, time: t, ...(resetValues ? { value: (channel === "scale" ? [1, 1, 1] : [0, 0, 0]) as Vec3 } : {}) });
      added.push({ bone, channel, time: t });
    }
  }
  if (!added.length) return false;
  api.commit(doc, resetValues ? "Insert Keyframe (reset values)" : "Insert Keyframe");
  api.store.set({ keys: added });
  return true;
}

export function deleteSelectedKeys(api: StudioApi): boolean {
  const c = cur(api);
  const keys = api.store.get().keys;
  if (!c || !keys.length) return false;
  api.commit(deleteKeyframes(c.doc, { anim: c.name, keys }), "Delete Keyframes");
  api.store.set({ keys: [] });
  return true;
}

export function copySelectedKeys(api: StudioApi): boolean {
  const c = cur(api);
  const keys = api.store.get().keys;
  if (!c || !keys.length) return false;
  api.store.set({ clipboard: copyKeys(c.doc, c.name, keys) });
  return true;
}

export function pasteItems(api: StudioApi, at?: number) {
  const c = cur(api);
  const clip = api.store.get().clipboard;
  if (!c || !clip || !clip.keys.length) return null;
  const t = at ?? playheadTime(api, c.anim);
  const items = clip.keys.map((k) => ({ bone: k.bone, channel: k.channel, key: { ...k.key, time: r4(t + k.key.time) } as Keyframe }));
  return { c, items };
}
export function pasteKeys(api: StudioApi, at?: number): boolean {
  const p = pasteItems(api, at);
  if (!p) return false;
  api.commit(insertKeys(p.c.doc, p.c.name, p.items), "Paste Keyframes");
  api.store.set({ keys: p.items.map((i) => ({ bone: i.bone, channel: i.channel, time: i.key.time })) });
  return true;
}

export function duplicateSelectedKeys(api: StudioApi): boolean {
  const c = cur(api);
  const keys = api.store.get().keys;
  if (!c || !keys.length) return false;
  const times = keys.map((k) => k.time);
  const span = Math.max(...times) - Math.min(...times);
  const off = snapTick(span + 0.25);
  const clip = copyKeys(c.doc, c.name, keys);
  const t0 = Math.min(...times) + off;
  const items = clip.keys.map((k) => ({ bone: k.bone, channel: k.channel, key: { ...k.key, time: r4(t0 + k.key.time) } as Keyframe }));
  api.commit(insertKeys(c.doc, c.name, items), "Duplicate Keyframes");
  api.store.set({ keys: items.map((i) => ({ bone: i.bone, channel: i.channel, time: i.key.time })) });
  return true;
}

export function snapSelectedToTicks(api: StudioApi): boolean {
  const c = cur(api);
  if (!c) return false;
  const keys = api.store.get().keys;
  api.commit(snapKeysToTicks(c.doc, { anim: c.name, keys: keys.length ? keys : undefined }), "Snap Keyframes to Ticks");
  return true;
}

export function selectAllKeys(api: StudioApi): boolean {
  const c = cur(api);
  if (!c) return false;
  const out: KeyRef[] = [];
  for (const [bone, b] of c.anim.bones) for (const channel of CHANNELS) for (const k of b[channel]?.keys ?? []) out.push({ bone, channel, time: k.time });
  api.store.set({ keys: out });
  return true;
}

/** Jump to previous/next key time (of the selected bones, else all) or by one tick. */
export function stepTick(api: StudioApi, dir: 1 | -1): void {
  const s = api.store.get();
  setTime(api, snapTick(s.time + dir * TICK));
}

/** ⌘I in the timeline: select every key that is not selected. */
export function invertKeySelection(api: StudioApi): boolean {
  const c = cur(api);
  if (!c) return false;
  const sel = api.store.get().keys;
  const out: KeyRef[] = [];
  for (const [bone, b] of c.anim.bones) for (const channel of CHANNELS) for (const k of b[channel]?.keys ?? []) { const r = { bone, channel, time: k.time }; if (!hasKey(sel, r)) out.push(r); }
  api.store.set({ keys: out });
  return true;
}

/** ← / →: move the selected keyframes by `ticks` snap steps (clamped so no key goes below 0). */
export function nudgeSelectedKeys(api: StudioApi, ticks: number): boolean {
  const c = cur(api);
  const keys = api.store.get().keys;
  if (!c || !keys.length) return false;
  const min = Math.min(...keys.map((k) => k.time));
  const delta = r4(Math.max(ticks * TICK, -min));
  if (!delta) return false;
  api.commit(moveKeyframes(c.doc, { anim: c.name, keys, delta, anchor: api.store.get().anchorMode }), "Move Keyframes");
  api.store.set({ keys: keys.map((k) => ({ ...k, time: r4(k.time + delta) })) });
  return true;
}

/** ↑ / ↓ (graph): add `amount` to the value of the selected keyframes (scale channels use a tenth). One edit for the whole selection. */
export function nudgeKeyValues(api: StudioApi, amount: number): boolean {
  const c = cur(api);
  const keys = api.store.get().keys;
  if (!c || !keys.length) return false;
  const d = offsetKeys(c.doc, { anim: c.name, keys, delta: { rotation: [amount, amount, amount], position: [amount, amount, amount], scale: [amount / 10, amount / 10, amount / 10] } });
  if (d === c.doc) return false;
  api.commit(d, "Move Keyframe Values");
  return true;
}

export const isSelected = hasKey;
