/** Registry of mounted Studios (no Monaco import: the eagerly loaded register.ts uses it for focus-gated actions). */
import type { DocKind } from "../core";
import type { StudioApi, ViewName } from "./state";

export interface StudioHandle {
  api: StudioApi;
  docKey: string;
  groupId: string;
  kind: DocKind;
  root: { current: HTMLElement | null };
  /** feed the Monaco text; re-parses unless it is what the store already shows */
  syncFromText(text: string): void;
  /** current Monaco text, LF */
  text(): string;
  /** labels of the commits made through this Studio (most recent last; QA / Edit > Undo text) */
  labels?: string[];
  /** viewport hooks (set by the Viewport component) */
  viewport: { current: ViewportApi | null };
  dispose(): void;
}

/** Imperative surface of the three.js viewport (frame, views, QA). */
export interface ViewportApi {
  frame(selected?: boolean): void;
  /** camera preset: "persp" = free perspective camera, the rest are true orthographic locked-angle presets */
  setView(v: ViewName): void;
  /** perspective <-> orthographic at the current angle (Blockbench Num5) */
  toggleOrtho(): void;
  /** Blockbench "camera_initial" (Num1): default perspective camera */
  resetCamera(): void;
  /** Center View on Selection; rotateOnly = keep distance, zoom = also fit the zoom */
  focusSelection(o?: { rotateOnly?: boolean; zoom?: boolean }): void;
  /** the three.js canvas (QA / synthetic pointer events) */
  canvas(): HTMLCanvasElement;
  /** viewport screen-space rectangle of a cube (QA picking / area select) */
  projectCube(bone: string, index: number): { x: number; y: number } | null;
  render(): void;
  snapshot(): Record<string, unknown>;
  pick(x: number, y: number, add?: boolean): { bone?: string; cube?: { bone: string; index: number } } | null;
  /** simulate a gizmo edit of the current selection (QA): kind + delta in px / degrees */
  nudge(kind: "move" | "rotate" | "resize" | "pivot", delta: [number, number, number]): boolean;
  /** screen position of a bone's pivot (QA picking) */
  project(bone: string): { x: number; y: number } | null;
}

export const handles = new Set<StudioHandle>();
export const allStudios = () => [...handles];
/** The Studio that currently owns keyboard focus (DOM focus inside its root); text fields are ignored unless `allowInputs`. */
export function focusedStudio(opts: { allowInputs?: boolean } = {}): StudioHandle | null {
  const el = document.activeElement as HTMLElement | null;
  if (!el) return null;
  if (!opts.allowInputs && el.closest("input,textarea,select,[contenteditable='true']")) return null;
  for (const h of handles) if (h.root.current?.contains(el)) return h;
  return null;
}
export const studioOfGroup = (groupId: string) => [...handles].find((h) => h.groupId === groupId) ?? null;
