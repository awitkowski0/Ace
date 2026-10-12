/**
 * Copy with noise: clipboard of keys, paste N times with seeded Perlin/random jitter, optional L<->R mirror.
 * Everything is deterministic for a given seed (no Math.random, no time).
 */
import { type ChannelName, type Keyframe, type Vec3 } from "./format/animation";
import { findKey, getAnimation, insertKeys, type Doc, type KeyRef } from "./doc";

// ---------------------------------------------------------------- PRNG + noise

/** FNV-1a 32-bit hash of a string, mixed with a number. */
export function hashString(s: string, seed = 0): number {
  let h = (0x811c9dc5 ^ seed) >>> 0;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193) >>> 0;
  return h >>> 0;
}
function mix32(h: number): number {
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
}
/** mulberry32: returns a function giving floats in [0,1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const grad = (seed: number, i: number) => mix32((seed ^ Math.imul(i | 0, 0x9e3779b1)) >>> 0) / 4294967295 * 2 - 1;
/** 1D gradient (Perlin) noise, roughly in [-1, 1], 0 at integer x. */
export function perlin1(seed: number, x: number): number {
  const i = Math.floor(x);
  const f = x - i;
  const u = f * f * f * (f * (f * 6 - 15) + 10);
  const a = grad(seed, i) * f;
  const b = grad(seed, i + 1) * (f - 1);
  return (a + (b - a) * u) * 2;
}

// ---------------------------------------------------------------- model

export interface ClipKey {
  bone: string;
  channel: ChannelName;
  key: Keyframe;
}
export interface Clipboard {
  /** Key times are relative to the earliest copied key. */
  keys: ClipKey[];
  duration: number;
}

export interface NoiseOptions {
  /** rotation: degrees, position: model units (px), scale: percent. */
  amplitude: { rotation: number; position: number; scale: number };
  /** Which axes get noise (default all). */
  axes?: [boolean, boolean, boolean];
  kind: "perlin" | "random";
  /** Perlin: noise features per second of animation time (higher = jitterier). Ignored for "random". */
  frequency?: number;
  seed: number;
  /** First and last key of each bone+channel stay exact. */
  keepEnds?: boolean;
}
export interface PasteNoiseOptions extends NoiseOptions {
  targetTime: number;
  /** Number of copies (default 1). */
  repeat?: number;
  /** Spacing between copies in seconds (default: clipboard duration). */
  every?: number;
  /** Map source bone -> target bone, or a list matched to the clipboard's distinct bones in order. */
  targetBones?: Record<string, string> | string[];
  /** Swap armorLeft*<->armorRight* (bipedLeft*, generic left/right) and flip yaw/roll. */
  mirrorLR?: boolean;
}

/** Copy the referenced keys. */
export function copyKeys(doc: Doc, animName: string, refs: KeyRef[]): Clipboard {
  const a = getAnimation(doc, animName);
  if (!a) throw new Error(`No animation "${animName}"`);
  const found: ClipKey[] = [];
  for (const r of refs) {
    const k = findKey(a, r);
    if (k) found.push({ bone: r.bone, channel: r.channel, key: k });
  }
  if (!found.length) return { keys: [], duration: 0 };
  const t0 = Math.min(...found.map((f) => f.key.time));
  const t1 = Math.max(...found.map((f) => f.key.time));
  return { keys: found.map((f) => ({ ...f, key: { ...f.key, time: round4(f.key.time - t0), keyRaw: undefined, node: undefined, valueNode: undefined, preNode: undefined } })), duration: round4(t1 - t0) };
}
const round4 = (v: number) => Math.round(v * 10000) / 10000;

/** armorLeftArm <-> armorRightArm, bipedLeftLeg <-> bipedRightLeg, leftHand <-> rightHand, hand_L style is left alone. */
export function mirrorBoneName(name: string): string {
  const swap = (s: string, a: string, b: string) => {
    const ia = s.indexOf(a);
    const ib = s.indexOf(b);
    if (ia >= 0 && (ib < 0 || ia < ib)) return s.slice(0, ia) + b + s.slice(ia + a.length);
    if (ib >= 0) return s.slice(0, ib) + a + s.slice(ib + b.length);
    return undefined;
  };
  return swap(name, "Left", "Right") ?? swap(name, "left", "right") ?? swap(name, "LEFT", "RIGHT") ?? name;
}

function mirrorValue(ch: ChannelName, v: Vec3): Vec3 {
  const neg = (c: number | string) => (typeof c === "number" ? (c === 0 ? 0 : -c) : c);
  if (ch === "rotation") return [v[0], neg(v[1]), neg(v[2])];
  if (ch === "position") return [neg(v[0]), v[1], v[2]];
  return v;
}

// ---------------------------------------------------------------- noise application

function noiseAt(o: NoiseOptions, bone: string, ch: ChannelName, axis: number, time: number): number {
  const s = hashString(`${bone}/${ch}/${axis}`, o.seed);
  // perlin1 is 0 at integer x, and key times × frequency are often integers (0.5 s keys at 2 Hz): shift each
  // bone/channel/axis by a seeded fractional phase in [0.15, 0.85) so tick-aligned keys still get noise.
  if (o.kind === "perlin") return perlin1(s, time * (o.frequency ?? 2) + 0.15 + (mix32(s) / 4294967296) * 0.7);
  const r = mulberry32(mix32((s ^ Math.imul(Math.round(time * 10000), 0x9e3779b1)) >>> 0))();
  return r * 2 - 1;
}

function jitter(o: NoiseOptions, bone: string, ch: ChannelName, time: number, v: Vec3): Vec3 {
  const axes = o.axes ?? [true, true, true];
  const amp = o.amplitude[ch];
  const out: Vec3 = [v[0], v[1], v[2]];
  for (let a = 0; a < 3; a++) {
    const c = v[a];
    if (!axes[a] || typeof c !== "number" || !amp) continue;
    const n = noiseAt(o, bone, ch, a, time);
    out[a] = round4(ch === "scale" ? c * (1 + (n * amp) / 100) : c + n * amp);
  }
  return out;
}

/**
 * Add noise to a set of keys (pure; times are used as-is for noise coordinates, so pass absolute times
 * for live previews). With `keepEnds` the first and last key of every bone+channel are returned unchanged.
 */
export function addNoise(selection: ClipKey[], o: NoiseOptions): ClipKey[] {
  const groups = new Map<string, number[]>();
  selection.forEach((c, i) => {
    const id = c.bone + "\u0000" + c.channel;
    (groups.get(id) ?? groups.set(id, []).get(id)!).push(i);
  });
  const isEnd = new Set<number>();
  if (o.keepEnds) {
    for (const idx of groups.values()) {
      const sorted = idx.slice().sort((x, y) => selection[x].key.time - selection[y].key.time);
      isEnd.add(sorted[0]);
      isEnd.add(sorted[sorted.length - 1]);
    }
  }
  return selection.map((c, i) => {
    if (isEnd.has(i)) return c;
    const k = c.key;
    const value = jitter(o, c.bone, c.channel, k.time, k.value);
    let pre = k.pre;
    if (pre) pre = jitter(o, c.bone, c.channel, k.time, pre);
    return { ...c, key: { ...k, value, pre, valueNode: undefined, preNode: undefined, node: undefined } };
  });
}

/** Compute the keys a paste would create (absolute times, bones remapped, mirrored, noised). */
export function previewPasteWithNoise(clip: Clipboard, o: PasteNoiseOptions): ClipKey[] {
  const repeat = Math.max(1, Math.floor(o.repeat ?? 1));
  const every = o.every ?? clip.duration;
  const distinct = [...new Set(clip.keys.map((k) => k.bone))];
  const mapBone = (b: string): string => {
    if (Array.isArray(o.targetBones)) {
      const i = distinct.indexOf(b);
      return o.targetBones[i] ?? b;
    }
    if (o.targetBones && o.targetBones[b]) return o.targetBones[b];
    return o.mirrorLR ? mirrorBoneName(b) : b;
  };
  const out: ClipKey[] = [];
  for (let r = 0; r < repeat; r++) {
    const copy: ClipKey[] = clip.keys.map((c) => {
      const bone = mapBone(c.bone);
      const k = c.key;
      const value = o.mirrorLR ? mirrorValue(c.channel, k.value) : k.value;
      const pre = k.pre && o.mirrorLR ? mirrorValue(c.channel, k.pre) : k.pre;
      return { bone, channel: c.channel, key: { ...k, time: round4(o.targetTime + r * every + k.time), value, pre, keyRaw: undefined, node: undefined, valueNode: undefined, preNode: undefined } };
    });
    out.push(...addNoise(copy, o));
  }
  return out;
}

/** Paste the clipboard with noise (see PasteNoiseOptions). Pure. */
export function pasteWithNoise(doc: Doc, animName: string, clip: Clipboard, o: PasteNoiseOptions): Doc {
  return insertKeys(doc, animName, previewPasteWithNoise(clip, o));
}

/** Add noise in place to existing keys. */
export function applyNoise(doc: Doc, animName: string, refs: KeyRef[], o: NoiseOptions): Doc {
  const a = getAnimation(doc, animName);
  if (!a) throw new Error(`No animation "${animName}"`);
  const sel: ClipKey[] = [];
  for (const r of refs) {
    const k = findKey(a, r);
    if (k) sel.push({ bone: r.bone, channel: r.channel, key: k });
  }
  const noisy = addNoise(sel, o);
  // insertKeys drops node info, which is what we want for edited keys; unchanged (end) keys are skipped.
  const changed = noisy.filter((n, i) => n !== sel[i]);
  return insertKeys(doc, animName, changed.map((c) => ({ ...c, key: { ...c.key, keyRaw: undefined } })));
}
