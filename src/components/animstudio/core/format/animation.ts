/**
 * Typed view of `*.animation.json` (Bedrock 1.8.0 / GeckoLib / AzureLib).
 *
 * Reading never mutates; every `Animation`/`Channel`/`Keyframe` keeps the `JNode` it was read from so
 * that unchanged parts re-emit verbatim. Edits are done by building new Channels (see `writeChannel`).
 */
import {
  derive, fmtNum, fmtTime, getKey, isArr, isNum, isObj, isStr, jarr, jnum, jobj, jstr, numOf, setEntry,
  type JArr, type JEntry, type JNode, type JObj,
} from "./json";

/** A vector component: a number or a molang expression. */
export type Comp = number | string;
export type Vec3 = [Comp, Comp, Comp];
export type NumVec3 = [number, number, number];
export type ChannelName = "rotation" | "position" | "scale";
export const CHANNELS: readonly ChannelName[] = ["rotation", "position", "scale"];

export type LoopMode = boolean | "hold_on_last_frame" | undefined;

/** bbmodel bezier handles (offsets relative to the key, per axis x/y/z). */
export interface BezierHandles {
  linked: boolean;
  leftTime: NumVec3;
  leftValue: NumVec3;
  rightTime: NumVec3;
  rightValue: NumVec3;
}
export const DEFAULT_BEZIER: BezierHandles = { linked: true, leftTime: [-0.1, -0.1, -0.1], leftValue: [0, 0, 0], rightTime: [0.1, 0.1, 0.1], rightValue: [0, 0, 0] };

export interface Keyframe {
  time: number;
  /** Original key text ("0.0417") when read from a map; reused if still equal to `time`. */
  keyRaw?: string;
  /** Value at (and after) this time; molang strings allowed. */
  value: Vec3;
  /** Value just before this time (Bedrock `pre`); absent = same as `value`. */
  pre?: Vec3;
  /** Easing of the segment *ending* at this key (GeckoLib rule). Exact spelling as in the file. */
  easing?: string;
  easingArgs?: number[];
  /** Bedrock `lerp_mode` (`linear` | `catmullrom`); GeckoLib treats it as this key's easing. */
  lerp?: string;
  /** Original JSON node of the whole key value, reused when nothing changed. */
  node?: JNode;
  /** Original array nodes for value/pre (so edited siblings keep number formatting). */
  valueNode?: JNode;
  preNode?: JNode;
  /** bbmodel only: interpolation + raw bezier info and the animation-independent uuid. */
  bb?: { interpolation?: string; uuid?: string; extra?: Record<string, unknown> };
  /** bbmodel only: bezier handles (present when interpolation is "bezier" or any bezier_* field exists). */
  bezier?: BezierHandles;
}

export type ChannelShape = "keys" | "array" | "vector" | "scalar" | "opaque";
export interface Channel {
  shape: ChannelShape;
  keys: Keyframe[];
  /** Source node (for opaque channels this is all there is). */
  node?: JNode;
}

export interface BoneAnim {
  name: string;
  rotation?: Channel;
  position?: Channel;
  scale?: Channel;
  node?: JObj;
}

/** Which of Thematic's two readers plays this clip: the player/armor serializer ("player") or GeckoLib geo ("geo"). */
export type ClipSemantics = "player" | "geo";

export interface Animation {
  /** Semantics stamped by `getAnimations` from the Doc (undefined = geo). See playersample.ts. */
  semantics?: ClipSemantics;
  /** Key in the file (`animation.x.y` or bare). */
  name: string;
  loop: LoopMode;
  /** `animation_length` (seconds), if present. */
  length?: number;
  bones: Map<string, BoneAnim>;
  node?: JObj;
  /** bbmodel animations carry a uuid. */
  uuid?: string;
}

export interface AnimationFile {
  formatVersion?: string;
  /** Top-level keys other than `animations` and `format_version` (geckolib_format_version…), name→raw value. */
  extras: Record<string, unknown>;
  animations: Animation[];
}

// ---------------------------------------------------------------- reading

const EASING_WORDS = /^(linear|none|step|ease\w+|catmullrom)$/i;

function comp(n: JNode): Comp | undefined {
  if (n.t === "n") return n.value;
  if (n.t === "s") return n.value;
  return undefined;
}
export function readVec(n: JNode | undefined): Vec3 | undefined {
  if (!isArr(n) || n.items.length < 3) return undefined;
  const a = comp(n.items[0]);
  const b = comp(n.items[1]);
  const c = comp(n.items[2]);
  if (a === undefined || b === undefined || c === undefined) return undefined;
  return [a, b, c];
}
function isEasingStrings(n: JArr): boolean {
  return n.items.length > 0 && n.items.every((x) => isStr(x) && EASING_WORDS.test(x.value));
}

function readKeyValue(time: number, keyRaw: string | undefined, v: JNode): Keyframe | undefined {
  if (isArr(v)) {
    const vec = readVec(v);
    return vec ? { time, keyRaw, value: vec, node: v, valueNode: v } : undefined;
  }
  if (isNum(v)) return { time, keyRaw, value: [v.value, v.value, v.value], node: v };
  if (isObj(v)) {
    const vecN = getKey(v, "vector");
    const post = getKey(v, "post");
    const pre = getKey(v, "pre");
    const main = vecN ?? post ?? pre;
    const value = readVec(main);
    if (!value) return undefined;
    const k: Keyframe = { time, keyRaw, value, node: v, valueNode: main };
    if (vecN === undefined && post === undefined) {
      // only `pre`
      k.pre = value;
      k.preNode = pre;
    } else if (pre) {
      const pv = readVec(pre);
      if (pv) {
        k.pre = pv;
        k.preNode = pre;
      }
    }
    const e = getKey(v, "easing");
    if (isStr(e)) k.easing = e.value;
    const ea = getKey(v, "easingArgs");
    if (isArr(ea)) k.easingArgs = ea.items.filter(isNum).map((x) => x.value);
    const lm = getKey(v, "lerp_mode");
    if (isStr(lm)) k.lerp = lm.value;
    return k;
  }
  return undefined;
}

export function readChannel(n: JNode | undefined): Channel | undefined {
  if (!n) return undefined;
  if (isNum(n)) return { shape: "scalar", node: n, keys: [{ time: 0, value: [n.value, n.value, n.value], node: n }] };
  if (isArr(n)) {
    if (isEasingStrings(n)) return { shape: "opaque", node: n, keys: [] };
    const k = readKeyValue(0, undefined, n);
    return k ? { shape: "array", node: n, keys: [k] } : { shape: "opaque", node: n, keys: [] };
  }
  if (isObj(n)) {
    if (getKey(n, "vector") !== undefined) {
      const k = readKeyValue(0, undefined, n);
      return k ? { shape: "vector", node: n, keys: [k] } : { shape: "opaque", node: n, keys: [] };
    }
    const keys: Keyframe[] = [];
    for (const e of n.entries) {
      const t = parseFloat(e.key);
      const k = readKeyValue(Number.isFinite(t) ? t : 0, e.key, e.value);
      if (k) keys.push(k);
    }
    return { shape: "keys", node: n, keys };
  }
  return { shape: "opaque", node: n, keys: [] };
}

export function readBone(name: string, n: JNode): BoneAnim {
  const b: BoneAnim = { name, node: isObj(n) ? n : undefined };
  if (isObj(n)) {
    for (const ch of CHANNELS) {
      const c = readChannel(getKey(n, ch));
      if (c) b[ch] = c;
    }
  }
  return b;
}

export function readAnimation(name: string, n: JNode): Animation {
  const bones = new Map<string, BoneAnim>();
  let loop: LoopMode;
  let length: number | undefined;
  if (isObj(n)) {
    const l = getKey(n, "loop");
    if (l && l.t === "l" && typeof l.value === "boolean") loop = l.value;
    else if (isStr(l)) loop = l.value === "hold_on_last_frame" ? "hold_on_last_frame" : undefined;
    length = numOf(getKey(n, "animation_length"));
    const bs = getKey(n, "bones");
    if (isObj(bs)) for (const e of bs.entries) bones.set(e.key, readBone(e.key, e.value));
  }
  return { name, loop, length, bones, node: isObj(n) ? n : undefined };
}

export function readAnimationFile(root: JNode): AnimationFile {
  const out: AnimationFile = { extras: {}, animations: [] };
  if (!isObj(root)) return out;
  for (const e of root.entries) {
    if (e.key === "format_version" && isStr(e.value)) out.formatVersion = e.value.value;
    else if (e.key === "animations" && isObj(e.value)) {
      for (const a of e.value.entries) out.animations.push(readAnimation(a.key, a.value));
    } else if (e.value.t === "s" || e.value.t === "n") out.extras[e.key] = e.value.value;
  }
  return out;
}

/** Effective length: `animation_length`, else the last key time over every channel. */
export function animLength(a: Animation): number {
  if (a.length !== undefined && a.length > 0) return a.length;
  return lastKeyTime(a);
}
export function lastKeyTime(a: Animation): number {
  let m = 0;
  for (const b of a.bones.values()) for (const ch of CHANNELS) for (const k of b[ch]?.keys ?? []) if (k.time > m) m = k.time;
  return m;
}

export function sortedKeys(c: Channel): Keyframe[] {
  const ks = c.keys;
  for (let i = 1; i < ks.length; i++) if (ks[i].time < ks[i - 1].time) return ks.slice().sort((x, y) => x.time - y.time);
  return ks;
}

// ---------------------------------------------------------------- writing

export function vecNode(v: Vec3, like?: JNode, dp = 4): JArr {
  return jarr(v.map((c) => (typeof c === "number" ? jnum(c, dp) : jstr(c))), like);
}

const KEY_ORDER = ["pre", "post", "vector", "lerp_mode", "easing", "easingArgs"];

function sameVec(a: Vec3, b: Vec3 | undefined) {
  return !!b && a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
}
function sameKey(a: Keyframe, b: Keyframe) {
  return sameVec(a.value, b.value) && (a.pre ? sameVec(a.pre, b.pre) : !b.pre) && a.easing === b.easing && a.lerp === b.lerp && (a.easingArgs ?? []).join() === (b.easingArgs ?? []).join();
}

/**
 * Node for one keyframe value. Re-uses `k.node`'s object (patching only the entries that changed) when
 * it is an object; array-shaped keys stay arrays while they carry nothing but a value.
 */
export function keyToNode(k: Keyframe, like?: JNode, dp = 4): JNode {
  if (k.node) {
    const r = readKeyValue(k.time, undefined, k.node);
    if (r && sameKey(r, k)) return k.node;
  }
  const hasPre = !!k.pre;
  const old = k.node && isObj(k.node) ? k.node : undefined;
  const needsObj = hasPre || !!k.lerp || !!k.easing || !!old;
  const arrLike = (x: JNode | undefined) => (x && isArr(x) ? x : undefined);
  const valN = (): JNode => k.valueNode && isArr(k.valueNode) && readVec(k.valueNode) && sameVec(k.value, readVec(k.valueNode)) ? k.valueNode : vecNode(k.value, arrLike(k.valueNode) ?? arrLike(like), dp);
  if (!needsObj) {
    if (k.node && isNum(k.node) && k.value[0] === k.value[1] && k.value[1] === k.value[2] && k.node.value === k.value[0]) return k.node;
    return valN();
  }
  const want = new Map<string, JNode | undefined>();
  const usePost = hasPre || !!k.lerp;
  want.set("vector", usePost ? undefined : valN());
  want.set("post", usePost ? valN() : undefined);
  want.set("pre", hasPre ? (k.preNode && isArr(k.preNode) && sameVec(k.pre!, readVec(k.preNode)) ? k.preNode : vecNode(k.pre!, arrLike(k.preNode) ?? arrLike(like), dp)) : undefined);
  want.set("lerp_mode", k.lerp ? jstr(k.lerp) : undefined);
  want.set("easing", k.easing && !k.lerp ? jstr(k.easing) : undefined);
  want.set("easingArgs", k.easingArgs && k.easingArgs.length && !k.lerp ? jarr(k.easingArgs.map((x) => jnum(x, dp)), old && getKey(old, "easingArgs")) : undefined);
  // unchanged values keep the old node object so the patch is a no-op for them
  if (old) {
    const entries: JEntry[] = [];
    const done = new Set<string>();
    for (const e of old.entries) {
      if (want.has(e.key)) {
        done.add(e.key);
        const w = want.get(e.key);
        if (w === undefined) continue;
        const ov = e.value;
        const keep = (ov.t === "s" && w.t === "s" && ov.value === w.value) || ov === w;
        entries.push({ key: e.key, keyRaw: e.keyRaw, value: keep ? ov : w });
      } else entries.push(e);
    }
    for (const key of KEY_ORDER) if (!done.has(key) && want.get(key) !== undefined) entries.push({ key, value: want.get(key)! });
    const sameEntries = entries.length === old.entries.length && entries.every((e, i) => e === old.entries[i] || (e.key === old.entries[i].key && e.value === old.entries[i].value));
    return sameEntries ? old : derive(old, entries);
  }
  const entries: JEntry[] = [];
  for (const key of KEY_ORDER) if (want.get(key) !== undefined) entries.push({ key, value: want.get(key)! });
  return jobj(entries, isObj(like) ? like : undefined);
}

function keyText(k: Keyframe): string {
  if (k.keyRaw !== undefined) {
    const t = parseFloat(k.keyRaw);
    if (Math.abs(t - k.time) < 1e-9) return k.keyRaw;
  }
  return fmtTime(k.time);
}

/** Build the JSON node for a channel (in the shape it was read in, upgrading it only when needed). */
export function writeChannel(c: Channel, like?: JNode, dp = 4): JNode | undefined {
  if (c.shape === "opaque") return c.node;
  if (c.keys.length === 0) return undefined;
  const oldLike = c.node ?? like;
  const ks = sortedKeys(c);
  const single = ks.length === 1 && ks[0].time === 0;
  if (single && c.shape !== "keys") {
    const k = ks[0];
    const plain = !k.pre && !k.lerp && !k.easing;
    if (c.shape === "scalar" && plain && k.value[0] === k.value[1] && k.value[1] === k.value[2] && typeof k.value[0] === "number") {
      return c.node && isNum(c.node) && c.node.value === k.value[0] ? c.node : jnum(k.value[0], dp);
    }
    if (c.shape === "array" || c.shape === "scalar") {
      if (plain) return keyToNode({ ...k, node: c.shape === "array" ? k.node : undefined }, oldLike, dp);
    }
    if (c.shape === "vector" && !k.pre && !k.lerp) return keyToNode(k, oldLike, dp);
  }
  const likeKey = c.node && isObj(c.node) && c.node.entries.length ? c.node.entries.find((e) => isObj(e.value))?.value ?? c.node.entries[0].value : undefined;
  const entries: JEntry[] = ks.map((k) => ({ key: keyText(k), value: keyToNode(k, likeKey ?? k.node, dp) }));
  // reuse the old map node if nothing differs
  if (c.node && isObj(c.node) && c.node.entries.length === entries.length && entries.every((e, i) => c.node && isObj(c.node) && c.node.entries[i].key === e.key && c.node.entries[i].value === e.value)) return c.node;
  return jobj(entries, isObj(c.node) ? c.node : like);
}

/** Replace/insert a bone's channel in its bone node (keeps unknown keys). */
export function setBoneChannel(bone: JObj | undefined, ch: ChannelName, node: JNode | undefined, like?: JNode): JObj | undefined {
  const base = bone ?? jobj([], like);
  const order = ["rotation", "position", "scale"];
  const out = setEntry(base, ch, node, (k) => order.indexOf(k) > order.indexOf(ch));
  if (out.entries.length === 0) return undefined;
  return out;
}

export { fmtNum, fmtTime };
export { isNum };
