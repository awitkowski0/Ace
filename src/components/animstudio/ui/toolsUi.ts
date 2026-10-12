/** Per-Studio UI flags for the tool panels (breakdown panel, noise dialog, outliner options...). Kept outside StudioState so state.ts stays shared-minimal. */
import { createStore, useStore, type Store } from "../../../lib/store";
import type { ClipKey, Doc } from "../core";
import type { GizmoTool, StudioApi } from "./state";

/** Bones / cubes copied in Edit mode (file-space snapshots, pasted with fresh unique names). */
export interface ElemClip {
  bones: Array<{ name: string; parent?: string; pivot: [number, number, number]; rotation?: [number, number, number]; cubes: ElemCube[] }>;
  cubes: ElemCube[];
}
export interface ElemCube {
  name?: string;
  origin: [number, number, number];
  size: [number, number, number];
  pivot?: [number, number, number];
  rotation?: [number, number, number];
  inflate?: number;
  mirror?: boolean;
  uv?: import("../core").CubeUv;
}

export interface ToolsUi {
  breakdownOpen: boolean;
  noise: null | { mode: "paste" | "add" };
  problemsOpen: boolean;
  /** timeline tab */
  tlTab: "dope" | "graph";
  /** noise-paste preview: keys that would be created (drawn as ghost diamonds in the dope sheet) */
  ghost: ClipKey[] | null;
  /** Action Control (F) overlay */
  actionControl: boolean;
  /** outliner "more options" columns (F4) */
  outlinerOptions: boolean;
  /** bone currently being renamed inline in the outliner (F2) */
  renaming: string | null;
  /** tool used before the current one (Space swaps) */
  prevTool: GizmoTool;
  /** Edit-mode clipboard */
  elemClip: ElemClip | null;
  /** ⌘B */
  sidebarsHidden: boolean;
  /** "I": names hidden by Hide Everything Except Selection (null = not active) */
  hiddenBefore: string[] | null;
  /** Mirror Animating: pose edits are mirrored onto the counterpart bone */
  mirrorAnimating: boolean;
  /** markers of animations that cannot store them (session only), keyed by animation name */
  markers: Record<string, Array<{ time: number; color: number; name?: string }>>;
  /** collapsed groups in the outliner */
  collapsed: string[];
}
const stores = new WeakMap<object, Store<ToolsUi>>();
export function toolsStore(api: StudioApi): Store<ToolsUi> {
  let s = stores.get(api.store);
  if (!s) {
    const st = createStore<ToolsUi>({
      breakdownOpen: false, noise: null, problemsOpen: false, tlTab: "dope", ghost: null,
      actionControl: false, outlinerOptions: false, renaming: null, prevTool: "move", elemClip: null, sidebarsHidden: false,
      hiddenBefore: null, mirrorAnimating: false, markers: {}, collapsed: [],
    });
    s = st;
    stores.set(api.store, st);
    let last = api.store.get().tool;
    api.store.subscribe(() => {
      const t = api.store.get().tool;
      if (t !== last) { st.set({ prevTool: last }); last = t; }
    });
  }
  return s;
}
export function useToolsUi(api: StudioApi): ToolsUi {
  return useStore(toolsStore(api));
}
export type { Doc };
