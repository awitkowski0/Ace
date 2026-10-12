/** Animation-level commands behind the timeline / Animations panel / Action Control (flip, mirror, bake, scale, interpolation, markers). */
import {
  CHANNELS, addMarker, bakeAnimation, deleteMarker, flipAnimation, getMarkers, mirrorKeys, moveMarker, scaleAnimation, setBezierHandles,
  setKeyInterpolation, setLength, animLength, DEFAULT_BEZIER, findKey,
  type Doc,
} from "../../core";
import { confirmDialog, promptDialog } from "../../../shell/dialogs";
import type { StudioApi } from "../state";
import { toolsStore } from "../toolsUi";
import { cur, setTime } from "./ops";
import { snapTick } from "./layout";

export type Interpolation = "linear" | "catmullrom" | "bezier" | "step";
const guard = async (fn: () => void) => { try { fn(); return true; } catch (e) { await confirmDialog({ title: "Animation Studio", message: String((e as Error).message ?? e), okLabel: "OK" }); return false; } };

/** Interpolation of a key as Blockbench names it. */
export function interpolationOf(k: { easing?: string; lerp?: string; bb?: { interpolation?: string }; bezier?: unknown }): Interpolation | "eased" {
  const bi = k.bb?.interpolation;
  if (bi === "bezier" || bi === "step" || bi === "catmullrom" || bi === "linear") return bi;
  if (k.lerp === "catmullrom") return "catmullrom";
  if (k.easing === "step") return "step";
  if (k.easing && k.easing !== "linear") return "eased";
  return "linear";
}

export async function setInterpolation(api: StudioApi, interpolation: Interpolation): Promise<boolean> {
  const c = cur(api);
  const keys = api.store.get().keys;
  if (!c || !keys.length) return false;
  if (interpolation === "bezier" && c.doc.kind !== "bbmodel") {
    await confirmDialog({ title: "Bezier interpolation", message: "Bezier curves are saved only in .bbmodel files. In Bedrock / GeckoLib animation files Blockbench bakes them into sampled keyframes on export; use Bake Animation instead.", okLabel: "OK" });
    return false;
  }
  return guard(() => api.commit(setKeyInterpolation(c.doc, { anim: c.name, keys, interpolation }), "Change Interpolation"));
}

export async function resetBezierHandles(api: StudioApi): Promise<boolean> {
  const c = cur(api);
  const keys = api.store.get().keys;
  if (!c || !keys.length || c.doc.kind !== "bbmodel") return false;
  return guard(() => {
    let d: Doc = c.doc;
    for (const key of keys) {
      const k = findKey(c.anim, key);
      if (k?.bezier || k?.bb?.interpolation === "bezier") d = setBezierHandles(d, { anim: c.name, key, patch: { linked: true, leftTime: [...DEFAULT_BEZIER.leftTime], leftValue: [...DEFAULT_BEZIER.leftValue], rightTime: [...DEFAULT_BEZIER.rightTime], rightValue: [...DEFAULT_BEZIER.rightValue] } });
    }
    api.commit(d, "Reset Bezier Handles");
  });
}

export function flip(api: StudioApi, axis: "x" | "y" | "z", swapSides: boolean): boolean {
  const c = cur(api);
  if (!c) return false;
  api.commit(flipAnimation(c.doc, { anim: c.name, axis, swapSides }), `Flip Animation ${axis.toUpperCase()}`);
  return true;
}

/** Mirror the selected keys onto the counterpart bones (left/right). */
export function mirrorSelectedKeys(api: StudioApi): boolean {
  const c = cur(api);
  const keys = api.store.get().keys;
  if (!c || !keys.length) return false;
  const r = mirrorKeys(c.doc, { anim: c.name, keys });
  if (r.doc === c.doc) return false;
  api.commit(r.doc, "Mirror Keyframes");
  api.store.set({ keys: [...keys, ...r.added] });
  return true;
}

export async function bake(api: StudioApi): Promise<boolean> {
  const c = cur(api);
  if (!c) return false;
  const bezierOnly = c.doc.kind === "bbmodel";
  const ok = await confirmDialog({
    title: "Bake Animation",
    message: bezierOnly ? `Replace the bezier segments of "${c.name}" with linear keyframes every tick (Bedrock export does the same)?` : `Replace the keyframes of "${c.name}" with linear keyframes sampled every tick (removes easings, catmull-rom and step)? You can undo this.`,
    okLabel: "Bake",
  });
  if (!ok) return false;
  return guard(() => api.commit(bakeAnimation(c.doc, { anim: c.name, step: 0.05, onlyBezier: bezierOnly }), "Bake Animation"));
}

export async function scale(api: StudioApi): Promise<boolean> {
  const c = cur(api);
  if (!c) return false;
  const t = await promptDialog({ title: "Scale animation time", initial: "1", okLabel: "Scale" });
  const f = Number(t);
  if (t === null || !isFinite(f) || f <= 0 || f === 1) return false;
  return guard(() => api.commit(scaleAnimation(c.doc, { anim: c.name, factor: f }), "Scale Animation"));
}

// ---------------------------------------------------------------- markers

export interface MarkerView { index: number; time: number; color: number; name?: string; session: boolean }
export function markersOf(api: StudioApi): MarkerView[] {
  const s = api.store.get();
  if (!s.doc || !s.anim) return [];
  if (s.doc.kind === "bbmodel") return getMarkers(s.doc, s.anim).map((m, index) => ({ ...m, index, session: false }));
  return (toolsStore(api).get().markers[s.anim] ?? []).map((m, index) => ({ ...m, index, session: true }));
}
export function addMarkerAtPlayhead(api: StudioApi): boolean {
  const c = cur(api);
  if (!c) return false;
  const time = api.store.get().snapTicks ? snapTick(api.store.get().time) : Math.round(api.store.get().time * 1e4) / 1e4;
  if (c.doc.kind === "bbmodel") { api.commit(addMarker(c.doc, { anim: c.name, time }), "Set Marker"); return true; }
  const ui = toolsStore(api);
  const all = ui.get().markers;
  ui.set({ markers: { ...all, [c.name]: [...(all[c.name] ?? []), { time, color: 0 }].sort((a, b) => a.time - b.time) } });
  return true;
}
export function moveMarkerTo(api: StudioApi, m: MarkerView, time: number): boolean {
  const c = cur(api);
  if (!c) return false;
  if (!m.session) { api.commit(moveMarker(c.doc, { anim: c.name, index: m.index, time }), "Move Marker"); return true; }
  const ui = toolsStore(api);
  const list = (ui.get().markers[c.name] ?? []).map((x, i) => (i === m.index ? { ...x, time } : x));
  ui.set({ markers: { ...ui.get().markers, [c.name]: list } });
  return true;
}
export function deleteMarkerAt(api: StudioApi, m: MarkerView): boolean {
  const c = cur(api);
  if (!c) return false;
  if (!m.session) { api.commit(deleteMarker(c.doc, { anim: c.name, index: m.index }), "Delete Marker"); return true; }
  const ui = toolsStore(api);
  ui.set({ markers: { ...ui.get().markers, [c.name]: (ui.get().markers[c.name] ?? []).filter((_, i) => i !== m.index) } });
  return true;
}
export function jumpToMarker(api: StudioApi, dir: 1 | -1): boolean {
  const t = api.store.get().time;
  const ms = markersOf(api).map((m) => m.time).filter((x) => (dir > 0 ? x > t + 1e-6 : x < t - 1e-6));
  if (!ms.length) return false;
  setTime(api, dir > 0 ? Math.min(...ms) : Math.max(...ms));
  return true;
}

/** ⌘End: animation length = playhead. */
export function setAnimationEnd(api: StudioApi): boolean {
  const c = cur(api);
  if (!c) return false;
  const t = api.store.get().time;
  if (!(t > 0) || Math.abs(t - animLength(c.anim)) < 1e-9) return false;
  api.commit(setLength(c.doc, { anim: c.name, length: Math.round(t * 10000) / 10000 }), "Set Animation End");
  return true;
}

export { CHANNELS };
