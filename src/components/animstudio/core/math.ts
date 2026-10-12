/** Small quaternion/euler helpers (no three.js). Euler = degrees, rotation matrix R = Rz(z)·Ry(y)·Rx(x) (Blockbench ZYX). */
import type { NumVec3 } from "./format/animation";

export type Quat = [number, number, number, number]; // x y z w
const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;

export function eulerToQuat(e: NumVec3): Quat {
  const [x, y, z] = [e[0] * D2R * 0.5, e[1] * D2R * 0.5, e[2] * D2R * 0.5];
  const [sx, cx, sy, cy, sz, cz] = [Math.sin(x), Math.cos(x), Math.sin(y), Math.cos(y), Math.sin(z), Math.cos(z)];
  // q = qz * qy * qx
  return [
    cz * cy * sx - sz * sy * cx,
    cz * sy * cx + sz * cy * sx,
    sz * cy * cx - cz * sy * sx,
    cz * cy * cx + sz * sy * sx,
  ];
}

export function quatMul(a: Quat, b: Quat): Quat {
  return [
    a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
    a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
    a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
    a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
  ];
}
export function quatNormalize(q: Quat): Quat {
  const l = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
  return [q[0] / l, q[1] / l, q[2] / l, q[3] / l];
}
export function quatFromAxisAngle(axis: NumVec3, deg: number): Quat {
  const h = deg * D2R * 0.5;
  const s = Math.sin(h);
  return [axis[0] * s, axis[1] * s, axis[2] * s, Math.cos(h)];
}
export function quatRotate(q: Quat, v: NumVec3): NumVec3 {
  const [x, y, z, w] = q;
  const [vx, vy, vz] = v;
  const tx = 2 * (y * vz - z * vy);
  const ty = 2 * (z * vx - x * vz);
  const tz = 2 * (x * vy - y * vx);
  return [vx + w * tx + (y * tz - z * ty), vy + w * ty + (z * tx - x * tz), vz + w * tz + (x * ty - y * tx)];
}

/** Spherical interpolation along the shortest arc; t may be outside 0..1 (extrapolates). */
export function slerp(a: Quat, b: Quat, t: number): Quat {
  let [bx, by, bz, bw] = b;
  let d = a[0] * bx + a[1] * by + a[2] * bz + a[3] * bw;
  if (d < 0) {
    d = -d;
    bx = -bx; by = -by; bz = -bz; bw = -bw;
  }
  if (d > 0.9995) {
    return quatNormalize([a[0] + (bx - a[0]) * t, a[1] + (by - a[1]) * t, a[2] + (bz - a[2]) * t, a[3] + (bw - a[3]) * t]);
  }
  const th = Math.acos(Math.min(1, d));
  const s = Math.sin(th);
  const w0 = Math.sin((1 - t) * th) / s;
  const w1 = Math.sin(t * th) / s;
  return [a[0] * w0 + bx * w1, a[1] * w0 + by * w1, a[2] * w0 + bz * w1, a[3] * w0 + bw * w1];
}

/** Euler (deg) of a quaternion, y in [-90, 90]. At gimbal lock z is set to 0. */
export function quatToEuler(q: Quat): NumVec3 {
  const [x, y, z, w] = quatNormalize(q);
  const r20 = 2 * (x * z - w * y);
  const r21 = 2 * (y * z + w * x);
  const r22 = 1 - 2 * (x * x + y * y);
  const r10 = 2 * (x * y + w * z);
  const r00 = 1 - 2 * (y * y + z * z);
  const sy = Math.max(-1, Math.min(1, -r20));
  const b = Math.asin(sy);
  if (Math.abs(sy) > 0.999999) {
    const r11 = 1 - 2 * (x * x + z * z);
    const r12 = 2 * (y * z - w * x);
    return [Math.atan2(-r12, r11) * R2D, b * R2D, 0];
  }
  return [Math.atan2(r21, r22) * R2D, b * R2D, Math.atan2(r10, r00) * R2D];
}

const near = (v: number, ref: number) => v + 360 * Math.round((ref - v) / 360);

/** Equivalent euler triple of `q` closest to `ref` (no >180° axis jumps). */
export function nearestEuler(q: Quat, ref: NumVec3): NumVec3 {
  const e = quatToEuler(q);
  const alt: NumVec3 = [e[0] + 180, 180 - e[1], e[2] + 180];
  const cands = [e, alt].map((c) => [near(c[0], ref[0]), near(c[1], ref[1]), near(c[2], ref[2])] as NumVec3);
  let best = cands[0];
  let bd = Infinity;
  for (const c of cands) {
    const d = Math.abs(c[0] - ref[0]) + Math.abs(c[1] - ref[1]) + Math.abs(c[2] - ref[2]);
    if (d < bd - 1e-9) {
      bd = d;
      best = c;
    }
  }
  return best;
}

export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export const lerp3 = (a: NumVec3, b: NumVec3, t: number): NumVec3 => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
