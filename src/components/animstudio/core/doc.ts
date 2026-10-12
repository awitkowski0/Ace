/**
 * Editing model. A `Doc` is an immutable parse of one file; every command is a pure function
 * `(doc, args) => newDoc` that shares all untouched JSON nodes with the input. `serialize(doc)` re-emits
 * the file: untouched subtrees are copied verbatim from the original text, edited containers are laid out
 * in the style of the container they replace (see format/json.ts).
 *
 * Time arguments are seconds; keyframes are matched by time within `TIME_EPS`.
 */
import {
  CHANNELS, animLength, readAnimationFile, readChannel, sortedKeys, writeChannel, setBoneChannel,
  type Animation, type ClipSemantics, type Channel, type ChannelName, type Keyframe, type LoopMode, type NumVec3, type Vec3,
} from "./format/animation";
import {
  allGroups, bbKeyToNode, bbLoopFromMode, bbToAnimations, groupByName, pseudoUuid, readBbKeyframe, readBbModel, type BbModel,
} from "./format/bbmodel";
import {
  FACES, readGeoFile, descendants, findBone, isAncestor, type CubeUv, type GeoFile, type Geometry,
} from "./format/geo";
import {
  derive, detectStyle, fmtTime, getIn, getKey, isArr, isObj, jarr, jbool, jnum, jobj, jstr, parseJson, serializeParsed, setEntry, setIn,
  type FileStyle, type JArr, type JEntry, type JNode, type JObj,
} from "./format/json";
import { REST, sampleChannelRaw } from "./sample";
import { stampSemantics } from "./playersample";
import type { Pose } from "./sample";

export type DocKind = "geo" | "animation" | "bbmodel";
export const TIME_EPS = 0.0005;

export interface Doc {
  kind: DocKind;
  /** Text this doc was parsed from (untouched subtrees point into it). */
  text: string;
  root: JNode;
  start: number;
  end: number;
  style: FileStyle;
  /** Which reader's rules sample this file's clips (default "geo"); see playersample.ts / `clipSemantics(path)`. */
  semantics?: ClipSemantics;
}

export function docKindForPath(path: string): DocKind | undefined {
  const p = path.toLowerCase();
  if (p.endsWith(".geo.json")) return "geo";
  if (p.endsWith(".animation.json")) return "animation";
  if (p.endsWith(".bbmodel")) return "bbmodel";
  return undefined;
}

export function parseDoc(text: string, kind: DocKind, semantics?: ClipSemantics): Doc {
  const p = parseJson(text);
  const doc: Doc = { kind, text, root: p.root, start: p.start, end: p.end, style: detectStyle(text, p.start, p.end) };
  if (semantics && semantics !== "geo") doc.semantics = semantics;
  return doc;
}

/** Text of the document including all edits. A doc with no edits returns its original text exactly. */
export function serialize(doc: Doc): string {
  return serializeParsed(doc.root, doc.style, doc.text, doc.start, doc.end);
}

/** Smallest single replacement turning `a` into `b` (for Monaco `pushEditOperations`). */
export function minimalEdit(a: string, b: string): { start: number; end: number; text: string } {
  let s = 0;
  const m = Math.min(a.length, b.length);
  while (s < m && a.charCodeAt(s) === b.charCodeAt(s)) s++;
  let ea = a.length;
  let eb = b.length;
  while (ea > s && eb > s && a.charCodeAt(ea - 1) === b.charCodeAt(eb - 1)) {
    ea--;
    eb--;
  }
  return { start: s, end: ea, text: b.slice(s, eb) };
}

export const withRoot = (doc: Doc, root: JNode): Doc => (root === doc.root ? doc : { ...doc, root });

// ---------------------------------------------------------------- typed views (memoised per root node)

const memo = new WeakMap<JNode, { anims?: Animation[]; animsSem?: ClipSemantics; geo?: GeoFile; bb?: BbModel }>();
const slot = (doc: Doc) => {
  let m = memo.get(doc.root);
  if (!m) memo.set(doc.root, (m = {}));
  return m;
};
export function getBb(doc: Doc): BbModel {
  const m = slot(doc);
  return (m.bb ??= readBbModel(doc.root));
}
export function getGeo(doc: Doc): GeoFile {
  const m = slot(doc);
  return (m.geo ??= readGeoFile(doc.root));
}
/** Animations of an animation file or bbmodel, in file order. */
export function getAnimations(doc: Doc): Animation[] {
  const m = slot(doc);
  const sem: ClipSemantics = doc.semantics ?? "geo";
  if (!m.anims || m.animsSem !== sem) {
    m.anims = doc.kind === "bbmodel" ? bbToAnimations(getBb(doc)) : doc.kind === "animation" ? readAnimationFile(doc.root).animations : [];
    if (doc.kind === "animation") stampSemantics(m.anims, sem);
    m.animsSem = sem;
  }
  return m.anims;
}
export function getAnimation(doc: Doc, name: string): Animation | undefined {
  return getAnimations(doc).find((a) => a.name === name);
}
function mustAnim(doc: Doc, name: string): Animation {
  const a = getAnimation(doc, name);
  if (!a) throw new Error(`No animation "${name}"`);
  return a;
}

// ---------------------------------------------------------------- references

export interface KeyRef {
  bone: string;
  channel: ChannelName;
  time: number;
}
const same = (a: number, b: number) => Math.abs(a - b) < TIME_EPS;
const r4 = (t: number) => Math.round(t * 10000) / 10000;

export function findKey(a: Animation, ref: KeyRef): Keyframe | undefined {
  return a.bones.get(ref.bone)?.[ref.channel]?.keys.find((k) => same(k.time, ref.time));
}

// ---------------------------------------------------------------- channel plumbing

function likeMapIn(a: JObj | undefined): JNode | undefined {
  const bones = getKey(a, "bones");
  if (!isObj(bones)) return undefined;
  for (const b of bones.entries) {
    if (!isObj(b.value)) continue;
    for (const c of b.value.entries) if (isObj(c.value) && c.value.entries.length > 1) return c.value;
  }
  return undefined;
}

type ChannelFn = (cur: Channel | undefined, bone: string) => Channel | undefined;

function editChannel(doc: Doc, animName: string, bone: string, ch: ChannelName, fn: ChannelFn): Doc {
  if (doc.kind === "bbmodel") return bbEditChannel(doc, animName, bone, ch, fn);
  if (doc.kind !== "animation") throw new Error("not an animation document");
  const animN = getIn(doc.root, ["animations", animName]);
  if (!isObj(animN)) throw new Error(`No animation "${animName}"`);
  const bonesN = getKey(animN, "bones");
  const boneN = isObj(bonesN) ? getKey(bonesN, bone) : undefined;
  const chN = isObj(boneN) ? getKey(boneN, ch) : undefined;
  const cur = readChannel(chN);
  const next = fn(cur, bone);
  if (next === cur) return doc;
  const node = next ? writeChannel(next, likeMapIn(animN)) : undefined;
  const likeBone = isObj(bonesN) && bonesN.entries.length ? bonesN.entries[0].value : undefined;
  const newBone = setBoneChannel(isObj(boneN) ? boneN : undefined, ch, node, likeBone);
  return withRoot(doc, setIn(doc.root, ["animations", animName, "bones", bone], newBone));
}

function bbEditChannel(doc: Doc, animName: string, bone: string, ch: ChannelName, fn: ChannelFn): Doc {
  const model = getBb(doc);
  const a = model.animations.find((x) => x.name === animName);
  if (!a) throw new Error(`No animation "${animName}"`);
  let animator = a.animators.find((x) => x.name === bone);
  const kfsN = animator ? getKey(animator.node, "keyframes") : undefined;
  const oldNodes: JNode[] = isArr(kfsN) ? kfsN.items : [];
  const curKeys: Keyframe[] = [];
  oldNodes.forEach((n) => {
    if (!isObj(n)) return;
    const r = readBbKeyframe(n);
    if (r && r.channel === ch) curKeys.push(r.key);
  });
  const cur: Channel | undefined = curKeys.length ? { shape: "keys", keys: curKeys } : undefined;
  const next = fn(cur, bone);
  if (next === cur) return doc;
  const likeKf = oldNodes.find(isObj);
  const nextNodes = (next ? sortedKeys(next) : []).map((k, i) => bbKeyToNode(k, ch, `${animName}/${bone}/${ch}/${fmtTime(k.time)}/${i}`, likeKf));
  const out: JNode[] = [];
  let placed = false;
  for (const n of oldNodes) {
    if (isObj(n) && getKey(n, "channel") && (getKey(n, "channel") as { value?: string }).value === ch) {
      if (!placed) {
        out.push(...nextNodes);
        placed = true;
      }
    } else out.push(n);
  }
  if (!placed) out.push(...nextNodes);
  const base = ["animations", a.index, "animators"];
  if (animator) {
    return withRoot(doc, setIn(doc.root, [...base, animator.key, "keyframes"], jarr(out, kfsN)));
  }
  const g = groupByName(model, bone);
  const key = g?.uuid ?? pseudoUuid(`${animName}/${bone}`);
  const anim = jobj([["name", jstr(bone)], ["type", jstr("bone")], ["keyframes", jarr(out)]]);
  return withRoot(doc, setIn(doc.root, [...base, key], anim));
}

/** Apply `fn` to several (bone, channel) pairs in one animation. */
function editChannels(doc: Doc, anim: string, targets: Array<{ bone: string; channel: ChannelName; fn: ChannelFn }>): Doc {
  return targets.reduce((d, t) => editChannel(d, anim, t.bone, t.channel, t.fn), doc);
}

function groupRefs(keys: KeyRef[]): Map<string, { bone: string; channel: ChannelName; times: number[] }> {
  const m = new Map<string, { bone: string; channel: ChannelName; times: number[] }>();
  for (const k of keys) {
    const id = k.bone + "\u0000" + k.channel;
    const g = m.get(id) ?? { bone: k.bone, channel: k.channel, times: [] };
    g.times.push(k.time);
    m.set(id, g);
  }
  return m;
}
const hasTime = (times: number[], t: number) => times.some((x) => same(x, t));

function mkChannel(cur: Channel | undefined, keys: Keyframe[]): Channel | undefined {
  if (keys.length === 0) return undefined;
  const base: Channel = cur ?? { shape: "keys", keys: [] };
  const shape = keys.length > 1 || (keys.length === 1 && keys[0].time !== 0) ? "keys" : base.shape;
  return { ...base, shape, keys };
}

// ---------------------------------------------------------------- keyframe commands

export interface AddKeyframeArgs {
  anim: string;
  bone: string;
  channel: ChannelName;
  time: number;
  /** Default: the animation's sampled value at `time` (or rest pose). */
  value?: Vec3;
  pre?: Vec3;
  easing?: string;
  easingArgs?: number[];
  lerp?: string;
}
/** Insert a key (replacing any key at the same time, keeping its extras unless overridden). */
export function addKeyframe(doc: Doc, a: AddKeyframeArgs): Doc {
  const time = r4(a.time);
  return editChannel(doc, a.anim, a.bone, a.channel, (cur) => {
    const keys = cur ? cur.keys.filter((k) => !same(k.time, time)) : [];
    const old = cur?.keys.find((k) => same(k.time, time));
    const sampled = a.value ?? old?.value ?? (cur ? sampleChannelRaw(cur, time, { anim_time: time }) : undefined) ?? (REST[a.channel] as Vec3);
    const k: Keyframe = {
      ...(old ?? {}),
      time,
      value: [...sampled] as Vec3,
      pre: a.pre ?? old?.pre,
      easing: a.easing ?? old?.easing,
      easingArgs: a.easingArgs ?? old?.easingArgs,
      lerp: a.lerp ?? old?.lerp,
    };
    if (!old) delete k.keyRaw;
    else if (!same(old.time, time)) delete k.keyRaw;
    return mkChannel(cur, [...keys, k]);
  });
}

/** Insert many keys at once (clipboard paste). Items replace keys at identical times. */
export function insertKeys(doc: Doc, anim: string, items: Array<{ bone: string; channel: ChannelName; key: Keyframe }>): Doc {
  const groups = new Map<string, { bone: string; channel: ChannelName; keys: Keyframe[] }>();
  for (const it of items) {
    const id = it.bone + "\u0000" + it.channel;
    const g = groups.get(id) ?? { bone: it.bone, channel: it.channel, keys: [] };
    g.keys.push(it.key);
    groups.set(id, g);
  }
  return editChannels(doc, anim, [...groups.values()].map((g) => ({
    bone: g.bone,
    channel: g.channel,
    fn: (cur) => {
      const incoming = g.keys.map((k) => ({ ...k, time: r4(k.time), keyRaw: undefined, node: undefined, valueNode: undefined, preNode: undefined, bb: undefined }));
      const keep = (cur?.keys ?? []).filter((k) => !incoming.some((n) => same(n.time, k.time)));
      return mkChannel(cur, [...keep, ...incoming]);
    },
  })));
}

export function deleteKeyframes(doc: Doc, args: { anim: string; keys: KeyRef[] }): Doc {
  return editChannels(doc, args.anim, [...groupRefs(args.keys).values()].map((g) => ({
    bone: g.bone,
    channel: g.channel,
    fn: (cur) => (cur ? mkChannel(cur, cur.keys.filter((k) => !hasTime(g.times, k.time))) : cur),
  })));
}

/** Shift keys by `delta` seconds. `anchor` = Thematic anchor mode: moving any key of a bone+channel shifts all of them. */
export function moveKeyframes(doc: Doc, args: { anim: string; keys: KeyRef[]; delta: number; anchor?: boolean }): Doc {
  return editChannels(doc, args.anim, [...groupRefs(args.keys).values()].map((g) => ({
    bone: g.bone,
    channel: g.channel,
    fn: (cur) => {
      if (!cur) return cur;
      const moving = (k: Keyframe) => args.anchor || hasTime(g.times, k.time);
      const moved = cur.keys.filter(moving).map((k) => {
        const time = Math.max(0, r4(k.time + args.delta));
        return same(time, k.time) ? k : { ...k, time, keyRaw: undefined };
      });
      const rest = cur.keys.filter((k) => !moving(k) && !moved.some((m) => same(m.time, k.time)));
      return mkChannel(cur, [...rest, ...moved]);
    },
  })));
}

/** Move one key to an absolute time. */
export function retimeKeyframe(doc: Doc, args: { anim: string; bone: string; channel: ChannelName; time: number; newTime: number }): Doc {
  return moveKeyframes(doc, { anim: args.anim, keys: [args], delta: args.newTime - args.time });
}

export type KeyPatch = Partial<Pick<Keyframe, "value" | "pre" | "easing" | "easingArgs" | "lerp">> & { clearPre?: boolean };
/** Patch properties of existing keys. Setting `easing` clears `lerp` and vice versa. */
export function patchKeyframes(doc: Doc, args: { anim: string; keys: KeyRef[]; patch: KeyPatch }): Doc {
  return editChannels(doc, args.anim, [...groupRefs(args.keys).values()].map((g) => ({
    bone: g.bone,
    channel: g.channel,
    fn: (cur) => {
      if (!cur) return cur;
      let changed = false;
      const keys = cur.keys.map((k) => {
        if (!hasTime(g.times, k.time)) return k;
        changed = true;
        const n: Keyframe = { ...k };
        const p = args.patch;
        if (p.value) n.value = p.value;
        if (p.pre) n.pre = p.pre;
        if (p.clearPre) n.pre = undefined;
        if ("easing" in p) {
          n.easing = p.easing === "linear" ? undefined : p.easing;
          if (p.easing !== undefined) n.lerp = undefined;
          if (p.easing === undefined || p.easing === "linear") n.easingArgs = undefined;
        }
        if ("easingArgs" in p) n.easingArgs = p.easingArgs && p.easingArgs.length ? p.easingArgs : undefined;
        if ("lerp" in p) {
          n.lerp = p.lerp;
          if (p.lerp !== undefined) {
            n.easing = undefined;
            n.easingArgs = undefined;
          }
        }
        return n;
      });
      return changed ? mkChannel(cur, keys) : cur;
    },
  })));
}
export const setKeyValue = (doc: Doc, a: { anim: string; bone: string; channel: ChannelName; time: number; value: Vec3 }) =>
  patchKeyframes(doc, { anim: a.anim, keys: [a], patch: { value: a.value } });
export const setKeyEasing = (doc: Doc, a: { anim: string; bone: string; channel: ChannelName; time: number; easing?: string; easingArgs?: number[] }) =>
  patchKeyframes(doc, { anim: a.anim, keys: [a], patch: { easing: a.easing, easingArgs: a.easingArgs } });
export const setKeyLerp = (doc: Doc, a: { anim: string; bone: string; channel: ChannelName; time: number; lerp?: "linear" | "catmullrom" }) =>
  patchKeyframes(doc, { anim: a.anim, keys: [a], patch: { lerp: a.lerp } });
/** Split a key into pre/post values (`pre` undefined removes the split). */
export const setKeyPrePost = (doc: Doc, a: { anim: string; bone: string; channel: ChannelName; time: number; pre?: Vec3; post?: Vec3 }) =>
  patchKeyframes(doc, { anim: a.anim, keys: [a], patch: { pre: a.pre, clearPre: !a.pre, value: a.post } });

/** Round every key time (and the animation length) to the tick grid. Used by the "Snap keys to ticks" quick-fix. */
export function snapKeysToTicks(doc: Doc, args: { anim: string; ticksPerSecond?: number; keys?: KeyRef[] }): Doc {
  const tps = args.ticksPerSecond ?? 20;
  const snap = (t: number) => r4(Math.round(t * tps) / tps);
  const a = mustAnim(doc, args.anim);
  const targets: Array<{ bone: string; channel: ChannelName; fn: ChannelFn }> = [];
  for (const [bone, b] of a.bones) {
    for (const ch of CHANNELS) {
      const c = b[ch];
      if (!c) continue;
      const sel = args.keys ? groupRefs(args.keys).get(bone + "\u0000" + ch) : undefined;
      if (args.keys && !sel) continue;
      if (!c.keys.some((k) => (!sel || hasTime(sel.times, k.time)) && Math.abs(snap(k.time) - k.time) > 1e-9)) continue;
      targets.push({
        bone, channel: ch,
        fn: (cur) => {
          if (!cur) return cur;
          const map = new Map<number, Keyframe>();
          for (const k of cur.keys) {
            const t = !sel || hasTime(sel.times, k.time) ? snap(k.time) : k.time;
            map.set(t, t === k.time ? k : { ...k, time: t, keyRaw: undefined });
          }
          return mkChannel(cur, [...map.values()]);
        },
      });
    }
  }
  let out = editChannels(doc, args.anim, targets);
  if (a.length !== undefined && Math.abs(snap(a.length) - a.length) > 1e-9) out = setLength(out, { anim: args.anim, length: snap(a.length) });
  return out;
}

/** Insert the keys of a Pose (e.g. a breakdown) at `time`. */
export function insertPoseKeys(doc: Doc, args: { anim: string; time: number; pose: Pose; easing?: string }): Doc {
  const items: Array<{ bone: string; channel: ChannelName; key: Keyframe }> = [];
  for (const [bone, p] of Object.entries(args.pose)) {
    for (const ch of CHANNELS) {
      const v = p[ch];
      if (v) items.push({ bone, channel: ch, key: { time: args.time, value: [...v] as Vec3, easing: args.easing } });
    }
  }
  // keep existing extras (easing) of keys being replaced
  const a = getAnimation(doc, args.anim);
  const merged = items.map((it) => {
    const old = a?.bones.get(it.bone)?.[it.channel]?.keys.find((k) => same(k.time, args.time));
    return old ? { ...it, key: { ...old, value: it.key.value, pre: undefined, ...(args.easing ? { easing: args.easing } : {}) } } : it;
  });
  return insertKeys(doc, args.anim, merged);
}

// ---------------------------------------------------------------- animation commands

function animationsNode(doc: Doc): JObj {
  const n = getKey(doc.root as JObj, "animations");
  if (!isObj(n)) throw new Error("no animations object");
  return n;
}

export function addAnimation(doc: Doc, args: { name: string; length?: number; loop?: LoopMode; like?: string }): Doc {
  if (getAnimation(doc, args.name)) throw new Error(`Animation "${args.name}" exists`);
  const length = args.length ?? 1;
  if (doc.kind === "bbmodel") {
    const arr = getKey(doc.root as JObj, "animations");
    const likeA = isArr(arr) ? arr.items[arr.items.length - 1] : undefined;
    const node = jobj([
      ["uuid", jstr(pseudoUuid("anim/" + args.name + "/" + (isArr(arr) ? arr.items.length : 0)))],
      ["name", jstr(args.name)],
      ["loop", jstr(bbLoopFromMode(args.loop))],
      ["override", jbool(false)],
      ["length", jnum(length)],
      ["snapping", jnum(20)],
      ["animators", jobj([])],
    ], likeA);
    return withRoot(doc, setIn(doc.root, ["animations"], jarr([...(isArr(arr) ? arr.items : []), node], arr)));
  }
  const anims = animationsNode(doc);
  const likeEntry = anims.entries[anims.entries.length - 1]?.value;
  const entries: JEntry[] = [];
  if (args.loop !== undefined) entries.push({ key: "loop", value: typeof args.loop === "boolean" ? jbool(args.loop) : jstr(args.loop) });
  entries.push({ key: "animation_length", value: jnum(length) }, { key: "bones", value: jobj([], isObj(likeEntry) ? getKey(likeEntry, "bones") : undefined) });
  const node = jobj(entries, likeEntry);
  return withRoot(doc, setIn(doc.root, ["animations"], setEntry(anims, args.name, node)));
}

export function renameAnimation(doc: Doc, args: { name: string; newName: string }): Doc {
  if (args.name === args.newName) return doc;
  if (getAnimation(doc, args.newName)) throw new Error(`Animation "${args.newName}" exists`);
  mustAnim(doc, args.name);
  if (doc.kind === "bbmodel") return withRoot(doc, setIn(doc.root, ["animations", bbIndex(doc, args.name), "name"], jstr(args.newName)));
  const anims = animationsNode(doc);
  return withRoot(doc, setIn(doc.root, ["animations"], derive(anims, anims.entries.map((e) => (e.key === args.name ? { key: args.newName, value: e.value } : e)))));
}
function bbIndex(doc: Doc, name: string): number {
  const i = getBb(doc).animations.find((a) => a.name === name)?.index;
  if (i === undefined) throw new Error(`No animation "${name}"`);
  return i;
}

export function deleteAnimation(doc: Doc, args: { name: string }): Doc {
  mustAnim(doc, args.name);
  if (doc.kind === "bbmodel") return withRoot(doc, setIn(doc.root, ["animations", bbIndex(doc, args.name)], undefined));
  return withRoot(doc, setIn(doc.root, ["animations", args.name], undefined));
}

/** Copy an animation right after the original. */
export function duplicateAnimation(doc: Doc, args: { name: string; newName: string }): Doc {
  if (getAnimation(doc, args.newName)) throw new Error(`Animation "${args.newName}" exists`);
  mustAnim(doc, args.name);
  if (doc.kind === "bbmodel") {
    const i = bbIndex(doc, args.name);
    const arr = getKey(doc.root as JObj, "animations") as JArr;
    let copy = arr.items[i] as JObj;
    copy = setEntry(copy, "name", jstr(args.newName));
    copy = setEntry(copy, "uuid", jstr(pseudoUuid("dup/" + args.newName + "/" + arr.items.length)));
    const items = arr.items.slice();
    items.splice(i + 1, 0, copy);
    return withRoot(doc, setIn(doc.root, ["animations"], derive(arr, items)));
  }
  const anims = animationsNode(doc);
  const entries: JEntry[] = [];
  for (const e of anims.entries) {
    entries.push(e);
    if (e.key === args.name) entries.push({ key: args.newName, value: e.value });
  }
  return withRoot(doc, setIn(doc.root, ["animations"], derive(anims, entries)));
}

export function setLoop(doc: Doc, args: { anim: string; loop: LoopMode }): Doc {
  mustAnim(doc, args.anim);
  if (doc.kind === "bbmodel") return withRoot(doc, setIn(doc.root, ["animations", bbIndex(doc, args.anim), "loop"], jstr(bbLoopFromMode(args.loop))));
  const animN = getIn(doc.root, ["animations", args.anim]) as JObj;
  const v = args.loop === undefined ? undefined : typeof args.loop === "boolean" ? jbool(args.loop) : jstr(args.loop);
  const cur = getKey(animN, "loop");
  if (cur && v && cur.t === v.t && cur.value === v.value) return doc;
  return withRoot(doc, setIn(doc.root, ["animations", args.anim], setEntry(animN, "loop", v, (k) => k === "animation_length" || k === "bones")));
}

export function setLength(doc: Doc, args: { anim: string; length: number }): Doc {
  mustAnim(doc, args.anim);
  const len = jnum(args.length);
  if (doc.kind === "bbmodel") return withRoot(doc, setIn(doc.root, ["animations", bbIndex(doc, args.anim), "length"], len));
  const animN = getIn(doc.root, ["animations", args.anim]) as JObj;
  const cur = getKey(animN, "animation_length");
  if (cur && cur.t === "n" && Math.abs(cur.value - args.length) < 1e-9) return doc;
  return withRoot(doc, setIn(doc.root, ["animations", args.anim], setEntry(animN, "animation_length", len, (k) => k === "bones")));
}

/** Rename a bone's channels inside one animation (or all animations when `anim` is omitted). */
export function renameAnimBone(doc: Doc, args: { anim?: string; from: string; to: string }): Doc {
  if (doc.kind === "bbmodel") return doc;
  let out = doc;
  for (const a of getAnimations(doc)) {
    if (args.anim && a.name !== args.anim) continue;
    if (!a.bones.has(args.from)) continue;
    const bones = getIn(out.root, ["animations", a.name, "bones"]) as JObj;
    out = withRoot(out, setIn(out.root, ["animations", a.name, "bones"], derive(bones, bones.entries.map((e) => (e.key === args.from ? { key: args.to, value: e.value } : e)))));
  }
  return out;
}

export function deleteAnimBone(doc: Doc, args: { anim: string; bone: string }): Doc {
  if (doc.kind === "bbmodel") return doc;
  return withRoot(doc, setIn(doc.root, ["animations", args.anim, "bones", args.bone], undefined));
}

// ---------------------------------------------------------------- geometry commands

function geoPath(doc: Doc, gi: number | undefined): { g: Geometry; path: Array<string | number> } {
  if (doc.kind !== "geo") throw new Error("not a geometry document");
  const geo = getGeo(doc);
  const g = geo.geometries[gi ?? 0];
  if (!g) throw new Error("no geometry");
  return { g, path: ["minecraft:geometry", g.index] };
}
const vec = (v: readonly number[], like?: JNode, dp = 5): JArr => jarr(v.map((x) => jnum(x, dp)), like);

const BONE_ORDER = ["name", "parent", "pivot", "rotation", "mirror", "inflate", "cubes"];
const CUBE_ORDER = ["origin", "size", "pivot", "rotation", "inflate", "mirror", "uv"];
function setCanon(o: JObj, order: string[], key: string, v: JNode | undefined): JObj {
  return setEntry(o, key, v, (k) => order.indexOf(k) > order.indexOf(key) && order.includes(k));
}

export function addBone(doc: Doc, a: { name: string; parent?: string; pivot?: NumVec3; rotation?: NumVec3; geometry?: number }): Doc {
  const { g, path } = geoPath(doc, a.geometry);
  if (findBone(g, a.name)) throw new Error(`Bone "${a.name}" exists`);
  if (a.parent && !findBone(g, a.parent)) throw new Error(`No parent bone "${a.parent}"`);
  const barr = getKey(g.node, "bones") as JArr | undefined;
  const items = barr && isArr(barr) ? barr.items : [];
  const likeB = items[items.length - 1];
  const parentPivot = a.parent ? findBone(g, a.parent)?.pivot : undefined;
  let n: JObj = jobj([["name", jstr(a.name)]], likeB);
  if (a.parent) n = setCanon(n, BONE_ORDER, "parent", jstr(a.parent));
  n = setCanon(n, BONE_ORDER, "pivot", vec(a.pivot ?? parentPivot ?? [0, 0, 0], isObj(likeB) ? getKey(likeB, "pivot") : undefined));
  if (a.rotation) n = setCanon(n, BONE_ORDER, "rotation", vec(a.rotation));
  return withRoot(doc, setIn(doc.root, [...path, "bones"], jarr([...items, n], barr)));
}

export function deleteBone(doc: Doc, a: { name: string; cascade?: boolean; geometry?: number }): Doc {
  const { g, path } = geoPath(doc, a.geometry);
  const b = findBone(g, a.name);
  if (!b) throw new Error(`No bone "${a.name}"`);
  const barr = getKey(g.node, "bones") as JArr;
  const dead = new Set([a.name, ...(a.cascade ? descendants(g, a.name).map((x) => x.name) : [])]);
  const items: JNode[] = [];
  g.bones.forEach((bone, i) => {
    if (dead.has(bone.name)) return;
    let n = barr.items[i] as JObj;
    if (bone.parent === a.name) n = setEntry(n, "parent", b.parent ? jstr(b.parent) : undefined);
    items.push(n);
  });
  return withRoot(doc, setIn(doc.root, [...path, "bones"], derive(barr, items)));
}

export function renameBone(doc: Doc, a: { from: string; to: string; geometry?: number }): Doc {
  const { g, path } = geoPath(doc, a.geometry);
  if (a.from === a.to) return doc;
  if (!findBone(g, a.from)) throw new Error(`No bone "${a.from}"`);
  if (findBone(g, a.to)) throw new Error(`Bone "${a.to}" exists`);
  const barr = getKey(g.node, "bones") as JArr;
  const items = g.bones.map((b, i) => {
    let n = barr.items[i] as JObj;
    if (b.name === a.from) n = setEntry(n, "name", jstr(a.to));
    if (b.parent === a.from) n = setEntry(n, "parent", jstr(a.to));
    return n;
  });
  return withRoot(doc, setIn(doc.root, [...path, "bones"], derive(barr, items)));
}

/** Change a bone's parent (`null`/undefined = top level). Pivots are absolute in Bedrock so nothing else moves. */
export function reparentBone(doc: Doc, a: { name: string; parent?: string | null; geometry?: number }): Doc {
  const { g, path } = geoPath(doc, a.geometry);
  const b = findBone(g, a.name);
  if (!b) throw new Error(`No bone "${a.name}"`);
  if (a.parent) {
    if (!findBone(g, a.parent)) throw new Error(`No parent bone "${a.parent}"`);
    if (isAncestor(g, a.name, a.parent)) throw new Error("Cannot parent a bone under itself or its descendant");
  }
  if ((b.parent ?? null) === (a.parent ?? null)) return doc;
  const n = setCanon(b.node, BONE_ORDER, "parent", a.parent ? jstr(a.parent) : undefined);
  return withRoot(doc, setIn(doc.root, [...path, "bones", b.index], n));
}

export interface BonePatch {
  pivot?: NumVec3;
  /** `null` removes the key. */
  rotation?: NumVec3 | null;
  inflate?: number | null;
  mirror?: boolean | null;
}
export function setBone(doc: Doc, a: { bone: string; patch: BonePatch; geometry?: number }): Doc {
  const { g, path } = geoPath(doc, a.geometry);
  const b = findBone(g, a.bone);
  if (!b) throw new Error(`No bone "${a.bone}"`);
  let n = b.node;
  const p = a.patch;
  if (p.pivot) n = setCanon(n, BONE_ORDER, "pivot", sameNums(getKey(n, "pivot"), p.pivot) ? getKey(n, "pivot") : vec(p.pivot, getKey(n, "pivot")));
  if (p.rotation !== undefined) n = setCanon(n, BONE_ORDER, "rotation", p.rotation === null ? undefined : sameNums(getKey(n, "rotation"), p.rotation) ? getKey(n, "rotation") : vec(p.rotation, getKey(n, "rotation") ?? getKey(n, "pivot")));
  if (p.inflate !== undefined) n = setCanon(n, BONE_ORDER, "inflate", p.inflate === null ? undefined : jnum(p.inflate));
  if (p.mirror !== undefined) n = setCanon(n, BONE_ORDER, "mirror", p.mirror === null ? undefined : jbool(p.mirror));
  return withRoot(doc, setIn(doc.root, [...path, "bones", b.index], n));
}
function sameNums(n: JNode | undefined, v: readonly number[]): boolean {
  return isArr(n) && n.items.length === v.length && n.items.every((x, i) => x.t === "n" && x.value === v[i]);
}

export interface CubeSpec {
  origin: NumVec3;
  size: NumVec3;
  pivot?: NumVec3;
  rotation?: NumVec3;
  inflate?: number;
  mirror?: boolean;
  uv?: CubeUv;
}
export interface CubePatch {
  origin?: NumVec3;
  size?: NumVec3;
  pivot?: NumVec3 | null;
  rotation?: NumVec3 | null;
  inflate?: number | null;
  mirror?: boolean | null;
  uv?: CubeUv | null;
}

function uvNode(uv: NonNullable<CubeUv>, old?: JNode, likeCubeUv?: JNode): JNode {
  if (uv.kind === "box") return sameNums(old, uv.uv) ? old! : vec(uv.uv, old ?? likeCubeUv, 4);
  const oldO = isObj(old) ? old : undefined;
  const likeO = isObj(likeCubeUv) ? likeCubeUv : undefined;
  const ents: JEntry[] = [];
  for (const f of FACES) {
    const fv = uv.faces[f];
    if (!fv) continue;
    const of = oldO ? getKey(oldO, f) : undefined;
    const lf = likeO ? getKey(likeO, f) : undefined;
    const fnode: JObj = jobj(
      [
        ["uv", sameNums(isObj(of) ? getKey(of, "uv") : undefined, fv.uv) ? (getKey(of as JObj, "uv") as JNode) : vec(fv.uv, isObj(of) ? getKey(of, "uv") : isObj(lf) ? getKey(lf, "uv") : undefined, 4)],
        ["uv_size", sameNums(isObj(of) ? getKey(of, "uv_size") : undefined, fv.uvSize) ? (getKey(of as JObj, "uv_size") as JNode) : vec(fv.uvSize, isObj(of) ? getKey(of, "uv_size") : isObj(lf) ? getKey(lf, "uv_size") : undefined, 4)],
      ],
      of ?? lf,
    );
    ents.push({ key: f, value: fnode });
  }
  return jobj(ents, old ?? likeCubeUv);
}

function applyCubePatch(n: JObj, p: CubePatch, likeCube?: JObj): JObj {
  const O = CUBE_ORDER;
  const likeOf = (k: string) => getKey(n, k) ?? (likeCube ? getKey(likeCube, k) : undefined);
  if (p.origin) n = setCanon(n, O, "origin", sameNums(getKey(n, "origin"), p.origin) ? getKey(n, "origin") : vec(p.origin, likeOf("origin")));
  if (p.size) n = setCanon(n, O, "size", sameNums(getKey(n, "size"), p.size) ? getKey(n, "size") : vec(p.size, likeOf("size")));
  if (p.pivot !== undefined) n = setCanon(n, O, "pivot", p.pivot === null ? undefined : sameNums(getKey(n, "pivot"), p.pivot) ? getKey(n, "pivot") : vec(p.pivot, likeOf("pivot") ?? likeOf("origin")));
  if (p.rotation !== undefined) n = setCanon(n, O, "rotation", p.rotation === null ? undefined : sameNums(getKey(n, "rotation"), p.rotation) ? getKey(n, "rotation") : vec(p.rotation, likeOf("rotation") ?? likeOf("origin")));
  if (p.inflate !== undefined) n = setCanon(n, O, "inflate", p.inflate === null ? undefined : jnum(p.inflate));
  if (p.mirror !== undefined) n = setCanon(n, O, "mirror", p.mirror === null ? undefined : jbool(p.mirror));
  if (p.uv !== undefined) n = setCanon(n, O, "uv", p.uv === null ? undefined : uvNode(p.uv, getKey(n, "uv"), likeCube ? getKey(likeCube, "uv") : undefined));
  return n;
}

function cubeOf(doc: Doc, bone: string, index: number, gi?: number) {
  const { g, path } = geoPath(doc, gi);
  const b = findBone(g, bone);
  if (!b) throw new Error(`No bone "${bone}"`);
  const c = b.cubes[index];
  if (!c) throw new Error(`No cube ${index} in "${bone}"`);
  return { g, b, c, path };
}

export function addCube(doc: Doc, a: { bone: string; cube: CubeSpec; geometry?: number }): Doc {
  const { g, path } = geoPath(doc, a.geometry);
  const b = findBone(g, a.bone);
  if (!b) throw new Error(`No bone "${a.bone}"`);
  const carr = getKey(b.node, "cubes");
  const items = isArr(carr) ? carr.items : [];
  const likeCube = items[items.length - 1] ?? (g.bones.flatMap((x) => x.cubes)[0]?.node);
  const spec = a.cube;
  const n = applyCubePatch(jobj([], likeCube), { origin: spec.origin, size: spec.size, pivot: spec.pivot, rotation: spec.rotation, inflate: spec.inflate, mirror: spec.mirror, uv: spec.uv }, isObj(likeCube) ? likeCube : undefined);
  const cubes = jarr([...items, n]);
  const nb = setCanon(b.node, BONE_ORDER, "cubes", isArr(carr) ? derive(carr, [...items, n]) : cubes);
  return withRoot(doc, setIn(doc.root, [...path, "bones", b.index], nb));
}

export function deleteCube(doc: Doc, a: { bone: string; index: number; geometry?: number }): Doc {
  const { b, path } = cubeOf(doc, a.bone, a.index, a.geometry);
  const carr = getKey(b.node, "cubes") as JArr;
  const items = carr.items.slice();
  items.splice(a.index, 1);
  const nb = setCanon(b.node, BONE_ORDER, "cubes", items.length ? derive(carr, items) : undefined);
  return withRoot(doc, setIn(doc.root, [...path, "bones", b.index], nb));
}

export function setCube(doc: Doc, a: { bone: string; index: number; patch: CubePatch; geometry?: number }): Doc {
  const { b, c, path } = cubeOf(doc, a.bone, a.index, a.geometry);
  const n = applyCubePatch(c.node, a.patch);
  if (n === c.node) return doc;
  return withRoot(doc, setIn(doc.root, [...path, "bones", b.index, "cubes", a.index], n));
}
/** Move a cube (origin and pivot, if any) by `delta`, or to `origin`. */
export function moveCube(doc: Doc, a: { bone: string; index: number; delta?: NumVec3; origin?: NumVec3; geometry?: number }): Doc {
  const { c } = cubeOf(doc, a.bone, a.index, a.geometry);
  const d: NumVec3 = a.delta ?? (a.origin ? [a.origin[0] - c.origin[0], a.origin[1] - c.origin[1], a.origin[2] - c.origin[2]] : [0, 0, 0]);
  const add = (v: NumVec3): NumVec3 => [v[0] + d[0], v[1] + d[1], v[2] + d[2]];
  return setCube(doc, { bone: a.bone, index: a.index, geometry: a.geometry, patch: { origin: add(c.origin), pivot: c.pivot ? add(c.pivot) : undefined } });
}
/** Resize a cube; keeps the pivot unless `origin` is given. */
export function resizeCube(doc: Doc, a: { bone: string; index: number; size: NumVec3; origin?: NumVec3; geometry?: number }): Doc {
  return setCube(doc, { bone: a.bone, index: a.index, geometry: a.geometry, patch: { size: a.size, origin: a.origin } });
}
export const setPivot = (doc: Doc, a: { bone: string; index?: number; pivot: NumVec3; geometry?: number }) =>
  a.index === undefined ? setBone(doc, { bone: a.bone, patch: { pivot: a.pivot }, geometry: a.geometry }) : setCube(doc, { bone: a.bone, index: a.index, patch: { pivot: a.pivot }, geometry: a.geometry });
export const setRotation = (doc: Doc, a: { bone: string; index?: number; rotation: NumVec3 | null; geometry?: number }) =>
  a.index === undefined ? setBone(doc, { bone: a.bone, patch: { rotation: a.rotation }, geometry: a.geometry }) : setCube(doc, { bone: a.bone, index: a.index, patch: { rotation: a.rotation }, geometry: a.geometry });
export const setInflate = (doc: Doc, a: { bone: string; index?: number; inflate: number | null; geometry?: number }) =>
  a.index === undefined ? setBone(doc, { bone: a.bone, patch: { inflate: a.inflate }, geometry: a.geometry }) : setCube(doc, { bone: a.bone, index: a.index, patch: { inflate: a.inflate }, geometry: a.geometry });
export const setMirror = (doc: Doc, a: { bone: string; index?: number; mirror: boolean | null; geometry?: number }) =>
  a.index === undefined ? setBone(doc, { bone: a.bone, patch: { mirror: a.mirror }, geometry: a.geometry }) : setCube(doc, { bone: a.bone, index: a.index, patch: { mirror: a.mirror }, geometry: a.geometry });
export const setUv = (doc: Doc, a: { bone: string; index: number; uv: CubeUv | null; geometry?: number }) =>
  setCube(doc, { bone: a.bone, index: a.index, patch: { uv: a.uv }, geometry: a.geometry });

// ---------------------------------------------------------------- bbmodel group helpers (limited geometry editing)

/** bbmodel: rename a group and the animators that target it. */
export function renameBbGroup(doc: Doc, a: { from: string; to: string }): Doc {
  if (doc.kind !== "bbmodel") throw new Error("not a bbmodel");
  const model = getBb(doc);
  const g = allGroups(model).find((x) => x.name === a.from);
  if (!g) throw new Error(`No group "${a.from}"`);
  let root = doc.root;
  const setName = (node: JObj | undefined, path: Array<string | number>) => {
    if (node && getKey(node, "name")) root = setIn(root, [...path, "name"], jstr(a.to));
  };
  // locate by walking the source arrays
  const rec = (arr: JNode | undefined, path: Array<string | number>) => {
    if (!isArr(arr)) return;
    arr.items.forEach((it, i) => {
      if (!isObj(it)) return;
      if (getKey(it, "uuid") && (getKey(it, "uuid") as { value?: string }).value === g.uuid) setName(it, [...path, i]);
      rec(getKey(it, "children"), [...path, i, "children"]);
    });
  };
  rec(getKey(root as JObj, "outliner"), ["outliner"]);
  rec(getKey(root as JObj, "groups"), ["groups"]);
  for (const an of model.animations) for (const ar of an.animators) if (ar.key === g.uuid || ar.name === a.from) root = setIn(root, ["animations", an.index, "animators", ar.key, "name"], jstr(a.to));
  return withRoot(doc, root);
}

/** Channel-editing plumbing shared with animtools.ts (not part of the documented API). */
export const docInternals = { editChannel, editChannels, groupRefs, hasTime, mkChannel, mustAnim, bbIndex, r4, same };
