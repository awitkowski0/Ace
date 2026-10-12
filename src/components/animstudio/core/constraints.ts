/**
 * Limb links ("constraints"): an authoring aid. The game only reads keyframes, so constraints drive the preview live and are
 * BAKED to ordinary rotation keys (`bakeConstraints`). Blockbench does the same with IK (`sampleIK` on Bedrock export).
 *
 * Kinds (all evaluated in list order, after the clip is sampled):
 *  - link   point A on a bone meets point B on another bone. The "driven" side(s) rotate about their own pivots (aim-style solve:
 *           the smallest rotation from the animated pose, so roll from the animation is kept). Both driven = they meet in the middle.
 *  - pin    point A on a bone stays at a world position captured at a chosen frame (planted hand / foot).
 *  - follow bone Y copies bone X's rotation (optional L<->R mirror and an offset).
 *
 * Kinematics are done in *scene space* exactly like ui/viewport/rigView.ts (x = -file x, euler (-(r+a)x, -(r+a)y, (r+a)z) in ZYX),
 * so what the solver reaches is what the viewport shows. Scale channels are ignored by the solve.
 * A point lives in the bone's own frame as raw file coordinates (the numbers you see on the cubes), so it follows the bone.
 */
import { CHANNELS, type Animation, type Keyframe, type NumVec3, type Vec3 } from "./format/animation";
import { fromValue, getKey, isObj, setEntry, toValue, type JObj } from "./format/json";
import { deleteKeyframes, getAnimation, insertKeys, type Doc } from "./doc";
import { eulerToQuat, nearestEuler, quatMul, quatNormalize, quatRotate, slerp, type Quat } from "./math";
import { BONE_ALIASES } from "./rig";
import { animLength } from "./format/animation";
import { sampleChannelRaw, samplePose, type BonePose, type Pose } from "./sample";

export const TICK = 0.05;

// ---------------------------------------------------------------- model

/** A point on a bone. `p` = raw file coordinates in the bone's frame; `via` = the bone that rotates to move it (default: `bone`). */
export interface PointRef {
  bone: string;
  p: NumVec3;
  via?: string;
}
interface Base {
  id: string;
  name: string;
  enabled: boolean;
  /** 0..1 */
  influence: number;
  /** seconds; `end` null = end of the clip */
  start: number;
  end: number | null;
  /** ramp lengths in ticks (0.05 s) */
  blendIn: number;
  blendOut: number;
}
export type Drive = "a" | "b" | "both";
export interface LinkConstraint extends Base { kind: "link"; a: PointRef; b: PointRef; drive: Drive }
export interface PinConstraint extends Base { kind: "pin"; point: PointRef; /** world position in file space (x negated scene space) */ world: NumVec3; /** time the position was captured at */ frame: number }
export interface FollowConstraint extends Base { kind: "follow"; source: string; target: string; mirror: boolean; offset: NumVec3 }
export type Constraint = LinkConstraint | PinConstraint | FollowConstraint;
export type ConstraintMap = Record<string, Constraint[]>;

export interface ConsBone { name: string; parent?: string; pivot: NumVec3; rotation?: NumVec3 }

const baseDefaults = (): Omit<Base, "id" | "name"> => ({ enabled: true, influence: 1, start: 0, end: null, blendIn: 0, blendOut: 0 });
let seq = 0;
export const newConstraintId = () => `c${Date.now().toString(36)}${(seq++).toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;

export const viaOf = (p: PointRef) => p.via ?? p.bone;
export function makeLink(a: PointRef, b: PointRef, drive: Drive = "b", extra: Partial<Base> = {}): LinkConstraint {
  return { id: newConstraintId(), name: `${viaOf(a)} ↔ ${viaOf(b)}`, kind: "link", ...baseDefaults(), a, b, drive, ...extra };
}
export function makePin(point: PointRef, world: NumVec3, frame: number, extra: Partial<Base> = {}): PinConstraint {
  return { id: newConstraintId(), name: `Pin ${viaOf(point)}`, kind: "pin", ...baseDefaults(), point, world, frame, ...extra };
}
export function makeFollow(source: string, target: string, mirror = false, extra: Partial<Base> = {}): FollowConstraint {
  return { id: newConstraintId(), name: `${target} follows ${source}`, kind: "follow", ...baseDefaults(), source, target, mirror, offset: [0, 0, 0], ...extra };
}

/** Bones whose rotation this constraint writes. */
export function drivenBones(c: Constraint): string[] {
  if (c.kind === "pin") return [viaOf(c.point)];
  if (c.kind === "follow") return [c.target];
  return c.drive === "a" ? [viaOf(c.a)] : c.drive === "b" ? [viaOf(c.b)] : [...new Set([viaOf(c.a), viaOf(c.b)])];
}
/** Bones whose pose the constraint reads (inputs). */
export function inputBones(c: Constraint): string[] {
  if (c.kind === "pin") return [c.point.bone];
  if (c.kind === "follow") return [c.source];
  return [c.a.bone, c.b.bone];
}

// ---------------------------------------------------------------- time weight

export const constraintEnd = (c: Base, length: number) => (c.end == null ? length : c.end);
/** Influence at clip time t: 0 outside [start, end], linear ramps of `blendIn` / `blendOut` ticks, times `influence`. */
export function constraintWeight(c: Base, t: number, length: number): number {
  const end = constraintEnd(c, length);
  if (t < c.start - 1e-6 || t > end + 1e-6) return 0;
  let w = 1;
  if (c.blendIn > 0) w = Math.min(w, Math.max(0, (t - c.start) / (c.blendIn * TICK)));
  if (c.blendOut > 0) w = Math.min(w, Math.max(0, (end - t) / (c.blendOut * TICK)));
  return Math.max(0, Math.min(1, w * c.influence));
}

// ---------------------------------------------------------------- kinematics (scene space)

interface Xf { q: Quat; p: NumVec3 }
const IDQ: Quat = [0, 0, 0, 1];
const sceneVec = (v: NumVec3): NumVec3 => [-v[0], v[1], v[2]];
const sub = (a: NumVec3, b: NumVec3): NumVec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: NumVec3, b: NumVec3): NumVec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scl = (a: NumVec3, k: number): NumVec3 => [a[0] * k, a[1] * k, a[2] * k];
const dot = (a: NumVec3, b: NumVec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const len = (a: NumVec3) => Math.hypot(a[0], a[1], a[2]);
const cross = (a: NumVec3, b: NumVec3): NumVec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const conj = (q: Quat): Quat => [-q[0], -q[1], -q[2], q[3]];
const norm = (a: NumVec3): NumVec3 => { const l = len(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

/** Shortest rotation taking unit vector a to unit vector b. */
function quatFromTo(a: NumVec3, b: NumVec3): Quat {
  const d = dot(a, b);
  if (d > 0.999999999) return IDQ;
  if (d < -0.999999999) {
    const ax = norm(Math.abs(a[0]) < 0.9 ? cross(a, [1, 0, 0]) : cross(a, [0, 1, 0]));
    return [ax[0], ax[1], ax[2], 0];
  }
  const c = cross(a, b);
  return quatNormalize([c[0], c[1], c[2], 1 + d]);
}

/** Scene euler (deg, ZYX) of a bone: rest rotation r plus animation rotation a (see rigView.setPose). */
export function sceneEuler(rest: NumVec3 | undefined, anim: NumVec3 | undefined): NumVec3 {
  const r = rest ?? [0, 0, 0], a = anim ?? [0, 0, 0];
  return [-(r[0] + a[0]), -(r[1] + a[1]), r[2] + a[2]];
}
/** Animation rotation (file degrees) whose scene local rotation is `q`, as the euler nearest `ref` (the current animation rotation). */
export function animRotFromLocal(rest: NumVec3 | undefined, q: Quat, ref: NumVec3 | undefined): NumVec3 {
  const r = rest ?? [0, 0, 0];
  const s = nearestEuler(q, sceneEuler(rest, ref));
  return [-s[0] - r[0], -s[1] - r[1], s[2] - r[2]];
}

export const bonePose = (pose: Pose, name: string): BonePose | undefined => pose[name] ?? pose[BONE_ALIASES[name] ?? ""];

export class Skeleton {
  readonly bones = new Map<string, ConsBone>();
  /** parents before children */
  readonly order: string[] = [];
  constructor(list: readonly ConsBone[]) {
    for (const b of list) this.bones.set(b.name, b);
    const seen = new Set<string>();
    const visit = (n: string, stack: Set<string>) => {
      if (seen.has(n) || stack.has(n)) return;
      stack.add(n);
      const p = this.bones.get(n)?.parent;
      if (p && this.bones.has(p) && p !== n) visit(p, stack);
      stack.delete(n);
      seen.add(n);
      this.order.push(n);
    };
    for (const b of list) visit(b.name, new Set());
  }
  has(name: string) { return this.bones.has(name); }
  parentOf(name: string): string | undefined { const p = this.bones.get(name)?.parent; return p && this.bones.has(p) && p !== name ? p : undefined; }
  /** is `anc` an ancestor of (or equal to) `name` */
  isAncestor(anc: string, name: string): boolean {
    for (let n: string | undefined = name, i = 0; n && i < 512; n = this.parentOf(n), i++) if (n === anc) return true;
    return false;
  }
  chain(name: string): string[] {
    const out: string[] = [];
    for (let n: string | undefined = name, i = 0; n && i < 512; n = this.parentOf(n), i++) out.push(n);
    return out;
  }
  /** Scene-space world transform of every bone under `pose`. */
  worlds(pose: Pose): Map<string, Xf> {
    const out = new Map<string, Xf>();
    for (const name of this.order) {
      const b = this.bones.get(name)!;
      const par = this.parentOf(name);
      const pv = sceneVec(b.pivot);
      const qv = par ? sceneVec(this.bones.get(par)!.pivot) : ([0, 0, 0] as NumVec3);
      const bp = bonePose(pose, name);
      const pos = bp?.position;
      const lp: NumVec3 = pos ? [pv[0] - qv[0] - pos[0], pv[1] - qv[1] + pos[1], pv[2] - qv[2] + pos[2]] : sub(pv, qv);
      const lq = eulerToQuat(sceneEuler(b.rotation, bp?.rotation));
      const pw = par ? out.get(par)! : { q: IDQ, p: [0, 0, 0] as NumVec3 };
      out.set(name, { q: quatMul(pw.q, lq), p: add(pw.p, quatRotate(pw.q, lp)) });
    }
    return out;
  }
  /** local (bone frame, scene axes) offset of a file-space point from the bone origin */
  localOf(ref: PointRef): NumVec3 {
    const b = this.bones.get(ref.bone);
    const pv: NumVec3 = b ? b.pivot : [0, 0, 0];
    return sceneVec(sub(ref.p, pv));
  }
  pointWorld(w: Map<string, Xf>, ref: PointRef): NumVec3 {
    const x = w.get(ref.bone);
    if (!x) return sceneVec(ref.p);
    return add(x.p, quatRotate(x.q, this.localOf(ref)));
  }
  /** File-space bone-frame coordinates of a scene world position (the inverse of pointWorld). */
  fileFromWorld(w: Map<string, Xf>, bone: string, world: NumVec3): NumVec3 {
    const x = w.get(bone);
    const b = this.bones.get(bone);
    if (!x || !b) return sceneVec(world);
    const l = quatRotate(conj(x.q), sub(world, x.p));
    return add(sceneVec(l), b.pivot);
  }
}

const skCache = new WeakMap<object, Skeleton>();
export function skeletonOf(bones: readonly ConsBone[]): Skeleton {
  let s = skCache.get(bones);
  if (!s) skCache.set(bones, (s = new Skeleton(bones)));
  return s;
}

/** World position (file space) of a point under `pose`. */
export function pointWorldFile(sk: Skeleton, pose: Pose, ref: PointRef): NumVec3 {
  return sceneVec(sk.pointWorld(sk.worlds(pose), ref));
}

// ---------------------------------------------------------------- solvers

function withRot(pose: Pose, name: string, rot: NumVec3): void {
  const cur = pose[name] ?? bonePose(pose, name);
  pose[name] = { ...(cur ?? {}), rotation: rot };
}

/** Rotate `via` (smallest rotation) so the point direction from its pivot aims at `target`. Returns false when nothing could be done. */
function aimOnce(sk: Skeleton, work: Pose, ref: PointRef, via: string, target: NumVec3): boolean {
  const w = sk.worlds(work);
  const x = w.get(via);
  if (!x) return false;
  const v = sub(sk.pointWorld(w, ref), x.p);
  const d = sub(target, x.p);
  if (len(v) < 1e-9 || len(d) < 1e-9) return false;
  const delta = quatFromTo(norm(v), norm(d));
  const par = sk.parentOf(via);
  const parentQ = par ? w.get(par)!.q : IDQ;
  const localQ = quatMul(conj(parentQ), quatMul(delta, x.q));
  withRot(work, via, animRotFromLocal(sk.bones.get(via)!.rotation, localQ, bonePose(work, via)?.rotation));
  return true;
}

/** Point on the circle where two spheres meet that is closest to `q`; falls back to aiming along the line of centres. */
function meetingTargets(ca: NumVec3, ra: number, cb: NumVec3, rb: number, q: NumVec3, pa: NumVec3): [NumVec3, NumVec3] {
  const dv = sub(cb, ca);
  const d = len(dv);
  if (d < 1e-9) return [pa, pa];
  const u = scl(dv, 1 / d);
  if (d > ra + rb) { const m = add(ca, scl(u, d / 2)); return [m, m]; }
  if (d < Math.abs(ra - rb)) return [add(ca, scl(u, ra)), add(cb, scl(u, rb))];
  const x = (d * d + ra * ra - rb * rb) / (2 * d);
  const rho = Math.sqrt(Math.max(0, ra * ra - x * x));
  const k = add(ca, scl(u, x));
  let w = sub(q, k);
  w = sub(w, scl(u, dot(w, u)));
  if (len(w) < 1e-7) { w = sub(pa, k); w = sub(w, scl(u, dot(w, u))); }
  if (len(w) < 1e-7) w = Math.abs(u[1]) < 0.9 ? cross(u, [0, 1, 0]) : cross(u, [1, 0, 0]);
  const m = add(k, scl(norm(w), rho));
  return [m, m];
}

function solveLink(sk: Skeleton, work: Pose, c: LinkConstraint, fixed: ReadonlySet<string> | undefined): void {
  const va = viaOf(c.a), vb = viaOf(c.b);
  let drive: Drive = c.drive;
  const lockedA = !!fixed?.has(va), lockedB = !!fixed?.has(vb);
  if (drive === "both" && lockedA && !lockedB) drive = "b";
  else if (drive === "both" && lockedB && !lockedA) drive = "a";
  if ((drive === "a" && lockedA) || (drive === "b" && lockedB) || (drive === "both" && lockedA && lockedB)) return;
  if (drive === "both" && va === vb) drive = "a";
  if (!sk.has(va) || !sk.has(vb)) return;
  for (let pass = 0; pass < 4; pass++) {
    const w = sk.worlds(work);
    const A = sk.pointWorld(w, c.a), B = sk.pointWorld(w, c.b);
    if (len(sub(A, B)) < 1e-7) return;
    if (drive === "both") {
      const ca = w.get(va)!.p, cb = w.get(vb)!.p;
      const [ta, tb] = meetingTargets(ca, len(sub(A, ca)), cb, len(sub(B, cb)), scl(add(A, B), 0.5), A);
      // the shallower bone first, so a descendant sees its parent's new position
      const first = sk.isAncestor(va, vb) ? 0 : sk.isAncestor(vb, va) ? 1 : 0;
      for (const side of first === 0 ? [0, 1] : [1, 0]) {
        if (side === 0) aimOnce(sk, work, c.a, va, ta); else aimOnce(sk, work, c.b, vb, tb);
      }
    } else if (drive === "a") aimOnce(sk, work, c.a, va, B);
    else aimOnce(sk, work, c.b, vb, A);
  }
}

function solvePin(sk: Skeleton, work: Pose, c: PinConstraint, fixed: ReadonlySet<string> | undefined): void {
  const via = viaOf(c.point);
  if (fixed?.has(via) || !sk.has(via)) return;
  const target = sceneVec(c.world);
  for (let pass = 0; pass < 4; pass++) {
    const w = sk.worlds(work);
    if (len(sub(sk.pointWorld(w, c.point), target)) < 1e-7) return;
    aimOnce(sk, work, c.point, via, target);
  }
}

const mirrorRot = (r: NumVec3): NumVec3 => [r[0], -r[1], -r[2]];

/** Blend two animation rotations through their real (scene) local rotations. */
export function blendAnimRot(rest: NumVec3 | undefined, a: NumVec3 | undefined, b: NumVec3, w: number): NumVec3 {
  if (w >= 1) return b;
  const a0 = a ?? [0, 0, 0];
  if (w <= 0) return a0;
  const q = slerp(eulerToQuat(sceneEuler(rest, a0)), eulerToQuat(sceneEuler(rest, b)), w);
  return animRotFromLocal(rest, q, a0);
}

export interface ApplyOptions {
  /** clip time (seconds) the pose was sampled at */
  t: number;
  /** clip length, for open-ended ranges */
  length: number;
  /** bones the user is dragging: never modified (the other side follows) */
  fixed?: ReadonlySet<string>;
  /** only these constraint ids (default: every enabled one) */
  only?: ReadonlySet<string>;
}

/**
 * Evaluate constraints on a sampled pose. Returns a NEW pose (the input is untouched); bones that are not driven keep their
 * object identity. Results are written under the rig bone's own name.
 */
export function applyConstraints(bones: readonly ConsBone[] | Skeleton, list: readonly Constraint[], pose: Pose, o: ApplyOptions): Pose {
  if (!list.length) return pose;
  const sk = bones instanceof Skeleton ? bones : skeletonOf(bones);
  let out: Pose | null = null;
  for (const c of list) {
    if (o.only ? !o.only.has(c.id) : !c.enabled) continue;
    const w = constraintWeight(c, o.t, o.length);
    if (w <= 0) continue;
    const work: Pose = out ? { ...out } : { ...pose };
    if (c.kind === "follow") {
      if (o.fixed?.has(c.target) || !sk.has(c.target)) continue;
      const src = bonePose(work, c.source)?.rotation ?? [0, 0, 0];
      const m = c.mirror ? mirrorRot(src) : src;
      const want: NumVec3 = [m[0] + c.offset[0], m[1] + c.offset[1], m[2] + c.offset[2]];
      const cur = bonePose(work, c.target)?.rotation;
      withRot(work, c.target, blendAnimRot(sk.bones.get(c.target)!.rotation, cur, want, w));
      out = work;
      continue;
    }
    const before = new Map<string, NumVec3 | undefined>();
    for (const b of drivenBones(c)) before.set(b, bonePose(work, b)?.rotation);
    if (c.kind === "link") solveLink(sk, work, c, o.fixed); else solvePin(sk, work, c, o.fixed);
    if (w < 1) for (const [b, r0] of before) {
      const solved = bonePose(work, b)?.rotation;
      if (solved && solved !== r0) withRot(work, b, blendAnimRot(sk.bones.get(b)?.rotation, r0, solved, w));
    }
    out = work;
  }
  return out ?? pose;
}

// ---------------------------------------------------------------- bake

export interface BakeOptions {
  anim: string;
  /** constraints to bake (default: every enabled one). The others are still evaluated for context. */
  ids?: readonly string[];
  /** "ticks" = a key every 0.05 s; "keys" = only at times where an input or driven bone already has a key */
  at?: "ticks" | "keys";
  /** drop keys that a straight line between neighbours reproduces within this many degrees (0 = off) */
  simplify?: number;
}
export interface BakeResult { doc: Doc; bones: string[]; keys: number }

const r4 = (v: number) => Math.round(v * 10000) / 10000;
const r3 = (v: number) => { const x = Math.round(v * 1000) / 1000; return x === 0 ? 0 : x; };
const unwrap = (v: number, ref: number) => v + 360 * Math.round((ref - v) / 360);

/** Greedy Douglas-Peucker over (time, euler) samples; the series interpolates linearly like the baked keys do. */
export function simplifySeries(ts: readonly number[], vs: readonly NumVec3[], tol: number): number[] {
  const n = ts.length;
  if (n <= 2 || !(tol > 0)) return ts.map((_, i) => i);
  const keep = new Array<boolean>(n).fill(false);
  keep[0] = keep[n - 1] = true;
  const stack: Array<[number, number]> = [[0, n - 1]];
  while (stack.length) {
    const [i0, i1] = stack.pop()!;
    let worst = -1, wd = tol;
    for (let i = i0 + 1; i < i1; i++) {
      const f = (ts[i] - ts[i0]) / (ts[i1] - ts[i0] || 1);
      const dev = Math.max(...[0, 1, 2].map((a) => Math.abs(vs[i][a] - (vs[i0][a] + (vs[i1][a] - vs[i0][a]) * f))));
      if (dev > wd) { wd = dev; worst = i; }
    }
    if (worst >= 0) { keep[worst] = true; stack.push([i0, worst], [worst, i1]); }
  }
  return keep.map((k, i) => (k ? i : -1)).filter((i) => i >= 0);
}

function animBoneName(anim: Animation, bone: string): string {
  if (anim.bones.has(bone)) return bone;
  const alias = BONE_ALIASES[bone];
  return alias && anim.bones.has(alias) ? alias : bone;
}

/**
 * Bake constraints into rotation keys of the driven bones. Per driven bone the covered range is the union of the ranges of the
 * constraints that drive it; existing rotation keys inside that range are replaced by the sampled result. Euler values are
 * unwrapped against the previous sample (no >180 degree jumps). One doc, so one undo step.
 */
export function bakeConstraints(doc: Doc, bones: readonly ConsBone[], list: readonly Constraint[], o: BakeOptions): BakeResult {
  const anim = getAnimation(doc, o.anim);
  if (!anim) throw new Error(`No animation "${o.anim}"`);
  const sk = skeletonOf(bones);
  const length = animLength(anim);
  const chosen = list.filter((c) => (o.ids ? o.ids.includes(c.id) : c.enabled));
  if (!chosen.length) return { doc, bones: [], keys: 0 };
  const only = new Set(list.filter((c) => c.enabled || chosen.includes(c)).map((c) => c.id));
  const ranges = new Map<string, [number, number]>();
  const inputs = new Map<string, Set<string>>();
  for (const c of chosen) {
    const lo = Math.max(0, c.start), hi = Math.min(length, constraintEnd(c, length));
    if (hi < lo) continue;
    for (const b of drivenBones(c)) {
      const cur = ranges.get(b);
      ranges.set(b, cur ? [Math.min(cur[0], lo), Math.max(cur[1], hi)] : [lo, hi]);
      const set = inputs.get(b) ?? new Set<string>();
      set.add(b);
      for (const i of inputBones(c)) set.add(i);
      inputs.set(b, set);
    }
  }
  const sampleTimes = (b: string, lo: number, hi: number): number[] => {
    const out = new Set<number>([r4(lo), r4(hi)]);
    if ((o.at ?? "ticks") === "ticks") {
      for (let n = Math.ceil(lo / TICK - 1e-9); n * TICK <= hi + 1e-9; n++) out.add(r4(n * TICK));
    } else {
      for (const name of inputs.get(b) ?? []) {
        const bp = anim.bones.get(animBoneName(anim, name));
        for (const ch of CHANNELS) for (const k of bp?.[ch]?.keys ?? []) if (k.time >= lo - 1e-6 && k.time <= hi + 1e-6) out.add(r4(k.time));
      }
    }
    return [...out].sort((x, y) => x - y);
  };
  const perBone = new Map<string, number[]>();
  for (const [b, [lo, hi]] of ranges) perBone.set(b, sampleTimes(b, lo, hi));
  const allTimes = [...new Set([...perBone.values()].flat())].sort((x, y) => x - y);
  const series = new Map<string, { t: number; v: NumVec3 }[]>();
  for (const t of allTimes) {
    const base = samplePose(anim, t, { wrap: false });
    const solved = applyConstraints(sk, list, base, { t, length, only });
    for (const [b, ts] of perBone) {
      if (!ts.includes(t)) continue;
      const rot = bonePose(solved, b)?.rotation ?? bonePose(base, b)?.rotation ?? [0, 0, 0];
      const s = series.get(b) ?? [];
      s.push({ t, v: [rot[0], rot[1], rot[2]] });
      series.set(b, s);
    }
  }
  let next = doc;
  let total = 0;
  const items: Array<{ bone: string; channel: "rotation"; key: Keyframe }> = [];
  const del: Array<{ bone: string; channel: "rotation"; time: number }> = [];
  for (const [b, s] of series) {
    const name = animBoneName(anim, b);
    const ch = anim.bones.get(name)?.rotation;
    const [lo, hi] = ranges.get(b)!;
    // continuity: unwrap against the clip's own rotation at the start, then against the previous sample
    let prev: NumVec3 = ch ? (sampleChannelRaw(ch, lo, { anim_time: lo }) ?? [0, 0, 0]) : [0, 0, 0];
    const vs: NumVec3[] = s.map((x) => {
      const u: NumVec3 = [unwrap(x.v[0], prev[0]), unwrap(x.v[1], prev[1]), unwrap(x.v[2], prev[2])];
      prev = u;
      return u;
    });
    const idx = simplifySeries(s.map((x) => x.t), vs, o.simplify ?? 0);
    for (const k of ch?.keys ?? []) if (k.time >= lo - 1e-4 && k.time <= hi + 1e-4) del.push({ bone: name, channel: "rotation", time: k.time });
    for (const i of idx) items.push({ bone: name, channel: "rotation", key: { time: s[i].t, value: [r3(vs[i][0]), r3(vs[i][1]), r3(vs[i][2])] as Vec3 } });
    total += idx.length;
  }
  if (del.length) next = deleteKeyframes(next, { anim: o.anim, keys: del });
  if (items.length) next = insertKeys(next, o.anim, items);
  return { doc: next, bones: [...series.keys()], keys: total };
}

/** Does the animation have any enabled constraint that would change the preview (for the "unbaked" indicator). */
export const liveConstraintCount = (list: readonly Constraint[] | undefined) => (list ?? []).filter((c) => c.enabled && c.influence > 0).length;

// ---------------------------------------------------------------- persistence (plain JSON)

const num3 = (v: unknown, d: NumVec3 = [0, 0, 0]): NumVec3 => (Array.isArray(v) && v.length >= 3 && v.slice(0, 3).every((x) => typeof x === "number" && Number.isFinite(x)) ? [v[0], v[1], v[2]] : d);
const pointFrom = (v: unknown): PointRef | null => {
  const o = v as { bone?: unknown; p?: unknown; via?: unknown } | null;
  if (!o || typeof o.bone !== "string" || !Array.isArray(o.p)) return null;
  return { bone: o.bone, p: num3(o.p), ...(typeof o.via === "string" && o.via !== o.bone ? { via: o.via } : {}) };
};
const clamp01 = (n: unknown, d: number) => (typeof n === "number" && Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : d);
const nn = (n: unknown, d: number) => (typeof n === "number" && Number.isFinite(n) && n >= 0 ? n : d);

export function constraintFromJson(raw: unknown): Constraint | null {
  const o = raw as Record<string, unknown> | null;
  if (!o || typeof o !== "object") return null;
  const base = {
    id: typeof o.id === "string" && o.id ? o.id : newConstraintId(),
    name: typeof o.name === "string" ? o.name : "Constraint",
    enabled: o.enabled !== false,
    influence: clamp01(o.influence, 1),
    start: nn(o.start, 0),
    end: typeof o.end === "number" && Number.isFinite(o.end) ? o.end : null,
    blendIn: nn(o.blendIn, 0),
    blendOut: nn(o.blendOut, 0),
  };
  if (o.kind === "link") {
    const a = pointFrom(o.a), b = pointFrom(o.b);
    if (!a || !b) return null;
    return { ...base, kind: "link", a, b, drive: o.drive === "a" || o.drive === "both" ? o.drive : "b" };
  }
  if (o.kind === "pin") {
    const point = pointFrom(o.point);
    if (!point) return null;
    return { ...base, kind: "pin", point, world: num3(o.world), frame: nn(o.frame, 0) };
  }
  if (o.kind === "follow") {
    if (typeof o.source !== "string" || typeof o.target !== "string") return null;
    return { ...base, kind: "follow", source: o.source, target: o.target, mirror: o.mirror === true, offset: num3(o.offset) };
  }
  return null;
}
export function constraintsFromJson(raw: unknown): ConstraintMap {
  const out: ConstraintMap = {};
  const anims = (raw as { animations?: Record<string, unknown> } | null)?.animations;
  if (!anims || typeof anims !== "object") return out;
  for (const [name, list] of Object.entries(anims)) {
    if (!Array.isArray(list)) continue;
    const cs = list.map(constraintFromJson).filter((c): c is Constraint => !!c);
    if (cs.length) out[name] = cs;
  }
  return out;
}
export function constraintsToJson(map: ConstraintMap): { version: 1; animations: Record<string, Constraint[]> } {
  const animations: Record<string, Constraint[]> = {};
  for (const [k, v] of Object.entries(map)) if (v.length) animations[k] = v;
  return { version: 1, animations };
}

/** Top-level bbmodel key for Ace's constraints (Blockbench ignores unknown top-level keys). */
export const BB_KEY = "ace_constraints";

export function readBbConstraints(doc: Doc): ConstraintMap {
  if (doc.kind !== "bbmodel" || !isObj(doc.root)) return {};
  const n = getKey(doc.root as JObj, BB_KEY);
  return n ? constraintsFromJson(toValue(n)) : {};
}
/** Replace the `ace_constraints` key of a bbmodel (removed when there is nothing left). Same doc when nothing changed. */
export function setBbConstraints(doc: Doc, map: ConstraintMap): Doc {
  if (doc.kind !== "bbmodel" || !isObj(doc.root)) throw new Error("not a bbmodel");
  const root = doc.root as JObj;
  const cur = getKey(root, BB_KEY);
  const json = constraintsToJson(map);
  if (!Object.keys(json.animations).length) return cur ? { ...doc, root: setEntry(root, BB_KEY, undefined) } : doc;
  if (cur && JSON.stringify(toValue(cur)) === JSON.stringify(json)) return doc;
  return { ...doc, root: setEntry(root, BB_KEY, fromValue(json, cur, 4)) };
}
