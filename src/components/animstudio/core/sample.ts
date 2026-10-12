/**
 * GeckoLib/Bedrock-faithful animation sampler.
 *
 * Semantics are taken from GeckoLib 1.21.1 source (MIT), verified 2026-10:
 *  - software/bernie/geckolib/loading/json/typeadapter/BakedAnimationsAdapter.java (keyframe building)
 *  - software/bernie/geckolib/animation/EasingType.java (easing functions, catmull-rom)
 * Rules mirrored here:
 *  - A channel is a list of SEGMENTS. Key i defines the segment from key i-1's time (0 for the first key)
 *    to its own time, starting at key i-1's end value (the first key starts at its own value, so the pose
 *    holds the first key's value from t=0 until it). The easing/easingArgs written on key i apply to the
 *    segment that ENDS at key i (NOT the one that starts there).
 *  - A bare constant array / scalar / {vector} is one key at t=0. A scalar is [s,s,s].
 *  - `{pre, post, lerp_mode}`: `pre` becomes an extra key at time-0.001 (0 when time==0) with linear easing;
 *    `post` is the key at `time`, with `lerp_mode` used as its easing. `{pre}` only: pre is the value.
 *  - catmullrom: a segment with easing "catmullrom" interpolates on the spline p0,start,end,p3 where
 *    p0 = (i<2 ? start : seg[i-2].end), p3 = (i+1>=n ? end : seg[i+1].end), delta = linear progress.
 *  - A channel with exactly one key and a non-linear easing drops the easing.
 *  - progress >= segment length yields the end value; zero-length segments yield the end value.
 *  - Easings are case-insensitive; unknown names = linear. `step` takes easingArgs[0] steps (default 2).
 *  - Rotation components are file degrees; GeckoLib negates X/Y when converting to radians but that is a
 *    renderer concern, so samples here are in file units.
 * Deviation: GeckoLib walks keys in file (JSON object) order; we sort by time, which is what Bedrock does
 * and what every real file already satisfies.
 * Looping: loop=true wraps t modulo the length; false and "hold_on_last_frame" clamp at the end.
 */
import { animLength, sortedKeys, DEFAULT_BEZIER, type Animation, type BezierHandles, type Channel, type ChannelName, type Comp, type NumVec3, type Vec3 } from "./format/animation";
import { evalMolang, type MolangEnv } from "./molang";
import { playerClipTime, playerCtx, samplePlayerChannel } from "./playersample";

export interface Segment {
  t0: number;
  t1: number;
  start: Vec3;
  end: Vec3;
  easing: string;
  args: number[];
  p0: Vec3;
  p3: Vec3;
  /** bbmodel bezier segment: handles of the start key (right) and end key (left), offsets relative to the keys. */
  bz?: { rightTime: NumVec3; rightValue: NumVec3; leftTime: NumVec3; leftValue: NumVec3 };
}

const segCache = new WeakMap<Channel, { keys: Channel["keys"]; segs: Segment[] }>();

/** Expand a channel into GeckoLib segments (cached per Channel object). */
export function channelSegments(c: Channel): Segment[] {
  const hit = segCache.get(c);
  if (hit && hit.keys === c.keys) return hit.segs;
  const segs = buildSegments(c);
  segCache.set(c, { keys: c.keys, segs });
  return segs;
}

function buildSegments(c: Channel): Segment[] {
  if (c.shape === "opaque") return [];
  const frames: Array<{ time: number; value: Vec3; easing: string; args: number[]; bz?: BezierHandles; isPre?: boolean }> = [];
  for (const k of sortedKeys(c)) {
    const hasPre = k.pre !== undefined && !(k.pre[0] === k.value[0] && k.pre[1] === k.value[1] && k.pre[2] === k.value[2]);
    const bz = k.bezier && k.bb?.interpolation === "bezier" ? k.bezier : undefined;
    if (hasPre) frames.push({ time: k.time === 0 ? 0 : k.time - 0.001, value: k.pre!, easing: "linear", args: [], bz, isPre: true });
    frames.push({ time: k.time, value: k.value, easing: (k.lerp ?? k.easing ?? "linear").toLowerCase(), args: k.easingArgs ?? [], bz });
  }
  const segs: Segment[] = [];
  for (let i = 0; i < frames.length; i++) {
    const f = frames[i];
    const prevT = i > 0 ? frames[i - 1].time : 0;
    const seg: Segment = { t0: prevT, t1: f.time, start: i === 0 ? f.value : frames[i - 1].value, end: f.value, easing: f.easing, args: f.args, p0: f.value, p3: f.value };
    // Blockbench: a segment is bezier when either of its keys is; the pre->post hop of one split key is not
    const prev = frames[i - 1];
    if (i > 0 && (f.bz || prev.bz) && !(f.bz && !f.isPre && prev.isPre)) {
      const a = prev.bz ?? DEFAULT_BEZIER;
      const b = f.bz ?? DEFAULT_BEZIER;
      seg.bz = { rightTime: a.rightTime, rightValue: a.rightValue, leftTime: b.leftTime, leftValue: b.leftValue };
      seg.easing = "linear";
    }
    segs.push(seg);
  }
  if (segs.length === 1 && segs[0].easing !== "linear" && segs[0].easing !== "none") segs[0].easing = "linear";
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    if (s.easing === "catmullrom") {
      s.p0 = i < 2 ? s.start : segs[i - 2].end;
      s.p3 = i + 1 >= segs.length ? s.end : segs[i + 1].end;
    }
  }
  return segs;
}

// ---------------------------------------------------------------- easing

type Ease = (t: number) => number;
const easeIn = (f: Ease): Ease => f;
const easeOut = (f: Ease): Ease => (t) => 1 - f(1 - t);
const easeInOut = (f: Ease): Ease => (t) => (t < 0.5 ? f(t * 2) / 2 : 1 - f((1 - t) * 2) / 2);
const sine: Ease = (n) => 1 - Math.cos((n * Math.PI) / 2);
const quad: Ease = (n) => n * n;
const cubic: Ease = (n) => n * n * n;
const circ: Ease = (n) => 1 - Math.sqrt(1 - n * n);
const expo: Ease = (n) => Math.pow(2, 10 * (n - 1));
const pow = (p: number): Ease => (t) => Math.pow(t, p);
const back = (n?: number): Ease => {
  const n2 = n === undefined ? 1.70158 : n * 1.70158;
  return (t) => t * t * ((n2 + 1) * t - n2);
};
const elastic = (n?: number): Ease => {
  const n2 = n === undefined ? 1 : n;
  return (t) => 1 - Math.pow(Math.cos((t * Math.PI) / 2), 3) * Math.cos(t * n2 * Math.PI);
};
const bounce = (n?: number): Ease => {
  const n2 = n === undefined ? 0.5 : n;
  const one = (x: number) => (121 / 16) * x * x;
  const two = (x: number) => (121 / 4) * n2 * Math.pow(x - 6 / 11, 2) + 1 - n2;
  const three = (x: number) => 121 * n2 * n2 * Math.pow(x - 9 / 11, 2) + 1 - n2 * n2;
  const four = (x: number) => 484 * n2 * n2 * n2 * Math.pow(x - 10.5 / 11, 2) + 1 - n2 * n2 * n2;
  return (t) => Math.min(Math.min(one(t), two(t)), Math.min(three(t), four(t)));
};
const stepFn = (n?: number): Ease => {
  const n2 = n === undefined ? 2 : n;
  const steps = Math.max(2, Math.trunc(n2)); // GeckoLib throws below 2; clamp instead
  return (t) => {
    if (t < 0) return 0;
    const len = 1 / steps;
    const last = (steps - 1) * len;
    if (t > last) return last;
    let l = 0;
    let r = steps - 1;
    while (r - l !== 1) {
      const m = l + Math.trunc((r - l) / 2);
      if (t >= m * len) l = m;
      else r = m;
    }
    return l * len;
  };
};
const catmullRomN: Ease = (n) =>
  0.5 * (2 * (n + 1) + 2 + (2 * n - 5 * (n + 1) + 4 * (n + 2) - (n + 3)) + (3 * (n + 1) - n - 3 * (n + 2) + (n + 3)));

const FAMILIES: Record<string, (arg?: number) => Ease> = {
  sine: () => sine, quad: () => quad, cubic: () => cubic, quart: () => pow(4), quint: () => pow(5),
  expo: () => expo, circ: () => circ, back, elastic, bounce,
};

/** Eased progress (0..1 → 0..1) for a GeckoLib easing name; `undefined` for linear/unknown. */
export function easingFn(name: string, arg?: number): Ease | undefined {
  const n = name.toLowerCase();
  if (n === "step") return stepFn(arg);
  if (n === "catmullrom") return easeInOut(catmullRomN);
  const m = /^ease(inout|in|out)(\w+)$/.exec(n);
  if (!m) return undefined;
  const fam = FAMILIES[m[2]];
  if (!fam) return undefined;
  const f = fam(arg);
  return m[1] === "in" ? easeIn(f) : m[1] === "out" ? easeOut(f) : easeInOut(f);
}

/** Apply a named easing to progress p (linear for unknown names). */
export function applyEasing(name: string | undefined, p: number, args?: number[]): number {
  if (!name) return p;
  const f = easingFn(name, args?.[0]);
  return f ? f(p) : p;
}

export const EASING_NAMES: string[] = (() => {
  const out = ["linear", "step"];
  for (const kind of ["easeIn", "easeOut", "easeInOut"]) for (const fam of ["Sine", "Quad", "Cubic", "Quart", "Quint", "Expo", "Circ", "Back", "Elastic", "Bounce"]) out.push(kind + fam);
  return out;
})();

const spline = (d: number, p0: number, p1: number, p2: number, p3: number) =>
  0.5 * (2 * p1 + (p2 - p0) * d + (2 * p0 - 5 * p1 + 4 * p2 - p3) * d * d + (3 * p1 - p0 - 3 * p2 + p3) * d * d * d);

/**
 * Value at time `t` of the cubic Bezier through P0=(tA,vA), P1=(tA+rt,vA+rv), P2=(tB+lt,vB+lv), P3=(tB,vB).
 * Handle times are clamped into [tA,tB] so x(u) is monotonic; u is found with Newton steps guarded by bisection.
 */
export function bezierAt(tA: number, tB: number, t: number, vA: number, vB: number, rt: number, rv: number, lt: number, lv: number): number {
  const x1 = Math.min(Math.max(tA + rt, tA), tB);
  const x2 = Math.min(Math.max(tB + lt, tA), tB);
  const y1 = vA + rv;
  const y2 = vB + lv;
  const cub = (p0: number, p1: number, p2: number, p3: number, u: number) => {
    const m = 1 - u;
    return m * m * m * p0 + 3 * m * m * u * p1 + 3 * m * u * u * p2 + u * u * u * p3;
  };
  const dcub = (p0: number, p1: number, p2: number, p3: number, u: number) => {
    const m = 1 - u;
    return 3 * m * m * (p1 - p0) + 6 * m * u * (p2 - p1) + 3 * u * u * (p3 - p2);
  };
  if (t <= tA) return vA;
  if (t >= tB) return vB;
  let lo = 0;
  let hi = 1;
  let u = (t - tA) / (tB - tA);
  for (let i = 0; i < 40; i++) {
    const x = cub(tA, x1, x2, tB, u) - t;
    if (Math.abs(x) < 1e-12) break;
    if (x > 0) hi = u;
    else lo = u;
    const d = dcub(tA, x1, x2, tB, u);
    let nu = d > 1e-12 ? u - x / d : (lo + hi) / 2;
    if (nu <= lo || nu >= hi) nu = (lo + hi) / 2;
    u = nu;
  }
  return cub(vA, y1, y2, vB, u);
}

// ---------------------------------------------------------------- sampling

export interface SampleOptions {
  env?: MolangEnv;
  /** Apply loop/clamp to `t` (default true). Pass false when `t` is already in clip time. */
  wrap?: boolean;
}
// Clip semantics: an Animation stamped "player" (see playersample.ts; stamped by getAnimations from Doc.semantics) is sampled
// with the player/armor reader's rules; everything else keeps the GeckoLib geo rules below.

const comp = (c: Comp, env: MolangEnv): number => (typeof c === "number" ? c : evalMolang(c, env));

function evalSegment(s: Segment, t: number, env: MolangEnv): NumVec3 {
  const len = s.t1 - s.t0;
  const progress = t - s.t0;
  const out: NumVec3 = [0, 0, 0];
  if (s.bz) {
    const bz = s.bz;
    for (let a = 0; a < 3; a++) {
      const e = comp(s.end[a], env);
      if (len <= 0 || progress >= len) { out[a] = e; continue; }
      out[a] = bezierAt(s.t0, s.t1, t, comp(s.start[a], env), e, bz.rightTime[a], bz.rightValue[a], bz.leftTime[a], bz.leftValue[a]);
    }
    return out;
  }
  const cm = s.easing === "catmullrom";
  const fn = cm ? undefined : easingFn(s.easing, s.args[0]);
  for (let a = 0; a < 3; a++) {
    const e = comp(s.end[a], env);
    if (len <= 0 || progress >= len) {
      out[a] = e;
      continue;
    }
    const st = comp(s.start[a], env);
    const p = progress / len;
    if (cm) out[a] = spline(p, comp(s.p0[a], env), st, e, comp(s.p3[a], env));
    else out[a] = st + (e - st) * (fn ? fn(p) : p);
  }
  return out;
}

/** Sample a channel at clip time `t` seconds (already wrapped). */
export function sampleChannelRaw(c: Channel, t: number, env: MolangEnv = {}): NumVec3 | undefined {
  const pc = playerCtx(c);
  if (pc) return samplePlayerChannel(c, t, pc);
  const segs = channelSegments(c);
  if (segs.length === 0) return undefined;
  const e: MolangEnv = { anim_time: t, life_time: env.life_time ?? t, vars: env.vars };
  for (let i = 0; i < segs.length; i++) if (t <= segs[i].t1) return evalSegment(segs[i], t, e);
  const last = segs[segs.length - 1];
  return [comp(last.end[0], e), comp(last.end[1], e), comp(last.end[2], e)];
}

/** Map absolute playback time to clip time using the loop mode. */
export function clipTime(anim: Animation, t: number): number {
  if (anim.semantics === "player") return playerClipTime(anim, t);
  const len = animLength(anim);
  if (!(len > 0)) return Math.max(0, t);
  if (anim.loop === true) {
    const m = t % len;
    return m < 0 ? m + len : m;
  }
  return Math.min(Math.max(0, t), len);
}

export function sampleChannel(anim: Animation, bone: string, channel: ChannelName, t: number, opts: SampleOptions = {}): NumVec3 | undefined {
  const c = anim.bones.get(bone)?.[channel];
  if (!c) return undefined;
  return sampleChannelRaw(c, opts.wrap === false ? t : clipTime(anim, t), opts.env);
}

export interface BonePose {
  rotation?: NumVec3;
  position?: NumVec3;
  scale?: NumVec3;
}
export type Pose = Record<string, BonePose>;

export function samplePose(anim: Animation, t: number, opts: SampleOptions = {}): Pose {
  const ct = opts.wrap === false ? t : clipTime(anim, t);
  const pose: Pose = {};
  for (const [name, b] of anim.bones) {
    const p: BonePose = {};
    if (b.rotation) p.rotation = sampleChannelRaw(b.rotation, ct, opts.env);
    if (b.position) p.position = sampleChannelRaw(b.position, ct, opts.env);
    if (b.scale) p.scale = sampleChannelRaw(b.scale, ct, opts.env);
    if (p.rotation || p.position || p.scale) pose[name] = p;
  }
  return pose;
}

export const REST: Record<ChannelName, NumVec3> = { rotation: [0, 0, 0], position: [0, 0, 0], scale: [1, 1, 1] };
