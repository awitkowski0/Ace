/**
 * UV edits of the selected cubes through core commands (byte-faithful: only the changed face rectangles / box offsets are rewritten,
 * one undo stop per call; the UV editor wraps a drag in beginGesture / endGesture). Works for geo (`uv` box array / per-face objects)
 * and .bbmodel (`box_uv` + `uv_offset` / `faces.<f>.uv`).
 */
import {
  FACES, boxToFaces, cubeFaceRects, faceUvToRect, facesToBox, flipUv, rectToFaceUv, setBbBoxUv, setBbFaces,
  type CubeUv, type Doc, type Face, type FaceRects, type Rect,
} from "../core";
import { cmdSetCube, canEditDoc, ROOT_BONE } from "./ops";
import { rigTree, type RCube, type RigModel } from "./model";
import { coveredCubes, keyOf, selValue, type CubeRef } from "./selection";
import type { StudioApi } from "./state";

export const uvKey = (c: CubeRef) => keyOf(c);

/** Selected cubes that have UV (group selections expand to their cubes). */
export function uvCubes(api: StudioApi, rig: RigModel | null): Array<{ ref: CubeRef; cube: RCube }> {
  const s = api.store.get();
  if (!rig) return [];
  const refs = coveredCubes(selValue(s), rigTree(rig));
  const out: Array<{ ref: CubeRef; cube: RCube }> = [];
  for (const ref of refs) {
    const cube = rig.bones.find((b) => b.name === ref.bone)?.cubes.find((c) => c.index === ref.index);
    if (cube) out.push({ ref, cube });
  }
  return out;
}

/** RCube UV as a core CubeUv. */
export function cubeUvOf(c: RCube): CubeUv {
  if (!c.uv) return undefined;
  if (c.uv.kind === "box") return { kind: "box", uv: c.uv.uv };
  const faces: Partial<Record<Face, { uv: [number, number]; uvSize: [number, number] }>> = {};
  for (const f of FACES) {
    const r = c.uv.faces[f];
    if (r) faces[f] = rectToFaceUv(r);
  }
  return { kind: "faces", faces };
}

const rectsOf = (uv: CubeUv): FaceRects => cubeFaceRects(uv, [0, 0, 0], false) ?? {};
const sameRect = (a: Rect | undefined, b: Rect | undefined) => !!a && !!b && a.every((v, i) => Math.abs(v - b[i]) < 1e-6);

/** Write `next` as the UV of one cube; `prev` (the current UV) limits the bbmodel write to faces that changed. */
export function cmdSetUv(doc: Doc, ref: CubeRef, prev: CubeUv, next: CubeUv): Doc {
  if (!next) return doc;
  if (doc.kind === "bbmodel") {
    const group = ref.bone === ROOT_BONE ? null : ref.bone;
    if (next.kind === "box") {
      if (prev?.kind === "box" && prev.uv[0] === next.uv[0] && prev.uv[1] === next.uv[1]) return doc;
      return cmdSetCube(doc, ref.bone, ref.index, { uv: next });
    }
    const was = rectsOf(prev), now = rectsOf(next);
    const faces: Partial<Record<Face, { uv: Rect }>> = {};
    for (const f of FACES) if (now[f] && !sameRect(now[f], was[f])) faces[f] = { uv: now[f]! };
    return Object.keys(faces).length ? setBbFaces(doc, { group, index: ref.index, faces }) : doc;
  }
  return cmdSetCube(doc, ref.bone, ref.index, { uv: next });
}

/** Commit a set of cube UV changes as ONE edit (one undo stop). */
export function opSetUvs(api: StudioApi, edits: Array<{ ref: CubeRef; prev: CubeUv; next: CubeUv }>, label: string): boolean {
  const s = api.store.get();
  if (!canEditDoc(s.doc)) return false;
  let doc: Doc = s.doc;
  for (const e of edits) doc = cmdSetUv(doc, e.ref, e.prev, e.next);
  if (doc === s.doc) return false;
  api.beginGesture();
  api.commit(doc, label);
  api.endGesture();
  return true;
}

/** Mirror X / Y of the selected faces. Box-UV cubes: X toggles the cube's Mirror UV (Blockbench), Y has no meaning. */
export function opUvFlip(api: StudioApi, rig: RigModel | null, axis: "x" | "y"): boolean {
  const s = api.store.get();
  if (!canEditDoc(s.doc)) return false;
  const cubes = uvCubes(api, rig);
  const edits: Array<{ ref: CubeRef; prev: CubeUv; next: CubeUv }> = [];
  let doc: Doc = s.doc;
  let toggled = 0;
  for (const { ref, cube } of cubes) {
    const prev = cubeUvOf(cube);
    if (prev?.kind === "faces") edits.push({ ref, prev, next: flipUv(prev, s.uvFaces, axis) });
    else if (prev?.kind === "box" && axis === "x") {
      doc = cmdSetCube(doc, ref.bone, ref.index, { mirror: cube.mirror ? null : true });
      toggled++;
    }
  }
  if (toggled) { api.beginGesture(); api.commit(doc, "Mirror UV"); api.endGesture(); }
  const ok = edits.length ? opSetUvs(api, edits, axis === "x" ? "Mirror UV X" : "Mirror UV Y") : false;
  return ok || toggled > 0;
}

/** Rotate the selected faces' UV by 90 degrees (bbmodel `faces.<f>.rotation`; Bedrock geometry has no face rotation). */
export function opUvRotate(api: StudioApi, rig: RigModel | null, step: 90 | -90 = 90): boolean {
  const s = api.store.get();
  if (s.doc?.kind !== "bbmodel") return false;
  let doc: Doc = s.doc;
  let n = 0;
  for (const { ref, cube } of uvCubes(api, rig)) {
    if (cube.uv?.kind === "box") continue;
    const faces: Partial<Record<Face, { rotation: number }>> = {};
    for (const f of s.uvFaces) if (cube.uv?.faces[f]) faces[f] = { rotation: (((cube.faceRot?.[f] ?? 0) + step) % 360 + 360) % 360 };
    if (!Object.keys(faces).length) continue;
    doc = setBbFaces(doc, { group: ref.bone === ROOT_BONE ? null : ref.bone, index: ref.index, faces });
    n++;
  }
  if (!n) return false;
  api.commit(doc, "Rotate UV");
  return true;
}

/** Toggle every selected cube between box UV and per-face UV (the current layout is kept). */
export function opUvToggleBox(api: StudioApi, rig: RigModel | null, box?: boolean): boolean {
  const s = api.store.get();
  if (!canEditDoc(s.doc)) return false;
  const cubes = uvCubes(api, rig).filter((c) => !!c.cube.uv);
  if (!cubes.length) return false;
  const want = box ?? cubes[0].cube.uv!.kind !== "box";
  let doc: Doc = s.doc;
  for (const { ref, cube } of cubes) {
    const cur = cubeUvOf(cube);
    if ((cur?.kind === "box") === want) continue;
    if (doc.kind === "bbmodel") doc = setBbBoxUv(doc, { group: ref.bone === ROOT_BONE ? null : ref.bone, index: ref.index, box: want });
    else {
      const next = want ? facesToBox(cur, cube.size) : boxToFaces(cur, cube.size, cube.mirror);
      doc = cmdSetCube(doc, ref.bone, ref.index, { uv: next });
    }
  }
  if (doc === s.doc) return false;
  api.commit(doc, want ? "Box UV" : "Per-face UV");
  return true;
}

/** `uv` with one number changed: box U / V, or u / v / w / h of `face` (null when it does not apply). */
export function uvWithNumber(prev: CubeUv, face: Face | null, field: "u" | "v" | "w" | "h", value: number): CubeUv | null {
  if (!prev) return null;
  if (prev.kind === "box") {
    if (field !== "u" && field !== "v") return null;
    return { kind: "box", uv: field === "u" ? [value, prev.uv[1]] : [prev.uv[0], value] };
  }
  if (!face || !prev.faces[face]) return null;
  const fu = prev.faces[face]!;
  const r = faceUvToRect(fu);
  const w = r[2] - r[0], h = r[3] - r[1];
  const rr: Rect = field === "u" ? [value, r[1], value + w, r[3]] : field === "v" ? [r[0], value, r[2], value + h] : field === "w" ? [r[0], r[1], r[0] + value, r[3]] : [r[0], r[1], r[2], r[1] + value];
  return { kind: "faces", faces: { ...prev.faces, [face]: rectToFaceUv(rr, fu.material) } };
}

/** Set one UV number on every selected cube (mixed values were shown blank; the typed value applies to all). */
export function opUvSetNumber(api: StudioApi, rig: RigModel | null, face: Face | null, field: "u" | "v" | "w" | "h", value: number): boolean {
  const edits: Array<{ ref: CubeRef; prev: CubeUv; next: CubeUv }> = [];
  for (const { ref, cube } of uvCubes(api, rig)) {
    const prev = cubeUvOf(cube);
    const next = uvWithNumber(prev, face, field, value);
    if (next) edits.push({ ref, prev, next });
  }
  return edits.length ? opSetUvs(api, edits, "Edit UV") : false;
}
