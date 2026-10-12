/**
 * Built-in player rig for previewing armor clips: armorHead/Body/RightArm/LeftArm/RightLeg/LeftLeg with
 * Steve (4px arms) proportions, Bedrock coordinates (Y up, 1/16 block, absolute pivots).
 * Skin UVs are the standard 64x64 player skin (right/left limbs on their own regions).
 */
import type { CubeUv, GeoBone, GeoCube, Geometry } from "./format/geo";
import { quatMul, quatRotate, eulerToQuat, quatFromAxisAngle, type Quat } from "./math";
import type { BonePose, Pose } from "./sample";
import type { NumVec3 } from "./format/animation";

/** In-game model scale of the armor/player model. */
export const PLAYER_MODEL_SCALE = 0.9375;

export interface RigCube {
  origin: NumVec3;
  size: NumVec3;
  uv: [number, number];
  inflate?: number;
}
export interface RigBone {
  name: string;
  pivot: NumVec3;
  cubes: RigCube[];
}

export const PLAYER_RIG: readonly RigBone[] = [
  { name: "armorHead", pivot: [0, 24, 0], cubes: [{ origin: [-4, 24, -4], size: [8, 8, 8], uv: [0, 0] }] },
  { name: "armorBody", pivot: [0, 24, 0], cubes: [{ origin: [-4, 12, -2], size: [8, 12, 4], uv: [16, 16] }] },
  { name: "armorRightArm", pivot: [-5, 22, 0], cubes: [{ origin: [-8, 12, -2], size: [4, 12, 4], uv: [40, 16] }] },
  { name: "armorLeftArm", pivot: [5, 22, 0], cubes: [{ origin: [4, 12, -2], size: [4, 12, 4], uv: [32, 48] }] },
  { name: "armorRightLeg", pivot: [-1.9, 12, 0], cubes: [{ origin: [-3.9, 0, -2], size: [4, 12, 4], uv: [0, 16] }] },
  { name: "armorLeftLeg", pivot: [1.9, 12, 0], cubes: [{ origin: [-0.1, 0, -2], size: [4, 12, 4], uv: [16, 48] }] },
];

export const RIG_BONE_NAMES: readonly string[] = PLAYER_RIG.map((b) => b.name);

/** The rig as a `Geometry` (nodes are synthetic and not part of any document). */
export function playerRigGeometry(): Geometry {
  const fakeNode = { t: "o" as const, entries: [] };
  const bones: GeoBone[] = PLAYER_RIG.map((b, index) => ({
    name: b.name,
    pivot: [...b.pivot] as NumVec3,
    cubes: b.cubes.map((c, i): GeoCube => ({ index: i, origin: [...c.origin] as NumVec3, size: [...c.size] as NumVec3, inflate: c.inflate, uv: { kind: "box", uv: c.uv } as CubeUv, node: fakeNode })),
    node: fakeNode,
    index,
  }));
  return { identifier: "geometry.ace.player", textureWidth: 64, textureHeight: 64, bones, node: fakeNode, index: 0 };
}

// ---------------------------------------------------------------- bone aliases

const LIMBS = ["Head", "Body", "RightArm", "LeftArm", "RightLeg", "LeftLeg"];
/** bipedX <-> armorX. */
export const BONE_ALIASES: Record<string, string> = Object.fromEntries(LIMBS.flatMap((l) => [[`biped${l}`, `armor${l}`], [`armor${l}`, `biped${l}`]]));

/** Name used to look a bone up on the rig (bipedX -> armorX). */
export function canonicalBone(name: string): string {
  return name.startsWith("biped") && BONE_ALIASES[name] ? BONE_ALIASES[name] : name;
}
export function isArmorBone(name: string): boolean {
  return RIG_BONE_NAMES.includes(canonicalBone(name));
}
/** Pose with bipedX keys renamed to armorX (display). */
export function canonicalizePose(p: Pose): Pose {
  const out: Pose = {};
  for (const [k, v] of Object.entries(p)) out[canonicalBone(k)] = v;
  return out;
}

// ---------------------------------------------------------------- kinematics

/** Rotation of a bone pose as a quaternion (file degrees, ZYX). */
export const boneQuat = (p: BonePose | undefined): Quat => eulerToQuat(p?.rotation ?? [0, 0, 0]);

/** World point of a local model-space point of `bone` under `pose` (rotation about the bone pivot, then position offset). Flat rig: bones do not inherit. */
export function transformPoint(rig: readonly RigBone[], bone: string, point: NumVec3, pose: Pose): NumVec3 {
  const b = rig.find((x) => x.name === canonicalBone(bone));
  if (!b) return point;
  const p = pose[bone] ?? pose[canonicalBone(bone)] ?? pose[BONE_ALIASES[bone] ?? ""];
  const s = p?.scale ?? [1, 1, 1];
  const rel: NumVec3 = [(point[0] - b.pivot[0]) * s[0], (point[1] - b.pivot[1]) * s[1], (point[2] - b.pivot[2]) * s[2]];
  const r = quatRotate(boneQuat(p), rel);
  const pos = p?.position ?? [0, 0, 0];
  // Bedrock/GeckoLib position channel moves the bone along +Y/-X... file units are model px; treated as direct offsets here
  return [r[0] + b.pivot[0] + pos[0], r[1] + b.pivot[1] + pos[1], r[2] + b.pivot[2] + pos[2]];
}
export { quatMul, quatFromAxisAngle };
