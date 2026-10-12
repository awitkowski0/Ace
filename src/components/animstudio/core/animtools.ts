/**
 * Animation tools: interpolation, bezier handles, baking, scaling, flipping/mirroring, markers.
 * Work on `.animation.json` and `.bbmodel` docs (markers and bezier handles are bbmodel-only).
 */
import { CHANNELS, DEFAULT_BEZIER, type BezierHandles, type ChannelName, type Comp, type Keyframe, type NumVec3, type Vec3 } from "./format/animation";
import { groupByName } from "./format/bbmodel";
import { derive, getKey, isArr, isNum, isObj, jarr, jnum, jobj, jstr, numOf, setEntry, setIn, strOf, type JArr, type JEntry, type JNode, type JObj } from "./format/json";
import { docInternals, findKey, getBb, setLength, withRoot, type Doc, type KeyRef } from "./doc";
import { mirrorBoneName } from "./noise";
import { sampleChannelRaw } from "./sample";

const { editChannel, editChannels, groupRefs, hasTime, mkChannel, mustAnim, bbIndex, r4, same } = docInternals;

export type Interpolation = "linear" | "catmullrom" | "bezier" | "step";

/** Counterpart of a left/right bone name (noise.ts `mirrorBoneName` returns the name itself when there is none), or `undefined` when the name has none. */
export function counterpartBone(name: string): string | undefined {
  const m = mirrorBoneName(name);
  return m === name ? undefined : m;
}

/** Interpolation a key currently has. */
export function keyInterpolation(doc: Doc, k: Keyframe): Interpolation {
  if (doc.kind === "bbmodel" && k.bb?.interpolation) {
    const i = k.bb.interpolation;
    if (i === "linear" || i === "catmullrom" || i === "bezier" || i === "step") return i;
  }
  if (k.lerp === "catmullrom" || k.easing === "catmullrom") return "catmullrom";
  if (k.easing === "step") return "step";
  return "linear";
}

const neg = (c: Comp): Comp => (typeof c === "number" ? (c === 0 ? 0 : -c) : `-(${c})`);
const sameVec = (a: Vec3 | undefined, b: Vec3 | undefined) => (!a && !b) || (!!a && !!b && a[0] === b[0] && a[1] === b[1] && a[2] === b[2]);

// ---------------------------------------------------------------- interpolation

export function setKeyInterpolation(doc: Doc, a: { anim: string; keys: KeyRef[]; interpolation: Interpolation }): Doc {
  if (a.interpolation === "bezier" && doc.kind !== "bbmodel") throw new Error("Bezier is baked on export; use bakeAnimation");
  mustAnim(doc, a.anim);
  const want = a.interpolation;
  return editChannels(doc, a.anim, [...groupRefs(a.keys).values()].map((g) => ({
    bone: g.bone,
    channel: g.channel,
    fn: (cur) => {
      if (!cur) return cur;
      let changed = false;
      const keys = cur.keys.map((k) => {
        if (!hasTime(g.times, k.time)) return k;
        const bb = doc.kind === "bbmodel";
        if (keyInterpolation(doc, k) === want && (want !== "bezier" || k.bezier)) return k;
        const n: Keyframe = { ...k };
        if (want === "linear") { n.lerp = undefined; if (n.easing === "step" || n.easing === "catmullrom") n.easing = undefined; }
        else if (want === "catmullrom") { n.lerp = "catmullrom"; n.easing = undefined; n.easingArgs = undefined; }
        else if (want === "step") { n.lerp = undefined; n.easing = "step"; n.easingArgs = undefined; }
        else { n.lerp = undefined; if (n.easing === "step") n.easing = undefined; n.bezier = k.bezier ?? { ...DEFAULT_BEZIER, leftTime: [...DEFAULT_BEZIER.leftTime], leftValue: [...DEFAULT_BEZIER.leftValue], rightTime: [...DEFAULT_BEZIER.rightTime], rightValue: [...DEFAULT_BEZIER.rightValue] }; }
        if (bb) n.bb = { ...k.bb, interpolation: want };
        changed = true;
        return n;
      });
      return changed ? mkChannel(cur, keys) : cur;
    },
  })));
}

const mirror3 = (v: readonly number[]): NumVec3 => [v[0] === 0 ? 0 : -v[0], v[1] === 0 ? 0 : -v[1], v[2] === 0 ? 0 : -v[2]];
const sameTrip = (a: readonly number[], b: readonly number[]) => a.every((x, i) => Math.abs(x - b[i]) < 1e-9);

export type BezierPatch = Partial<Pick<BezierHandles, "linked" | "leftTime" | "leftValue" | "rightTime" | "rightValue">>;
/** bbmodel only. Setting handles on a non-bezier key also switches it to bezier. `linked` keeps the other side mirrored (negated). */
export function setBezierHandles(doc: Doc, a: { anim: string; key: KeyRef; patch: BezierPatch }): Doc {
  if (doc.kind !== "bbmodel") throw new Error("Bezier handles are stored in .bbmodel files only");
  mustAnim(doc, a.anim);
  const p = a.patch;
  return editChannel(doc, a.anim, a.key.bone, a.key.channel, (cur) => {
    if (!cur) return cur;
    const k = cur.keys.find((x) => same(x.time, a.key.time));
    if (!k) return cur;
    const old = k.bezier ?? DEFAULT_BEZIER;
    const h: BezierHandles = {
      linked: p.linked ?? old.linked,
      leftTime: p.leftTime ? [...p.leftTime] : [...old.leftTime],
      leftValue: p.leftValue ? [...p.leftValue] : [...old.leftValue],
      rightTime: p.rightTime ? [...p.rightTime] : [...old.rightTime],
      rightValue: p.rightValue ? [...p.rightValue] : [...old.rightValue],
    };
    if (h.linked) {
      const leftChanged = !!(p.leftTime || p.leftValue);
      const rightChanged = !!(p.rightTime || p.rightValue);
      if (leftChanged && !rightChanged) { h.rightTime = mirror3(h.leftTime); h.rightValue = mirror3(h.leftValue); }
      else if (rightChanged && !leftChanged) { h.leftTime = mirror3(h.rightTime); h.leftValue = mirror3(h.rightValue); }
      else if (p.linked && !old.linked) { h.leftTime = mirror3(h.rightTime); h.leftValue = mirror3(h.rightValue); }
    }
    const same2 = k.bb?.interpolation === "bezier" && k.bezier && k.bezier.linked === h.linked && sameTrip(k.bezier.leftTime, h.leftTime) && sameTrip(k.bezier.leftValue, h.leftValue) && sameTrip(k.bezier.rightTime, h.rightTime) && sameTrip(k.bezier.rightValue, h.rightValue);
    if (same2) return cur;
    const keys = cur.keys.map((x) => (x === k ? { ...x, lerp: undefined, easing: x.easing === "step" ? undefined : x.easing, bezier: h, bb: { ...x.bb, interpolation: "bezier" } } : x));
    return mkChannel(cur, keys);
  });
}

// ---------------------------------------------------------------- bake

const hasMolang = (k: Keyframe) => k.value.some((c) => typeof c === "string") || !!k.pre?.some((c) => typeof c === "string");

export function bakeAnimation(doc: Doc, a: { anim: string; step?: number; bones?: string[]; onlyBezier?: boolean }): Doc {
  const step = a.step ?? 0.05;
  if (!(step > 0)) throw new Error("step must be > 0");
  const anim = mustAnim(doc, a.anim);
  const isBz = (k: Keyframe) => doc.kind === "bbmodel" && k.bb?.interpolation === "bezier";
  const targets: Array<{ bone: string; channel: ChannelName; fn: Parameters<typeof editChannel>[4] }> = [];
  for (const [bone, b] of anim.bones) {
    if (a.bones && !a.bones.includes(bone)) continue;
    for (const ch of CHANNELS) {
      const c = b[ch];
      if (!c || c.shape === "opaque" || c.keys.length < 2) continue;
      const sorted = c.keys.slice().sort((x, y) => x.time - y.time);
      if (sorted.some(hasMolang)) continue;
      if (a.onlyBezier && !sorted.some(isBz)) continue;
      targets.push({
        bone, channel: ch,
        fn: (cur) => {
          if (!cur) return cur;
          const orig = cur.keys.slice().sort((x, y) => x.time - y.time);
          const out: Keyframe[] = [];
          const sampleAt = (t: number): Vec3 => (sampleChannelRaw(cur, t, { anim_time: t }) ?? orig[0].value) as Vec3;
          const lin = (k: Keyframe): Keyframe => ({
            ...k, easing: undefined, easingArgs: undefined, lerp: undefined, bezier: undefined,
            ...(doc.kind === "bbmodel" ? { bb: { ...k.bb, interpolation: "linear" } } : {}),
          });
          const grid = (t0: number, t1: number) => {
            const ts: number[] = [];
            for (let n = Math.ceil(t0 / step - 1e-9); n * step < t1 + 1e-9; n++) {
              const t = r4(n * step);
              if (t > t0 + 5e-4 && t < t1 - 5e-4) ts.push(t);
            }
            return ts;
          };
          const fresh = (t: number): Keyframe => ({ time: t, value: sampleAt(t), ...(doc.kind === "bbmodel" ? { bb: { interpolation: "linear" } } : {}) });
          if (a.onlyBezier) {
            orig.forEach((k, i) => {
              out.push(isBz(k) ? lin(k) : k);
              const nx = orig[i + 1];
              if (nx && (isBz(k) || isBz(nx))) for (const t of grid(k.time, nx.time)) out.push(fresh(t));
            });
          } else {
            const first = orig[0].time;
            const last = orig[orig.length - 1].time;
            const times = grid(first - 1e-9, last + 1e-9).filter((t) => !orig.some((k) => same(k.time, t)));
            for (const k of orig) out.push(lin(k));
            for (const t of times) out.push(fresh(t));
            out.sort((x, y) => x.time - y.time);
          }
          if (out.length === orig.length && out.every((k, i) => k === orig[i])) return cur;
          return mkChannel(cur, out);
        },
      });
    }
  }
  return editChannels(doc, a.anim, targets);
}

// ---------------------------------------------------------------- scale

export function scaleAnimation(doc: Doc, a: { anim: string; factor: number }): Doc {
  if (!(a.factor > 0)) throw new Error("factor must be > 0");
  const anim = mustAnim(doc, a.anim);
  if (a.factor === 1) return doc;
  const f = a.factor;
  const targets: Array<{ bone: string; channel: ChannelName; fn: Parameters<typeof editChannel>[4] }> = [];
  for (const [bone, b] of anim.bones) {
    for (const ch of CHANNELS) {
      const c = b[ch];
      if (!c || c.shape === "opaque" || c.keys.length === 0) continue;
      targets.push({
        bone, channel: ch,
        fn: (cur) => {
          if (!cur) return cur;
          const byTime = new Map<number, Keyframe>();
          for (const k of cur.keys) {
            const time = r4(k.time * f);
            const n: Keyframe = time === k.time ? k : { ...k, time, keyRaw: undefined };
            if (k.bezier) n.bezier = { ...k.bezier, leftTime: k.bezier.leftTime.map((x) => x * f) as NumVec3, rightTime: k.bezier.rightTime.map((x) => x * f) as NumVec3 };
            byTime.set(time, n);
          }
          return mkChannel({ ...cur, shape: "keys" }, [...byTime.values()]);
        },
      });
    }
  }
  let out = editChannels(doc, a.anim, targets);
  if (anim.length !== undefined && anim.length > 0) out = setLength(out, { anim: a.anim, length: r4(anim.length * f) });
  if (doc.kind === "bbmodel") {
    const ms = getMarkers(out, a.anim);
    ms.forEach((m, i) => { out = setMarker(out, { anim: a.anim, index: i, patch: { time: m.time * f } }); });
  }
  return out;
}

// ---------------------------------------------------------------- multi-key value edits

export interface MapKeyValuesArgs {
  anim: string;
  keys: KeyRef[];
  /** only keys of this channel (a collapsed bone row selects all three channels) */
  channel?: ChannelName;
  /** which vector(s) to rewrite; `pre` skips keys without a pre value. Default `value`. */
  which?: "value" | "pre" | "both";
  /** new value for one component, or the same `c` to leave it alone */
  map: (c: Comp, ctx: { axis: number; channel: ChannelName; key: Keyframe }) => Comp;
}
/** Rewrite components of many keys in one pass (one edit per channel). Unchanged keys keep their identity so the text diff stays minimal. */
export function mapKeyValues(doc: Doc, a: MapKeyValuesArgs): Doc {
  mustAnim(doc, a.anim);
  const which = a.which ?? "value";
  const keys = a.channel ? a.keys.filter((k) => k.channel === a.channel) : a.keys;
  return editChannels(doc, a.anim, [...groupRefs(keys).values()].map((g) => ({
    bone: g.bone,
    channel: g.channel,
    fn: (cur) => {
      if (!cur || cur.shape === "opaque") return cur;
      let changed = false;
      const out = cur.keys.map((k) => {
        if (!hasTime(g.times, k.time)) return k;
        const run = (v: Vec3): Vec3 => {
          let ch = false;
          const n = v.map((c, axis) => { const m = a.map(c, { axis, channel: g.channel, key: k }); if (m !== c) ch = true; return m; }) as Vec3;
          return ch ? n : v;
        };
        const nv = which === "pre" ? k.value : run(k.value);
        const np = which !== "value" && k.pre ? run(k.pre) : k.pre;
        if (nv === k.value && np === k.pre) return k;
        changed = true;
        const n: Keyframe = { ...k, value: nv };
        if (np) n.pre = np;
        return n;
      });
      return changed ? mkChannel(cur, out) : cur;
    },
  })));
}

const rnd4 = (x: number) => Math.round(x * 1e4) / 1e4;
/** `c + d` for a number; a molang string becomes `(expr)+d` so the offset survives. */
export function addToComp(c: Comp, d: number): Comp {
  if (d === 0) return c;
  if (typeof c === "number") return rnd4(c + d);
  return d > 0 ? `(${c})+${rnd4(d)}` : `(${c})-${rnd4(-d)}`;
}
export function mulComp(c: Comp, f: number): Comp {
  if (f === 1) return c;
  if (typeof c === "number") return rnd4(c * f);
  return `(${c})*${rnd4(f)}`;
}

export type KeyOffset = { rotation?: Vec3 | readonly number[]; position?: Vec3 | readonly number[]; scale?: Vec3 | readonly number[] };
/**
 * Add a per-channel delta to every selected key (value and pre). Each key keeps its own value; only the offset is shared.
 * Used by the keyframe inspector (`+5`, scrubbing) and by gizmo drags with several keys selected.
 */
export function offsetKeys(doc: Doc, a: { anim: string; keys: KeyRef[]; delta: KeyOffset }): Doc {
  let out = doc;
  for (const channel of CHANNELS) {
    const d = a.delta[channel];
    if (!d || !d.some((x) => typeof x === "number" && x !== 0)) continue;
    out = mapKeyValues(out, { anim: a.anim, keys: a.keys, channel, which: "both", map: (c, { axis }) => { const x = d[axis]; return typeof x === "number" ? addToComp(c, x) : c; } });
  }
  return out;
}

/**
 * Multiply the values of the selected keys by `factor`. `zero` scales around 0; `average` scales each channel/axis around the
 * mean of the selected keys' values, so a pose keeps its centre and only its spread grows or shrinks.
 */
export function scaleKeyValues(doc: Doc, a: { anim: string; keys: KeyRef[]; factor: number; pivot?: "zero" | "average" }): Doc {
  if (!Number.isFinite(a.factor) || a.factor === 1) return doc;
  const anim = mustAnim(doc, a.anim);
  let out = doc;
  for (const channel of CHANNELS) {
    const refs = a.keys.filter((k) => k.channel === channel);
    if (!refs.length) continue;
    const mean = [0, 0, 0];
    if (a.pivot === "average") {
      const sums = [0, 0, 0], counts = [0, 0, 0];
      for (const r of refs) {
        const k = findKey(anim, r);
        if (k) k.value.forEach((c, i) => { if (typeof c === "number") { sums[i] += c; counts[i]++; } });
      }
      for (let i = 0; i < 3; i++) mean[i] = counts[i] ? sums[i] / counts[i] : 0;
    }
    out = mapKeyValues(out, {
      anim: a.anim, keys: refs, channel, which: "both",
      map: (c, { axis }) => (a.pivot === "average" ? (typeof c === "number" ? rnd4(mean[axis] + (c - mean[axis]) * a.factor) : addToComp(mulComp(addToComp(c, -mean[axis]), a.factor), mean[axis])) : mulComp(c, a.factor)),
    });
  }
  return out;
}

// ---------------------------------------------------------------- flip / mirror

const AXES = { x: 0, y: 1, z: 2 } as const;
type Axis = keyof typeof AXES;

function negIdx(ch: ChannelName, axis: Axis): number[] {
  const ai = AXES[axis];
  if (ch === "position") return [ai];
  if (ch === "rotation") return [0, 1, 2].filter((i) => i !== ai);
  return [];
}
function flipKey(k: Keyframe, idx: number[]): Keyframe {
  if (!idx.length) return k;
  const fv = (v: Vec3): Vec3 => v.map((c, i) => (idx.includes(i) ? neg(c) : c)) as Vec3;
  const n: Keyframe = { ...k, value: fv(k.value) };
  if (k.pre) n.pre = fv(k.pre);
  if (k.bezier) {
    const fb = (v: NumVec3): NumVec3 => v.map((c, i) => (idx.includes(i) ? (c === 0 ? 0 : -c) : c)) as NumVec3;
    n.bezier = { ...k.bezier, leftValue: fb(k.bezier.leftValue), rightValue: fb(k.bezier.rightValue) };
  }
  return n;
}
const fresh = (k: Keyframe): Keyframe => ({ ...k, keyRaw: undefined, node: undefined, valueNode: undefined, preNode: undefined, bb: k.bb?.interpolation ? { interpolation: k.bb.interpolation } : undefined });

function hasBone(doc: Doc, name: string): boolean {
  return doc.kind === "bbmodel" ? !!groupByName(getBb(doc), name) : true;
}

/** Blockbench "Flip Animation": mirror the pose across the plane perpendicular to `axis` (optionally swapping left/right bones). */
export function flipAnimation(doc: Doc, a: { anim: string; axis: Axis; swapSides?: boolean }): Doc {
  const anim = mustAnim(doc, a.anim);
  const counterpart = (b: string): string | undefined => {
    if (!a.swapSides) return undefined;
    const m = counterpartBone(b);
    return m && hasBone(doc, m) ? m : undefined;
  };
  const names = new Set<string>();
  for (const b of anim.bones.keys()) { names.add(b); const m = counterpart(b); if (m) names.add(m); }
  const targets: Array<{ bone: string; channel: ChannelName; fn: Parameters<typeof editChannel>[4] }> = [];
  for (const bone of names) {
    const src = counterpart(bone) ?? bone;
    for (const ch of CHANNELS) {
      const srcCh = anim.bones.get(src)?.[ch];
      if (srcCh?.shape === "opaque") continue;
      const srcKeys = srcCh?.keys ?? [];
      const idx = negIdx(ch, a.axis);
      if (src === bone && !idx.length) continue;
      if (!srcKeys.length && !anim.bones.get(bone)?.[ch]?.keys.length) continue;
      targets.push({
        bone, channel: ch,
        fn: (cur) => {
          const keys = srcKeys.map((k) => flipKey(k, idx));
          if (src === bone) {
            if (cur && keys.every((k, i) => k === cur.keys[i])) return cur; // nothing changed
          }
          return keys.length ? mkChannel(cur, keys) : undefined;
        },
      });
    }
  }
  return editChannels(doc, a.anim, targets);
}

/** Write the X-mirrored counterpart of each selected key (same time) on the left/right counterpart bone. */
export function mirrorKeys(doc: Doc, a: { anim: string; keys: KeyRef[] }): { doc: Doc; added: KeyRef[] } {
  const anim = mustAnim(doc, a.anim);
  const added: KeyRef[] = [];
  const per = new Map<string, { bone: string; channel: ChannelName; keys: Keyframe[] }>();
  for (const ref of a.keys) {
    const k = findKey(anim, ref);
    const m = counterpartBone(ref.bone);
    if (!k || !m || !hasBone(doc, m)) continue;
    const id = m + "\u0000" + ref.channel;
    const g = per.get(id) ?? { bone: m, channel: ref.channel, keys: [] };
    g.keys.push(fresh(flipKey(k, negIdx(ref.channel, "x"))));
    per.set(id, g);
    added.push({ bone: m, channel: ref.channel, time: k.time });
  }
  const out = editChannels(doc, a.anim, [...per.values()].map((g) => ({
    bone: g.bone,
    channel: g.channel,
    fn: (cur) => {
      const keep = (cur?.keys ?? []).filter((k) => !g.keys.some((n) => same(n.time, k.time)));
      return mkChannel(cur, [...keep, ...g.keys]);
    },
  })));
  return { doc: out, added };
}

// ---------------------------------------------------------------- markers (bbmodel only)

export interface Marker {
  color: number;
  time: number;
  name?: string;
}
const NOT_BB = "markers are stored in .bbmodel files only";
function markersNode(doc: Doc, anim: string): { animNode: JObj; path: Array<string | number>; arr: JArr | undefined } {
  if (doc.kind !== "bbmodel") throw new Error(NOT_BB);
  mustAnim(doc, anim);
  const i = bbIndex(doc, anim);
  const animNode = getBb(doc).animations[i].node;
  const m = getKey(animNode, "markers");
  return { animNode, path: ["animations", i], arr: isArr(m) ? m : undefined };
}

export function getMarkers(doc: Doc, anim: string): Marker[] {
  if (doc.kind !== "bbmodel") return [];
  const found = getBb(doc).animations.find((x) => x.name === anim);
  if (!found) return [];
  const m = getKey(found.node, "markers");
  if (!isArr(m)) return [];
  const out: Marker[] = [];
  for (const it of m.items) {
    if (!isObj(it)) continue;
    const mk: Marker = { color: numOf(getKey(it, "color"), 0), time: numOf(getKey(it, "time"), 0) };
    const nm = strOf(getKey(it, "name"));
    if (nm !== undefined) mk.name = nm;
    out.push(mk);
  }
  return out;
}

function markerNode(m: Marker, like?: JNode): JObj {
  const ents: JEntry[] = [{ key: "color", value: jnum(m.color, 0) }, { key: "time", value: jnum(r4(m.time), 4) }];
  if (m.name !== undefined) ents.push({ key: "name", value: jstr(m.name) });
  return jobj(ents, like);
}
function writeMarkers(doc: Doc, anim: string, items: JNode[] | undefined, arr: JArr | undefined, animNode: JObj, path: Array<string | number>): Doc {
  if (!items || items.length === 0) {
    return arr ? withRoot(doc, setIn(doc.root, path, setEntry(animNode, "markers", undefined))) : doc;
  }
  const next = arr ? derive(arr, items) : jarr(items);
  return withRoot(doc, setIn(doc.root, path, setEntry(animNode, "markers", next, (k) => k === "animators")));
}

export function addMarker(doc: Doc, a: { anim: string; time: number; color?: number; name?: string }): Doc {
  const { animNode, path, arr } = markersNode(doc, a.anim);
  const items = arr ? arr.items.slice() : [];
  const like = items.find(isObj);
  items.push(markerNode({ color: a.color ?? 0, time: a.time, name: a.name }, like));
  return writeMarkers(doc, a.anim, items, arr, animNode, path);
}
function markerAt(arr: JArr | undefined, index: number): JObj {
  const it = arr?.items[index];
  if (!isObj(it)) throw new Error(`No marker ${index}`);
  return it;
}
export function setMarker(doc: Doc, a: { anim: string; index: number; patch: { color?: number; time?: number; name?: string | null } }): Doc {
  const { animNode, path, arr } = markersNode(doc, a.anim);
  const cur = markerAt(arr, a.index);
  let n = cur;
  const p = a.patch;
  const upd = (key: string, v: JNode | undefined, before?: (k: string) => boolean) => {
    const c = getKey(n, key);
    if (v === undefined ? c === undefined : c && c.t === v.t && (c as { value?: unknown }).value === (v as { value?: unknown }).value) return;
    n = setEntry(n, key, v, before);
  };
  if (p.color !== undefined) upd("color", jnum(p.color, 0), (k) => k === "time" || k === "name");
  if (p.time !== undefined) { const c = getKey(n, "time"); if (!(isNum(c) && Math.abs(c.value - p.time) < 1e-9)) upd("time", jnum(r4(p.time), 4), (k) => k === "name"); }
  if (p.name !== undefined) upd("name", p.name === null ? undefined : jstr(p.name));
  if (n === cur) return doc;
  const items = arr!.items.slice();
  items[a.index] = n;
  return writeMarkers(doc, a.anim, items, arr, animNode, path);
}
export const moveMarker = (doc: Doc, a: { anim: string; index: number; time: number }) => setMarker(doc, { anim: a.anim, index: a.index, patch: { time: a.time } });
export function deleteMarker(doc: Doc, a: { anim: string; index: number }): Doc {
  const { animNode, path, arr } = markersNode(doc, a.anim);
  markerAt(arr, a.index);
  const items = arr!.items.slice();
  items.splice(a.index, 1);
  return writeMarkers(doc, a.anim, items, arr, animNode, path);
}

