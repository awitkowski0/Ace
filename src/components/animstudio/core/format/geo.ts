/** Typed view of Bedrock geometry (`*.geo.json`, format 1.12.0 / 1.21.0). Bedrock coords: Y up, 1/16 block, absolute pivots. */
import { getKey, isArr, isObj, numOf, numsOf, strOf, type JNode, type JObj } from "./json";

import type { NumVec3 } from "./animation";
export const FACES = ["north", "east", "south", "west", "up", "down"] as const;
export type Face = (typeof FACES)[number];

export interface FaceUv {
  uv: [number, number];
  /** Negative components = flipped. */
  uvSize: [number, number];
  material?: string;
}
export type CubeUv =
  | { kind: "box"; uv: [number, number] }
  | { kind: "faces"; faces: Partial<Record<Face, FaceUv>> }
  | undefined;

export interface GeoCube {
  /** Index inside its bone's `cubes` array. */
  index: number;
  origin: NumVec3;
  size: NumVec3;
  pivot?: NumVec3;
  rotation?: NumVec3;
  inflate?: number;
  mirror?: boolean;
  uv: CubeUv;
  node: JObj;
}

export interface GeoBone {
  name: string;
  parent?: string;
  pivot: NumVec3;
  rotation?: NumVec3;
  mirror?: boolean;
  inflate?: number;
  cubes: GeoCube[];
  /** Number of `poly_mesh`/`locators`… style extras are kept in `node`. */
  node: JObj;
  /** Index in the geometry's `bones` array. */
  index: number;
}

export interface Geometry {
  identifier: string;
  textureWidth: number;
  textureHeight: number;
  visibleBounds?: { width: number; height: number; offset: NumVec3 };
  bones: GeoBone[];
  node: JObj;
  /** Index inside `minecraft:geometry`. */
  index: number;
}

export interface GeoFile {
  formatVersion?: string;
  geometries: Geometry[];
}

function v3(n: JNode | undefined): NumVec3 | undefined {
  const a = numsOf(n);
  return a && a.length >= 3 ? [a[0], a[1], a[2]] : undefined;
}
function v2(n: JNode | undefined): [number, number] | undefined {
  const a = numsOf(n);
  return a && a.length >= 2 ? [a[0], a[1]] : undefined;
}

export function readCube(n: JObj, index: number): GeoCube {
  const uvN = getKey(n, "uv");
  let uv: CubeUv;
  if (isArr(uvN)) {
    const b = v2(uvN);
    if (b) uv = { kind: "box", uv: b };
  } else if (isObj(uvN)) {
    const faces: Partial<Record<Face, FaceUv>> = {};
    for (const f of FACES) {
      const fn = getKey(uvN, f);
      if (isObj(fn)) {
        const u = v2(getKey(fn, "uv"));
        if (u) faces[f] = { uv: u, uvSize: v2(getKey(fn, "uv_size")) ?? [0, 0], material: strOf(getKey(fn, "material_instance")) };
      }
    }
    uv = { kind: "faces", faces };
  }
  const mir = getKey(n, "mirror");
  return {
    index,
    origin: v3(getKey(n, "origin")) ?? [0, 0, 0],
    size: v3(getKey(n, "size")) ?? [0, 0, 0],
    pivot: v3(getKey(n, "pivot")),
    rotation: v3(getKey(n, "rotation")),
    inflate: numOf(getKey(n, "inflate")),
    mirror: mir && mir.t === "l" ? (mir.value as boolean) : undefined,
    uv,
    node: n,
  };
}

export function readGeoBone(n: JObj, index: number): GeoBone {
  const cubesN = getKey(n, "cubes");
  const cubes: GeoCube[] = [];
  if (isArr(cubesN)) cubesN.items.forEach((c, i) => isObj(c) && cubes.push(readCube(c, i)));
  const mir = getKey(n, "mirror");
  return {
    name: strOf(getKey(n, "name")) ?? "",
    parent: strOf(getKey(n, "parent")),
    pivot: v3(getKey(n, "pivot")) ?? [0, 0, 0],
    rotation: v3(getKey(n, "rotation")),
    mirror: mir && mir.t === "l" ? (mir.value as boolean) : undefined,
    inflate: numOf(getKey(n, "inflate")),
    cubes,
    node: n,
    index,
  };
}

export function readGeoFile(root: JNode): GeoFile {
  const out: GeoFile = { geometries: [] };
  if (!isObj(root)) return out;
  out.formatVersion = strOf(getKey(root, "format_version"));
  const geos = getKey(root, "minecraft:geometry");
  if (!isArr(geos)) return out;
  geos.items.forEach((g, gi) => {
    if (!isObj(g)) return;
    const desc = getKey(g, "description");
    const d = isObj(desc) ? desc : undefined;
    const bonesN = getKey(g, "bones");
    const bones: GeoBone[] = [];
    if (isArr(bonesN)) bonesN.items.forEach((b, i) => isObj(b) && bones.push(readGeoBone(b, i)));
    const vbo = v3(getKey(d, "visible_bounds_offset"));
    const vw = numOf(getKey(d, "visible_bounds_width"));
    const vh = numOf(getKey(d, "visible_bounds_height"));
    out.geometries.push({
      identifier: strOf(getKey(d, "identifier")) ?? "",
      textureWidth: numOf(getKey(d, "texture_width"), 16),
      textureHeight: numOf(getKey(d, "texture_height"), 16),
      visibleBounds: vw !== undefined && vh !== undefined && vbo ? { width: vw, height: vh, offset: vbo } : undefined,
      bones,
      node: g,
      index: gi,
    });
  });
  return out;
}

export function findBone(g: Geometry, name: string): GeoBone | undefined {
  return g.bones.find((b) => b.name === name);
}
export function childrenOf(g: Geometry, name: string | undefined): GeoBone[] {
  return g.bones.filter((b) => (b.parent ?? undefined) === name);
}
/** All descendants (depth-first) of a bone. */
export function descendants(g: Geometry, name: string): GeoBone[] {
  const out: GeoBone[] = [];
  const seen = new Set<string>([name]);
  const rec = (n: string) => {
    for (const c of g.bones) {
      if (c.parent === n && !seen.has(c.name)) {
        seen.add(c.name);
        out.push(c);
        rec(c.name);
      }
    }
  };
  rec(name);
  return out;
}
/** True if `ancestor` is `name` or one of its ancestors (cycle-safe). */
export function isAncestor(g: Geometry, ancestor: string, name: string): boolean {
  let cur: string | undefined = name;
  const seen = new Set<string>();
  while (cur && !seen.has(cur)) {
    if (cur === ancestor) return true;
    seen.add(cur);
    cur = findBone(g, cur)?.parent;
  }
  return false;
}

