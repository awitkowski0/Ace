/**
 * Typed view of Blockbench `.bbmodel` (format 4.x / 5.0; bedrock, azure_model, modded_entity).
 * Only the parts the Studio edits are typed; everything else lives in the JSON nodes and is preserved.
 */
import {
  derive, fmtNum, getKey, isArr, isNum, isObj, isStr, jarr, jbool, jnum, jobj, jstr, numOf, numsOf, setEntry, strOf, toValue,
  type JEntry, type JNode, type JObj,
} from "./json";
import {
  CHANNELS, DEFAULT_BEZIER, type Animation, type BezierHandles, type BoneAnim, type Channel, type ChannelName, type Comp, type Keyframe, type LoopMode, type Vec3,
} from "./animation";

type V3 = [number, number, number];
const v3 = (n: JNode | undefined): V3 | undefined => {
  const a = numsOf(n);
  return a && a.length >= 3 ? [a[0], a[1], a[2]] : undefined;
};

export interface BbElement {
  uuid: string;
  name: string;
  /** `cube` (default when absent), `mesh`, … */
  type: string;
  from?: V3;
  to?: V3;
  origin?: V3;
  rotation?: V3;
  inflate?: number;
  boxUv?: boolean;
  uvOffset?: [number, number];
  node: JObj;
  index: number;
}
export interface BbGroup {
  uuid: string;
  name: string;
  origin: V3;
  rotation?: V3;
  /** Child groups and element uuids in outliner order. */
  children: Array<BbGroup | string>;
  /** The outliner node (4.x: holds all data; 5.0: only uuid/children) and the `groups[]` entry when separate. */
  outlinerNode: JObj;
  defNode?: JObj;
}
export interface BbTexture {
  name: string;
  path?: string;
  /** `data:` URL when embedded. */
  source?: string;
  node: JObj;
  index: number;
}
export interface BbAnimator {
  /** Key in `animators` (group/element uuid). */
  key: string;
  name: string;
  type: string;
  node: JObj;
}
export interface BbAnimation {
  uuid: string;
  name: string;
  loop: string;
  length: number;
  animators: BbAnimator[];
  node: JObj;
  index: number;
}
export interface BbModel {
  formatVersion?: string;
  modelFormat?: string;
  name?: string;
  resolution?: { width: number; height: number };
  elements: BbElement[];
  groups: BbGroup[]; // top-level groups (tree)
  textures: BbTexture[];
  animations: BbAnimation[];
}

export function readBbModel(root: JNode): BbModel {
  const out: BbModel = { elements: [], groups: [], textures: [], animations: [] };
  if (!isObj(root)) return out;
  const meta = getKey(root, "meta");
  out.formatVersion = strOf(getKey(meta as JObj, "format_version"));
  out.modelFormat = strOf(getKey(meta as JObj, "model_format"));
  out.name = strOf(getKey(root, "name"));
  const res = getKey(root, "resolution");
  if (isObj(res)) out.resolution = { width: numOf(getKey(res, "width"), 16), height: numOf(getKey(res, "height"), 16) };

  const els = getKey(root, "elements");
  if (isArr(els)) {
    els.items.forEach((e, index) => {
      if (!isObj(e)) return;
      const uo = numsOf(getKey(e, "uv_offset"));
      const bu = getKey(e, "box_uv");
      out.elements.push({
        uuid: strOf(getKey(e, "uuid")) ?? "",
        name: strOf(getKey(e, "name")) ?? "",
        type: strOf(getKey(e, "type")) ?? "cube",
        from: v3(getKey(e, "from")),
        to: v3(getKey(e, "to")),
        origin: v3(getKey(e, "origin")),
        rotation: v3(getKey(e, "rotation")),
        inflate: numOf(getKey(e, "inflate")),
        boxUv: bu && bu.t === "l" ? (bu.value as boolean) : undefined,
        uvOffset: uo && uo.length >= 2 ? [uo[0], uo[1]] : undefined,
        node: e,
        index,
      });
    });
  }

  const defs = new Map<string, JObj>();
  const groupsN = getKey(root, "groups");
  if (isArr(groupsN)) for (const g of groupsN.items) if (isObj(g)) defs.set(strOf(getKey(g, "uuid")) ?? "", g);
  const walk = (n: JNode): BbGroup | string | undefined => {
    if (isStr(n)) return n.value;
    if (!isObj(n)) return undefined;
    const uuid = strOf(getKey(n, "uuid")) ?? "";
    const def = defs.get(uuid);
    const src = def ?? n;
    const children: Array<BbGroup | string> = [];
    const ch = getKey(n, "children");
    if (isArr(ch)) for (const c of ch.items) { const w = walk(c); if (w !== undefined) children.push(w); }
    return {
      uuid,
      name: strOf(getKey(src, "name")) ?? strOf(getKey(n, "name")) ?? "",
      origin: v3(getKey(src, "origin")) ?? [0, 0, 0],
      rotation: v3(getKey(src, "rotation")),
      children,
      outlinerNode: n,
      defNode: def,
    };
  };
  const ol = getKey(root, "outliner");
  if (isArr(ol)) for (const n of ol.items) { const w = walk(n); if (w && typeof w !== "string") out.groups.push(w); }

  const tex = getKey(root, "textures");
  if (isArr(tex)) {
    tex.items.forEach((t, index) => {
      if (isObj(t)) out.textures.push({ name: strOf(getKey(t, "name")) ?? "", path: strOf(getKey(t, "path")), source: strOf(getKey(t, "source")), node: t, index });
    });
  }

  const anims = getKey(root, "animations");
  if (isArr(anims)) {
    anims.items.forEach((a, index) => {
      if (!isObj(a)) return;
      const animators: BbAnimator[] = [];
      const an = getKey(a, "animators");
      if (isObj(an)) for (const e of an.entries) if (isObj(e.value)) animators.push({ key: e.key, name: strOf(getKey(e.value, "name")) ?? "", type: strOf(getKey(e.value, "type")) ?? "bone", node: e.value });
      out.animations.push({
        uuid: strOf(getKey(a, "uuid")) ?? "",
        name: strOf(getKey(a, "name")) ?? "",
        loop: strOf(getKey(a, "loop")) ?? "once",
        length: numOf(getKey(a, "length"), 0),
        animators,
        node: a,
        index,
      });
    });
  }
  return out;
}

export function groupByName(m: BbModel, name: string): BbGroup | undefined {
  let found: BbGroup | undefined;
  const rec = (g: BbGroup) => {
    if (!found && g.name === name) found = g;
    for (const c of g.children) if (typeof c !== "string") rec(c);
  };
  m.groups.forEach(rec);
  return found;
}
export function allGroups(m: BbModel): BbGroup[] {
  const out: BbGroup[] = [];
  const rec = (g: BbGroup) => {
    out.push(g);
    for (const c of g.children) if (typeof c !== "string") rec(c);
  };
  m.groups.forEach(rec);
  return out;
}

// ---------------------------------------------------------------- animations <-> common model

const bbLoop = (s: string): LoopMode => (s === "loop" ? true : s === "hold" ? "hold_on_last_frame" : false);
export const bbLoopFromMode = (l: LoopMode): string => (l === true ? "loop" : l === "hold_on_last_frame" ? "hold" : "once");

function dpComp(n: JNode | undefined): Comp {
  if (!n) return 0;
  if (n.t === "n") return n.value;
  if (n.t === "s") {
    const t = n.value.trim();
    if (t === "") return 0;
    const num = Number(t);
    return Number.isFinite(num) ? num : n.value;
  }
  return 0;
}
function dpVec(n: JNode | undefined): Vec3 {
  if (!isObj(n)) return [0, 0, 0];
  return [dpComp(getKey(n, "x")), dpComp(getKey(n, "y")), dpComp(getKey(n, "z"))];
}

export function readBbKeyframe(k: JObj): { channel: string; key: Keyframe } | undefined {
  const channel = strOf(getKey(k, "channel"));
  if (!channel) return undefined;
  const dps = getKey(k, "data_points");
  const pts = isArr(dps) ? dps.items : [];
  const interp = strOf(getKey(k, "interpolation"));
  const key: Keyframe = { time: numOf(getKey(k, "time"), 0), value: pts.length ? dpVec(pts[pts.length - 1]) : [0, 0, 0], node: k, bb: { interpolation: interp, uuid: strOf(getKey(k, "uuid")) } };
  if (pts.length >= 2) key.pre = dpVec(pts[0]);
  if (interp === "catmullrom") key.lerp = "catmullrom";
  const e = strOf(getKey(k, "easing"));
  if (e && e !== "linear") key.easing = e;
  else if (interp === "step") key.easing = "step";
  const ea = getKey(k, "easingArgs");
  if (isArr(ea) && ea.items.length) key.easingArgs = ea.items.filter(isNum).map((x) => x.value);
  const bz = readBezier(k, interp === "bezier");
  if (bz) key.bezier = bz;
  return { channel, key };
}

const BEZIER_KEYS = ["bezier_linked", "bezier_left_time", "bezier_left_value", "bezier_right_time", "bezier_right_value"];
const trip = (n: JNode | undefined, d: readonly number[]): [number, number, number] => {
  const a = numsOf(n);
  return a && a.length >= 3 ? [a[0], a[1], a[2]] : [d[0], d[1], d[2]];
};
function readBezier(k: JObj, isBezier: boolean): BezierHandles | undefined {
  if (!isBezier && !BEZIER_KEYS.some((x) => getKey(k, x) !== undefined)) return undefined;
  const l = getKey(k, "bezier_linked");
  return {
    linked: l && l.t === "l" && typeof l.value === "boolean" ? l.value : DEFAULT_BEZIER.linked,
    leftTime: trip(getKey(k, "bezier_left_time"), DEFAULT_BEZIER.leftTime),
    leftValue: trip(getKey(k, "bezier_left_value"), DEFAULT_BEZIER.leftValue),
    rightTime: trip(getKey(k, "bezier_right_time"), DEFAULT_BEZIER.rightTime),
    rightValue: trip(getKey(k, "bezier_right_value"), DEFAULT_BEZIER.rightValue),
  };
}
const sameTrip = (n: JNode | undefined, v: readonly number[]) => {
  const a = numsOf(n);
  return !!a && a.length === 3 && a.every((x, i) => Math.abs(x - v[i]) < 1e-9);
};

/** Convert all animations to the shared `Animation` model (bones named after the animator). Keyframe `node`s are the bbmodel keyframe objects. */
export function bbToAnimations(m: BbModel): Animation[] {
  return m.animations.map((a) => {
    const bones = new Map<string, BoneAnim>();
    for (const an of a.animators) {
      const b: BoneAnim = { name: an.name, node: an.node };
      const kfs = getKey(an.node, "keyframes");
      const per: Record<string, Keyframe[]> = {};
      if (isArr(kfs)) {
        for (const k of kfs.items) {
          if (!isObj(k)) continue;
          const r = readBbKeyframe(k);
          if (r && (CHANNELS as readonly string[]).includes(r.channel)) (per[r.channel] ??= []).push(r.key);
        }
      }
      for (const ch of CHANNELS) if (per[ch]) b[ch] = { shape: "keys", keys: per[ch] };
      if (an.type === "bone" || b.rotation || b.position || b.scale) bones.set(an.name, b);
    }
    return { name: a.name, uuid: a.uuid, loop: bbLoop(a.loop), length: a.length, bones, node: a.node };
  });
}

/** Deterministic pseudo-uuid for new keyframes (commands must be pure). */
export function pseudoUuid(seed: string): string {
  let h1 = 0x811c9dc5, h2 = 0x1b873593;
  const hex: string[] = [];
  for (let r = 0; r < 4; r++) {
    for (let i = 0; i < seed.length; i++) {
      const c = seed.charCodeAt(i);
      h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
      h2 = (Math.imul(h2 ^ c, 0x5bd1e995) + h1) >>> 0;
    }
    hex.push(h1.toString(16).padStart(8, "0"), h2.toString(16).padStart(8, "0"));
    seed += "#";
  }
  const s = hex.join("");
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20, 32)}`;
}

function dpNode(v: Vec3, old: JNode | undefined, asString: boolean): JNode {
  const mk = (c: Comp, o: JNode | undefined): JNode => {
    if (typeof c === "string") return jstr(c);
    if (o && ((o.t === "n" && o.value === c) || (o.t === "s" && Number(o.value) === c && o.value.trim() !== ""))) return o;
    return asString ? jstr(fmtNum(c, 5)) : jnum(c, 5);
  };
  const ox = isObj(old) ? old : undefined;
  const ents: JEntry[] = [
    { key: "x", value: mk(v[0], getKey(ox, "x")) },
    { key: "y", value: mk(v[1], getKey(ox, "y")) },
    { key: "z", value: mk(v[2], getKey(ox, "z")) },
  ];
  if (ox && ents.every((e, i) => e.value === ox.entries[i]?.value && e.key === ox.entries[i]?.key) && ox.entries.length === 3) return ox;
  return ox ? derive(ox, ents) : jobj(ents);
}

const BZ_ORDER = ["interpolation", ...BEZIER_KEYS];
function writeBezier(o: JObj, b: BezierHandles): JObj {
  const put = (key: string, val: JNode) => {
    o = setEntry(o, key, val, (x) => x === "easing" || x === "easingArgs" || BZ_ORDER.indexOf(x) > BZ_ORDER.indexOf(key) && BZ_ORDER.indexOf(x) > 0);
  };
  const cur = getKey(o, "bezier_linked");
  if (!(cur && cur.t === "l" && cur.value === b.linked)) put("bezier_linked", jbool(b.linked));
  const vecs: Array<[string, readonly number[]]> = [
    ["bezier_left_time", b.leftTime], ["bezier_left_value", b.leftValue], ["bezier_right_time", b.rightTime], ["bezier_right_value", b.rightValue],
  ];
  for (const [key, v] of vecs) if (!sameTrip(getKey(o, key), v)) put(key, jarr(v.map((x) => jnum(x)), getKey(o, key)));
  return o;
}

/** Node for a bbmodel keyframe, patched from `k.node` when present. */
export function bbKeyToNode(k: Keyframe, channel: ChannelName, uuidSeed: string, like?: JNode): JObj {
  const old = k.node && isObj(k.node) ? k.node : undefined;
  const oldPts = old ? getKey(old, "data_points") : undefined;
  const oldItems = isArr(oldPts) ? oldPts.items : [];
  const str = oldItems.length ? isObj(oldItems[0]) && isStr(getKey(oldItems[0], "x")) : true;
  const hasPre = !!k.pre && !(k.pre[0] === k.value[0] && k.pre[1] === k.value[1] && k.pre[2] === k.value[2]);
  const pts: JNode[] = hasPre ? [dpNode(k.pre!, oldItems[0], str), dpNode(k.value, oldItems[1], str)] : [dpNode(k.value, oldItems[oldItems.length ? oldItems.length - 1 : 0], str)];
  const ptsNode = oldPts && isArr(oldPts) && pts.length === oldItems.length && pts.every((p, i) => p === oldItems[i]) ? oldPts : jarr(pts, oldPts ?? (like && isObj(like) ? getKey(like, "data_points") : undefined));
  const interp = k.lerp === "catmullrom" ? "catmullrom" : k.bb?.interpolation && k.bb.interpolation !== "catmullrom" ? k.bb.interpolation : k.easing === "step" ? "step" : "linear";
  const want: Array<[string, JNode | undefined]> = [
    ["channel", jstr(channel)],
    ["data_points", ptsNode],
    ["uuid", jstr(k.bb?.uuid ?? pseudoUuid(uuidSeed))],
    ["time", jnum(k.time, 4)],
    ["color", old ? undefined : jnum(-1)],
    ["interpolation", jstr(interp)],
  ];
  const easingOut = k.easing && k.easing !== "step" ? k.easing : undefined;
  if (old) {
    let o: JObj = old;
    for (const [key, val] of want) {
      if (!val) continue;
      const cur = getKey(o, key);
      if (key === "channel" || key === "uuid") { if (!cur) o = setEntry(o, key, val); continue; }
      if (key === "time" && cur && isNum(cur) && Math.abs(cur.value - k.time) < 1e-9) continue;
      if (key === "interpolation" && cur && isStr(cur) && cur.value === interp) continue;
      if (key === "data_points" && cur === val) continue;
      o = setEntry(o, key, val);
    }
    if (k.bezier) o = writeBezier(o, k.bezier);
    const curE = getKey(o, "easing");
    if (easingOut !== undefined) { if (!(isStr(curE) && curE.value === easingOut)) o = setEntry(o, "easing", jstr(easingOut)); }
    else if (curE && isStr(curE) && curE.value !== "linear" && curE.value !== "step") o = setEntry(o, "easing", jstr("linear"));
    const ea = k.easingArgs ?? [];
    const curA = getKey(o, "easingArgs");
    const curArr = isArr(curA) ? curA.items.filter(isNum).map((x) => x.value) : [];
    if (curArr.join() !== ea.join()) o = setEntry(o, "easingArgs", jarr(ea.map((x) => jnum(x)), curA));
    return o;
  }
  const ents: JEntry[] = [];
  for (const [key, val] of want) if (val) ents.push({ key, value: val });
  if (k.bezier) {
    const b = k.bezier;
    ents.push(
      { key: "bezier_linked", value: jbool(b.linked) },
      { key: "bezier_left_time", value: jarr(b.leftTime.map((x) => jnum(x))) },
      { key: "bezier_left_value", value: jarr(b.leftValue.map((x) => jnum(x))) },
      { key: "bezier_right_time", value: jarr(b.rightTime.map((x) => jnum(x))) },
      { key: "bezier_right_value", value: jarr(b.rightValue.map((x) => jnum(x))) },
    );
  }
  ents.push({ key: "easing", value: jstr(easingOut ?? "linear") }, { key: "easingArgs", value: jarr((k.easingArgs ?? []).map((x) => jnum(x))) });
  return jobj(ents, like);
}

export { toValue };
