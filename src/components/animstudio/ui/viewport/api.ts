/**
 * Viewport / reference-image keybind API (import from "./ui/viewport/api" or "../viewport/api").
 *
 * Every function targets the Studio that owns keyboard focus (falling back to the active Studio) unless you pass a `StudioApi`
 * as the first optional argument. They are safe to call when no Studio is open (return false / do nothing). No three.js import here.
 *
 * Camera (Blockbench defaults in docs/BLOCKBENCH-PARITY.md 1.4 / 2.4):
 *   setView(v)        v = "persp" | "front" | "back" | "left" | "right" | "top" | "bottom"   ("side" = legacy alias of "left").
 *                     Blockbench numpad: Num8 top, Num2 bottom, Num4 camera_south = "back", Num6 camera_north = "front",
 *                     Num7 camera_east = "right", Num9 camera_west = "left", Num1 resetCamera().
 *                     All but "persp" are TRUE orthographic, locked-angle presets (camera 512 units away, zoom 0.5).
 *   toggleOrtho()     Num5: perspective <-> orthographic at the current angle (unlocks a preset).
 *   resetCamera()     Num1 camera_initial: perspective at [-40, 32, -40] looking at [0, 12, 0].
 *   focusSelection({rotateOnly?, zoom?})   "Center View on Selection" (no default key in Blockbench; Studio.Frame "F" can call it).
 *   frameAll()        fit the whole model.
 *   Display: toggleWire() / toggleXray() / toggleShading() / toggleGrid() / toggleChecker() (T) / cycleViewMode() (Z: textured,
 *            solid, wireframe) / toggleGround().
 *
 * Reference images (Blockbench section 3; no default keys there either):
 *   startRefImageAdd("file" | "clipboard")  "Add Reference Image" (file picker) / "Paste Reference Image" (clipboard); both open the
 *                     import dialog (view mode, layer, add globally) like Blockbench.
 *   editRefImages()   enter/leave Reference Image mode ("Edit Reference Images").
 *   toggleAllRefImages()   "Hide/Show All Reference Images".
 *   deleteSelectedRefImage(): boolean   Delete key hook: removes the selected reference when Reference Image mode is active and
 *                     returns true (the keybind handler must then NOT also delete cubes/bones). `refImageModeActive()` tells before.
 *
 * State (ui/state.ts, additive): view, ortho, shading, viewMode, checker, ground, cubes (multi-selection), refs, refSel, refEdit, refsHidden.
 */
import { focusedStudio, handles, type StudioHandle, type ViewportApi } from "../studios";
import { getActiveStudio } from "../active";
import type { StudioApi, ViewName } from "../state";
import { addRefFromClipboard, addRefFromPicker, deleteSelectedRef, toggleRefEditMode, toggleAllRefs } from "../refimages/refs";

export type { ViewName };

function handleOf(api?: StudioApi): StudioHandle | null {
  if (api) {
    for (const h of handles) if (h.api === api) return h;
    return null;
  }
  const f = focusedStudio({ allowInputs: true });
  if (f) return f;
  const a = getActiveStudio();
  if (a) for (const h of handles) if (h.api === a) return h;
  return null;
}
const vp = (api?: StudioApi): ViewportApi | null => handleOf(api)?.viewport.current ?? null;
const st = (api?: StudioApi) => handleOf(api)?.api ?? null;

export const setView = (v: ViewName, api?: StudioApi) => vp(api)?.setView(v);
export const toggleOrtho = (api?: StudioApi) => vp(api)?.toggleOrtho();
export const resetCamera = (api?: StudioApi) => vp(api)?.resetCamera();
export const focusSelection = (o?: { rotateOnly?: boolean; zoom?: boolean }, api?: StudioApi) => vp(api)?.focusSelection(o);
export const frameAll = (api?: StudioApi) => vp(api)?.frame(false);

export function toggleWire(api?: StudioApi) {
  const a = st(api);
  if (!a) return;
  const wire = !a.store.get().wire;
  a.store.set({ wire, viewMode: wire ? "wireframe" : "textured" });
}
export function toggleXray(api?: StudioApi) { const a = st(api); a?.store.set({ xray: !a.store.get().xray }); }
export function toggleShading(api?: StudioApi) { const a = st(api); a?.store.set({ shading: !a.store.get().shading }); }
export function toggleGrid(api?: StudioApi) { const a = st(api); a?.store.set({ grid: !a.store.get().grid }); }
export function toggleChecker(api?: StudioApi) { const a = st(api); a?.store.set({ checker: !a.store.get().checker }); }
export function toggleGround(api?: StudioApi) { const a = st(api); a?.store.set({ ground: !a.store.get().ground }); }
export function cycleViewMode(api?: StudioApi) {
  const a = st(api);
  if (!a) return;
  const order = ["textured", "solid", "wireframe"] as const;
  const cur = a.store.get().viewMode;
  const next = order[(order.indexOf(cur) + 1) % order.length];
  a.store.set({ viewMode: next, wire: next === "wireframe" });
}

export const startRefImageAdd = (how: "file" | "clipboard" = "file", api?: StudioApi) => {
  const a = st(api);
  if (!a) return;
  if (how === "clipboard") void addRefFromClipboard(a); else addRefFromPicker(a);
};
export const editRefImages = (api?: StudioApi) => { const a = st(api); if (a) toggleRefEditMode(a); };
export const toggleAllRefImages = (api?: StudioApi) => { const a = st(api); if (a) toggleAllRefs(a); };
export const refImageModeActive = (api?: StudioApi) => { const a = st(api); return !!a && a.store.get().refEdit && !!a.store.get().refSel; };
export function deleteSelectedRefImage(api?: StudioApi): boolean {
  const a = st(api);
  return !!a && deleteSelectedRef(a);
}
