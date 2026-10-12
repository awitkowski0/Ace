/**
 * Blockbench's Resize tool: one drag handle per cube face (box at the end of a shaft, axis coloured), NOT a centre scale gizmo.
 * Dragging a handle moves that face along the cube's own axis (Alt: both faces). Handles are screen-constant in size
 * (shaft 70 px, box 0.15 x 0.06 x 0.15 of the shaft, picker 0.4 — docs 2.7) and turn #3e90ff on hover.
 */
import type * as T from "three";
import { BB } from "./stage";

type TH = typeof T;
export const ARM_PX = 70;
const AXIS_COLOR = [BB.axisX, BB.axisY, BB.axisZ];

export interface FaceHit { axis: 0 | 1 | 2; sign: 1 | -1 }

export class FaceHandles {
  readonly group: T.Group;
  private items: Array<{ axis: 0 | 1 | 2; sign: 1 | -1; line: T.Line; box: T.Mesh; pick: T.Mesh; mat: T.MeshBasicMaterial; lmat: T.LineBasicMaterial }> = [];
  private mesh: T.Mesh | null = null;
  private hover: string | null = null;
  private v = new this.THREE.Vector3();

  constructor(private THREE: TH) {
    this.group = new THREE.Group();
    this.group.visible = false;
    for (const axis of [0, 1, 2] as const) for (const sign of [1, -1] as const) {
      const color = AXIS_COLOR[axis];
      const mat = new THREE.MeshBasicMaterial({ color, depthTest: false, depthWrite: false, transparent: true });
      const lmat = new THREE.LineBasicMaterial({ color, depthTest: false, depthWrite: false, transparent: true });
      const box = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), mat);
      const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]), lmat);
      const pick = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial({ visible: false }));
      for (const o of [box, line]) o.renderOrder = 40;
      this.group.add(line, box, pick);
      this.items.push({ axis, sign, line, box, pick, mat, lmat });
    }
  }

  attach(mesh: T.Mesh | null) {
    this.mesh = mesh;
    this.group.visible = !!mesh;
    if (mesh && this.group.parent !== mesh) mesh.add(this.group);
    if (!mesh) this.group.removeFromParent();
  }

  /** screen-constant layout; call before every render */
  update(camera: T.PerspectiveCamera | T.OrthographicCamera, viewH: number) {
    const mesh = this.mesh;
    if (!mesh) return;
    const g = mesh.geometry;
    if (!g.boundingBox) g.computeBoundingBox();
    const bb = g.boundingBox!;
    const c = bb.getCenter(new this.THREE.Vector3());
    const half = bb.getSize(new this.THREE.Vector3()).multiplyScalar(0.5);
    mesh.updateWorldMatrix(true, false);
    const wp = this.v.copy(c).applyMatrix4(mesh.matrixWorld);
    const persp = camera as T.PerspectiveCamera;
    const wpp = (camera as T.OrthographicCamera).isOrthographicCamera
      ? 1 / (16 * (camera as T.OrthographicCamera).zoom)
      : (2 * wp.distanceTo(camera.position) * Math.tan((persp.fov * Math.PI) / 360)) / viewH;
    const arm = ARM_PX * wpp;
    for (const it of this.items) {
      const dir = [0, 0, 0]; dir[it.axis] = it.sign;
      const base = c.toArray(); base[it.axis] += it.sign * half.getComponent(it.axis);
      const tip = base.slice(); tip[it.axis] += it.sign * arm;
      const pos = it.line.geometry.getAttribute("position") as T.BufferAttribute;
      pos.setXYZ(0, base[0], base[1], base[2]); pos.setXYZ(1, tip[0], tip[1], tip[2]); pos.needsUpdate = true;
      it.line.geometry.computeBoundingSphere();
      it.box.position.set(tip[0], tip[1], tip[2]);
      const s = [0.15, 0.15, 0.15]; s[it.axis] = 0.06;
      it.box.scale.set(s[0] * arm, s[1] * arm, s[2] * arm);
      it.pick.position.copy(it.box.position);
      it.pick.scale.setScalar(0.4 * arm);
      const hot = this.hover === `${it.axis}${it.sign}`;
      it.mat.color.setHex(hot ? BB.accent : AXIS_COLOR[it.axis]);
      it.lmat.color.setHex(hot ? BB.accent : AXIS_COLOR[it.axis]);
    }
    this.group.updateMatrixWorld(true);
  }

  hit(rc: T.Raycaster): FaceHit | null {
    if (!this.mesh || !this.group.visible) return null;
    const hits = rc.intersectObjects(this.items.map((i) => i.pick), false);
    if (!hits.length) return null;
    const it = this.items.find((i) => i.pick === hits[0].object)!;
    return { axis: it.axis, sign: it.sign };
  }
  setHover(h: FaceHit | null): boolean {
    const k = h ? `${h.axis}${h.sign}` : null;
    if (k === this.hover) return false;
    this.hover = k;
    return true;
  }

  /** world position of a handle's box (QA / hit-test helpers); call `update` first */
  tipWorld(axis: 0 | 1 | 2, sign: 1 | -1): T.Vector3 | null {
    const it = this.items.find((i) => i.axis === axis && i.sign === sign);
    if (!it || !this.mesh) return null;
    this.mesh.updateWorldMatrix(true, false);
    return it.box.position.clone().applyMatrix4(this.mesh.matrixWorld);
  }

  /** world-space origin of a face centre and the outward unit direction (for the drag ray/axis intersection) */
  faceFrame(h: FaceHit): { origin: T.Vector3; dir: T.Vector3 } | null {
    const mesh = this.mesh;
    if (!mesh) return null;
    const bb = mesh.geometry.boundingBox!;
    const c = bb.getCenter(new this.THREE.Vector3());
    c.setComponent(h.axis, c.getComponent(h.axis) + h.sign * bb.getSize(new this.THREE.Vector3()).getComponent(h.axis) / 2);
    mesh.updateWorldMatrix(true, false);
    const origin = c.applyMatrix4(mesh.matrixWorld);
    const dir = new this.THREE.Vector3();
    dir.setComponent(h.axis, h.sign);
    dir.transformDirection(mesh.matrixWorld);
    return { origin, dir };
  }

  dispose() {
    this.group.removeFromParent();
    for (const it of this.items) { it.box.geometry.dispose(); it.pick.geometry.dispose(); it.line.geometry.dispose(); it.mat.dispose(); it.lmat.dispose(); (it.pick.material as T.Material).dispose(); }
  }
}
