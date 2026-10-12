/**
 * "Player" clip semantics: how Thematic's PLAYER/ARMOR clip path reads and plays an `.animation.json`, as opposed to
 * the GeckoLib geo-model path that sample.ts implements. Verified 2026-10 against Thematic-Collections
 * (src/common/java/bond/thematic/api/):
 *  - core/data/gson/GeckoLibSerializer.java  (reader; builds a KeyframeAnimation, isEasingBefore = false)
 *  - layered/KeyframeAnimationPlayer.java    (Axis/RotationAxis: findBefore/findAfter/getValueFromKeyframes)
 *  - content/pose/client/ClipPoseLibrary.java (valueAt: same earlier-key rule)
 *  - core/util/Ease.java, Easing.java, MathHelper.lerpAngle
 *
 * Which semantics a file gets (the registry loads EVERY .json under assets/<ns>/animations/armor/ through the serializer:
 * minecraftApi/PlayerAnimationRegistry.java:99 -> AnimationSerializing.java:32 -> AnimationJson.java:57 -> GeckoLibSerializer):
 * see `clipSemantics`. A suit's own armor-folder file is ALSO read by the geo AnimationLoader (ModelResources.java:216), so
 * the Studio lets the user switch the preview.
 *
 * Differences from the geo sampler, all modelled here:
 *  - The easing of the EARLIER key governs the segment LEAVING it (KeyframeAnimationPlayer.java:372/399).
 *  - Key times are whole ticks: (int)(float(key) * 20f), truncated toward zero (GeckoLibSerializer.java:143).
 *  - `pre`/`vector`/`post` of one key are separate keys on the same tick sharing the key's ease (:167-187).
 *  - Ease names go through Easing.easeFromString: GeckoLib/Bedrock names ("easeInOutSine", "linear", "step") or enum names
 *    (INOUTSINE), any case; unknown or null is LINEAR. It never throws, so names never drop keys.
 *  - lerp_mode "catmullrom" becomes INOUTSINE for position and LINEAR for rotation (:195-201); `easing` overrides lerp_mode.
 *  - easingArgs are never read (addKeyFrame(..., 0, true) -> arg null): back/elastic/bounce/step use their defaults.
 *  - scale is not read; only rotation and position.
 *  - Before the first key the value eases (INOUTSINE) from rest (0) at tick 0 to the first key, instead of holding it.
 *  - Rotation interpolates with lerpAngle: the shortest way round (wrap at 180), unless the delta is a full-turn multiple.
 *  - Looping clips are endTick+1 ticks long and the last key blends toward the FIRST key over that extra tick.
 *  - Per-axis keys: a non-numeric component (molang, a bare word) drops that key for its axis and the axes after it.
 *  - animation_length absent => static pose (endTick 1) in the game; here the last key time is used so the preview stays usable.
 */
import { CHANNELS, sortedKeys, type Animation, type Channel, type ChannelName, type ClipSemantics, type Keyframe, type NumVec3 } from "./format/animation";
import { easingFn } from "./sample";

export type { ClipSemantics } from "./format/animation";

/** "player" for files under assets/<ns>/animations/armor/ (any depth, `.json`), otherwise "geo" (also the default for unknown paths). */
export function clipSemantics(path: string | undefined | null): ClipSemantics {
  if (!path) return "geo";
  return /\/assets\/[^/]+\/animations\/armor\/.+\.json$/i.test(path.replace(/\\/g, "/")) ? "player" : "geo";
}

// ---------------------------------------------------------------- easing names (Java enum)

const FAMILIES = ["SINE", "CUBIC", "QUAD", "QUART", "QUINT", "EXPO", "CIRC", "BACK", "ELASTIC", "BOUNCE"];
const JAVA_EASES: ReadonlySet<string> = new Set([
  "LINEAR", "CONSTANT", "CATMULLROM", "STEP",
  ...FAMILIES.flatMap((f) => ["IN", "OUT", "INOUT"].map((k) => k + f)),
]);
/** True when `name` is a Java Ease constant (exact, upper-case). */
export const isJavaEase = (name: string): boolean => JAVA_EASES.has(name);
/** Easing.easeFromString: file names ("easeInOutSine") or enum names, any case; unknown is LINEAR. */
export function javaEaseName(name: string | undefined | null): string {
  if (name == null) return "LINEAR";
  const n = name.toLowerCase();
  const m = /^ease(inout|in|out)(\w+)$/.exec(n);
  if (m) { const e = (m[1] + m[2]).toUpperCase(); return JAVA_EASES.has(e) ? e : "LINEAR"; }
  const u = n.toUpperCase();
  return JAVA_EASES.has(u) ? u : "LINEAR";
}

type Fn = (t: number) => number;
const inOut = (f: Fn): Fn => (t) => (t < 0.5 ? f(t * 2) / 2 : 1 - f((1 - t) * 2) / 2);
/** Easing.catmullRom(n): the "approximation" Ease.CATMULLROM wraps in easeInOut. */
const javaCatmull: Fn = (n) => 0.5 * (2 * (n + 1) + (2 * n - 5 * (n + 1) + 4 * (n + 2) - (n + 3)) * n * n + (3 * (n + 1) - n - 3 * (n + 2) + (n + 3)) * n * n * n);
const easeCache = new Map<string, Fn>();
const LINEAR_FN: Fn = (t) => t;
const INOUTSINE = "INOUTSINE";

/** Progress function of a Java Ease constant (args are never passed by the serializer). */
export function javaEase(name: string): Fn {
  let f = easeCache.get(name);
  if (f) return f;
  if (name === "LINEAR") f = LINEAR_FN;
  else if (name === "CONSTANT") f = () => 0;
  else if (name === "CATMULLROM") f = inOut(javaCatmull);
  else if (name === "STEP") f = easingFn("step") ?? LINEAR_FN;
  else {
    const m = /^(INOUT|IN|OUT)(\w+)$/.exec(name);
    const fam = m ? m[2][0] + m[2].slice(1).toLowerCase() : "";
    const k = m ? (m[1] === "IN" ? "easeIn" : m[1] === "OUT" ? "easeOut" : "easeInOut") : "";
    f = (m && easingFn(k + fam)) || LINEAR_FN;
  }
  easeCache.set(name, f);
  return f;
}

/** determineEase(): the Java ease name a key resolves to. Never fails: unknown names are LINEAR. */
export function keyEase(k: Keyframe, kind: ChannelName): string {
  let ease = "LINEAR";
  if (k.lerp !== undefined) ease = k.lerp === "catmullrom" ? (kind === "position" ? INOUTSINE : "LINEAR") : javaEaseName(k.lerp);
  if (k.easing !== undefined) ease = javaEaseName(k.easing);
  return ease;
}

// ---------------------------------------------------------------- context + registry

export interface PlayerCtx {
  kind: ChannelName;
  endTick: number;
  infinite: boolean;
  returnTick: number;
  /** The channel is never read at all (scale). */
  dead?: boolean;
}
const ctxOf = new WeakMap<Channel, PlayerCtx>();

/** The player context of a channel stamped by `stampSemantics`, if any. */
export const playerCtx = (c: Channel): PlayerCtx | undefined => ctxOf.get(c);

const f32 = Math.fround;
export function playerEndTick(a: Animation): number {
  if (a.length !== undefined) return Math.max(1, Math.ceil(f32(f32(a.length) * 20)));
  let m = 0;
  for (const b of a.bones.values()) for (const ch of CHANNELS) for (const k of b[ch]?.keys ?? []) if (k.time > m) m = k.time;
  return Math.max(1, Math.ceil(f32(f32(m) * 20)));
}

export interface PlayerDrop {
  bone: string;
  channel: ChannelName;
  time: number;
  /** what the game's serializer does not read */
  lost: string;
}

const dropsOf = new WeakMap<Animation, PlayerDrop[]>();
/** What the game's serializer ignores in this animation (scale channels, non-numeric components); empty unless stamped "player". */
export const playerDrops = (a: Animation): PlayerDrop[] => dropsOf.get(a) ?? [];

/** Stamp animations with their semantics: sets `anim.semantics` and, for "player", registers each channel's context. */
export function stampSemantics(anims: Animation[], sem: ClipSemantics): void {
  for (const a of anims) {
    a.semantics = sem;
    if (sem !== "player") continue;
    const endTick = playerEndTick(a);
    const infinite = a.loop === true || a.loop === "hold_on_last_frame";
    const returnTick = a.loop === "hold_on_last_frame" ? endTick : 0;
    const drops: PlayerDrop[] = [];
    for (const [bone, b] of a.bones) {
      for (const kind of CHANNELS) {
        const c = b[kind];
        if (!c) continue;
        const ctx: PlayerCtx = { kind, endTick, infinite, returnTick };
        if (kind === "scale") {
          ctx.dead = true;
          drops.push({ bone, channel: kind, time: sortedKeys(c)[0]?.time ?? 0, lost: "scale is not read" });
        } else {
          const bad = sortedKeys(c).find((k) => !(k.node && k.node.t === "n") && k.value.some((v) => num(v) === undefined));
          if (bad) drops.push({ bone, channel: kind, time: bad.time, lost: "non-numeric component (molang or a word): that axis misses the key" });
        }
        ctxOf.set(c, ctx);
      }
    }
    dropsOf.set(a, drops);
  }
}

// ---------------------------------------------------------------- axis keys

interface AKey { tick: number; value: number; ease: string }
interface Built { keys: Keyframe[]; axes: [AKey[], AKey[], AKey[]] }
const builtCache = new WeakMap<Channel, Built>();

const num = (v: number | string): number | undefined => {
  if (typeof v === "number") return Number.isFinite(v) ? v : undefined;
  const n = Number(v);
  return v.trim() !== "" && Number.isFinite(n) ? n : undefined;
};
/** (int)(Float.parseFloat(key) * 20): float32 product, truncated toward zero. */
export const serializerTick = (seconds: number): number => Math.trunc(f32(f32(seconds) * 20));

function build(c: Channel, ctx: PlayerCtx): Built {
  const hit = builtCache.get(c);
  if (hit && hit.keys === c.keys) return hit;
  const axes: Built["axes"] = [[], [], []];
  const ks = sortedKeys(c);
  if (c.shape !== "scalar") {
    for (let i = 0; i < ks.length; i++) {
      const k = ks[i];
      if (k.node && k.node.t === "n") continue; // `"0.5": 3` (a bare number) is neither array nor object: ignored
      const ease = keyEase(k, ctx.kind);
      const tick = serializerTick(k.keyRaw !== undefined && Number.isFinite(parseFloat(k.keyRaw)) ? parseFloat(k.keyRaw) : k.time);
      const vecs = k.pre ? [k.pre, k.value] : [k.value];
      for (const v of vecs) {
        for (let a = 0; a < 3; a++) {
          const n = num(v[a]);
          if (n === undefined) break; // getAsFloat throws: this axis and the ones after it miss the key
          axes[a].push({ tick, value: n, ease });
        }
      }
    }
  }
  const out = { keys: c.keys, axes };
  builtCache.set(c, out);
  return out;
}

// ---------------------------------------------------------------- evaluation (KeyframeAnimationPlayer.Axis)

/** MathHelper.lerpAngle in degrees (shortest way round unless the delta is a whole-turn multiple). */
function lerpAngleDeg(d: number, a: number, b: number): number {
  const raw = b - a;
  let x = raw % 360;
  if (x > 180) x -= 360;
  if (x < -180) x += 360;
  if (Math.abs(x) * (Math.PI / 180) < 0.0001 && Math.abs(raw) > 180) x = raw;
  return a + x * d;
}

function findAtTick(keys: AKey[], tick: number): number {
  let i = -1;
  for (let j = 0; j < keys.length; j++) if (keys[j].tick <= tick) i = j; else break;
  return i; // the later of duplicate ticks, like the Java correction
}

function axisAt(keys: AKey[], tickF: number, ctx: PlayerCtx, rot: boolean): number {
  const { endTick, infinite, returnTick } = ctx;
  const cur = Math.floor(tickF);
  const delta = tickF - cur;
  const pos = findAtTick(keys, cur);
  const last = keys.length - 1;
  const before = (p: number): AKey => {
    if (p === -1) return { tick: cur < endTick ? 0 : endTick, value: 0, ease: INOUTSINE };
    const f = keys[p];
    if (!infinite && cur >= endTick && p === last && f.tick < endTick) return { tick: endTick, value: f.value, ease: f.ease };
    return f;
  };
  const after = (p: number): AKey | undefined => {
    if (keys.length > p + 1) return keys[p + 1];
    if (infinite) {
      const lp = Math.max(0, findAtTick(keys, returnTick));
      return { tick: endTick + 1, value: keys[lp].value, ease: INOUTSINE };
    }
    if (cur < endTick) { const l = keys[last]; return { tick: endTick, value: l.value, ease: l.ease }; }
    return undefined; // past the end: the game blends to the underlying pose; the preview holds
  };
  const kb = before(pos);
  let ka = after(pos);
  if (infinite && ka && ka.tick > endTick) ka = after(findAtTick(keys, returnTick - 1));
  if (!ka) return kb.value;
  let tb = kb.tick;
  let ta = ka.tick;
  const period = endTick - returnTick + 1;
  if (tb >= ta) {
    if (cur < tb) tb -= period;
    else ta += period;
  }
  if (tb === ta) return kb.value;
  const f = (cur + delta - tb) / (ta - tb);
  const e = javaEase(kb.ease)(f);
  return rot ? lerpAngleDeg(e, kb.value, ka.value) : kb.value + (ka.value - kb.value) * e;
}

/** Sample a stamped channel at clip time `t` seconds (already wrapped by `clipTime`). */
export function samplePlayerChannel(c: Channel, t: number, ctx: PlayerCtx): NumVec3 | undefined {
  if (ctx.dead) return undefined;
  const b = build(c, ctx);
  if (!b.axes[0].length && !b.axes[1].length && !b.axes[2].length) return undefined;
  const tickF = Math.max(0, t) * 20;
  const rot = ctx.kind === "rotation";
  return [0, 1, 2].map((a) => (b.axes[a].length ? axisAt(b.axes[a], tickF, ctx, rot) : 0)) as NumVec3;
}

/** clipTime for player clips: loops are endTick+1 ticks long; hold/once clamp at endTick. */
export function playerClipTime(a: Animation, t: number): number {
  const end = playerEndTick(a);
  if (a.loop === true) {
    const period = (end + 1) / 20;
    const m = t % period;
    return m < 0 ? m + period : m;
  }
  return Math.min(Math.max(0, t), end / 20);
}
