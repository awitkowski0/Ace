/**
 * The 3D view of the pack editor: the suit's model (rest pose, textured) with a marker for every place something renders
 * from, and a move gizmo on the selected one. Scene space is the Studio's (model pixels, +X right, +Y up, -Z forward).
 */
import { useEffect, useRef, useState } from "react";
import type * as T from "three";
import { createScene, type SceneKit } from "../../../editor/viewers/scene3d";
import { RigView } from "../../animstudio/ui/viewport/rigView";
import type { RigModel } from "../../animstudio/ui/model";
import type { NumVec3 } from "../../animstudio/core";
import type { Pose } from "../../animstudio/core/sample";
import type { Cone, Quat } from "../core/flight";

export interface Marker {
  id: string;
  pos: NumVec3;
  /** where the render goes from here (unit vector), drawn as a short ray */
  dir?: NumVec3;
  color: string;
  label: string;
  /** a beam preview along `dir`: length in px and thickness in px */
  beam?: { length: number; width: number; end?: string };
  /** a flame cone along `dir` */
  flame?: { length: number; width: number; core: string; outer: string };
  /** cones along `dir` drawn the way JetFlameRenderer does (flame cones, nozzle glow, anti-grav pad); wins over `flame` */
  cones?: Cone[];
  /** drawn only (no ball, label or picking) */
  ghost?: boolean;
  movable?: boolean;
  /** the rotate gizmo can turn it; `quat` is its current scene-space orientation (x, y, z, w) */
  rotatable?: boolean;
  quat?: Quat;
  /** drawn dim: shown but not editable */
  dim?: boolean;
}

interface Props {
  rig: RigModel | null;
  texture: HTMLImageElement | null;
  markers: Marker[];
  selected: string | null;
  onSelect(id: string | null): void;
  /** live drag of the selected marker: total scene-px delta since the drag started */
  onDrag?(id: string, delta: NumVec3, phase: "move" | "end"): void;
  /** which gizmo the selected marker gets */
  mode?: "translate" | "rotate";
  /** live turn of the selected marker: its new scene-space orientation */
  onRotate?(id: string, q: Quat, phase: "move" | "end"): void;
  /** a pose for the model's bones (file rotation convention), e.g. the flight pose */
  pose?: Pose | null;
  testId?: string;
}

/** Draw now (not on the next animation frame: a hidden or throttled window may never give one). */
const drawNow = (k: Kit) => { if (k.sc.renderer.domElement.width) k.sc.renderer.render(k.sc.scene, k.sc.camera); };

interface Kit { sc: SceneKit; THREE: typeof T; rig: RigView; markers: T.Group; labels: HTMLDivElement; tc: import("three/examples/jsm/controls/TransformControls.js").TransformControls; handle: T.Object3D }

export function Viewport3D({ rig, texture, markers, selected, onSelect, onDrag, mode = "translate", onRotate, pose, testId }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const kit = useRef<Kit | null>(null);
  const [ready, setReady] = useState(0);
  const cb = useRef({ onSelect, onDrag, onRotate, selected, markers, mode });
  cb.current = { onSelect, onDrag, onRotate, selected, markers, mode };
  const drag = useRef<{ id: string; start: T.Vector3 } | null>(null);

  useEffect(() => {
    let dead = false;
    let k: Kit | null = null;
    (async () => {
      const el = host.current;
      if (!el) return;
      const sc = await createScene(el);
      const { TransformControls } = await import("three/examples/jsm/controls/TransformControls.js");
      if (dead) { sc.dispose(); return; }
      const THREE = sc.THREE;
      sc.grid.scale.setScalar(3.2); // 32 px cells round a 2-block wearer
      sc.camera.position.set(34, 30, -48);
      sc.controls.target.set(0, 16, 0);
      sc.camera.near = 0.5; sc.camera.far = 5000; sc.camera.updateProjectionMatrix();
      sc.controls.update();
      const rv = new RigView(THREE, { wire: false, xray: false });
      sc.scene.add(rv.group);
      const group = new THREE.Group();
      sc.scene.add(group);
      const labels = document.createElement("div");
      labels.className = "pe-labels";
      el.appendChild(labels);
      const handle = new THREE.Object3D();
      sc.scene.add(handle);
      const tc = new TransformControls(sc.camera, sc.renderer.domElement);
      tc.setSize(0.6);
      tc.setMode("translate");
      tc.setSpace("world");
      sc.scene.add(tc.getHelper());
      tc.addEventListener("dragging-changed", (e) => {
        sc.controls.enabled = !(e as unknown as { value: boolean }).value;
        const d = drag.current;
        if ((e as unknown as { value: boolean }).value) {
          const id = cb.current.selected;
          if (id) drag.current = { id, start: handle.position.clone() };
        } else if (d) {
          const p = handle.position;
          drag.current = null;
          if (cb.current.mode === "rotate") cb.current.onRotate?.(d.id, [handle.quaternion.x, handle.quaternion.y, handle.quaternion.z, handle.quaternion.w], "end");
          else cb.current.onDrag?.(d.id, [p.x - d.start.x, p.y - d.start.y, p.z - d.start.z], "end");
        }
      });
      tc.addEventListener("objectChange", () => {
        const d = drag.current;
        if (!d) return;
        const p = handle.position;
        if (cb.current.mode === "rotate") cb.current.onRotate?.(d.id, [handle.quaternion.x, handle.quaternion.y, handle.quaternion.z, handle.quaternion.w], "move");
        else cb.current.onDrag?.(d.id, [p.x - d.start.x, p.y - d.start.y, p.z - d.start.z], "move");
        sc.render();
      });
      tc.addEventListener("change", () => sc.render());
      k = { sc, THREE, rig: rv, markers: group, labels, tc, handle };
      kit.current = k;

      // click a marker to select it (a press that does not move: orbit drags stay orbit drags)
      const ray = new THREE.Raycaster();
      let down: { x: number; y: number } | null = null;
      const dom = sc.renderer.domElement;
      dom.addEventListener("pointerdown", (e) => { down = { x: e.clientX, y: e.clientY }; });
      dom.addEventListener("pointerup", (e) => {
        if (!down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 4 || drag.current) { down = null; return; }
        down = null;
        const r = dom.getBoundingClientRect();
        ray.setFromCamera(new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), sc.camera);
        ray.params.Points = { threshold: 1 };
        const hits = ray.intersectObjects(group.children.filter((c) => c.userData.pick), false);
        const id = hits[0]?.object.userData.id as string | undefined;
        if (id) cb.current.onSelect(id);
        else if (!tc.dragging) cb.current.onSelect(null);
      });
      // labels follow the camera (no idle render loop: they move only when the view or the markers do)
      sc.controls.addEventListener("change", () => placeLabels(k!));
      new ResizeObserver(() => { placeLabels(k!); drawNow(k!); }).observe(el);
      setReady((n) => n + 1);
    })();
    return () => {
      dead = true;
      if (k) { k.tc.dispose(); k.rig.dispose(); k.labels.remove(); k.sc.dispose(); }
      kit.current = null;
    };
  }, []);

  // model + texture
  useEffect(() => {
    const k = kit.current;
    if (!k) return;
    if (rig) k.rig.setRig(rig);
    k.rig.group.visible = !!rig;
    if (texture) {
      const t = new k.THREE.Texture(texture);
      t.magFilter = k.THREE.NearestFilter; t.minFilter = k.THREE.NearestFilter; t.colorSpace = k.THREE.SRGBColorSpace; t.needsUpdate = true;
      k.rig.setTextures([t]);
    } else k.rig.setTextures([]);
    drawNow(k);
  }, [rig, texture, ready]);

  // pose (the flight pose preview)
  useEffect(() => {
    const k = kit.current;
    if (!k) return;
    k.rig.setPose(pose ?? null);
    drawNow(k);
  }, [pose, rig, ready]);

  // markers
  useEffect(() => {
    const k = kit.current;
    if (!k) return;
    const { THREE } = k;
    for (const c of [...k.markers.children]) {
      k.markers.remove(c);
      c.traverse((o) => { const m = o as T.Mesh; m.geometry?.dispose(); (m.material as T.Material | undefined)?.dispose?.(); });
    }
    k.labels.textContent = "";
    for (const m of markers) {
      const sel = m.id === selected;
      if (m.ghost) { addCones(k, m, m.cones ?? []); continue; }
      const ball = new THREE.Mesh(new THREE.SphereGeometry(sel ? 1.1 : 0.8, 16, 12), new THREE.MeshBasicMaterial({ color: new THREE.Color(m.color), depthTest: false, transparent: true, opacity: sel ? 1 : 0.85 }));
      ball.position.set(...m.pos);
      ball.renderOrder = 10;
      if (m.dim) (ball.material as T.MeshBasicMaterial).opacity = 0.45;
      ball.userData = { pick: true, id: m.id };
      k.markers.add(ball);
      if (m.dir) {
        const d = new THREE.Vector3(...m.dir).normalize();
        const origin = new THREE.Vector3(...m.pos);
        if (m.beam) {
          const len = m.beam.length;
          const geo = new THREE.CylinderGeometry(m.beam.width, m.beam.width, len, 10, 1, true);
          geo.translate(0, len / 2, 0);
          const mat = new THREE.MeshBasicMaterial({ color: new THREE.Color(m.beam.end ?? m.color), transparent: true, opacity: 0.55, depthWrite: false, side: THREE.DoubleSide });
          const beam = new THREE.Mesh(geo, mat);
          beam.position.copy(origin);
          beam.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), d);
          k.markers.add(beam);
        } else if (m.cones) {
          addCones(k, m, m.cones);
        } else if (m.flame) {
          const len = m.flame.length;
          const mk = (r: number, col: string, op: number, l: number) => {
            const geo = new THREE.ConeGeometry(r, l, 14, 1, true);
            geo.translate(0, -l / 2, 0); // apex away from the nozzle
            geo.rotateX(Math.PI);
            const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: new THREE.Color(col), transparent: true, opacity: op, depthWrite: false, side: THREE.DoubleSide }));
            mesh.position.copy(origin);
            mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), d);
            return mesh;
          };
          k.markers.add(mk(m.flame.width, m.flame.outer, 0.35, len));
          k.markers.add(mk(m.flame.width * 0.45, m.flame.core, 0.8, len * 0.62)); // JetFlameRenderer.drawFlame: core is 0.62 long, 0.45 wide
        } else {
          const arrow = new THREE.ArrowHelper(d, origin, 6, new THREE.Color(m.color).getHex(), 1.6, 1);
          k.markers.add(arrow);
        }
      }
      const lab = document.createElement("div");
      lab.className = "pe-lab" + (sel ? " sel" : "");
      lab.textContent = m.label;
      lab.dataset.id = m.id;
      lab.onclick = () => cb.current.onSelect(m.id);
      k.labels.appendChild(lab);
    }
    const s = markers.find((m) => m.id === selected);
    const gizmo = mode === "rotate" ? !!(s?.rotatable && onRotate) : !!(s?.movable && onDrag);
    if (s && gizmo && !drag.current) {
      k.tc.setMode(mode);
      k.handle.position.set(...s.pos);
      if (mode === "rotate" && s.quat) k.handle.quaternion.set(...s.quat); else k.handle.quaternion.identity();
      k.tc.attach(k.handle);
      (k.tc.getHelper() as T.Object3D).visible = true;
    } else if (!drag.current) {
      k.tc.detach();
      (k.tc.getHelper() as T.Object3D).visible = false;
    }
    drawNow(k);
    placeLabels(k);
  }, [markers, selected, ready, mode]); // eslint-disable-line react-hooks/exhaustive-deps

  return <div className="pe-vp3" ref={host} data-testid={testId} />;

  function placeLabels(k: Kit) {
    const r = k.sc.renderer.domElement.getBoundingClientRect();
    if (!r.width) return;
    const v = new k.THREE.Vector3();
    for (const el of Array.from(k.labels.children) as HTMLElement[]) {
      const m = cb.current.markers.find((x) => x.id === el.dataset.id);
      if (!m) continue;
      v.set(...m.pos).project(k.sc.camera);
      const hidden = v.z > 1;
      el.style.display = hidden ? "none" : "";
      el.style.transform = `translate(${((v.x + 1) / 2) * r.width + 8}px, ${((1 - v.y) / 2) * r.height - 8}px)`;
    }
  }
}

const FLAME_MID = 0.3, FLAME_MID_RADIUS = 0.8; // JetFlameRenderer.MID / MID_RADIUS (l.42-43)

/**
 * JetFlameRenderer.cone (l.298-339) as a mesh: `radius` wide at the nozzle, 0.8 of it at 0.3 of the length, then to a point,
 * fading as it goes (alpha 1 -> 0.75 -> 0), added to the scene like the game's additive flame buffer.
 */
function addCones(k: Kit, m: Marker, cones: Cone[]) {
  const { THREE } = k;
  const d = new THREE.Vector3(...(m.dir ?? [0, -1, 0])).normalize();
  for (const c of cones) {
    if (c.length <= 0 || c.radius <= 0) continue;
    const pts = [new THREE.Vector2(c.radius, 0), new THREE.Vector2(c.radius * FLAME_MID_RADIUS, c.length * FLAME_MID), new THREE.Vector2(0, c.length)];
    const geo = new THREE.LatheGeometry(pts, 16);
    const fade = [1, 0.75, 0];
    const rgb = new THREE.Color(c.color);
    const col: number[] = [];
    const pos = geo.getAttribute("position");
    for (let i = 0; i < pos.count; i++) {
      const y = pos.getY(i);
      const f = y <= 1e-6 ? fade[0] : y >= c.length - 1e-6 ? fade[2] : fade[1];
      col.push(rgb.r * f, rgb.g * f, rgb.b * f);
    }
    geo.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
    const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: c.alpha, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }));
    mesh.position.set(...m.pos);
    mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), d);
    k.markers.add(mesh);
  }
}

/** The handle follows the marker while not dragging (an edit elsewhere moved it). */
export const sameVec = (a: NumVec3, b: NumVec3) => a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
