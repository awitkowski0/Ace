/**
 * Animation Studio actions. The key bindings come from the data table in ../keymap.ts (Blockbench v5.2.2 defaults, ⌘ for Ctrl);
 * this file holds the handlers (keyed by the table's `action`) and registers everything with the Ace action registry.
 *
 * Gate (`liveStudio`): a Studio key is live only while a Studio pane owns DOM focus and focus is not in a text field /
 * Monaco (or, with nothing focused, when the active Studio is visible). All actions are `context: "editor"`, so a popup being
 * open disables them, and outside a Studio every binding falls through to Ace's IntelliJ keymap untouched.
 */
import { registerAction } from "../../../../actions/registry";
import { saveAll } from "../../../../editor/store";
import { promptDialog } from "../../../shell/dialogs";
import { animLength, renameAnimation, type NumVec3 } from "../../core";
import { getActiveStudio } from "../active";
import { STUDIO_KEYMAP, registeredEntries } from "../keymap";
import { canEditDoc, opAddBone, opAddCube, opAddGroup, opCopyElements, opCutElements, opDeleteSelection, opDuplicate, opGroupElements, opHideOthers, opInvertSelection, opNudge, opPasteElements, opSelectAll, opSelectByPattern, opSort, opToggleFlag, opUngroup } from "../ops";
import type { GizmoTool, StudioApi, StudioMode, StudioState } from "../state";
import { allStudios, focusedStudio, type StudioHandle } from "../studios";
import { toolsStore } from "../toolsUi";
import { addMarkerAtPlayhead, bake, flip, mirrorSelectedKeys, scale, setAnimationEnd, setInterpolation, resetBezierHandles } from "../timeline/animCommands";
import { cur, copySelectedKeys, deleteSelectedKeys, duplicateSelectedKeys, insertKeyAtPlayhead, invertKeySelection, nudgeKeyValues, nudgeSelectedKeys, pasteKeys, selectAllKeys, setTime, snapSelectedToTicks, stepTick } from "../timeline/ops";
import * as vpApi from "../viewport/api";
import { vpCall } from "./vp";

type CameraPreset = "initial" | "top" | "bottom" | "south" | "north" | "east" | "west";
import { DEFAULT_YAW, nudgeStep, nudgeVector, type NudgeDir } from "./nudge";

/** True when the keyboard focus is somewhere keys should go to the Studio (not a text input, not Monaco). */
export function studioKeysLive(): boolean {
  const el = document.activeElement as HTMLElement | null;
  if (!el || el === document.body) return true;
  if (el.closest?.(".monaco-editor")) return false;
  const tag = el.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable) {
    // range sliders and checkboxes do not consume these keys
    return (el as HTMLInputElement).type === "range" || (el as HTMLInputElement).type === "checkbox";
  }
  return true;
}

/** The Studio that gets the key, or null. */
export function liveStudio(): StudioHandle | null {
  if (!studioKeysLive()) return null;
  const f = focusedStudio({ allowInputs: true });
  if (f) return f;
  const el = document.activeElement;
  if (!el || el === document.body) {
    const a = getActiveStudio();
    const h = allStudios().find((x) => x.api === a);
    const root = h?.root.current;
    if (h && root && root.isConnected && root.offsetParent !== null) return h;
  }
  return null;
}

// ---------------------------------------------------------------- availability

const group = (s: Pick<StudioState, "mode">): "edit" | "animate" => (s.mode === "edit" ? "edit" : "animate");
/** Edit-mode geometry editing applies (geo / bbmodel documents; not animation files or the built-in player rig). */
export const geometryEditable = (s: Pick<StudioState, "doc">): boolean => canEditDoc(s.doc);

/** Whether a gizmo tool applies in the current mode / document (the toolbar disables the others). */
export function toolAvailable(s: Pick<StudioState, "mode" | "doc">, t: GizmoTool): boolean {
  const mode: StudioMode = s.mode;
  if (mode === "edit") return geometryEditable(s);
  if (t === "pivot") return false; // pivots are edited in Edit mode; the Animate pivot is the bone pivot
  if (t === "resize" && mode === "pose") return false; // Blockbench: edit / display / animate only
  return true;
}

// ---------------------------------------------------------------- handlers

interface Def {
  id: string;
  title: string;
  /** keyed by the keymap table; extras without keys are command-palette only */
  enabled: (a: StudioApi, h: StudioHandle) => boolean;
  run: (a: StudioApi, h: StudioHandle) => void | Promise<void>;
}
const inEdit = (a: StudioApi) => group(a.store.get()) === "edit";
const inAnim = (a: StudioApi) => group(a.store.get()) === "animate" && !!cur(a);
const canEdit = (a: StudioApi) => geometryEditable(a.store.get());
const editSel = (a: StudioApi) => { const s = a.store.get(); return inEdit(a) && canEdit(a) && (!!s.cube || s.bones.length > 0); };
const hasKeys = (a: StudioApi) => inAnim(a) && a.store.get().keys.length > 0;
const anyTool = (t: GizmoTool): Pick<Def, "enabled"> => ({ enabled: (a) => toolAvailable(a.store.get(), t) });

const mods = () => { const e = (typeof window !== "undefined" ? (window as unknown as { event?: KeyboardEvent }).event : undefined); return { shift: !!e?.shiftKey, meta: !!e?.metaKey }; };
function nudge(dir: NudgeDir): Def["run"] {
  return (a, h) => {
    const m = mods();
    const yaw = vpCall<number>(h, "cameraYaw").value;
    const v = nudgeVector(dir, typeof yaw === "number" && isFinite(yaw) ? yaw : DEFAULT_YAW, nudgeStep(m.shift, m.meta));
    opNudge(a, v as NumVec3, `Move ${dir[0].toUpperCase()}${dir.slice(1)}`);
  };
}
const VIEW_OF: Record<Exclude<CameraPreset, "initial">, vpApi.ViewName> = { top: "top", bottom: "bottom", south: "back", north: "front", east: "right", west: "left" };
const viewDef = (preset: CameraPreset, title: string): Def => ({
  id: `Studio.View.${preset[0].toUpperCase()}${preset.slice(1)}`, title: `Camera Angle: ${title}`, enabled: () => true,
  run: (a) => { if (preset === "initial") vpApi.resetCamera(a); else vpApi.setView(VIEW_OF[preset], a); },
});
const vpDef = (id: string, title: string, method: string, ...args: unknown[]): Def => ({ id, title, enabled: () => true, run: (_a, h) => { vpCall(h, method, ...args); } });
const toolDef = (id: string, title: string, t: GizmoTool): Def => ({ id, title, ...anyTool(t), run: (a) => a.store.set({ tool: t }) });

async function renameAnimationPrompt(a: StudioApi) {
  const c = cur(a);
  if (!c) return;
  const name = await promptDialog({ title: "Rename animation", initial: c.name, okLabel: "Rename" });
  if (!name?.trim() || name === c.name) return;
  try { a.commit(renameAnimation(c.doc, { name: c.name, newName: name.trim() }), "Rename Animation"); a.store.set({ anim: name.trim() }); } catch { /* duplicate name: ignore */ }
}

export const DEFS: Def[] = [
  // history
  { id: "Studio.Undo", title: "Undo", enabled: () => true, run: (a) => a.undo() },
  { id: "Studio.Redo", title: "Redo", enabled: () => true, run: (a) => a.redo() },
  // clipboard (Animate: keyframes; Edit: bones / cubes)
  { id: "Studio.Copy", title: "Copy", enabled: (a) => (inEdit(a) ? editSel(a) : hasKeys(a)), run: (a) => { inEdit(a) ? opCopyElements(a) : copySelectedKeys(a); } },
  { id: "Studio.Cut", title: "Cut", enabled: (a) => (inEdit(a) ? editSel(a) : hasKeys(a)), run: (a) => { if (inEdit(a)) opCutElements(a); else if (copySelectedKeys(a)) deleteSelectedKeys(a); } },
  { id: "Studio.Paste", title: "Paste", enabled: (a) => (inEdit(a) ? canEdit(a) && !!toolsStore(a).get().elemClip : inAnim(a) && !!a.store.get().clipboard), run: (a) => { inEdit(a) ? opPasteElements(a) : pasteKeys(a); } },
  { id: "Studio.Duplicate", title: "Duplicate", enabled: (a) => (inEdit(a) ? editSel(a) : hasKeys(a)), run: (a) => { inEdit(a) ? opDuplicate(a) : duplicateSelectedKeys(a); } },
  { id: "Studio.Delete", title: "Delete", enabled: (a) => vpApi.refImageModeActive(a) || (inEdit(a) ? editSel(a) : hasKeys(a)), run: (a) => { if (vpApi.deleteSelectedRefImage(a)) return; inEdit(a) ? opDeleteSelection(a) : deleteSelectedKeys(a); } },
  { id: "Studio.SelectAll", title: "Select All", enabled: (a) => (inEdit(a) ? canEdit(a) || !!a.store.get().doc : inAnim(a)), run: (a) => { inEdit(a) ? opSelectAll(a) : selectAllKeys(a); } },
  { id: "Studio.InvertSelection", title: "Invert Selection", enabled: (a) => (inEdit(a) ? !!a.store.get().doc : inAnim(a)), run: (a) => { inEdit(a) ? opInvertSelection(a) : invertKeySelection(a); } },
  {
    id: "Studio.Rename", title: "Rename",
    enabled: (a) => { const s = a.store.get(); return (canEdit(a) && s.bones.length > 0) || (inAnim(a) && !s.bones.length); },
    run: (a) => { const s = a.store.get(); if (canEdit(a) && s.bones[0]) toolsStore(a).set({ renaming: s.cube?.bone ?? s.bones[0] }); else void renameAnimationPrompt(a); },
  },
  {
    id: "Studio.Cancel", title: "Cancel",
    enabled: (a, h) => { const t = toolsStore(a).get(); return t.actionControl || t.breakdownOpen || !!t.noise || vpCall<boolean>(h, "isDragging").value === true; },
    run: (a, h) => {
      const t = toolsStore(a);
      if (t.get().actionControl) { t.set({ actionControl: false }); return; }
      if (vpCall<boolean>(h, "isDragging").value) { vpCall(h, "cancelDrag"); return; }
      if (t.get().noise) t.set({ noise: null, ghost: null });
      else if (t.get().breakdownOpen) { t.set({ breakdownOpen: false }); a.store.set({ previewPose: null }); }
    },
  },
  { id: "Studio.ActionControl", title: "Action Control", enabled: () => true, run: (a) => toolsStore(a).set({ actionControl: !toolsStore(a).get().actionControl }) },
  {
    id: "Studio.Save", title: "Save", enabled: () => true, run: () => { void saveAll(); },
  },
  {
    id: "Studio.ToggleSidebars", title: "Toggle Sidebars", enabled: () => true,
    run: (a, h) => {
      const t = toolsStore(a);
      const hidden = !t.get().sidebarsHidden;
      t.set({ sidebarsHidden: hidden });
      if (h.root.current) { if (hidden) h.root.current.dataset.sidebars = "off"; else delete h.root.current.dataset.sidebars; }
    },
  },

  // tools
  toolDef("Studio.Tool.Move", "Move Tool", "move"),
  toolDef("Studio.Tool.Resize", "Resize Tool", "resize"),
  toolDef("Studio.Tool.Rotate", "Rotate Tool", "rotate"),
  toolDef("Studio.Tool.Pivot", "Pivot Tool", "pivot"),
  { id: "Studio.Tool.VertexSnap", title: "Vertex Snap Tool", enabled: (a) => inEdit(a) && canEdit(a), run: (_a, h) => { vpCall(h, "setTool", "vertex_snap"); } },
  { id: "Studio.Tool.Stretch", title: "Stretch Tool", enabled: (a) => inEdit(a) && canEdit(a), run: (_a, h) => { vpCall(h, "setTool", "stretch"); } },
  {
    id: "Studio.SwapTools", title: "Swap Tools", enabled: (a) => inEdit(a) && canEdit(a),
    run: (a) => { const s = a.store.get(); const prev = toolsStore(a).get().prevTool; a.store.set({ tool: prev && prev !== s.tool && toolAvailable(s, prev) ? prev : "move" }); },
  },

  // edit mode
  { id: "Studio.Move.Up", title: "Move Up", enabled: editSel, run: nudge("up") },
  { id: "Studio.Move.Down", title: "Move Down", enabled: editSel, run: nudge("down") },
  { id: "Studio.Move.Left", title: "Move Left", enabled: editSel, run: nudge("left") },
  { id: "Studio.Move.Right", title: "Move Right", enabled: editSel, run: nudge("right") },
  { id: "Studio.Move.Forth", title: "Move Forth", enabled: editSel, run: nudge("forth") },
  { id: "Studio.Move.Back", title: "Move Back", enabled: editSel, run: nudge("back") },
  { id: "Studio.AddGroup", title: "Add Group", enabled: (a) => inEdit(a) && canEdit(a), run: (a) => { opAddGroup(a); } },
  { id: "Studio.GroupElements", title: "Group Elements", enabled: editSel, run: (a) => { opGroupElements(a); } },
  { id: "Studio.Ungroup", title: "Ungroup", enabled: (a) => editSel(a) && !a.store.get().cube, run: (a) => { opUngroup(a); } },
  { id: "Studio.HideOthers", title: "Hide Everything Except Selection", enabled: (a) => inEdit(a) && (!!toolsStore(a).get().hiddenBefore || editSel(a) || !!a.store.get().bones.length), run: (a) => { opHideOthers(a); } },
  {
    id: "Studio.SelectWindow", title: "Select...", enabled: (a) => inEdit(a) && canEdit(a),
    run: async (a) => { const p = await promptDialog({ title: "Select by name (* wildcards)", initial: "*", okLabel: "Select" }); if (p) opSelectByPattern(a, p); },
  },
  { id: "Studio.OutlinerOptions", title: "Toggle More Options", enabled: () => true, run: (a) => toolsStore(a).set({ outlinerOptions: !toolsStore(a).get().outlinerOptions }) },
  { id: "Studio.NewBone", title: "New Bone", enabled: (a) => inEdit(a) && canEdit(a), run: (a) => { opAddBone(a, a.store.get().bones[0]); } },
  { id: "Studio.NewCube", title: "New Cube", enabled: (a) => inEdit(a) && canEdit(a), run: (a) => { opAddCube(a); } },
  { id: "Studio.SortOutliner", title: "Sort Outliner", enabled: (a) => canEdit(a), run: (a) => { opSort(a); } },
  {
    id: "Studio.CollapseGroups", title: "Collapse Groups", enabled: (a) => canEdit(a) || !!a.store.get().doc,
    run: (a) => { const rows = document.querySelectorAll<HTMLElement>("[data-bone]"); toolsStore(a).set({ collapsed: [...rows].map((r) => r.dataset.bone!).filter(Boolean) }); },
  },
  { id: "Studio.UnfoldGroups", title: "Unfold Groups", enabled: () => true, run: (a) => toolsStore(a).set({ collapsed: [] }) },
  { id: "Studio.UnlockAll", title: "Unlock All", enabled: () => true, run: (a) => a.store.set({ locked: [] }) },
  { id: "Studio.ShowAll", title: "Show All", enabled: () => true, run: (a) => { a.store.set({ hidden: [] }); toolsStore(a).set({ hiddenBefore: null }); } },
  { id: "Studio.ToggleExport", title: "Toggle Export", enabled: (a) => a.store.get().doc?.kind === "bbmodel", run: (a) => { opToggleFlag(a, "export"); } },
  { id: "Studio.ToggleShade", title: "Toggle Shading", enabled: (a) => a.store.get().doc?.kind === "bbmodel", run: (a) => { opToggleFlag(a, "shade"); } },
  { id: "Studio.ToggleAutoUv", title: "Toggle Auto UV", enabled: (a) => a.store.get().doc?.kind === "bbmodel", run: (a) => { opToggleFlag(a, "autouv"); } },
  { id: "Studio.ToggleMirrorUv", title: "Toggle Mirror UV", enabled: (a) => canEdit(a), run: (a) => { opToggleFlag(a, "mirror_uv"); } },

  // animate
  { id: "Studio.AddKeyframe", title: "Add Keyframe", enabled: (a) => inAnim(a), run: (a) => { insertKeyAtPlayhead(a); } },
  { id: "Studio.AddKeyframeReset", title: "Add Keyframe (reset values)", enabled: (a) => inAnim(a), run: (a) => { insertKeyAtPlayhead(a, true); } },
  { id: "Studio.KeyBack", title: "Move Keyframes Back", enabled: hasKeys, run: (a) => { nudgeSelectedKeys(a, -1); } },
  { id: "Studio.KeyForth", title: "Move Keyframes Forth", enabled: hasKeys, run: (a) => { nudgeSelectedKeys(a, 1); } },
  { id: "Studio.GraphUp", title: "Move Keyframe Graph Up", enabled: hasKeys, run: (a) => { nudgeKeyValues(a, 1); } },
  { id: "Studio.GraphDown", title: "Move Keyframe Graph Down", enabled: hasKeys, run: (a) => { nudgeKeyValues(a, -1); } },
  { id: "Studio.ToggleGraph", title: "Toggle Graph Editor", enabled: (a) => group(a.store.get()) === "animate", run: (a) => toolsStore(a).set({ tlTab: toolsStore(a).get().tlTab === "graph" ? "dope" : "graph" }) },
  { id: "Studio.PlayPause", title: "Play / Pause", enabled: inAnim, run: (a) => a.store.set({ playing: !a.store.get().playing }) },
  { id: "Studio.JumpStart", title: "Jump to Animation Start", enabled: inAnim, run: (a) => setTime(a, 0) },
  { id: "Studio.JumpEnd", title: "Jump to Animation End", enabled: inAnim, run: (a) => { const c = cur(a); if (c) setTime(a, animLength(c.anim)); } },
  { id: "Studio.FrameBack", title: "Jump 1 Frame Back", enabled: (a) => !!cur(a), run: (a) => stepTick(a, -1) },
  { id: "Studio.FrameForth", title: "Jump 1 Frame Forth", enabled: (a) => !!cur(a), run: (a) => stepTick(a, 1) },
  { id: "Studio.AddMarker", title: "Set Marker", enabled: inAnim, run: (a) => { addMarkerAtPlayhead(a); } },
  { id: "Studio.SetAnimationEnd", title: "Set Animation End", enabled: inAnim, run: (a) => { setAnimationEnd(a); } },
  { id: "Studio.SnapKeys", title: "Snap Keyframes to Ticks", enabled: inAnim, run: (a) => { snapSelectedToTicks(a); } },
  { id: "Studio.MirrorKeys", title: "Mirror Keyframes to the Other Side", enabled: hasKeys, run: (a) => { mirrorSelectedKeys(a); } },
  { id: "Studio.FlipX", title: "Flip Animation X (swap left / right)", enabled: inAnim, run: (a) => { flip(a, "x", true); } },
  { id: "Studio.FlipY", title: "Flip Animation Y", enabled: inAnim, run: (a) => { flip(a, "y", false); } },
  { id: "Studio.FlipZ", title: "Flip Animation Z", enabled: inAnim, run: (a) => { flip(a, "z", false); } },
  { id: "Studio.BakeAnimation", title: "Bake Animation", enabled: inAnim, run: (a) => { void bake(a); } },
  { id: "Studio.ScaleAnimation", title: "Scale Animation Time", enabled: inAnim, run: (a) => { void scale(a); } },
  { id: "Studio.Interp.Linear", title: "Interpolation: Linear", enabled: hasKeys, run: (a) => { void setInterpolation(a, "linear"); } },
  { id: "Studio.Interp.Catmullrom", title: "Interpolation: Catmull-Rom", enabled: hasKeys, run: (a) => { void setInterpolation(a, "catmullrom"); } },
  { id: "Studio.Interp.Bezier", title: "Interpolation: Bezier", enabled: hasKeys, run: (a) => { void setInterpolation(a, "bezier"); } },
  { id: "Studio.Interp.Step", title: "Interpolation: Step", enabled: hasKeys, run: (a) => { void setInterpolation(a, "step"); } },
  { id: "Studio.ResetBezier", title: "Reset Bezier Handles", enabled: hasKeys, run: (a) => { void resetBezierHandles(a); } },
  { id: "Studio.MirrorAnimating", title: "Toggle Mirror Animating", enabled: inAnim, run: (a) => toolsStore(a).set({ mirrorAnimating: !toolsStore(a).get().mirrorAnimating }) },
  // Ace-only
  { id: "Studio.Breakdown", title: "Pose Between Frames", enabled: inAnim, run: (a) => openBreakdown(a) },
  { id: "Studio.PasteWithNoise", title: "Paste with Noise…", enabled: inAnim, run: (a) => openNoise(a, "paste") },
  { id: "Studio.AddNoise", title: "Add Noise to Selection…", enabled: hasKeys, run: (a) => openNoise(a, "add") },
  { id: "Studio.Frame", title: "Frame Selected", enabled: () => true, run: (a) => { vpApi.focusSelection(undefined, a); } },

  // viewport
  vpDef("Studio.Screenshot", "Screenshot Model", "screenshot"),
  { id: "Studio.ViewMode", title: "View Mode", enabled: () => true, run: (a) => vpApi.cycleViewMode(a) },
  { id: "Studio.Checkerboard", title: "Toggle Checkerboard", enabled: () => true, run: (a) => vpApi.toggleChecker(a) },
  vpDef("Studio.PixelGrid", "Toggle Pixel Grid", "togglePixelGrid"),
  { id: "Studio.View.Projection", title: "Toggle Camera Projection", enabled: () => true, run: (a) => { vpApi.toggleOrtho(a); } },
  viewDef("initial", "Initial"), viewDef("top", "Top"), viewDef("bottom", "Bottom"),
  viewDef("south", "South"), viewDef("north", "North"), viewDef("east", "East"), viewDef("west", "West"),
];

export function openBreakdown(api: StudioApi): void {
  if (!cur(api)) return;
  api.store.set({ playing: false });
  toolsStore(api).set({ breakdownOpen: true });
}
export function openNoise(api: StudioApi, mode: "paste" | "add"): void {
  if (!cur(api)) return;
  api.store.set({ playing: false });
  toolsStore(api).set({ noise: { mode } });
}

let registered = false;
/** Register every Studio action (keys from the keymap table; entries without a key are palette / menu commands). */
export function registerStudioActions(): void {
  if (registered) return;
  registered = true;
  const keys = new Map<string, string[]>();
  for (const e of registeredEntries()) if (e.action) keys.set(e.action, [...(keys.get(e.action) ?? []), ...e.keys]);
  for (const d of DEFS) {
    registerAction({
      id: d.id, title: `Animation Studio: ${d.title}`, defaultKeys: keys.get(d.id), context: "editor",
      isEnabled: () => { const h = liveStudio(); return !!h && d.enabled(h.api, h); },
      run: () => { const h = liveStudio(); if (h) return d.run(h.api, h); },
    });
  }
}
/** @deprecated name kept for register.ts callers */
export const registerTimelineActions = registerStudioActions;

/** Commands for Action Control: Studio commands that are enabled right now for `h`, with their key labels. */
export function studioCommands(h: StudioHandle): Array<{ id: string; title: string; keys: string[] }> {
  const byAction = new Map<string, string[]>();
  for (const e of STUDIO_KEYMAP) if (e.action && e.keys.length) byAction.set(e.action, [...(byAction.get(e.action) ?? []), e.mac]);
  return DEFS.filter((d) => { try { return d.enabled(h.api, h) && d.id !== "Studio.ActionControl"; } catch { return false; } })
    .map((d) => ({ id: d.id, title: d.title, keys: [...new Set(byAction.get(d.id) ?? [])] }));
}
export function runStudioCommand(h: StudioHandle, id: string): void {
  const d = DEFS.find((x) => x.id === id);
  if (d && d.enabled(h.api, h)) void d.run(h.api, h);
}
