/**
 * Shared Studio UI state — the contract between the viewport/shell half and the timeline/tools half of the UI.
 * One `StudioState` store per open Studio tab (created by StudioView, passed down via StudioContext).
 * Document changes go ONLY through `commit()`: it serializes, computes a minimal edit and applies it to the Monaco
 * model as one undo stop. The store's `doc` is then refreshed from the text (single source of truth = Monaco text).
 * Extend (add fields/helpers) but don't rename or remove anything here without updating both halves.
 */
import { createContext, useContext, useRef, useSyncExternalStore } from "react";
import { createStore, useStore, type Store } from "../../../lib/store";
import { initialCons, type ConsUi } from "./constraints/types"; // == constraints hook ==
import type { ChannelName, ClipInfo, Clipboard, Doc, Face, GeoTexState, KeyRef, Pose, Problem, PoseSet, RefImage } from "../core";

export type StudioMode = "edit" | "animate" | "pose";
export type GizmoTool = "move" | "resize" | "rotate" | "pivot";

export interface StudioState {
  /** last successfully parsed doc (null while the text doesn't parse — show parseError, keep last good view) */
  doc: Doc | null;
  parseError: string | null;
  path: string;
  mode: StudioMode;
  tool: GizmoTool;
  space: "local" | "global";
  /** selection */
  bones: string[];
  cube: { bone: string; index: number } | null;
  anim: string | null;
  keys: KeyRef[];
  /** which reader's clip semantics the preview uses: the path's own ("auto": armor folder = player, else geo) or forced */
  semMode: "auto" | "player" | "geo";
  /** timeline */
  time: number;
  playing: boolean;
  speed: number;
  loopPreview: boolean;
  autoKey: boolean;
  snapTicks: boolean;
  onion: { on: boolean; before: number; after: number; step: number };
  /** live, uncommitted pose override (breakdown slider, noise preview, gizmo drag); viewport shows it over the sampled pose */
  previewPose: Pose | null;
  clipboard: Clipboard | null;
  /** preview rig: geo path chosen for an animation file (null = built-in player rig) */
  previewModel: string | null;
  /** spidey */
  poseSets: PoseSet[];
  clipInfo: Record<string, ClipInfo>;
  problems: Problem[];
  asGameApplies: boolean;
  anchorMode: boolean;
  /** "As game applies": aimed limbs (pose-set `aimed`) point at the web-anchor marker like LimbDriver.aimFrom; scene px (x right, y up, z behind) */
  liveAim: boolean;
  webAnchor: [number, number, number];
  /** stride clips: preview pace in blocks/s (phase follows distance, not time) and the blocks walked since the last reset */
  strideSpeed: number;
  strideDist: number;
  /** viewport toggles */
  wire: boolean;
  xray: boolean;
  hidden: string[];
  locked: string[];
  /** --- additions (shell/viewport half; backward compatible) --- */
  /** camera angle label: "persp" = free camera; the others are the locked orthographic presets (viewport/api.ts). "side" = legacy alias of "left". */
  view: ViewName;
  /** gizmo snapping (1px move/resize, 22.5° rotate; ⇧ = fine) */
  snap: boolean;
  /** bone selection came from a cube click etc. is tracked in `bones`/`cube`; this is the rig the viewport shows */
  rig: { source: "geo" | "bbmodel" | "player"; label: string; path?: string } | null;
  /** geo files: a sibling animation file previewed read-only on the model (Animate mode is for animation docs) */
  ext: { path: string; doc: Doc; anim: string | null } | null;
  /** candidate preview geos / sibling animation files found next to this file (for the pickers) */
  siblings: { geos: string[]; anims: string[] };
  /** texture resolved for the viewport (null = none found) */
  texture: string | null;
  /** viewport helpers */
  reference: boolean;
  grid: boolean;
  /** --- viewport parity additions (Blockbench); all optional-by-default, see viewport/api.ts --- */
  /** orthographic projection (presets force it; Num5 toggles it at the current angle) */
  ortho: boolean;
  /** lighting on (6 directional lights + ambient); off = flat ambient only */
  shading: boolean;
  /** Blockbench view mode (Z): textured / solid / wireframe (kept in sync with `wire`) */
  viewMode: "textured" | "solid" | "wireframe";
  /** checkerboard viewport background (T); false = solid #101316 */
  checker: boolean;
  /** ground plane (off by default, like Blockbench) */
  ground: boolean;
  /** multi-selection of cubes (edit mode); `cube` stays the primary/last one. Treat as stale unless it contains `cube` */
  cubes: Array<{ bone: string; index: number }>;
  /** reference images shown in this Studio: project (file) + global scope; managed by ui/refimages */
  refs: RefImage[];
  refSel: string | null;
  /** Reference Image mode (handles + panel visible) */
  refEdit: boolean;
  /** "Hide/Show All Reference Images" */
  refsHidden: boolean;
  /** --- Edit-mode UV editor / textures (Blockbench Edit layout) --- */
  /** the texture the UV editor shows: index into the bbmodel `textures[]`, or into `geoTex.layers` for geo files */
  texActive: number;
  /** geo files: preview texture layers (Bedrock geometry has one texture slot in game; these are viewport-only variants), persisted in app data */
  geoTex: GeoTexState;
  /** faces selected in the UV editor (shared by every selected per-face cube) */
  uvFaces: Face[];
  /** == constraints hook == limb links (ui/constraints) */
  cons: ConsUi;
}

export type ViewName = "persp" | "front" | "back" | "left" | "right" | "top" | "bottom" | "side";

export interface StudioApi {
  store: Store<StudioState>;
  /** apply a pure core command result (or any new Doc) as one Monaco undo stop; label shows in Edit > Undo */
  commit(next: Doc, label: string): void;
  /** begin/end a coalesced gesture (drags): commits inside are merged into one undo stop on end */
  beginGesture(): void;
  endGesture(): void;
  undo(): void;
  redo(): void;
  /** open the text side / reveal a JSON location for a bone/key */
  revealInText(target: { anim?: string; bone?: string; time?: number }): void;
}

export const initialStudioState = (path: string): StudioState => ({
  doc: null, parseError: null, path, mode: "edit", tool: "rotate", space: "local",
  bones: [], cube: null, anim: null, keys: [], semMode: "auto",
  time: 0, playing: false, speed: 1, loopPreview: true, autoKey: true, snapTicks: true,
  onion: { on: false, before: 2, after: 2, step: 0.1 },
  previewPose: null, clipboard: null, previewModel: null,
  poseSets: [], clipInfo: {}, problems: [], asGameApplies: false, anchorMode: false,
  liveAim: false, webAnchor: [0, 64, -40], strideSpeed: 3, strideDist: 0,
  wire: false, xray: false, hidden: [], locked: [],
  view: "persp", snap: true, rig: null, ext: null, siblings: { geos: [], anims: [] }, texture: null, reference: false, grid: true,
  ortho: false, shading: true, viewMode: "textured", checker: true, ground: false, cubes: [], refs: [], refSel: null, refEdit: false, refsHidden: false,
  texActive: 0, geoTex: { layers: [], active: 0 }, uvFaces: ["north"], cons: initialCons(), // == constraints hook ==
});

export const createStudioStore = (path: string) => createStore<StudioState>(initialStudioState(path));

export const StudioContext = createContext<StudioApi | null>(null);
export function useStudio(): StudioApi {
  const s = useContext(StudioContext);
  if (!s) throw new Error("useStudio outside StudioContext");
  return s;
}
export function useStudioState(): StudioState {
  return useStore(useStudio().store);
}
/** Re-render only when one of `keys` changes (the store ticks on every playhead move; most panels don't care about `time`). */
export function useStudioPick<K extends keyof StudioState>(...keys: K[]): Pick<StudioState, K> {
  return usePickFrom(useStudio().store, ...keys);
}
export function usePickFrom<K extends keyof StudioState>(store: Store<StudioState>, ...keys: K[]): Pick<StudioState, K> {
  const ref = useRef<Pick<StudioState, K> | null>(null);
  return useSyncExternalStore(store.subscribe, () => {
    const st = store.get();
    const prev = ref.current;
    if (prev && keys.every((k) => Object.is(prev[k], st[k]))) return prev;
    const next = {} as Pick<StudioState, K>;
    for (const k of keys) next[k] = st[k];
    ref.current = next;
    return next;
  });
}
export type { ChannelName };
