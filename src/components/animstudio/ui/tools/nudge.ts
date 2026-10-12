/** Arrow-key nudges (Blockbench move_up/down/left/right/forth/back): step sizes and camera-relative directions. Pure, unit-tested. */
import type { NumVec3 } from "../../core";

export type NudgeDir = "up" | "down" | "left" | "right" | "forth" | "back";

/** Snap step in px: 1; ⇧ = 16/64; ⌘ (Ctrl) = 16/160; ⌘⇧ = 16/640 (docs/BLOCKBENCH-PARITY.md 1.4). */
export function nudgeStep(shift: boolean, meta: boolean): number {
  return shift && meta ? 0.025 : meta ? 0.1 : shift ? 0.25 : 1;
}

/** Default Blockbench start camera [-40, 32, -40] looks along (+x, +z): azimuth atan2(fx, fz) = 45 degrees. */
export const DEFAULT_YAW = Math.PI / 4;

/**
 * File-space delta for `dir` given the camera azimuth `yaw` (radians, atan2(forward.x, forward.z) in scene space).
 * Left / right follow the screen horizontal, forth / back the horizontal view direction, up / down are vertical.
 * Directions snap to the nearest world axis (Blockbench moves along one axis). File space = scene space with x negated.
 */
export function nudgeVector(dir: NudgeDir, yaw: number, step: number): NumVec3 {
  const fx = Math.sin(yaw), fz = Math.cos(yaw);
  const f: [number, number] = Math.abs(fx) >= Math.abs(fz) ? [Math.sign(fx) || 1, 0] : [0, Math.sign(fz) || 1];
  const r: [number, number] = [-f[1], f[0]];
  let s: NumVec3;
  switch (dir) {
    case "up": s = [0, step, 0]; break;
    case "down": s = [0, -step, 0]; break;
    case "right": s = [r[0] * step, 0, r[1] * step]; break;
    case "left": s = [-r[0] * step, 0, -r[1] * step]; break;
    case "forth": s = [f[0] * step, 0, f[1] * step]; break;
    default: s = [-f[0] * step, 0, -f[1] * step];
  }
  const z = (x: number) => (x === 0 ? 0 : x); // no -0
  return [z(-s[0]), z(s[1]), z(s[2])];
}
