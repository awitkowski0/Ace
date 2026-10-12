/** Selection helpers shared by the viewport, gizmo commit and (optionally) the outliner / keybind half. Pure, no three.js. */
import type { StudioState } from "../state";

export type CubeRef = { bone: string; index: number };
const same = (a: CubeRef, b: CubeRef) => a.bone === b.bone && a.index === b.index;

/**
 * The cubes an edit-mode operation applies to. `cubes` (multi-selection) is honoured only while it still contains the primary `cube`
 * (other code that sets just `cube` therefore never sees a stale multi-selection).
 */
export function selectedCubes(s: Pick<StudioState, "cube" | "cubes">): CubeRef[] {
  if (!s.cube) return [];
  return s.cubes && s.cubes.some((c) => same(c, s.cube!)) ? s.cubes : [s.cube];
}
/** Groups an Edit-mode operation applies to (no cube selected = the group selection). See ui/selection.ts. */

/** Snap step of a move/resize drag by modifier (Blockbench 1.4): none 1, Shift 0.25, Ctrl/Cmd 0.1, both 0.025. */
export function moveStep(shift: boolean, ctrl: boolean): number {
  return shift && ctrl ? 0.025 : ctrl ? 0.1 : shift ? 0.25 : 1;
}
/** Rotation snap in degrees: none 2.5, Shift 22.5, Ctrl/Cmd 1, both 0.25. */
export function rotateStep(shift: boolean, ctrl: boolean): number {
  return shift && ctrl ? 0.25 : ctrl ? 1 : shift ? 22.5 : 2.5;
}
