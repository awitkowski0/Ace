/**
 * Edit-mode operations on the document (bones / cubes), each one a single `commit` (= one undo step).
 * They work on both editable kinds: Bedrock geo (`bones[]`) and .bbmodel (outliner groups + elements). Coordinates are
 * the "file space" of ui/model.ts (what the properties panel shows); the cmd* wrappers dispatch to the core command set.
 */
import {
  addBbCube, addBbGroup, addBone, addCube, deleteBbCube, deleteBbGroup, deleteBone, deleteCube, getBb, getKey, isObj, moveBbCube,
  renameBbGroup, renameBone, reparentBbGroup, reparentBone, setBbCube, setBbGroup, setBone, setCube, sortBbOutliner, sortGeoBones,
  strOf, toValue, allGroups,
  type BbFlags, type CubePatch, type CubeSpec, type CubeUv, type Doc, type Face, type NumVec3,
} from "../core";
import { rigFromDoc, type RBone, type RCube, type RigModel } from "./model";
import type { StudioApi, StudioState } from "./state";
import { toolsStore, type ElemClip, type ElemCube } from "./toolsUi";
import { ofCubes, ofGroups, selValue, targets as selTargets, topGroups, type CubeRef } from "./selection";
import { rigTree } from "./model";

export const ROOT_BONE = "(root)";
export const canEditDoc = (doc: Doc | null | undefined): doc is Doc => !!doc && (doc.kind === "geo" || doc.kind === "bbmodel");

const uniq = (names: Set<string>, base: string) => {
  if (!names.has(base)) return base;
  const stem = base.replace(/_\d+$/, "");
  for (let i = 1; ; i++) if (!names.has(`${stem}_${i}`)) return `${stem}_${i}`;
};
const rigOf = (doc: Doc | null): RigModel | null => (canEditDoc(doc) ? rigFromDoc(doc) : null);
const boneOf = (rig: RigModel, name: string): RBone | undefined => rig.bones.find((b) => b.name === name);
const kidsOf = (rig: RigModel, name: string): RBone[] => rig.bones.filter((b) => b.parent === name);
export function descendantsOf(rig: RigModel, name: string): RBone[] {
  const out: RBone[] = [];
  const rec = (n: string) => { for (const b of kidsOf(rig, n)) { out.push(b); rec(b.name); } };
  rec(name);
  return out;
}
const isBb = (doc: Doc) => doc.kind === "bbmodel";

/** What an Edit-mode operation acts on (ui/selection.ts): the explicit cubes (cube selection) or the top-most selected groups. Locked groups are skipped. */
export function editTargets(s: Pick<StudioState, "bones" | "cube" | "cubes" | "locked">, rig: RigModel | null) {
  const tree = rigTree(rig);
  const sel = selValue(s);
  return { ...selTargets(sel, tree, new Set(s.locked)), sel, tree };
}
const setSel = (api: StudioApi, v: { bones: string[]; cube: CubeRef | null; cubes: CubeRef[] }) => api.store.set({ bones: v.bones, cube: v.cube, cubes: v.cubes });
/** group cube refs by bone, highest index first (so deleting one does not shift the next) */
const byBoneDesc = (cubes: CubeRef[]): CubeRef[] => [...cubes].sort((a, b) => (a.bone === b.bone ? b.index - a.index : a.bone < b.bone ? -1 : 1));

// ---------------------------------------------------------------- file-space <-> core command wrappers

function uvOf(c: RCube): CubeUv {
  if (!c.uv) return undefined;
  if (c.uv.kind === "box") return { kind: "box", uv: c.uv.uv };
  const faces: Partial<Record<Face, { uv: [number, number]; uvSize: [number, number] }>> = {};
  for (const [f, r] of Object.entries(c.uv.faces) as Array<[Face, [number, number, number, number]]>) faces[f] = { uv: [r[0], r[1]], uvSize: [r[2] - r[0], r[3] - r[1]] };
  return { kind: "faces", faces };
}
export const cubeSpecOf = (c: RCube): CubeSpec => ({ origin: c.origin, size: c.size, pivot: c.pivot, rotation: c.rotation, inflate: c.inflate || undefined, mirror: c.mirror || undefined, uv: uvOf(c) });

export interface BonePatchF { pivot?: NumVec3; rotation?: NumVec3 | null; inflate?: number | null; mirror?: boolean | null; flags?: BbFlags }
export function cmdSetBone(doc: Doc, bone: string, p: BonePatchF): Doc {
  if (isBb(doc)) {
    const flags: BbFlags = { ...p.flags };
    if (p.mirror !== undefined) flags.mirror_uv = p.mirror;
    return setBbGroup(doc, { group: bone, patch: { origin: p.pivot, rotation: p.rotation, flags: Object.keys(flags).length ? flags : undefined } });
  }
  return setBone(doc, { bone, patch: { pivot: p.pivot, rotation: p.rotation, inflate: p.inflate, mirror: p.mirror } });
}
export type CubePatchF = CubePatch & { name?: string; flags?: BbFlags };
export function cmdSetCube(doc: Doc, bone: string, index: number, p: CubePatchF): Doc {
  if (isBb(doc)) {
    const { mirror, flags, ...rest } = p;
    const f: BbFlags = { ...flags };
    if (mirror !== undefined) f.mirror_uv = mirror;
    return setBbCube(doc, { group: bone, index, patch: { ...rest, flags: Object.keys(f).length ? f : undefined } });
  }
  const { name: _n, flags: _f, ...rest } = p;
  return setCube(doc, { bone, index, patch: rest });
}
export function cmdAddBone(doc: Doc, a: { name: string; parent?: string; pivot?: NumVec3; rotation?: NumVec3 }): Doc {
  if (isBb(doc)) return addBbGroup(doc, { name: a.name, parent: a.parent && a.parent !== ROOT_BONE ? a.parent : undefined, origin: a.pivot, rotation: a.rotation });
  return addBone(doc, a);
}
export function cmdDeleteBone(doc: Doc, name: string, cascade = false): Doc {
  return isBb(doc) ? deleteBbGroup(doc, { name, cascade }) : deleteBone(doc, { name, cascade });
}
export function cmdAddCube(doc: Doc, bone: string, spec: CubeSpec, name?: string): Doc {
  if (isBb(doc)) return addBbCube(doc, { group: bone === ROOT_BONE ? null : bone, cube: { ...spec, name } });
  return addCube(doc, { bone, cube: spec });
}
export function cmdDeleteCube(doc: Doc, bone: string, index: number): Doc {
  return isBb(doc) ? deleteBbCube(doc, { group: bone, index }) : deleteCube(doc, { bone, index });
}
export function cmdReparent(doc: Doc, name: string, parent: string | null): Doc {
  return isBb(doc) ? reparentBbGroup(doc, { name, parent }) : reparentBone(doc, { name, parent });
}
export function cmdRename(doc: Doc, from: string, to: string): Doc {
  return isBb(doc) ? renameBbGroup(doc, { from, to }) : renameBone(doc, { from, to });
}

// ---------------------------------------------------------------- bbmodel flags (outliner columns)

export type FlagName = "export" | "shade" | "autouv" | "mirror_uv";
export const FLAG_NAMES: FlagName[] = ["export", "shade", "autouv", "mirror_uv"];
export interface FlagState { export?: boolean; shade?: boolean; autouv?: boolean; mirror_uv?: boolean }
const flagsOfNode = (node: unknown, defNode?: unknown): FlagState => {
  const out: FlagState = {};
  const rd = (k: string) => {
    for (const n of [defNode, node]) {
      if (!n || !isObj(n as never)) continue;
      const v = getKey(n as never, k);
      if (v) return toValue(v);
    }
    return undefined;
  };
  const e = rd("export"), s = rd("shade"), a = rd("autouv"), m = rd("mirror_uv");
  if (typeof e === "boolean") out.export = e;
  if (typeof s === "boolean") out.shade = s;
  if (typeof a === "number" || typeof a === "boolean") out.autouv = !!a;
  if (typeof m === "boolean") out.mirror_uv = m;
  return out;
};
/** Flags of every bbmodel group (by name) and cube (`group#index`). Defaults follow Blockbench: export / shade / auto UV on. */
export function bbFlagMap(doc: Doc | null): { groups: Map<string, FlagState>; cubes: Map<string, FlagState> } {
  const groups = new Map<string, FlagState>(), cubes = new Map<string, FlagState>();
  if (!doc || doc.kind !== "bbmodel") return { groups, cubes };
  const m = getBb(doc);
  const els = new Map(m.elements.map((e) => [e.uuid, e]));
  for (const g of allGroups(m)) {
    groups.set(g.name, flagsOfNode(g.outlinerNode, g.defNode));
    let i = 0;
    for (const c of g.children) {
      if (typeof c !== "string") continue;
      const e = els.get(c);
      if (!e || (e.type !== "cube" && e.type !== "") || !e.from || !e.to) continue;
      cubes.set(`${g.name}#${i++}`, flagsOfNode(e.node));
    }
  }
  return { groups, cubes };
}
const flagDefault = (f: FlagName) => f !== "mirror_uv";
export function flagValue(s: FlagState | undefined, f: FlagName): boolean { return s?.[f] ?? flagDefault(f); }

/** Toggle a bbmodel flag on the selected bones / cube (mirror UV also works for geo bones / cubes). */
export function opToggleFlag(api: StudioApi, flag: FlagName, target?: { bone: string; index?: number }): boolean {
  const s = api.store.get();
  const doc = s.doc;
  if (!canEditDoc(doc)) return false;
  if (doc.kind === "geo" && flag !== "mirror_uv") return false;
  const targets: Array<{ bone: string; index?: number }> = target ? [target] : s.cube ? selValue(s).cubes.map((c) => ({ bone: c.bone, index: c.index })) : s.bones.map((bone) => ({ bone }));
  if (!targets.length) return false;
  const fm = bbFlagMap(doc);
  const rig = rigOf(doc)!;
  const cur = (t: { bone: string; index?: number }) => {
    if (doc.kind === "geo") {
      const b = boneOf(rig, t.bone);
      return t.index === undefined ? !!(b as RBone & { mirror?: boolean }).mirror : !!b?.cubes[t.index]?.mirror;
    }
    return flagValue(t.index === undefined ? fm.groups.get(t.bone) : fm.cubes.get(`${t.bone}#${t.index}`), flag);
  };
  const next = !cur(targets[0]);
  let d: Doc = doc;
  for (const t of targets) {
    if (t.index === undefined) d = cmdSetBone(d, t.bone, flag === "mirror_uv" ? { mirror: next ? true : null } : { flags: { [flag]: next === flagDefault(flag) ? null : next } });
    else d = cmdSetCube(d, t.bone, t.index, flag === "mirror_uv" ? { mirror: next ? true : null } : { flags: { [flag]: next === flagDefault(flag) ? null : next } });
  }
  api.commit(d, `Toggle ${flag === "autouv" ? "Auto UV" : flag === "mirror_uv" ? "Mirror UV" : flag[0].toUpperCase() + flag.slice(1)}`);
  return true;
}

// ---------------------------------------------------------------- lifecycle

export function opAddBone(api: StudioApi, parent?: string, name = "bone"): string | null {
  const doc = api.store.get().doc;
  const rig = rigOf(doc);
  if (!canEditDoc(doc) || !rig) return null;
  const n = uniq(new Set(rig.bones.map((b) => b.name)), name);
  const p = parent && parent !== ROOT_BONE ? boneOf(rig, parent) : undefined;
  api.commit(cmdAddBone(doc, { name: n, parent: p?.name, pivot: p?.pivot }), "Add Bone");
  api.store.set({ bones: [n], cube: null, cubes: [] });
  return n;
}

export function opAddCube(api: StudioApi, bone?: string): { bone: string; index: number } | null {
  let doc = api.store.get().doc;
  let rig = rigOf(doc);
  if (!canEditDoc(doc) || !rig) return null;
  const sel = bone ?? api.store.get().bones[0] ?? rig.bones.find((b) => b.name !== ROOT_BONE)?.name;
  let target = sel;
  if (!target) {
    doc = cmdAddBone(doc, { name: "root", pivot: [0, 0, 0] });
    target = "root";
    rig = rigOf(doc)!;
  }
  const b = boneOf(rig, target)!;
  const spec: CubeSpec = { origin: [b.pivot[0] - 2, b.pivot[1], b.pivot[2] - 2], size: [4, 4, 4], uv: { kind: "box", uv: [0, 0] } };
  const index = b.cubes.length;
  api.commit(cmdAddCube(doc, target, spec, isBb(doc) ? `cube` : undefined), "Add Cube");
  api.store.set({ bones: [target], cube: { bone: target, index }, cubes: [{ bone: target, index }] });
  return { bone: target, index };
}

/** Delete the selected cubes, else the selected bones (children are re-parented, like Blockbench "Delete (keep children)"). */
export function opDeleteSelection(api: StudioApi): boolean {
  const s = api.store.get();
  let doc = s.doc;
  if (!canEditDoc(doc)) return false;
  if (s.cube) {
    const cubes = byBoneDesc(editTargets(s, rigOf(doc)).cubes);
    if (!cubes.length) return false;
    for (const c of cubes) doc = cmdDeleteCube(doc, c.bone, c.index);
    api.commit(doc, cubes.length > 1 ? "Delete Cubes" : "Delete Cube");
    api.store.set({ cube: null, cubes: [], bones: [] });
    return true;
  }
  const bones = s.bones.filter((b) => b !== ROOT_BONE);
  if (!bones.length) return false;
  for (const b of bones) doc = cmdDeleteBone(doc, b);
  api.commit(doc, bones.length > 1 ? "Delete Bones" : "Delete Bone");
  api.store.set({ bones: [], cube: null, cubes: [] });
  return true;
}

const cubeToClip = (c: RCube): ElemCube => ({ name: c.name, origin: c.origin, size: c.size, pivot: c.pivot, rotation: c.rotation, inflate: c.inflate || undefined, mirror: c.mirror || undefined, uv: uvOf(c) });
const clipToSpec = (c: ElemCube): CubeSpec => ({ origin: c.origin, size: c.size, pivot: c.pivot, rotation: c.rotation, inflate: c.inflate, mirror: c.mirror, uv: c.uv });

/** Snapshot of the Edit-mode selection (the selected cubes, or the selected top-most bones with their subtrees). */
export function opSnapshotSelection(api: StudioApi): ElemClip | null {
  const s = api.store.get();
  const rig = rigOf(s.doc);
  if (!rig) return null;
  if (s.cube) {
    const cubes = editTargets(s, rig).cubes.map((r) => boneOf(rig, r.bone)?.cubes[r.index]).filter((c): c is RCube => !!c);
    return cubes.length ? { bones: [], cubes: cubes.map(cubeToClip) } : null;
  }
  const sel = topGroups(s.bones.filter((b) => b !== ROOT_BONE), rigTree(rig));
  if (!sel.length) return null;
  const bones: ElemClip["bones"] = [];
  for (const root of sel) {
    for (const b of [boneOf(rig, root), ...descendantsOf(rig, root)]) {
      if (!b) continue;
      bones.push({ name: b.name, parent: b.name === root ? undefined : b.parent, pivot: b.pivot, rotation: b.rotation, cubes: b.cubes.map(cubeToClip) });
    }
  }
  return { bones, cubes: [] };
}

export function opCopyElements(api: StudioApi): boolean {
  const clip = opSnapshotSelection(api);
  if (!clip) return false;
  toolsStore(api).set({ elemClip: clip });
  return true;
}

/** Paste the Edit-mode clipboard: cubes go into the selected bone, bones become siblings of the selected bone (fresh names). */
export function opPasteElements(api: StudioApi): boolean {
  const clip = toolsStore(api).get().elemClip;
  const s = api.store.get();
  let doc = s.doc;
  let rig = rigOf(doc);
  if (!clip || !canEditDoc(doc) || !rig) return false;
  if (clip.cubes.length) {
    const target = s.cube?.bone ?? s.bones[0] ?? rig.bones.find((b) => b.name !== ROOT_BONE)?.name;
    if (!target) return false;
    let n = boneOf(rig, target)?.cubes.length ?? 0;
    for (const c of clip.cubes) doc = cmdAddCube(doc, target, clipToSpec(c), c.name ? c.name + "" : isBb(doc) ? "cube" : undefined);
    api.commit(doc, clip.cubes.length > 1 ? "Paste Cubes" : "Paste Cube");
    setSel(api, ofCubes(clip.cubes.map((_, k) => ({ bone: target, index: n + k }))));
    return true;
  }
  const names = new Set(rig.bones.map((b) => b.name));
  const rename = new Map<string, string>();
  const parentOfSel = s.bones[0] ? boneOf(rig, s.bones[0])?.parent : undefined;
  const made: string[] = [];
  for (const b of clip.bones) {
    const nn = uniq(names, b.parent ? b.name : b.name.replace(/_copy(_\d+)?$/, "") + "_copy");
    names.add(nn);
    rename.set(b.name, nn);
    const parent = b.parent ? rename.get(b.parent) : parentOfSel;
    doc = cmdAddBone(doc, { name: nn, parent, pivot: b.pivot, rotation: b.rotation });
    for (const c of b.cubes) doc = cmdAddCube(doc, nn, clipToSpec(c), c.name);
    if (!b.parent) made.push(nn);
  }
  rig = rigOf(doc);
  api.commit(doc, "Paste Bone");
  setSel(api, ofGroups(made));
  return true;
}

export function opCutElements(api: StudioApi): boolean {
  if (!opCopyElements(api)) return false;
  return opDeleteSelection(api);
}

/** Duplicate the selected cubes (same bone, appended) or bones (with cubes and descendants). */
export function opDuplicate(api: StudioApi): boolean {
  const s = api.store.get();
  const doc = s.doc;
  const rig = rigOf(doc);
  if (!canEditDoc(doc) || !rig) return false;
  if (s.cube) {
    const cubes = editTargets(s, rig).cubes;
    let d: Doc = doc;
    const counts = new Map<string, number>();
    const made: CubeRef[] = [];
    for (const r of cubes) {
      const b = boneOf(rig, r.bone);
      const c = b?.cubes[r.index];
      if (!b || !c) continue;
      const names = new Set(b.cubes.map((x) => x.name ?? ""));
      d = cmdAddCube(d, b.name, cubeSpecOf(c), c.name ? uniq(names, c.name) : undefined);
      const n = counts.get(b.name) ?? b.cubes.length;
      counts.set(b.name, n + 1);
      made.push({ bone: b.name, index: n });
    }
    if (!made.length) return false;
    api.commit(d, made.length > 1 ? "Duplicate Cubes" : "Duplicate Cube");
    setSel(api, ofCubes(made));
    return true;
  }
  if (!s.bones.length) return false;
  const clip = opSnapshotSelection(api);
  if (!clip) return false;
  const names = new Set(rig.bones.map((b) => b.name));
  const rename = new Map<string, string>();
  const made: string[] = [];
  let d: Doc = doc;
  for (const b of clip.bones) {
    const nn = uniq(names, b.name.replace(/_copy(_\d+)?$/, "") + "_copy");
    names.add(nn);
    rename.set(b.name, nn);
    const orig = boneOf(rig, b.name);
    const parent = b.parent ? rename.get(b.parent) : orig?.parent;
    d = cmdAddBone(d, { name: nn, parent, pivot: b.pivot, rotation: b.rotation });
    for (const c of b.cubes) d = cmdAddCube(d, nn, clipToSpec(c), c.name);
    if (!b.parent) made.push(nn);
  }
  api.commit(d, "Duplicate Bone");
  setSel(api, ofGroups(made));
  return true;
}

export function opRenameBone(api: StudioApi, from: string, to: string): boolean {
  const doc = api.store.get().doc;
  to = to.trim();
  if (!canEditDoc(doc) || !to || to === from) return false;
  try {
    api.commit(cmdRename(doc, from, to), "Rename Bone");
    api.store.set((s) => ({ bones: s.bones.map((b) => (b === from ? to : b)), cube: s.cube?.bone === from ? { ...s.cube, bone: to } : s.cube, cubes: s.cubes.map((c) => (c.bone === from ? { ...c, bone: to } : c)), hidden: s.hidden.map((b) => (b === from ? to : b)), locked: s.locked.map((b) => (b === from ? to : b)) }));
    return true;
  } catch { return false; }
}

export function opReparent(api: StudioApi, name: string, parent: string | null): boolean {
  const doc = api.store.get().doc;
  if (!canEditDoc(doc)) return false;
  try { api.commit(cmdReparent(doc, name, parent === ROOT_BONE ? null : parent), "Reparent Bone"); return true; } catch { return false; }
}

/** Re-parent several groups at once (one undo step); groups that cannot move (under themselves) are skipped. */
export function opReparentMany(api: StudioApi, names: string[], parent: string | null): boolean {
  let doc = api.store.get().doc;
  if (!canEditDoc(doc)) return false;
  let n = 0;
  for (const name of names) {
    if (name === parent) continue;
    try { const next = cmdReparent(doc, name, parent === ROOT_BONE ? null : parent); if (next !== doc) { doc = next; n++; } } catch { /* cycle */ }
  }
  if (!n) return false;
  api.commit(doc, n > 1 ? "Reparent Bones" : "Reparent Bone");
  return true;
}

/** Drag cubes onto another bone (the whole selection when the dragged cube is part of it). */
export function opMoveCube(api: StudioApi, from: { bone: string; index: number }, toBone: string): boolean {
  const doc = api.store.get().doc;
  const rig = rigOf(doc);
  if (!canEditDoc(doc) || !rig) return false;
  const st = api.store.get();
  const sel = selValue(st);
  const moving = sel.cube && sel.cubes.some((c) => c.bone === from.bone && c.index === from.index) ? sel.cubes : [from];
  const dst = boneOf(rig, toBone);
  const list = moving.filter((c) => c.bone !== toBone);
  if (!dst || !list.length) return false;
  let d: Doc = doc;
  const made: CubeRef[] = [];
  let at = dst.cubes.length;
  if (isBb(doc)) {
    // moveBbCube re-indexes the source group's remaining cubes: move highest index first
    for (const c of byBoneDesc(list)) { d = moveBbCube(d, { group: c.bone, index: c.index, toGroup: toBone === ROOT_BONE ? null : toBone }); }
    list.forEach(() => made.push({ bone: toBone, index: at++ }));
  } else {
    for (const c of list) { const src = boneOf(rig, c.bone)?.cubes[c.index]; if (src) { d = cmdAddCube(d, toBone, cubeSpecOf(src), src.name); made.push({ bone: toBone, index: at++ }); } }
    for (const c of byBoneDesc(list)) d = cmdDeleteCube(d, c.bone, c.index);
  }
  api.commit(d, list.length > 1 ? "Move Cubes" : "Move Cube");
  setSel(api, ofCubes(made));
  return true;
}

// ---------------------------------------------------------------- grouping

/** ⌘G: new empty group, child of the selected bone (else top level), at the selected bone's pivot. */
export function opAddGroup(api: StudioApi): string | null {
  const s = api.store.get();
  const rig = rigOf(s.doc);
  if (!canEditDoc(s.doc) || !rig) return null;
  const parent = s.bones[0] && s.bones[0] !== ROOT_BONE ? boneOf(rig, s.bones[0]) : undefined;
  const n = uniq(new Set(rig.bones.map((b) => b.name)), "group");
  api.commit(cmdAddBone(s.doc, { name: n, parent: parent?.name, pivot: parent?.pivot ?? [0, 0, 0] }), "Add Group");
  api.store.set({ bones: [n], cube: null, cubes: [] });
  return n;
}

/** ⌘⇧G: wrap the selected bones / cube in a new group (pivot = first selected, parent = its parent). */
export function opGroupElements(api: StudioApi): string | null {
  const s = api.store.get();
  let doc = s.doc;
  const rig = rigOf(doc);
  if (!canEditDoc(doc) || !rig) return null;
  const n = uniq(new Set(rig.bones.map((b) => b.name)), "group");
  if (s.cube) {
    const cubes = editTargets(s, rig).cubes;
    const first = cubes.find((r) => r.bone === s.cube!.bone && r.index === s.cube!.index) ?? cubes[0];
    const b = first && boneOf(rig, first.bone);
    const c = b?.cubes[first.index];
    if (!b || !c) return null;
    doc = cmdAddBone(doc, { name: n, parent: b.name === ROOT_BONE ? undefined : b.name, pivot: c.pivot ?? b.pivot });
    for (const r of cubes) { const src = boneOf(rig, r.bone)?.cubes[r.index]; if (src) doc = cmdAddCube(doc, n, cubeSpecOf(src), src.name); }
    for (const r of byBoneDesc(cubes)) doc = cmdDeleteCube(doc, r.bone, r.index);
    api.commit(doc, "Group Elements");
    setSel(api, ofCubes(cubes.map((_, k) => ({ bone: n, index: k }))));
    return n;
  }
  const sel = s.bones.filter((x) => x !== ROOT_BONE && !s.bones.some((o) => o !== x && descendantsOf(rig, o).some((d) => d.name === x)));
  if (!sel.length) return null;
  const first = boneOf(rig, sel[0])!;
  doc = cmdAddBone(doc, { name: n, parent: first.parent, pivot: first.pivot });
  for (const b of sel) doc = cmdReparent(doc, b, n);
  api.commit(doc, "Group Elements");
  setSel(api, ofGroups([n]));
  return n;
}

/** Dissolve the selected bones: their cubes and child bones move to the parent. Top-level bones that own cubes cannot be dissolved. */
export function opUngroup(api: StudioApi): boolean {
  const s = api.store.get();
  let doc = s.doc;
  const rig = rigOf(doc);
  if (!canEditDoc(doc) || !rig || s.cube) return false;
  let did = false;
  for (const name of s.bones) {
    if (name === ROOT_BONE) continue;
    const b = boneOf(rig, name);
    if (!b) continue;
    if (!isBb(doc) && b.cubes.length) {
      if (!b.parent) continue;
      for (const c of b.cubes) doc = cmdAddCube(doc, b.parent, cubeSpecOf(c));
    }
    doc = cmdDeleteBone(doc, name);
    did = true;
  }
  if (!did) return false;
  api.commit(doc, "Ungroup");
  api.store.set({ bones: [], cube: null, cubes: [] });
  return true;
}

export function opSort(api: StudioApi): boolean {
  const doc = api.store.get().doc;
  if (!canEditDoc(doc)) return false;
  const next = doc.kind === "bbmodel" ? sortBbOutliner(doc, { recursive: true }) : sortGeoBones(doc, {});
  if (next === doc) return false;
  api.commit(next, "Sort Outliner");
  return true;
}

// ---------------------------------------------------------------- selection helpers

export function opSelectAll(api: StudioApi): boolean {
  const rig = rigOf(api.store.get().doc);
  if (!rig) return false;
  api.store.set({ bones: rig.bones.filter((b) => b.name !== ROOT_BONE || b.cubes.length).map((b) => b.name), cube: null, cubes: [] });
  return true;
}
export function opInvertSelection(api: StudioApi): boolean {
  const s = api.store.get();
  const rig = rigOf(s.doc);
  if (!rig) return false;
  if (s.cube) {
    const chosen = new Set(selValue(s).cubes.map((c) => `${c.bone}#${c.index}`));
    setSel(api, ofCubes(rig.bones.flatMap((b) => b.cubes.map((c) => ({ bone: b.name, index: c.index }))).filter((c) => !chosen.has(`${c.bone}#${c.index}`))));
    return true;
  }
  api.store.set({ bones: rig.bones.map((b) => b.name).filter((n) => !s.bones.includes(n)), cube: null, cubes: [] });
  return true;
}
const wildcard = (p: string) => new RegExp("^" + p.trim().replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".") + "$", "i");
/** Select bones / cubes whose name matches `pattern` (`*` / `?` wildcards; a bare word matches as substring). */
export function opSelectByPattern(api: StudioApi, pattern: string): number {
  const rig = rigOf(api.store.get().doc);
  const p = pattern.trim();
  if (!rig || !p) return 0;
  const re = /[*?]/.test(p) ? wildcard(p) : new RegExp(p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
  const bones = rig.bones.filter((b) => re.test(b.name)).map((b) => b.name);
  let cube: { bone: string; index: number } | null = null;
  if (!bones.length) for (const b of rig.bones) for (const c of b.cubes) if (!cube && c.name && re.test(c.name)) cube = { bone: b.name, index: c.index };
  api.store.set({ bones: cube ? [cube.bone] : bones, cube, cubes: cube ? [cube] : [] });
  return bones.length + (cube ? 1 : 0);
}
/** "I": hide every bone except the selection (+ its ancestors and descendants); again to restore. */
export function opHideOthers(api: StudioApi): boolean {
  const ui = toolsStore(api);
  const s = api.store.get();
  if (ui.get().hiddenBefore) {
    api.store.set({ hidden: ui.get().hiddenBefore! });
    ui.set({ hiddenBefore: null });
    return true;
  }
  const rig = rigOf(s.doc);
  const sel = s.cube ? [...new Set(selValue(s).cubes.map((c) => c.bone))] : s.bones;
  if (!rig || !sel.length) return false;
  const keep = new Set<string>();
  for (const n of sel) {
    keep.add(n);
    for (const d of descendantsOf(rig, n)) keep.add(d.name);
    for (let p = boneOf(rig, n)?.parent; p; p = boneOf(rig, p)?.parent) keep.add(p);
  }
  ui.set({ hiddenBefore: s.hidden });
  api.store.set({ hidden: rig.bones.map((b) => b.name).filter((n) => !keep.has(n)) });
  return true;
}

// ---------------------------------------------------------------- moving

/** Move a bone with everything inside it (own cubes + descendants' pivots and cubes) by `delta` px, file space. */
export function moveBoneTree(doc: Doc, bone: string, delta: NumVec3): Doc {
  const rig = rigOf(doc);
  if (!rig) return doc;
  const add = (v: NumVec3): NumVec3 => [v[0] + delta[0], v[1] + delta[1], v[2] + delta[2]];
  const all = [boneOf(rig, bone), ...descendantsOf(rig, bone)].filter((b): b is RBone => !!b);
  let d = doc;
  for (const b of all) {
    if (b.name !== ROOT_BONE) d = cmdSetBone(d, b.name, { pivot: add(b.pivot) });
    for (const c of b.cubes) d = cmdSetCube(d, b.name, c.index, { origin: add(c.origin), pivot: c.pivot ? add(c.pivot) : undefined });
  }
  return d;
}

/** Nudge the selection by `delta` (file space px): the selected cubes, else the selected top-most bones with their subtrees. */
export function opNudge(api: StudioApi, delta: NumVec3, label = "Move"): boolean {
  const s = api.store.get();
  let doc = s.doc;
  const rig = rigOf(doc);
  if (!canEditDoc(doc) || !rig) return false;
  const t = editTargets(s, rig);
  const add = (v: NumVec3): NumVec3 => [v[0] + delta[0], v[1] + delta[1], v[2] + delta[2]];
  if (s.cube) {
    let n = 0;
    for (const r of t.cubes) {
      const c = boneOf(rig, r.bone)?.cubes[r.index];
      if (!c) continue;
      doc = cmdSetCube(doc, r.bone, r.index, { origin: add(c.origin), pivot: c.pivot ? add(c.pivot) : undefined });
      n++;
    }
    if (!n) return false;
    api.commit(doc, label);
    return true;
  }
  if (!t.bones.length) return false;
  for (const b of t.bones) doc = moveBoneTree(doc, b, delta);
  api.commit(doc, label);
  return true;
}

export { strOf };
