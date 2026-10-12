/**
 * Pure UV maths for the UV editor (no React, no three.js). Re-implements the behaviour of Blockbench's UV editor
 * (docs/BLOCKBENCH-PARITY.md section 6): box-UV unwrap layout, per-face rectangles, move / resize / flip with pixel
 * snapping, and the modifier-dependent snap steps. UV space = texture px of the model's `texture_width x texture_height`.
 *
 * A *rect* is `[u0, v0, u1, v1]` in UV px; a flipped face has u0 > u1 and/or v0 > v1 (geo: negative `uv_size`).
 */
import { FACES, type CubeUv, type Face, type FaceUv } from "./format/geo";

export type Rect = [number, number, number, number];
export type FaceRects = Partial<Record<Face, Rect>>;
export type Side = -1 | 0 | 1;

const r4 = (v: number) => {
  const r = Math.round(v * 10000) / 10000;
  return r === 0 ? 0 : r;
};

// ---------------------------------------------------------------- box UV layout

/** Blockbench box-UV unwrap: the six face rectangles for `size` (floored, as Bedrock only knows integer boxes) at offset `off`. */
export function boxUvRects(off: readonly [number, number], size: readonly number[]): Record<Face, Rect> {
  const [u, v] = off;
  const dx = Math.floor(size[0]), dy = Math.floor(size[1]), dz = Math.floor(size[2]);
  return {
    east: [u, v + dz, u + dz, v + dz + dy],
    north: [u + dz, v + dz, u + dz + dx, v + dz + dy],
    west: [u + dz + dx, v + dz, u + 2 * dz + dx, v + dz + dy],
    south: [u + 2 * dz + dx, v + dz, u + 2 * dz + 2 * dx, v + dz + dy],
    up: [u + dz, v, u + dz + dx, v + dz],
    down: [u + dz + dx, v + dz, u + dz + 2 * dx, v],
  };
}

/** Bounding box of the box-UV island: `2*(dx+dz)` wide, `dz+dy` tall (the unwrap "T" shape). */
export function boxUvIsland(off: readonly [number, number], size: readonly number[]): { x: number; y: number; w: number; h: number } {
  const dx = Math.floor(size[0]), dy = Math.floor(size[1]), dz = Math.floor(size[2]);
  return { x: off[0], y: off[1], w: 2 * (dx + dz), h: dz + dy };
}

/**
 * Face rectangles of a cube as drawn on the model (viewport) and in the UV editor. Box UV with `mirror` swaps the east / west
 * rectangles and flips them horizontally (Blockbench "Mirror UV"). Per-face UV: the rects as stored. `null` = no UV at all.
 */
export function cubeFaceRects(uv: CubeUv, size: readonly number[], mirror: boolean): FaceRects | null {
  if (!uv) return null;
  if (uv.kind === "box") {
    const r = boxUvRects(uv.uv, size);
    if (!mirror) return r;
    const m: FaceRects = {};
    for (const f of FACES) {
      const src = r[f === "east" ? "west" : f === "west" ? "east" : f];
      m[f] = [src[2], src[1], src[0], src[3]];
    }
    return m;
  }
  const out: FaceRects = {};
  for (const f of FACES) {
    const fu = uv.faces[f];
    if (fu) out[f] = faceUvToRect(fu);
  }
  return out;
}

export const faceUvToRect = (f: FaceUv): Rect => [f.uv[0], f.uv[1], f.uv[0] + f.uvSize[0], f.uv[1] + f.uvSize[1]];
export const rectToFaceUv = (r: Rect, material?: string): FaceUv => {
  const fu: FaceUv = { uv: [r4(r[0]), r4(r[1])], uvSize: [r4(r[2] - r[0]), r4(r[3] - r[1])] };
  if (material !== undefined) fu.material = material;
  return fu;
};

// ---------------------------------------------------------------- snapping

/**
 * UV snap step (UV px) of a drag: Blockbench derives it from the grid size of the move tool (docs 1.4): none 1 px, Shift 0.25,
 * Ctrl/Cmd 0.1, both 0.025. `texPerUv` = texture px per UV unit (a 128 px texture on a 64 UV grid has 2, so one drag step is
 * one *texture* pixel = 0.5 UV).
 */
export function uvSnapStep(shift: boolean, ctrl: boolean, texPerUv = 1): number {
  const base = shift && ctrl ? 0.025 : ctrl ? 0.1 : shift ? 0.25 : 1;
  return base / Math.max(texPerUv, 1e-6);
}
/** Snap a raw UV delta to `step` (cleaned of float noise). */
export function snapDelta(d: number, step: number): number {
  return r4(Math.round(d / step) * step);
}

// ---------------------------------------------------------------- rect operations

export const moveRect = (r: Rect, dx: number, dy: number): Rect => [r4(r[0] + dx), r4(r[1] + dy), r4(r[2] + dx), r4(r[3] + dy)];

/**
 * Drag a resize handle. `xs` / `ys` = which side moves: -1 left/top, +1 right/bottom, 0 none. Like Blockbench, a flipped rect
 * (u0 > u1) moves the *other* stored coordinate so "left" is always the visually left edge.
 */
export function resizeRect(r: Rect, xs: Side, ys: Side, dx: number, dy: number, clamp?: { w: number; h: number }): Rect {
  const inv: [boolean, boolean] = [r[0] > r[2], r[1] > r[3]];
  const out: Rect = [r[0], r[1], r[2], r[3]];
  const c = (v: number, hi: number) => (clamp ? Math.min(hi, Math.max(0, v)) : v);
  if (xs && (xs === -1) !== inv[0]) out[0] = c(r[0] + dx, clamp?.w ?? 0);
  if (ys && (ys === -1) !== inv[1]) out[1] = c(r[1] + dy, clamp?.h ?? 0);
  if (xs && (xs === 1) !== inv[0]) out[2] = c(r[2] + dx, clamp?.w ?? 0);
  if (ys && (ys === 1) !== inv[1]) out[3] = c(r[3] + dy, clamp?.h ?? 0);
  return [r4(out[0]), r4(out[1]), r4(out[2]), r4(out[3])];
}
export const flipRectX = (r: Rect): Rect => [r[2], r[1], r[0], r[3]];
export const flipRectY = (r: Rect): Rect => [r[0], r[3], r[2], r[1]];
export const normRect = (r: Rect): { x: number; y: number; w: number; h: number } => ({ x: Math.min(r[0], r[2]), y: Math.min(r[1], r[3]), w: Math.abs(r[2] - r[0]), h: Math.abs(r[3] - r[1]) });

/** Limit a move delta so none of `rects` leaves `[0,w] x [0,h]` (Blockbench "clamp UV"). */
export function clampMove(rects: readonly Rect[], dx: number, dy: number, w: number, h: number): [number, number] {
  let x = dx, y = dy;
  for (const r of rects) {
    const lx = Math.min(r[0], r[2]), hx = Math.max(r[0], r[2]), ly = Math.min(r[1], r[3]), hy = Math.max(r[1], r[3]);
    x = Math.min(w - hx, Math.max(-lx, x));
    y = Math.min(h - hy, Math.max(-ly, y));
  }
  return [r4(x), r4(y)];
}

// ---------------------------------------------------------------- CubeUv level operations (one cube)

/** Replace the rects of `faces` (per-face UV only; a box UV is returned unchanged). */
export function withRects(uv: CubeUv, rects: FaceRects): CubeUv {
  if (!uv || uv.kind !== "faces") return uv;
  const faces = { ...uv.faces };
  for (const f of FACES) {
    const r = rects[f];
    if (r && faces[f]) faces[f] = rectToFaceUv(r, faces[f]!.material);
  }
  return { kind: "faces", faces };
}

/** What a UV drag edits: the whole box island, or some faces' rects (move / resize one side or corner). */
export type UvDrag =
  | { kind: "island" }
  | { kind: "move"; faces: readonly Face[] }
  | { kind: "resize"; faces: readonly Face[]; xs: Side; ys: Side };

/** `base` + a drag of (dx, dy) UV px (total since the gesture started; recomputed from the base so snapping never accumulates). */
export function applyUvDrag(base: CubeUv, drag: UvDrag, dx: number, dy: number, clamp?: { w: number; h: number }): CubeUv {
  if (!base) return base;
  if (base.kind === "box") {
    if (drag.kind !== "island") return base;
    return { kind: "box", uv: [Math.round(base.uv[0] + dx), Math.round(base.uv[1] + dy)] };
  }
  if (drag.kind === "island") return base;
  const rects: FaceRects = {};
  const cur = cubeFaceRects(base, [0, 0, 0], false)!;
  if (drag.kind === "move") {
    let mx = dx, my = dy;
    if (clamp) [mx, my] = clampMove(drag.faces.map((f) => cur[f]).filter((r): r is Rect => !!r), dx, dy, clamp.w, clamp.h);
    for (const f of drag.faces) if (cur[f]) rects[f] = moveRect(cur[f]!, mx, my);
  } else {
    for (const f of drag.faces) if (cur[f]) rects[f] = resizeRect(cur[f]!, drag.xs, drag.ys, dx, dy, clamp);
  }
  return withRects(base, rects);
}

/** Mirror the faces' UV (Blockbench uv_mirror_x / uv_mirror_y). Box UV has no per-face flip (use the cube's Mirror UV flag). */
export function flipUv(uv: CubeUv, faces: readonly Face[], axis: "x" | "y"): CubeUv {
  if (!uv || uv.kind !== "faces") return uv;
  const cur = cubeFaceRects(uv, [0, 0, 0], false)!;
  const rects: FaceRects = {};
  for (const f of faces) if (cur[f]) rects[f] = axis === "x" ? flipRectX(cur[f]!) : flipRectY(cur[f]!);
  return withRects(uv, rects);
}

/** Box UV -> explicit per-face UV (the current unwrap, honouring the cube's mirror flag). */
export function boxToFaces(uv: CubeUv, size: readonly number[], mirror: boolean): CubeUv {
  if (!uv || uv.kind !== "box") return uv;
  const r = cubeFaceRects(uv, size, mirror)!;
  const faces: Partial<Record<Face, FaceUv>> = {};
  for (const f of FACES) faces[f] = rectToFaceUv(r[f]!);
  return { kind: "faces", faces };
}

/** Per-face UV -> box UV: offset derived from the north rectangle (box layout: north sits at `(u + dz, v + dz)`). */
export function facesToBox(uv: CubeUv, size: readonly number[]): CubeUv {
  if (!uv || uv.kind !== "faces") return uv;
  const dz = Math.floor(size[2]);
  const n = uv.faces.north ? faceUvToRect(uv.faces.north) : null;
  const u = n ? Math.min(n[0], n[2]) - dz : 0, v = n ? Math.min(n[1], n[3]) - dz : 0;
  return { kind: "box", uv: [Math.max(0, Math.round(u)), Math.max(0, Math.round(v))] };
}

/** Faces of a cube that carry UV rects (all six for box UV). */
export function uvFaces(uv: CubeUv): Face[] {
  if (!uv) return [];
  return uv.kind === "box" ? [...FACES] : FACES.filter((f) => !!uv.faces[f]);
}
