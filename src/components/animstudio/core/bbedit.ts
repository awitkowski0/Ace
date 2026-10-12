/**
 * bbmodel geometry editing (groups = bones, cubes). Pure commands `(doc, args) => newDoc`.
 *
 * Addressing mirrors ui/model.ts `rigFromBb`: a bone is a group NAME, the pseudo bone "(root)" holds loose
 * elements, a cube is (group, index) where index counts cube-type elements among the group's direct uuid
 * children in outliner order (for "(root)": in `elements` order, as rigFromBb does). Values are FILE SPACE
 * (as rigFromBb produces them): cube origin = [-to.x, from.y, from.z], size = to - from, pivot = [-origin.x, origin.y, origin.z],
 * rotation = [-rx, -ry, rz]; group origin/rotation likewise.
 * Both layouts are supported: 4.x (group data lives in the outliner node) and 5.0 (data in top-level `groups[]`,
 * outliner nodes minimal).
 */
import { FACES, type CubeUv, type Face } from "./format/geo";
import type { NumVec3 } from "./format/animation";
import { allGroups, pseudoUuid, type BbElement, type BbGroup, type BbModel } from "./format/bbmodel";
import {
  derive, getIn, getKey, isArr, isObj, isStr, jarr, jbool, jnull, jnum, jobj, jstr, numsOf, setEntry, setIn, strOf,
  type JArr, type JEntry, type JNode, type JObj, type Path,
} from "./format/json";
import { getBb, getGeo, renameBbGroup, withRoot, type CubePatch, type CubeSpec, type Doc } from "./doc";

export const BB_ROOT = "(root)";

export interface BbFlags {
  visibility?: boolean | null;
  locked?: boolean | null;
  export?: boolean | null;
  shade?: boolean | null;
  autouv?: number | null;
  mirror_uv?: boolean | null;
  color?: number | null;
  name?: string;
}
export type BbCubeSpec = CubeSpec & { name?: string; flags?: BbFlags };

export interface BbCubeRef {
  /** Group name, or "(root)" for loose elements. */
  group: string;
  /** Cube-only index inside the group (see header). */
  index: number;
  element: BbElement;
}

// ---------------------------------------------------------------- reading

export const isBbCube = (e: BbElement | undefined): e is BbElement => !!e && (e.type === "cube" || e.type === "") && !!e.from && !!e.to;

/** All cubes with their (group, index) address, in the order rigFromBb lists them. */
export function bbCubeRefs(model: BbModel): BbCubeRef[] {
  const els = new Map(model.elements.map((e) => [e.uuid, e]));
  const used = new Set<string>();
  const out: BbCubeRef[] = [];
  const walk = (g: BbGroup) => {
    let n = 0;
    for (const c of g.children) {
      if (typeof c === "string") {
        const e = els.get(c);
        if (isBbCube(e)) {
          out.push({ group: g.name, index: n++, element: e });
          used.add(c);
        }
      } else walk(c);
    }
  };
  model.groups.forEach(walk);
  let n = 0;
  for (const e of model.elements) if (!used.has(e.uuid) && isBbCube(e)) out.push({ group: BB_ROOT, index: n++, element: e });
  return out;
}
export function bbCubeAt(model: BbModel, group: string | null | undefined, index: number): BbCubeRef | undefined {
  const g = !group ? BB_ROOT : group;
  return bbCubeRefs(model).find((r) => r.group === g && r.index === index);
}

/** File-space spec of an element (inverse of what addBbCube writes). */
export function readBbCube(e: BbElement): BbCubeSpec {
  const from = e.from ?? [0, 0, 0];
  const to = e.to ?? [0, 0, 0];
  const spec: BbCubeSpec = {
    name: e.name,
    origin: [-to[0], from[1], from[2]],
    size: [to[0] - from[0], to[1] - from[1], to[2] - from[2]],
  };
  if (e.origin) spec.pivot = [-e.origin[0], e.origin[1], e.origin[2]];
  if (e.rotation && (e.rotation[0] || e.rotation[1] || e.rotation[2])) spec.rotation = [-e.rotation[0], -e.rotation[1], e.rotation[2]];
  if (e.inflate !== undefined) spec.inflate = e.inflate;
  const mu = getKey(e.node, "mirror_uv");
  if (mu && mu.t === "l" && mu.value === true) spec.mirror = true;
  if (e.boxUv) spec.uv = { kind: "box", uv: e.uvOffset ?? [0, 0] };
  else {
    const faces = getKey(e.node, "faces");
    if (isObj(faces)) {
      const r: Partial<Record<Face, { uv: [number, number]; uvSize: [number, number] }>> = {};
      for (const f of FACES) {
        const fn = getKey(faces, f);
        const uv = isObj(fn) ? numsOf(getKey(fn, "uv")) : undefined;
        const tex = isObj(fn) ? getKey(fn, "texture") : undefined;
        if (uv && uv.length >= 4 && !(tex && tex.t === "l" && tex.value === null)) r[f] = { uv: [uv[0], uv[1]], uvSize: [uv[2] - uv[0], uv[3] - uv[1]] };
      }
      spec.uv = { kind: "faces", faces: r };
    }
  }
  return spec;
}

// ---------------------------------------------------------------- node helpers

const NUM_EPS = 1e-7;
function eq(a: JNode | undefined, b: JNode): boolean {
  if (!a || a.t !== b.t) return false;
  if (a.t === "n") return Math.abs(a.value - (b as typeof a).value) < NUM_EPS;
  if (a.t === "s" || a.t === "l") return a.value === (b as typeof a).value;
  if (a.t === "a") {
    const bb = b as JArr;
    return a.items.length === bb.items.length && a.items.every((x, i) => eq(x, bb.items[i]));
  }
  return false;
}
/** Set (or remove with `undefined`) a key; returns `o` itself when nothing changes. New keys are placed by `order`. */
function put(o: JObj, key: string, val: JNode | undefined, order: string[]): JObj {
  const cur = getKey(o, key);
  if (val === undefined) return cur === undefined ? o : setEntry(o, key, undefined);
  if (cur && eq(cur, val)) return o;
  const ki = order.indexOf(key);
  return setEntry(o, key, val, ki < 0 ? undefined : (k) => order.indexOf(k) > ki);
}
const vec3 = (v: readonly number[], like?: JNode): JArr => jarr(v.map((x) => jnum(x, 5)), isArr(like) ? like : undefined);
const num3 = (n: JNode | undefined, d: NumVec3 = [0, 0, 0]): NumVec3 => {
  const a = numsOf(n);
  return a && a.length >= 3 ? [a[0], a[1], a[2]] : d;
};
const uuidOf = (n: JNode | undefined): string | undefined => (isObj(n) ? strOf(getKey(n, "uuid")) : undefined);

const ELEM_ORDER = ["name", "box_uv", "rescale", "render_order", "locked", "export", "visibility", "shade", "mirror_uv", "scope", "allow_mirror_modeling", "from", "to", "autouv", "color", "inflate", "rotation", "origin", "uv_offset", "faces", "type", "uuid"];
const G4_ORDER = ["name", "origin", "rotation", "bedrock_binding", "color", "uuid", "export", "mirror_uv", "isOpen", "locked", "visibility", "autouv", "shade", "children"];
const G5_ORDER = ["name", "uuid", "export", "locked", "scope", "origin", "rotation", "bedrock_binding", "color", "children", "reset", "shade", "mirror_uv", "visibility", "autouv", "isOpen"];
const FLAG_KEYS = ["visibility", "locked", "export", "shade", "autouv", "mirror_uv", "color"] as const;

function applyFlags(n: JObj, f: BbFlags | undefined, order: string[]): JObj {
  if (!f) return n;
  for (const k of FLAG_KEYS) {
    const v = f[k];
    if (v === undefined) continue;
    n = put(n, k, v === null ? undefined : typeof v === "boolean" ? jbool(v) : jnum(v, 0), order);
  }
  return n;
}

// ---------------------------------------------------------------- outliner helpers

interface Loc {
  arrPath: Path;
  index: number;
  parentUuid: string | null;
}
function locate(root: JObj, uuid: string): Loc | undefined {
  const rec = (arr: JNode | undefined, path: Path, parent: string | null): Loc | undefined => {
    if (!isArr(arr)) return undefined;
    for (let i = 0; i < arr.items.length; i++) {
      const it = arr.items[i];
      if ((isStr(it) && it.value === uuid) || uuidOf(it) === uuid) return { arrPath: path, index: i, parentUuid: parent };
      if (isObj(it)) {
        const r = rec(getKey(it, "children"), [...path, i, "children"], uuidOf(it) ?? null);
        if (r) return r;
      }
    }
    return undefined;
  };
  return rec(getKey(root, "outliner"), ["outliner"], null);
}
function childrenPath(root: JObj, parentUuid: string | null): Path {
  if (parentUuid === null) return ["outliner"];
  const l = locate(root, parentUuid);
  if (!l) throw new Error("group not in outliner");
  return [...l.arrPath, l.index, "children"];
}
function insertChild(root: JObj, parentUuid: string | null, node: JNode, at?: number): JObj {
  const p = childrenPath(root, parentUuid);
  const arr = getIn(root, p);
  const items = isArr(arr) ? arr.items.slice() : [];
  items.splice(at === undefined || at > items.length ? items.length : Math.max(0, at), 0, node);
  if (!isArr(arr) && parentUuid === null && !getKey(root, "outliner")) return setEntry(root, "outliner", jarr(items), (k) => k === "textures" || k === "display");
  return setIn(root, p, isArr(arr) ? derive(arr, items) : jarr(items)) as JObj;
}
function removeChild(root: JObj, uuid: string): JObj {
  const l = locate(root, uuid);
  if (!l) return root;
  return setIn(root, [...l.arrPath, l.index], undefined) as JObj;
}
function elementsArr(root: JObj): JArr | undefined {
  const e = getKey(root, "elements");
  return isArr(e) ? e : undefined;
}
function removeElements(root: JObj, uuids: Set<string>): JObj {
  const arr = elementsArr(root);
  if (!arr) return root;
  const items = arr.items.filter((x) => !uuids.has(uuidOf(x) ?? "\0"));
  return items.length === arr.items.length ? root : (setIn(root, ["elements"], derive(arr, items)) as JObj);
}
function removeDefs(root: JObj, uuids: Set<string>): JObj {
  const arr = getKey(root, "groups");
  if (!isArr(arr)) return root;
  const items = arr.items.filter((x) => !uuids.has(uuidOf(x) ?? "\0"));
  return items.length === arr.items.length ? root : (setIn(root, ["groups"], derive(arr, items)) as JObj);
}
function dropAnimators(root: JObj, uuids: Set<string>): JObj {
  const anims = getKey(root, "animations");
  if (!isArr(anims)) return root;
  anims.items.forEach((a, i) => {
    const an = isObj(a) ? getKey(a, "animators") : undefined;
    if (!isObj(an)) return;
    const kept = an.entries.filter((e) => !uuids.has(e.key));
    if (kept.length !== an.entries.length) root = setIn(root, ["animations", i, "animators"], derive(an, kept)) as JObj;
  });
  return root;
}

function mustBb(doc: Doc): { model: BbModel; root: JObj } {
  if (doc.kind !== "bbmodel") throw new Error("not a bbmodel");
  return { model: getBb(doc), root: doc.root as JObj };
}
const isRootName = (n: string | null | undefined): n is null | undefined => n == null || n === BB_ROOT || n === "";
function mustGroup(model: BbModel, name: string): BbGroup {
  const g = allGroups(model).find((x) => x.name === name);
  if (!g) throw new Error(`No group "${name}"`);
  return g;
}
function allUuids(root: JObj): Set<string> {
  const out = new Set<string>();
  const rec = (n: JNode | undefined): void => {
    if (!n) return;
    if (n.t === "s") out.add(n.value);
    else if (n.t === "o") n.entries.forEach((e) => rec(e.value));
    else if (n.t === "a") n.items.forEach(rec);
  };
  rec(getKey(root, "elements"));
  rec(getKey(root, "groups"));
  rec(getKey(root, "outliner"));
  return out;
}
function freshUuid(root: JObj, seed: string): string {
  const used = allUuids(root);
  let u = pseudoUuid(seed);
  for (let i = 0; used.has(u) && i < 1000; i++) u = pseudoUuid(`${seed}#${i}`);
  return u;
}
const is5 = (model: BbModel, root: JObj) =>
  isArr(getKey(root, "groups")) || allGroups(model).some((g) => g.defNode) || (!allGroups(model).length && parseInt(model.formatVersion ?? "4", 10) >= 5);

// ---------------------------------------------------------------- groups

interface GroupSrc {
  /** node holding name/origin/rotation/flags */
  data: JObj;
  path: Path;
  order: string[];
}
function groupSrc(root: JObj, g: BbGroup): GroupSrc {
  if (g.defNode) {
    const defs = getKey(root, "groups") as JArr;
    const i = defs.items.findIndex((x) => uuidOf(x) === g.uuid);
    return { data: defs.items[i] as JObj, path: ["groups", i], order: G5_ORDER };
  }
  const l = locate(root, g.uuid);
  if (!l) throw new Error(`group "${g.name}" not in outliner`);
  return { data: g.outlinerNode, path: [...l.arrPath, l.index], order: G4_ORDER };
}

export function addBbGroup(doc: Doc, a: { name: string; parent?: string; origin?: NumVec3; rotation?: NumVec3 }): Doc {
  const { model, root } = mustBb(doc);
  if (!a.name || a.name === BB_ROOT) throw new Error("invalid group name");
  const groups = allGroups(model);
  if (groups.some((g) => g.name === a.name)) throw new Error(`Group "${a.name}" exists`);
  const parent = isRootName(a.parent) ? undefined : mustGroup(model, a.parent);
  const tpl = groups[groups.length - 1];
  const five = is5(model, root);
  const uuid = freshUuid(root, `bbgroup/${a.name}/${groups.length}`);
  const originBb: NumVec3 = a.origin ? [-a.origin[0], a.origin[1], a.origin[2]] : [0, 0, 0];
  const rotBb: NumVec3 = a.rotation ? [-a.rotation[0], -a.rotation[1], a.rotation[2]] : [0, 0, 0];
  const build = (srcTpl: JObj | undefined, fallback: string[], order: string[], alwaysRot: boolean): JObj => {
    const want: Record<string, (like: JNode | undefined) => JNode | undefined> = {
      name: () => jstr(a.name),
      uuid: () => jstr(uuid),
      origin: (l) => vec3(originBb, l),
      rotation: (l) => (a.rotation || alwaysRot ? vec3(rotBb, l) : undefined),
      color: () => jnum(0, 0),
      export: () => jbool(true),
      locked: () => jbool(false),
      visibility: () => jbool(true),
      autouv: () => jnum(0, 0),
      shade: () => jbool(true),
      mirror_uv: () => jbool(false),
      isOpen: () => jbool(true),
      selected: () => jbool(false),
      primary_selected: () => jbool(false),
      reset: () => jbool(false),
      scope: () => jnum(0, 0),
      children: () => jarr([]),
      bedrock_binding: () => undefined,
      _static: () => undefined,
    };
    const entries: JEntry[] = [];
    const seen = new Set<string>();
    for (const k of srcTpl ? srcTpl.entries.map((e) => e.key) : fallback) {
      seen.add(k);
      const te = srcTpl?.entries.find((e) => e.key === k);
      const w = want[k];
      if (w) {
        const v = w(te?.value);
        if (v) entries.push({ key: k, keyRaw: te?.keyRaw, value: k === "children" && te ? jarr([], te.value) : v });
      } else if (te) entries.push(te);
    }
    let o = jobj(entries, srcTpl);
    if (!seen.has("rotation") && a.rotation) o = put(o, "rotation", vec3(rotBb), order);
    return o;
  };
  let next = root;
  let outlinerNode: JObj;
  if (five) {
    const def = build(tpl?.defNode, ["name", "uuid", "export", "locked", "scope", "origin", "rotation", "color", "children", "reset", "shade", "mirror_uv", "visibility", "autouv", "isOpen"], G5_ORDER, true);
    const defsArr = getKey(next, "groups");
    next = (isArr(defsArr)
      ? setIn(next, ["groups"], derive(defsArr, [...defsArr.items, def]))
      : setEntry(next, "groups", jarr([def]), (k) => k === "outliner")) as JObj;
    outlinerNode = build(tpl?.outlinerNode, ["uuid", "isOpen", "children"], ["uuid", "isOpen", "children"], false);
  } else {
    outlinerNode = build(tpl?.outlinerNode, ["name", "origin", "rotation", "color", "uuid", "export", "isOpen", "locked", "visibility", "autouv", "children"], G4_ORDER, !!tpl && getKey(tpl.outlinerNode, "rotation") !== undefined);
  }
  next = insertChild(next, parent ? parent.uuid : null, outlinerNode);
  return withRoot(doc, next);
}

export function deleteBbGroup(doc: Doc, a: { name: string; cascade?: boolean }): Doc {
  const { model, root } = mustBb(doc);
  const g = mustGroup(model, a.name);
  const loc = locate(root, g.uuid);
  if (!loc) throw new Error(`group "${a.name}" not in outliner`);
  const dead = new Set<string>([g.uuid]);
  const deadEls = new Set<string>();
  let next = root;
  if (a.cascade) {
    const rec = (x: BbGroup) => {
      for (const c of x.children) {
        if (typeof c === "string") deadEls.add(c);
        else {
          dead.add(c.uuid);
          rec(c);
        }
      }
    };
    rec(g);
    next = setIn(next, [...loc.arrPath, loc.index], undefined) as JObj;
    next = removeElements(next, deadEls);
  } else {
    const kids = getKey(g.outlinerNode, "children");
    const items = isArr(kids) ? kids.items : [];
    const parr = getIn(next, loc.arrPath) as JArr;
    const out = parr.items.slice();
    out.splice(loc.index, 1, ...items);
    next = setIn(next, loc.arrPath, derive(parr, out)) as JObj;
  }
  next = removeDefs(next, dead);
  next = dropAnimators(next, new Set([...dead, ...deadEls]));
  return withRoot(doc, next);
}

export function reparentBbGroup(doc: Doc, a: { name: string; parent: string | null; index?: number }): Doc {
  const { model, root } = mustBb(doc);
  const g = mustGroup(model, a.name);
  const parent = isRootName(a.parent) ? undefined : mustGroup(model, a.parent);
  if (parent) {
    const inside = (x: BbGroup): boolean => x === parent || x.children.some((c) => typeof c !== "string" && inside(c));
    if (inside(g)) throw new Error("Cannot parent a group under itself or its descendant");
  }
  const loc = locate(root, g.uuid);
  if (!loc) throw new Error(`group "${a.name}" not in outliner`);
  const sameParent = loc.parentUuid === (parent ? parent.uuid : null);
  if (sameParent && (a.index === undefined || a.index === loc.index)) return doc;
  const node = getIn(root, [...loc.arrPath, loc.index]) as JObj;
  let next = setIn(root, [...loc.arrPath, loc.index], undefined) as JObj;
  next = insertChild(next, parent ? parent.uuid : null, node, a.index);
  return withRoot(doc, next);
}

export function setBbGroup(
  doc: Doc,
  a: { group: string; patch: { origin?: NumVec3; rotation?: NumVec3 | null; flags?: BbFlags; bedrockBinding?: string | null } },
): Doc {
  const { model, root } = mustBb(doc);
  const g = mustGroup(model, a.group);
  const src = groupSrc(root, g);
  const p = a.patch;
  let n = src.data;
  if (p.origin) n = put(n, "origin", vec3([-p.origin[0], p.origin[1], p.origin[2]], getKey(n, "origin")), src.order);
  if (p.rotation !== undefined) {
    n = put(n, "rotation", p.rotation === null ? undefined : vec3([-p.rotation[0], -p.rotation[1], p.rotation[2]], getKey(n, "rotation") ?? getKey(n, "origin")), src.order);
  }
  if (p.bedrockBinding !== undefined) n = put(n, "bedrock_binding", p.bedrockBinding === null ? undefined : jstr(p.bedrockBinding), src.order);
  n = applyFlags(n, p.flags, src.order);
  let out = n === src.data ? doc : withRoot(doc, setIn(root, src.path, n));
  const nm = p.flags?.name;
  if (nm !== undefined && nm !== a.group) {
    if (allGroups(model).some((x) => x.name === nm)) throw new Error(`Group "${nm}" exists`);
    out = renameBbGroup(out, { from: a.group, to: nm });
  }
  return out;
}

// ---------------------------------------------------------------- cubes

function boxRects(size: NumVec3, off: [number, number], mirror: boolean): Record<Face, [number, number, number, number]> {
  const [w, h, d] = [Math.floor(size[0]), Math.floor(size[1]), Math.floor(size[2])];
  const [u, v] = off;
  const r = (x: number, y: number, ww: number, hh: number): [number, number, number, number] => [u + x, v + y, u + x + ww, v + y + hh];
  const east = r(0, d, d, h);
  const west = r(d + w, d, d, h);
  return {
    north: r(d, d, w, h),
    east: mirror ? west : east,
    south: r(d + w + d, d, w, h),
    west: mirror ? east : west,
    up: r(d, 0, w, d),
    down: r(d + w, d, w, -d),
  };
}

function facesNode(rects: Partial<Record<Face, readonly number[]>>, old: JNode | undefined, likeFaces: JNode | undefined): JObj {
  const oldO = isObj(old) ? old : undefined;
  const likeO = isObj(likeFaces) ? likeFaces : undefined;
  const FO = ["uv", "texture"];
  const ents: JEntry[] = [];
  for (const f of FACES) {
    const r = rects[f];
    const of = oldO ? getKey(oldO, f) : undefined;
    const lf = likeO ? getKey(likeO, f) : undefined;
    const uvLike = (isObj(of) ? getKey(of, "uv") : undefined) ?? (isObj(lf) ? getKey(lf, "uv") : undefined);
    let fn: JObj = isObj(of) ? of : jobj([], lf);
    fn = put(fn, "uv", jarr((r ?? [0, 0, 0, 0]).map((x) => jnum(x, 5)), isArr(uvLike) ? uvLike : undefined), FO);
    const tex = getKey(fn, "texture");
    if (r) {
      if (!tex || (tex.t === "l" && tex.value === null)) fn = put(fn, "texture", jnum(0, 0), FO);
    } else fn = put(fn, "texture", jnull(), FO);
    ents.push({ key: f, value: fn });
  }
  if (oldO && oldO.entries.length === ents.length && oldO.entries.every((e, i) => e.key === ents[i].key && e.value === ents[i].value)) return oldO;
  return jobj(ents, oldO ?? likeO);
}

function uvRects(uv: NonNullable<CubeUv>): Partial<Record<Face, number[]>> {
  const out: Partial<Record<Face, number[]>> = {};
  if (uv.kind === "faces") {
    for (const f of FACES) {
      const fv = uv.faces[f];
      if (fv) out[f] = [fv.uv[0], fv.uv[1], fv.uv[0] + fv.uvSize[0], fv.uv[1] + fv.uvSize[1]];
    }
  }
  return out;
}

function curFile(n: JObj): { origin: NumVec3; size: NumVec3 } {
  const from = num3(getKey(n, "from"));
  const to = num3(getKey(n, "to"));
  return { origin: [-to[0], from[1], from[2]], size: [to[0] - from[0], to[1] - from[1], to[2] - from[2]] };
}

/** Apply a file-space patch to an element node (shared by add/set). `likeEl` supplies number-array styles. */
function patchCube(n: JObj, p: CubePatch & { name?: string; flags?: BbFlags }, likeEl?: JObj): JObj {
  const O = ELEM_ORDER;
  const lk = (k: string) => getKey(n, k) ?? (likeEl ? getKey(likeEl, k) : undefined);
  if (p.name !== undefined) n = put(n, "name", jstr(p.name), O);
  if (p.origin || p.size) {
    const cur = curFile(n);
    const o = p.origin ?? cur.origin;
    const s = p.size ?? cur.size;
    n = put(n, "from", vec3([-o[0] - s[0], o[1], o[2]], lk("from")), O);
    n = put(n, "to", vec3([-o[0], o[1] + s[1], o[2] + s[2]], lk("to")), O);
  }
  if (p.pivot !== undefined) n = put(n, "origin", p.pivot === null ? undefined : vec3([-p.pivot[0], p.pivot[1], p.pivot[2]], lk("origin")), O);
  if (p.rotation !== undefined) {
    const r = p.rotation;
    n = put(n, "rotation", r === null ? undefined : vec3([-r[0], -r[1], r[2]], lk("rotation") ?? lk("origin")), O);
  }
  if (p.inflate !== undefined) n = put(n, "inflate", p.inflate === null ? undefined : jnum(p.inflate, 5), O);
  if (p.mirror !== undefined) n = put(n, "mirror_uv", p.mirror === null ? undefined : jbool(p.mirror), O);
  if (p.uv !== undefined) {
    if (p.uv === null) {
      n = put(n, "uv_offset", undefined, O);
      n = put(n, "box_uv", jbool(false), O);
      n = put(n, "faces", undefined, O);
    } else if (p.uv.kind === "box") {
      n = put(n, "box_uv", jbool(true), O);
      n = put(n, "uv_offset", vec3(p.uv.uv, lk("uv_offset")), O);
    } else {
      n = put(n, "box_uv", jbool(false), O);
      n = put(n, "uv_offset", undefined, O);
      n = put(n, "faces", facesNode(uvRects(p.uv), getKey(n, "faces"), likeEl ? getKey(likeEl, "faces") : undefined), O);
    }
  }
  const bu = getKey(n, "box_uv");
  if (bu && bu.t === "l" && bu.value === true && (p.size || p.origin || p.uv || p.mirror !== undefined)) {
    // keep the (derived) per-face rectangles consistent with the box layout
    const off = numsOf(getKey(n, "uv_offset")) ?? [0, 0];
    const mu = getKey(n, "mirror_uv");
    const rects = boxRects(curFile(n).size, [off[0], off[1]], !!(mu && mu.t === "l" && mu.value === true));
    n = put(n, "faces", facesNode(rects, getKey(n, "faces"), likeEl ? getKey(likeEl, "faces") : undefined), O);
  }
  return applyFlags(n, p.flags, O);
}

const CUBE_RESET: Record<string, () => JNode> = {
  locked: () => jbool(false),
  export: () => jbool(true),
  visibility: () => jbool(true),
  selected: () => jbool(false),
  color: () => jnum(0, 0),
};

function newCubeNode(root: JObj, model: BbModel, spec: BbCubeSpec, uuid: string): JObj {
  const tplEl = [...model.elements].reverse().find((e) => isBbCube(e));
  const tpl = tplEl?.node;
  const name = spec.name ?? spec.flags?.name ?? "cube";
  const metaBox = getKey(getKey(root, "meta") as JObj | undefined, "box_uv");
  const boxDefault = tplEl?.boxUv ?? (metaBox?.t === "l" && metaBox.value === true);
  let n: JObj;
  if (tpl) {
    const ents: JEntry[] = [];
    for (const e of tpl.entries) {
      if (e.key === "uuid") ents.push({ key: "uuid", keyRaw: e.keyRaw, value: jstr(uuid) });
      else if (e.key === "name") ents.push({ key: e.key, keyRaw: e.keyRaw, value: jstr(name) });
      else if (e.key === "rotation" || e.key === "inflate" || e.key === "mirror_uv") continue; // re-added below when the spec has them
      else if (CUBE_RESET[e.key]) ents.push({ key: e.key, keyRaw: e.keyRaw, value: CUBE_RESET[e.key]() });
      else ents.push(e);
    }
    n = jobj(ents, tpl);
  } else {
    n = jobj(
      [
        ["name", jstr(name)], ["box_uv", jbool(false)], ["rescale", jbool(false)], ["locked", jbool(false)], ["render_order", jstr("default")],
        ["allow_mirror_modeling", jbool(true)], ["from", vec3([0, 0, 0])], ["to", vec3([0, 0, 0])], ["autouv", jnum(0, 0)], ["color", jnum(0, 0)],
        ["origin", vec3([0, 0, 0])], ["type", jstr("cube")], ["uuid", jstr(uuid)],
      ],
      undefined,
    );
  }
  const uv: CubeUv = spec.uv ?? (boxDefault ? { kind: "box", uv: [0, 0] } : { kind: "faces", faces: {} });
  const rot = spec.rotation && (spec.rotation[0] || spec.rotation[1] || spec.rotation[2]) ? spec.rotation : undefined;
  n = patchCube(n, { origin: spec.origin, size: spec.size, pivot: spec.pivot ?? [0, 0, 0], rotation: rot, inflate: spec.inflate ? spec.inflate : undefined, mirror: spec.mirror ? true : undefined, uv }, tpl);
  if (!getKey(n, "type")) n = put(n, "type", jstr("cube"), ELEM_ORDER);
  return applyFlags(n, spec.flags, ELEM_ORDER);
}

function cubeChildPositions(items: JNode[], els: Map<string, BbElement>): number[] {
  const out: number[] = [];
  items.forEach((it, i) => {
    if (isStr(it) && isBbCube(els.get(it.value))) out.push(i);
  });
  return out;
}

export function addBbCube(doc: Doc, a: { group: string | null; cube: BbCubeSpec; index?: number }): Doc {
  const { model, root } = mustBb(doc);
  const g = isRootName(a.group) ? undefined : mustGroup(model, a.group);
  const uuid = freshUuid(root, `bbcube/${g ? g.name : BB_ROOT}/${model.elements.length}`);
  const node = newCubeNode(root, model, a.cube, uuid);
  const els = new Map(model.elements.map((e) => [e.uuid, e]));
  let next = root;
  // 1. elements[] (loose cubes are ordered by this array)
  let elAt: number | undefined;
  if (!g && a.index !== undefined) {
    const loose = bbCubeRefs(model).filter((r) => r.group === BB_ROOT);
    if (a.index < loose.length) elAt = loose[Math.max(0, a.index)].element.index;
  }
  const earr = elementsArr(next);
  if (earr) {
    const items = earr.items.slice();
    items.splice(elAt ?? items.length, 0, node);
    next = setIn(next, ["elements"], derive(earr, items)) as JObj;
  } else next = setEntry(next, "elements", jarr([node]), (k) => k === "outliner" || k === "textures") as JObj;
  // 2. outliner reference
  const parentUuid = g ? g.uuid : null;
  const parr = getIn(next, childrenPath(next, parentUuid));
  const pos = cubeChildPositions(isArr(parr) ? parr.items : [], els);
  const at = a.index !== undefined && a.index < pos.length ? pos[Math.max(0, a.index)] : undefined;
  next = insertChild(next, parentUuid, jstr(uuid), at);
  return withRoot(doc, next);
}

function mustCube(model: BbModel, group: string | null | undefined, index: number): BbCubeRef {
  const r = bbCubeAt(model, group, index);
  if (!r) throw new Error(`No cube ${index} in "${isRootName(group) ? BB_ROOT : group}"`);
  return r;
}

export function deleteBbCube(doc: Doc, a: { group: string | null; index: number }): Doc {
  const { model, root } = mustBb(doc);
  const r = mustCube(model, a.group, a.index);
  let next = removeChild(root, r.element.uuid);
  next = removeElements(next, new Set([r.element.uuid]));
  next = dropAnimators(next, new Set([r.element.uuid]));
  return withRoot(doc, next);
}

export function setBbCube(doc: Doc, a: { group: string | null; index: number; patch: CubePatch & { name?: string; flags?: BbFlags } }): Doc {
  const { model, root } = mustBb(doc);
  const r = mustCube(model, a.group, a.index);
  const n = patchCube(r.element.node, a.patch);
  if (n === r.element.node) return doc;
  return withRoot(doc, setIn(root, ["elements", r.element.index], n));
}

export function moveBbCube(doc: Doc, a: { group: string | null; index: number; toGroup: string | null; toIndex?: number }): Doc {
  const { model, root } = mustBb(doc);
  const r = mustCube(model, a.group, a.index);
  const to = isRootName(a.toGroup) ? undefined : mustGroup(model, a.toGroup);
  const toName = to ? to.name : BB_ROOT;
  if (r.group === toName && (a.toIndex === undefined || a.toIndex === a.index)) return doc;
  const uuid = r.element.uuid;
  // detach from the old parent first, then place relative to the new parent's remaining cubes
  const doc1 = withRoot(doc, removeChild(root, uuid));
  const els = new Map(getBb(doc1).elements.map((e) => [e.uuid, e]));
  let next = doc1.root as JObj;
  const parentUuid = to ? to.uuid : null;
  const parr = getIn(next, childrenPath(next, parentUuid));
  const pos = cubeChildPositions(isArr(parr) ? parr.items : [], els);
  const at = a.toIndex !== undefined && a.toIndex < pos.length ? pos[Math.max(0, a.toIndex)] : undefined;
  next = insertChild(next, parentUuid, jstr(uuid), at);
  if (!to && a.toIndex !== undefined) {
    const earr = elementsArr(next);
    if (earr) {
      const others = bbCubeRefs(getBb(withRoot(doc1, next))).filter((x) => x.group === BB_ROOT && x.element.uuid !== uuid);
      const items = earr.items.filter((x) => uuidOf(x) !== uuid);
      const node = earr.items.find((x) => uuidOf(x) === uuid)!;
      const target = a.toIndex < others.length ? others[Math.max(0, a.toIndex)].element.node : undefined;
      const ti = target ? items.indexOf(target) : items.length;
      items.splice(ti, 0, node);
      if (items.some((x, i) => x !== earr.items[i])) next = setIn(next, ["elements"], derive(earr, items)) as JObj;
    }
  }
  return withRoot(doc, next);
}

// ---------------------------------------------------------------- sorting

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

/** Alphabetical sort (Blockbench "Sort outliner": all siblings, groups and elements, by name, numeric/case-insensitive). */
export function sortBbOutliner(doc: Doc, a: { group?: string | null; recursive?: boolean } = {}): Doc {
  const { model, root } = mustBb(doc);
  const els = new Map(model.elements.map((e) => [e.uuid, e.name]));
  const gname = new Map(allGroups(model).map((g) => [g.uuid, g.name]));
  const nameOf = (n: JNode) => (isStr(n) ? els.get(n.value) ?? "" : gname.get(uuidOf(n) ?? "") ?? "");
  const sortArr = (arr: JArr, recursive: boolean): JArr => {
    let items = arr.items.map((it) => {
      if (!recursive || !isObj(it)) return it;
      const ch = getKey(it, "children");
      if (!isArr(ch)) return it;
      const sc = sortArr(ch, true);
      return sc === ch ? it : setEntry(it, "children", sc);
    });
    const idx = items.map((it, i) => ({ it, i, n: nameOf(it) }));
    idx.sort((x, y) => collator.compare(x.n, y.n) || x.i - y.i);
    items = idx.map((x) => x.it);
    return items.every((x, i) => x === arr.items[i]) ? arr : derive(arr, items);
  };
  const rec = !!a.recursive;
  if (isRootName(a.group)) {
    const ol = getKey(root, "outliner");
    if (!isArr(ol)) return doc;
    const s = sortArr(ol, rec);
    return s === ol ? doc : withRoot(doc, setIn(root, ["outliner"], s));
  }
  const g = mustGroup(model, a.group as string);
  const loc = locate(root, g.uuid)!;
  const p = [...loc.arrPath, loc.index, "children"];
  const ch = getIn(root, p);
  if (!isArr(ch)) return doc;
  const s = sortArr(ch, rec);
  return s === ch ? doc : withRoot(doc, setIn(root, p, s));
}

/** Geo docs: order bones alphabetically by name (parents are referenced by name, so they stay valid). */
export function sortGeoBones(doc: Doc, a: { geometry?: number } = {}): Doc {
  if (doc.kind !== "geo") throw new Error("not a geometry document");
  let root = doc.root;
  getGeo(doc).geometries.forEach((g, gi) => {
    if (a.geometry !== undefined && a.geometry !== gi) return;
    const barr = getKey(g.node, "bones");
    if (!isArr(barr)) return;
    const order = g.bones.map((b, i) => ({ i, n: b.name })).sort((x, y) => collator.compare(x.n, y.n) || x.i - y.i);
    if (order.every((o, k) => o.i === k)) return;
    root = setIn(root, ["minecraft:geometry", g.index, "bones"], derive(barr, order.map((o) => barr.items[o.i])));
  });
  return withRoot(doc, root);
}

// ---------------------------------------------------------------- per-face patches (UV editor / texture assignment)

/** `texture`: index into `textures[]`, `null` = face disabled (Blockbench "remove face"), `false` = no texture (key removed). */
export interface BbFacePatch {
  uv?: readonly [number, number, number, number];
  texture?: number | null | false;
  /** 0 / 90 / 180 / 270 (0 removes the key) */
  rotation?: number;
}
const FACE_KEY_ORDER = ["uv", "rotation", "texture"];

/**
 * Patch single faces of a bbmodel cube without touching the others (unlike `setBbCube({uv})`, which re-lays out all six faces).
 * Only the keys named in the patch change, so dragging one face rectangle edits one `uv` array in the file.
 */
export function setBbFaces(doc: Doc, a: { group: string | null; index: number; faces: Partial<Record<Face, BbFacePatch>> }): Doc {
  const { model, root } = mustBb(doc);
  const r = mustCube(model, a.group, a.index);
  let n = r.element.node;
  let faces = getKey(n, "faces");
  if (!isObj(faces)) faces = facesNode({}, undefined, undefined);
  let fobj = faces as JObj;
  for (const f of FACES) {
    const p = a.faces[f];
    if (!p) continue;
    const cur = getKey(fobj, f);
    let fn: JObj = isObj(cur) ? cur : jobj([]);
    if (p.uv) {
      const like = getKey(fn, "uv");
      fn = put(fn, "uv", jarr(p.uv.map((x) => jnum(x, 5)), isArr(like) ? like : undefined), FACE_KEY_ORDER);
    }
    if (p.rotation !== undefined) fn = put(fn, "rotation", p.rotation ? jnum(p.rotation, 0) : undefined, FACE_KEY_ORDER);
    if (p.texture !== undefined) fn = put(fn, "texture", p.texture === false ? undefined : p.texture === null ? jnull() : jnum(p.texture, 0), FACE_KEY_ORDER);
    if (fn !== cur) fobj = setEntry(fobj, f, fn);
  }
  if (fobj === getKey(n, "faces")) return doc;
  n = put(n, "faces", fobj, ELEM_ORDER);
  return n === r.element.node ? doc : withRoot(doc, setIn(root, ["elements", r.element.index], n));
}

/** Switch a bbmodel cube between box UV and per-face UV (the current layout is kept: box -> six rects, faces -> offset from north). */
export function setBbBoxUv(doc: Doc, a: { group: string | null; index: number; box: boolean }): Doc {
  const { model } = mustBb(doc);
  const r = mustCube(model, a.group, a.index);
  const spec = readBbCube(r.element);
  const isBox = spec.uv?.kind === "box";
  if (a.box === isBox) return doc;
  let uv: CubeUv;
  if (a.box) {
    const dz = Math.floor(spec.size[2]);
    const n = spec.uv?.kind === "faces" ? spec.uv.faces.north : undefined;
    uv = { kind: "box", uv: n ? [Math.max(0, Math.round(Math.min(n.uv[0], n.uv[0] + n.uvSize[0]) - dz)), Math.max(0, Math.round(Math.min(n.uv[1], n.uv[1] + n.uvSize[1]) - dz))] : [0, 0] };
  } else {
    const rects = boxRects(spec.size, spec.uv?.kind === "box" ? spec.uv.uv : [0, 0], !!spec.mirror);
    const faces: Partial<Record<Face, { uv: [number, number]; uvSize: [number, number] }>> = {};
    for (const f of FACES) faces[f] = { uv: [rects[f][0], rects[f][1]], uvSize: [rects[f][2] - rects[f][0], rects[f][3] - rects[f][1]] };
    uv = { kind: "faces", faces };
  }
  return setBbCube(doc, { group: a.group, index: a.index, patch: { uv } });
}
