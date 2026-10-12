/**
 * RigModel: what the viewport / outliner show, independent of the source format. All coordinates are in *file space*
 * (Bedrock: Y up, px, absolute pivots, x/y rotation as written in the file). bbmodel (Blockbench internal space) is
 * converted into file space here; the viewport converts file space to scene space once (x negated, see scene.ts).
 */
import {
  FACES, PLAYER_RIG, getBb, getGeo, allGroups, toValue, faceTextureOf, type BbGroup, type Doc, type Face, type NumVec3,
} from "../core";
import type { CubeRef, Tree } from "./selection";

export type RUv =
  | { kind: "box"; uv: [number, number] }
  | { kind: "rects"; faces: Partial<Record<Face, [number, number, number, number]>> };

export interface RCube {
  bone: string;
  /** index inside the bone's `cubes` array (geo) or the element order (bbmodel) */
  index: number;
  name?: string;
  origin: NumVec3;
  size: NumVec3;
  pivot?: NumVec3;
  rotation?: NumVec3;
  inflate: number;
  mirror: boolean;
  uv?: RUv;
  /** bbmodel: texture slot of the cube's faces (first textured face; undefined = untextured) */
  tex?: number;
  /** bbmodel: per-face texture slot (>= 0), -1 = none, null = face disabled */
  faceTex?: Partial<Record<Face, number | null>>;
  /** bbmodel: per-face UV rotation (90 / 180 / 270; absent = 0) */
  faceRot?: Partial<Record<Face, number>>;
}
export interface RBone {
  name: string;
  parent?: string;
  pivot: NumVec3;
  rotation?: NumVec3;
  cubes: RCube[];
}
export interface RigModel {
  bones: RBone[];
  texW: number;
  texH: number;
  source: "geo" | "bbmodel" | "player";
  /** geometry edits go through core geo commands (bbmodel is animation-only) */
  editable: boolean;
  /** bbmodel embedded textures (data URLs) */
  textures: string[];
  identifier?: string;
}

const neg3 = (v: NumVec3): NumVec3 => [-v[0], -v[1], v[2]];

export function rigFromGeo(doc: Doc, geometry = 0): RigModel | null {
  const g = getGeo(doc).geometries[geometry];
  if (!g) return null;
  return {
    source: "geo", editable: true, textures: [], identifier: g.identifier, texW: g.textureWidth, texH: g.textureHeight,
    bones: g.bones.map((b) => ({
      name: b.name, parent: b.parent, pivot: b.pivot, rotation: b.rotation,
      cubes: b.cubes.map((c): RCube => ({
        bone: b.name, index: c.index, origin: c.origin, size: c.size, pivot: c.pivot, rotation: c.rotation,
        inflate: c.inflate ?? b.inflate ?? 0, mirror: c.mirror ?? b.mirror ?? false,
        uv: !c.uv ? undefined : c.uv.kind === "box"
          ? { kind: "box", uv: c.uv.uv }
          : { kind: "rects", faces: Object.fromEntries(Object.entries(c.uv.faces).map(([f, fu]) => [f, [fu!.uv[0], fu!.uv[1], fu!.uv[0] + fu!.uvSize[0], fu!.uv[1] + fu!.uvSize[1]]])) },
      })),
    })),
  };
}

const flagMirror = (node: unknown): boolean => (toValue(node as never) as { mirror_uv?: boolean } | undefined)?.mirror_uv === true;
const isHidden = (node: unknown): boolean => (toValue(node as never) as { visible?: boolean } | undefined)?.visible === false;

export function rigFromBb(doc: Doc): RigModel {
  const m = getBb(doc);
  const els = new Map(m.elements.map((e) => [e.uuid, e]));
  const bones: RBone[] = [];
  const used = new Set<string>();
  const cubeOf = (uuid: string, bone: string, index: number): RCube | null => {
    const e = els.get(uuid);
    if (!e || (e.type !== "cube" && e.type !== "") || !e.from || !e.to) return null;
    const size: NumVec3 = [e.to[0] - e.from[0], e.to[1] - e.from[1], e.to[2] - e.from[2]];
    const origin: NumVec3 = [-e.to[0], e.from[1], e.from[2]];
    const piv = e.origin;
    const faces = toValue(e.node) as { faces?: Record<string, { uv?: number[]; texture?: number | null | false; rotation?: number }> } | undefined;
    let uv: RUv | undefined;
    let tex: number | undefined;
    const faceTex: Partial<Record<Face, number | null>> = {};
    const faceRot: Partial<Record<Face, number>> = {};
    if (faces?.faces) {
      for (const f of FACES) {
        const fu = faces.faces[f];
        if (!fu) continue;
        const t = faceTextureOf(fu.texture);
        faceTex[f] = t;
        if (fu.rotation) faceRot[f] = fu.rotation;
        if (t !== null && t >= 0) tex ??= t;
      }
    }
    if (e.boxUv) uv = { kind: "box", uv: e.uvOffset ?? [0, 0] };
    else if (faces?.faces) {
      const r: Partial<Record<Face, [number, number, number, number]>> = {};
      for (const f of FACES) {
        const fu = faces.faces[f];
        if (fu?.uv && fu.uv.length >= 4 && fu.texture !== null) r[f] = [fu.uv[0], fu.uv[1], fu.uv[2], fu.uv[3]];
      }
      uv = { kind: "rects", faces: r };
    }
    used.add(uuid);
    return {
      bone, index, name: e.name, origin, size, inflate: e.inflate ?? 0, mirror: !!flagMirror(e.node), uv, tex,
      faceTex: Object.keys(faceTex).length ? faceTex : undefined, faceRot: Object.keys(faceRot).length ? faceRot : undefined,
      pivot: piv ? [-piv[0], piv[1], piv[2]] : undefined,
      rotation: e.rotation && (e.rotation[0] || e.rotation[1] || e.rotation[2]) ? neg3(e.rotation) : undefined,
    };
  };
  const walk = (g: BbGroup, parent: string | undefined) => {
    const b: RBone = { name: g.name, parent, pivot: [-g.origin[0], g.origin[1], g.origin[2]], rotation: g.rotation ? neg3(g.rotation) : undefined, cubes: [] };
    bones.push(b);
    for (const c of g.children) {
      if (typeof c === "string") { const cube = cubeOf(c, g.name, b.cubes.length); if (cube) b.cubes.push(cube); }
      else walk(c, g.name);
    }
  };
  m.groups.forEach((g) => walk(g, undefined));
  const loose = m.elements.filter((e) => !used.has(e.uuid));
  if (loose.length) {
    const b: RBone = { name: "(root)", pivot: [0, 0, 0], cubes: [] };
    for (const e of loose) { const c = cubeOf(e.uuid, b.name, b.cubes.length); if (c) b.cubes.push(c); }
    if (b.cubes.length) bones.unshift(b);
  }
  const res = m.resolution ?? { width: 16, height: 16 };
  return { source: "bbmodel", editable: true, textures: m.textures.map((t) => (isHidden(t.node) ? "" : t.source ?? "")), texW: res.width, texH: res.height, bones };
}

export function rigFromDoc(doc: Doc): RigModel | null {
  if (doc.kind === "geo") return rigFromGeo(doc);
  if (doc.kind === "bbmodel") return rigFromBb(doc);
  return null;
}

/** Built-in Steve-proportion armor rig (core PLAYER_RIG) for animation files that have no model of their own. */
export function playerRigModel(): RigModel {
  return {
    source: "player", editable: false, textures: [], texW: 64, texH: 64, identifier: "geometry.ace.player",
    bones: PLAYER_RIG.map((b) => ({
      name: b.name, pivot: [...b.pivot] as NumVec3,
      cubes: b.cubes.map((c, i): RCube => ({ bone: b.name, index: i, origin: [...c.origin] as NumVec3, size: [...c.size] as NumVec3, inflate: c.inflate ?? 0, mirror: false, uv: { kind: "box", uv: c.uv } })),
    })),
  };
}

/** Bone names a document defines (geo bones / bbmodel groups); animation files have none of their own. */
export function boneNamesOf(doc: Doc, _player = false): string[] {
  if (doc.kind === "geo") return getGeo(doc).geometries[0]?.bones.map((b) => b.name) ?? [];
  if (doc.kind === "bbmodel") return allGroups(getBb(doc)).map((g) => g.name);
  return [];
}

// ---------------------------------------------------------------- tree helpers (outliner)

export interface TreeBone { bone: RBone; children: TreeBone[]; depth: number }
export function boneTree(rig: RigModel): TreeBone[] {
  const byName = new Map(rig.bones.map((b) => [b.name, b]));
  const kids = new Map<string | undefined, RBone[]>();
  for (const b of rig.bones) {
    const p = b.parent && byName.has(b.parent) && b.parent !== b.name ? b.parent : undefined;
    kids.set(p, [...(kids.get(p) ?? []), b]);
  }
  const seen = new Set<string>();
  const rec = (b: RBone, depth: number): TreeBone => {
    seen.add(b.name);
    return { bone: b, depth, children: (kids.get(b.name) ?? []).filter((c) => !seen.has(c.name)).map((c) => rec(c, depth + 1)) };
  };
  const roots = (kids.get(undefined) ?? []).map((b) => rec(b, 0));
  // cycles / orphans: show them at top level so nothing is unreachable
  for (const b of rig.bones) if (!seen.has(b.name)) roots.push(rec(b, 0));
  return roots;
}

export function flattenTree(t: TreeBone[], collapsed: ReadonlySet<string>): TreeBone[] {
  const out: TreeBone[] = [];
  const rec = (n: TreeBone) => { out.push(n); if (!collapsed.has(n.bone.name)) n.children.forEach(rec); };
  t.forEach(rec);
  return out;
}

export function descendantNames(rig: RigModel, name: string): string[] {
  const out: string[] = [];
  const rec = (n: string) => { for (const b of rig.bones) if (b.parent === n && !out.includes(b.name)) { out.push(b.name); rec(b.name); } };
  rec(name);
  return out;
}

export const r3 = (v: readonly number[]): NumVec3 => [Math.round(v[0] * 1e4) / 1e4, Math.round(v[1] * 1e4) / 1e4, Math.round(v[2] * 1e4) / 1e4];

/** Unique bone name based on `base` (`bone`, `bone_1` …). */
export function uniqueName(rig: RigModel, base: string): string {
  const names = new Set(rig.bones.map((b) => b.name));
  if (!names.has(base)) return base;
  const stem = base.replace(/_\d+$/, "");
  for (let i = 1; ; i++) if (!names.has(`${stem}_${i}`)) return `${stem}_${i}`;
}

/** Group structure queries over a rig (selection logic, ui/selection.ts). */
export function rigTree(rig: RigModel | null): Tree {
  const byName = new Map((rig?.bones ?? []).map((b) => [b.name, b]));
  const kids = new Map<string, string[]>();
  for (const b of rig?.bones ?? []) if (b.parent && byName.has(b.parent) && b.parent !== b.name) kids.set(b.parent, [...(kids.get(b.parent) ?? []), b.name]);
  const under = (name: string, seen = new Set<string>()): CubeRef[] => {
    if (seen.has(name)) return [];
    seen.add(name);
    const b = byName.get(name);
    if (!b) return [];
    return [...b.cubes.map((c) => ({ bone: name, index: c.index })), ...(kids.get(name) ?? []).flatMap((k) => under(k, seen))];
  };
  return { cubesUnder: (b) => under(b), parentOf: (b) => { const p = byName.get(b)?.parent; return p && byName.has(p) ? p : undefined; } };
}
