/**
 * Viewport side of the limb links: evaluates constraints on the sampled pose (live preview), draws the contact dots and link lines,
 * picks contact points on cube surfaces (corner / edge-midpoint / face-centre snap), moves the linked limb while a gizmo drag is
 * in progress and supplies the extra keys for "Key constrained bones". The engine only calls the small `// == constraints hook ==`
 * entry points; nothing here changes the document except through store.ts actions.
 */
import type * as T from "three";
import { animLength, applyConstraints, clipTime, drivenBones, getAnimation, type Constraint, type NumVec3, type Pose, type PointRef } from "../../core";
import type { StudioApi, StudioState } from "../state";
import type { RigModel } from "../model";
import type { RigView } from "../viewport/rigView";
import { cancelPick, constraintsOf, defaultVia, handlePick } from "./store";

type TH = typeof T;
const R2D = 180 / Math.PI;
const COL = { a: 0x88c0d0, b: 0xd08770, pin: 0xa3be8c, off: 0x8b95a8, line: 0xebcb8b, hover: 0xffffff };

export interface RuntimeHost {
  scene: T.Scene;
  dom: HTMLCanvasElement;
  api: StudioApi;
  rig(): RigView;
  rigModel(): RigModel | null;
  camera(): T.Camera;
  request(): void;
  isVisible(m: T.Object3D): boolean;
}
interface Dot { mesh: T.Mesh; sig: string; bone: string }
const r4 = (v: number) => Math.round(v * 1e4) / 1e4;

export class ConstraintsRuntime {
  private dots = new Map<string, Dot>();
  private marks = new Map<string, T.Mesh>();
  private lines: T.LineSegments;
  private hoverMark: T.Mesh;
  private geoDot: T.SphereGeometry;
  private mats = new Map<number, T.MeshBasicMaterial>();
  /** pose before constraints / after (last applyPose) and the live result during a drag */
  base: Pose = {};
  solved: Pose = {};
  liveSolved: Pose | null = null;
  private onKey: (e: KeyboardEvent) => void;

  constructor(private THREE: TH, private host: RuntimeHost) {
    this.geoDot = new THREE.SphereGeometry(0.5, 12, 8);
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(3 * 2 * 64), 3));
    g.setDrawRange(0, 0);
    this.lines = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: COL.line, depthTest: false, transparent: true, opacity: 0.9 }));
    this.lines.renderOrder = 49;
    this.lines.frustumCulled = false;
    host.scene.add(this.lines);
    this.hoverMark = new THREE.Mesh(this.geoDot, this.mat(COL.hover));
    this.hoverMark.scale.setScalar(1.15);
    this.hoverMark.renderOrder = 52;
    this.hoverMark.visible = false;
    host.scene.add(this.hoverMark);
    this.onKey = (e) => { if (e.key === "Escape" && host.api.store.get().cons.pick) cancelPick(host.api); };
    window.addEventListener("keydown", this.onKey, true);
  }

  private mat(color: number): T.MeshBasicMaterial {
    let m = this.mats.get(color);
    if (!m) { m = new this.THREE.MeshBasicMaterial({ color, depthTest: false, transparent: true }); this.mats.set(color, m); }
    return m;
  }

  // ---------------------------------------------------------------- pose

  /** == constraints hook == evaluate the animation's constraints on a sampled pose */
  apply(s: StudioState, pose: Pose, time: number = s.time, fixed?: ReadonlySet<string>, record = true): Pose {
    if (record) this.base = pose;
    const rm = this.host.rigModel();
    const list = constraintsOf(s);
    const doc = s.doc;
    const anim = doc && doc.kind !== "geo" && s.anim ? getAnimation(doc, s.anim) : undefined;
    let out = pose;
    if (s.cons.live && list.length && rm && anim && s.mode !== "edit") out = applyConstraints(rm.bones, list, pose, { t: clipTime(anim, time), length: animLength(anim), fixed });
    if (record) { this.solved = out; this.liveSolved = null; }
    return out;
  }

  // ---------------------------------------------------------------- overlay

  sync(s: StudioState): void {
    const rig = this.host.rig();
    const rm = this.host.rigModel();
    const list = s.mode === "edit" || !rm ? [] : constraintsOf(s);
    const pick = s.cons.pick;
    const show = s.cons.showPoints && s.mode !== "edit" && (list.length > 0 || !!pick);
    const want = new Map<string, { bone: string; p: NumVec3; color: number; scale: number }>();
    const marks = new Map<string, NumVec3>();
    if (show && rm) {
      for (const c of list) {
        const on = c.enabled ? 1 : 0.6;
        const sel = s.cons.sel === c.id ? 1.35 : 1;
        if (c.kind === "link") {
          want.set(c.id + ":a", { bone: c.a.bone, p: c.a.p, color: c.enabled ? COL.a : COL.off, scale: sel * on });
          want.set(c.id + ":b", { bone: c.b.bone, p: c.b.p, color: c.enabled ? COL.b : COL.off, scale: sel * on });
        } else if (c.kind === "pin") {
          want.set(c.id + ":p", { bone: c.point.bone, p: c.point.p, color: c.enabled ? COL.pin : COL.off, scale: sel * on });
          marks.set(c.id, c.world);
        }
      }
      if (pick?.a) want.set("pick:a", { bone: pick.a.bone, p: pick.a.p, color: COL.a, scale: 1.3 });
    }
    for (const [k, d] of [...this.dots]) if (!want.has(k)) { d.mesh.removeFromParent(); this.dots.delete(k); }
    for (const [k, w] of want) {
      const group = rig.boneGroup(w.bone);
      const b = rm?.bones.find((x) => x.name === w.bone);
      if (!group || !b) { this.dots.get(k)?.mesh.removeFromParent(); this.dots.delete(k); continue; }
      const sig = `${w.bone}|${w.p.join(",")}|${b.pivot.join(",")}`;
      let d = this.dots.get(k);
      if (!d) { d = { mesh: new this.THREE.Mesh(this.geoDot, this.mat(w.color)), sig: "", bone: w.bone }; d.mesh.renderOrder = 50; this.dots.set(k, d); }
      d.mesh.material = this.mat(w.color);
      d.mesh.scale.setScalar(w.scale);
      if (d.sig !== sig || d.mesh.parent !== group) {
        d.sig = sig;
        d.mesh.position.set(-(w.p[0] - b.pivot[0]), w.p[1] - b.pivot[1], w.p[2] - b.pivot[2]);
        if (d.mesh.parent !== group) group.add(d.mesh);
      }
    }
    for (const [k, m] of [...this.marks]) if (!marks.has(k)) { m.removeFromParent(); m.geometry.dispose(); this.marks.delete(k); }
    for (const [k, w] of marks) {
      let m = this.marks.get(k);
      if (!m) {
        m = new this.THREE.Mesh(new this.THREE.OctahedronGeometry(0.8), new this.THREE.MeshBasicMaterial({ color: COL.pin, wireframe: true, depthTest: false, transparent: true }));
        m.renderOrder = 51;
        this.host.scene.add(m);
        this.marks.set(k, m);
      }
      m.position.set(-w[0], w[1], w[2]);
    }
    this.host.dom.style.cursor = pick ? "crosshair" : this.host.dom.style.cursor === "crosshair" ? "" : this.host.dom.style.cursor;
    if (!pick) this.hoverMark.visible = false;
    this.updateLines(list);
  }

  /** link lines (A to B, pin dot to its target) from the dots' current world positions */
  updateLines(list: readonly Constraint[] = constraintsOf(this.host.api.store.get())): void {
    const pos = this.lines.geometry.getAttribute("position") as T.BufferAttribute;
    let n = 0;
    this.host.scene.updateMatrixWorld(true);
    const v = new this.THREE.Vector3(), w = new this.THREE.Vector3();
    const put = (a: T.Vector3, b: T.Vector3) => { if (n >= 64) return; pos.setXYZ(n * 2, a.x, a.y, a.z); pos.setXYZ(n * 2 + 1, b.x, b.y, b.z); n++; };
    for (const c of list) {
      if (c.kind === "link") {
        const da = this.dots.get(c.id + ":a"), db = this.dots.get(c.id + ":b");
        if (da?.mesh.parent && db?.mesh.parent) { da.mesh.getWorldPosition(v); db.mesh.getWorldPosition(w); if (v.distanceTo(w) > 0.05) put(v.clone(), w.clone()); }
      } else if (c.kind === "pin") {
        const d = this.dots.get(c.id + ":p"), m = this.marks.get(c.id);
        if (d?.mesh.parent && m) { d.mesh.getWorldPosition(v); if (v.distanceTo(m.position) > 0.05) put(v.clone(), m.position.clone()); }
      }
    }
    pos.needsUpdate = true;
    this.lines.geometry.setDrawRange(0, n * 2);
    this.host.request();
  }

  // ---------------------------------------------------------------- picking

  private rayAt(clientX: number, clientY: number): T.Raycaster {
    const r = this.host.dom.getBoundingClientRect();
    const rc = new this.THREE.Raycaster();
    rc.setFromCamera(new this.THREE.Vector2(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1), this.host.camera());
    return rc;
  }

  /** nearest corner / edge midpoint / face centre of the cube under the pointer */
  private snap(clientX: number, clientY: number): { ref: PointRef; worldFile: NumVec3; world: T.Vector3 } | null {
    const s = this.host.api.store.get();
    const rig = this.host.rig();
    const rm = this.host.rigModel();
    if (!rm) return null;
    this.host.scene.updateMatrixWorld(true);
    const meshes = rig.pickables.filter((m) => this.host.isVisible(m) && !s.hidden.includes(m.userData.bone as string));
    const hit = this.rayAt(clientX, clientY).intersectObjects(meshes, false)[0];
    if (!hit) return null;
    const mesh = hit.object as T.Mesh;
    mesh.geometry.computeBoundingBox();
    const bb = mesh.geometry.boundingBox!;
    const local = mesh.worldToLocal(hit.point.clone());
    let best: { c: T.Vector3; d: number } | null = null;
    const xs = [bb.min.x, (bb.min.x + bb.max.x) / 2, bb.max.x], ys = [bb.min.y, (bb.min.y + bb.max.y) / 2, bb.max.y], zs = [bb.min.z, (bb.min.z + bb.max.z) / 2, bb.max.z];
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) for (let k = 0; k < 3; k++) {
      if (i === 1 && j === 1 && k === 1) continue;
      const c = new this.THREE.Vector3(xs[i], ys[j], zs[k]);
      const d = c.distanceTo(local);
      if (!best || d < best.d - 1e-9) best = { c, d };
    }
    if (!best) return null;
    const bone = mesh.userData.bone as string;
    const b = rm.bones.find((x) => x.name === bone);
    if (!b) return null;
    const inBone = best.c.clone().applyMatrix4(mesh.matrix); // bone-group local, scene axes
    const world = mesh.localToWorld(best.c.clone());
    const p: NumVec3 = [r4(b.pivot[0] - inBone.x), r4(b.pivot[1] + inBone.y), r4(b.pivot[2] + inBone.z)];
    const via = defaultVia(rm.bones, s.doc, s.anim, bone);
    return { ref: { bone, p, ...(via ? { via } : {}) }, worldFile: [r4(-world.x), r4(world.y), r4(world.z)], world };
  }

  /** == constraints hook == a primary press in pick mode; true = consumed */
  pointerDown(e: PointerEvent): boolean {
    if (!this.host.api.store.get().cons.pick || e.button !== 0) return false;
    e.preventDefault();
    const hit = this.snap(e.clientX, e.clientY);
    if (hit) handlePick(this.host.api, hit.ref, hit.worldFile);
    return true;
  }
  /** == constraints hook == snap preview while picking */
  hover(e: PointerEvent): void {
    if (!this.host.api.store.get().cons.pick) return;
    const hit = this.snap(e.clientX, e.clientY);
    this.hoverMark.visible = !!hit;
    if (hit) this.hoverMark.position.copy(hit.world);
    this.host.request();
  }

  // ---------------------------------------------------------------- live drag

  /** == constraints hook == while a bone is dragged with the gizmo, move whatever is linked to it (the dragged bones stay put) */
  liveDrag(kind: string, dragged: Array<{ bone: string; obj: T.Object3D }>): void {
    if (kind !== "key-rotation" && kind !== "key-position") return;
    const s = this.host.api.store.get();
    if (!s.cons.live || !constraintsOf(s).some((c) => c.enabled)) return;
    const rig = this.host.rig();
    const base: Pose = { ...this.base };
    const fixed = new Set<string>();
    for (const d of dragged) {
      const node = rig.boneRest(d.bone);
      if (!node) continue;
      fixed.add(d.bone);
      const o = d.obj;
      if (kind === "key-rotation") base[d.bone] = { ...base[d.bone], rotation: [-(o.rotation.x - node.restRot.x) * R2D, -(o.rotation.y - node.restRot.y) * R2D, (o.rotation.z - node.restRot.z) * R2D] };
      else base[d.bone] = { ...base[d.bone], position: [-(o.position.x - node.restPos.x), o.position.y - node.restPos.y, o.position.z - node.restPos.z] };
    }
    const solved = this.apply(s, base, s.time, fixed, false);
    this.liveSolved = solved;
    rig.setPose(solved, fixed);
    this.updateLines();
  }

  /** == constraints hook == rotation keys for the constrained bones after a drag ("Key constrained bones") */
  extraKeyed(s: StudioState, channel: string, exclude: readonly string[]): Array<{ bone: string; pre: NumVec3; post: NumVec3 }> {
    if (channel !== "rotation" || !s.cons.keyConstrained || !this.liveSolved) return [];
    const out: Array<{ bone: string; pre: NumVec3; post: NumVec3 }> = [];
    const seen = new Set<string>(exclude);
    for (const c of constraintsOf(s)) {
      if (!c.enabled) continue;
      for (const b of drivenBones(c)) {
        if (seen.has(b)) continue;
        seen.add(b);
        const post = this.liveSolved[b]?.rotation;
        const pre = this.solved[b]?.rotation ?? [0, 0, 0];
        if (!post || post.every((v, i) => Math.abs(v - pre[i]) < 1e-4)) continue;
        out.push({ bone: b, pre: [pre[0], pre[1], pre[2]], post: [r4(post[0]), r4(post[1]), r4(post[2])] });
      }
    }
    return out;
  }

  // ---------------------------------------------------------------- QA / inspection

  /** screen position (CSS px in the canvas) of a point of a bone */
  project(bone: string, p: NumVec3): { x: number; y: number } | null {
    const rm = this.host.rigModel();
    const b = rm?.bones.find((x) => x.name === bone);
    const g = this.host.rig().boneGroup(bone);
    if (!b || !g) return null;
    this.host.scene.updateMatrixWorld(true);
    const w = g.localToWorld(new this.THREE.Vector3(-(p[0] - b.pivot[0]), p[1] - b.pivot[1], p[2] - b.pivot[2]));
    const v = w.project(this.host.camera());
    const el = this.host.dom;
    return { x: (v.x * 0.5 + 0.5) * el.clientWidth, y: (-v.y * 0.5 + 0.5) * el.clientHeight };
  }
  /** world positions (file space) of the dots as the scene shows them */
  info(): Record<string, unknown> {
    const s = this.host.api.store.get();
    this.host.scene.updateMatrixWorld(true);
    const v = new this.THREE.Vector3();
    const wp = (k: string): NumVec3 | null => { const d = this.dots.get(k); if (!d?.mesh.parent) return null; d.mesh.getWorldPosition(v); return [r4(-v.x), r4(v.y), r4(v.z)]; };
    const links = constraintsOf(s).filter((c) => c.kind === "link").map((c) => {
      const a = wp(c.id + ":a"), b = wp(c.id + ":b");
      return { id: c.id, a, b, dist: a && b ? r4(Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])) : null };
    });
    const pins = constraintsOf(s).filter((c) => c.kind === "pin").map((c) => {
      const a = wp(c.id + ":p");
      const w = c.kind === "pin" ? c.world : null;
      return { id: c.id, a, world: w, dist: a && w ? r4(Math.hypot(a[0] - w[0], a[1] - w[1], a[2] - w[2])) : null };
    });
    return { dots: this.dots.size, marks: this.marks.size, lineSegments: this.lines.geometry.drawRange.count / 2, links, pins, pick: s.cons.pick };
  }

  dispose(): void {
    window.removeEventListener("keydown", this.onKey, true);
    for (const d of this.dots.values()) d.mesh.removeFromParent();
    for (const m of this.marks.values()) { m.removeFromParent(); m.geometry.dispose(); (m.material as T.Material).dispose(); }
    this.lines.removeFromParent(); this.lines.geometry.dispose(); (this.lines.material as T.Material).dispose();
    this.hoverMark.removeFromParent();
    this.geoDot.dispose();
    for (const m of this.mats.values()) m.dispose();
    this.dots.clear(); this.marks.clear();
  }
}
