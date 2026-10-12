/**
 * Animation preview vs Blockbench: every bone rotates about the geo's OWN pivot, children inherit the parent's transform.
 * The expected world position of a cube corner is computed by an independent matrix chain (no three.js, no RigView):
 * scene x = -file x; euler ZYX with (-(rest+anim)x, -(rest+anim)y, +(rest+anim)z) about the bone pivot; pivots are absolute in the file.
 */
import { describe, expect, it } from "vitest";
import * as THREE from "three";
import fs from "node:fs";
import { getGeo, parseDoc, type NumVec3, type Pose } from "../../core";
import { rigFromGeo } from "../model";
import { RigView, sceneVec } from "./rigView";

type M = number[][];
const mul = (a: M, b: M): M => a.map((r, i) => b[0].map((_, j) => r.reduce((s, _v, k) => s + a[i][k] * b[k][j], 0)));
const tr = (v: NumVec3): M => [[1, 0, 0, v[0]], [0, 1, 0, v[1]], [0, 0, 1, v[2]], [0, 0, 0, 1]];
const rx = (a: number): M => [[1, 0, 0, 0], [0, Math.cos(a), -Math.sin(a), 0], [0, Math.sin(a), Math.cos(a), 0], [0, 0, 0, 1]];
const ry = (a: number): M => [[Math.cos(a), 0, Math.sin(a), 0], [0, 1, 0, 0], [-Math.sin(a), 0, Math.cos(a), 0], [0, 0, 0, 1]];
const rz = (a: number): M => [[Math.cos(a), -Math.sin(a), 0, 0], [Math.sin(a), Math.cos(a), 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]];
const D = Math.PI / 180;
const apply = (m: M, p: NumVec3): NumVec3 => [0, 1, 2].map((i) => m[i][0] * p[0] + m[i][1] * p[1] + m[i][2] * p[2] + m[i][3]) as NumVec3;

interface B { name: string; parent?: string; pivot: NumVec3; rotation?: NumVec3 }
/** world scene position of a scene-space point carried by the leaf bone */
function chainWorld(bones: B[], leaf: string, pose: Pose, pointScene: NumVec3): NumVec3 {
  const by = new Map(bones.map((b) => [b.name, b]));
  const chain: B[] = [];
  for (let n: string | undefined = leaf; n; n = by.get(n)?.parent) chain.unshift(by.get(n)!);
  let m: M = tr([0, 0, 0]);
  for (const b of chain) {
    const r = b.rotation ?? [0, 0, 0], a = pose[b.name]?.rotation ?? [0, 0, 0];
    const ex = -(r[0] + a[0]) * D, ey = -(r[1] + a[1]) * D, ez = (r[2] + a[2]) * D;
    const pv = sceneVec(b.pivot);
    m = mul(m, mul(tr(pv), mul(rz(ez), mul(ry(ey), mul(rx(ex), tr([-pv[0], -pv[1], -pv[2]]))))));
  }
  return apply(m, pointScene);
}

function check(geoText: string, cases: Array<{ leaf: string; pose: Pose }>) {
  const doc = parseDoc(geoText, "geo");
  const rig = rigFromGeo(doc)!;
  const view = new RigView(THREE, { wire: false, xray: false });
  view.setRig(rig);
  const bones: B[] = rig.bones.map((b) => ({ name: b.name, parent: b.parent, pivot: b.pivot, rotation: b.rotation }));
  let checked = 0;
  for (const c of cases) {
    view.setPose(c.pose);
    view.group.updateMatrixWorld(true);
    const rb = rig.bones.find((b) => b.name === c.leaf)!;
    const cube = rb.cubes.find((x) => !x.rotation);
    if (!cube) continue;
    const mesh = view.cubeMesh(c.leaf, cube.index)!;
    const pos = mesh.geometry.getAttribute("position");
    const piv = sceneVec(cube.pivot ?? rb.pivot);
    for (const vi of [0, 5, pos.count - 1]) {
      const local = new THREE.Vector3().fromBufferAttribute(pos, vi);
      const got = mesh.localToWorld(local.clone());
      const exp = chainWorld(bones, c.leaf, c.pose, [local.x + piv[0], local.y + piv[1], local.z + piv[2]]);
      expect(got.x).toBeCloseTo(exp[0], 3); expect(got.y).toBeCloseTo(exp[1], 3); expect(got.z).toBeCloseTo(exp[2], 3);
      checked++;
    }
  }
  expect(checked).toBeGreaterThan(0);
}

const cubeAt = (o: NumVec3) => ({ origin: o, size: [2, 3, 4], uv: [0, 0] });
const synthetic = JSON.stringify({
  format_version: "1.12.0",
  "minecraft:geometry": [{
    description: { identifier: "geometry.t", texture_width: 64, texture_height: 64 },
    bones: [
      { name: "armorBody", pivot: [0, 24, 0], cubes: [cubeAt([-4, 12, -2])] },
      { name: "armorRightArm", pivot: [-4, 22, 0], cubes: [cubeAt([-8, 12, -2])] },
      { name: "rightArmtop", parent: "armorRightArm", pivot: [0, 24, 0], rotation: [0, 0, 10], cubes: [cubeAt([-8, 18, -2])] },
      { name: "hand", parent: "rightArmtop", pivot: [-6, 13, 1], rotation: [5, -20, 0], cubes: [cubeAt([-8, 11, -1])] },
      { name: "armorLeftLeg", pivot: [-2, 12, 0] },
      { name: "armorLeftBoot", pivot: [-2, 12, 0], cubes: [cubeAt([-3, 0, -2])] },
      { name: "toe", parent: "armorLeftBoot", pivot: [-2, 2, -2], rotation: [0, 90, 0], cubes: [cubeAt([-3, 0, -4])] },
    ],
  }],
});

describe("pivots: nested bones rotate about their own pivots (Blockbench)", () => {
  it("synthetic nested rig: arm [-90,0,0], boot with rotated parent", () => {
    check(synthetic, [
      { leaf: "armorRightArm", pose: { armorRightArm: { rotation: [-90, 0, 0] } } },
      { leaf: "rightArmtop", pose: { armorRightArm: { rotation: [-90, 0, 0] } } },
      { leaf: "hand", pose: { armorRightArm: { rotation: [-90, 0, 0] }, rightArmtop: { rotation: [0, 30, -15] }, hand: { rotation: [12, 0, 7] } } },
      { leaf: "toe", pose: { armorLeftBoot: { rotation: [35, 20, 10] }, toe: { rotation: [0, 0, 25] } } },
      { leaf: "armorLeftBoot", pose: {} },
    ]);
  });
  it("arm pivot is the geo's pivot, not the player rig's: rotating about [-4,22,0] keeps that point fixed", () => {
    const doc = parseDoc(synthetic, "geo");
    const view = new RigView(THREE, { wire: false, xray: false });
    view.setRig(rigFromGeo(doc)!);
    view.setPose({ armorRightArm: { rotation: [-90, 40, 20] } });
    view.group.updateMatrixWorld(true);
    const g = view.boneGroup("armorRightArm")!;
    const w = g.getWorldPosition(new THREE.Vector3());
    expect([w.x, w.y, w.z].map((v) => Math.round(v * 1e4) / 1e4)).toEqual([4, 22, 0]); // scene x = -file x
  });
  const real = "/Users/alexw/IdeaProjects/Thematic-Collections/src/packs/heroes/resources/assets/thematic/geo/armor/spiderman.geo.json";
  it.skipIf(!fs.existsSync(real))("real spiderman.geo.json: arms, boots and deep descendants", () => {
    const text = fs.readFileSync(real, "utf8");
    const names = new Set(getGeo(parseDoc(text, "geo")).geometries[0].bones.map((b) => b.name));
    const pick = (n: string) => names.has(n);
    expect(pick("armorRightArm") && pick("armorLeftBoot") && pick("bone141") && pick("rightArmtop")).toBe(true);
    check(text, [
      { leaf: "armorRightArm", pose: { armorRightArm: { rotation: [-90, 0, 0] } } },
      { leaf: "rightArmBottom", pose: { armorRightArm: { rotation: [-90, 12, 3] } } },
      { leaf: "rightArmtop", pose: { armorRightArm: { rotation: [-60, 0, 20] } } },
      { leaf: "bone97", pose: { armorRightArm: { rotation: [-60, 0, 20] }, bone87: { rotation: [0, 15, 0] } } },
      { leaf: "bone141", pose: { armorLeftBoot: { rotation: [30, 10, 5] }, bone143: { rotation: [0, 0, 20] } } },
      { leaf: "armorLeftLeg", pose: { armorLeftLeg: { rotation: [25, 0, 0] } } },
      { leaf: "bone176", pose: { armorRightBoot: { rotation: [-20, 5, 0] }, bone174: { rotation: [10, 0, 0] } } },
    ]);
  });
});
