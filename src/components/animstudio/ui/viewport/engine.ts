/**
 * ViewportEngine: owns the three.js side of one Studio (stage, Blockbench camera rig, rig views, gizmo, face-drag resize,
 * picking / area select, onion skin, spidey preview, reference-image planes) and follows the StudioState store.
 * Render-on-demand: no rAF unless a render was requested. Values follow docs/BLOCKBENCH-PARITY.md sections 1.4 and 2.
 */
import type * as T from "three";
import {
  addKeyframe, offsetKeys, getAnimation, samplePose, spinPreview, aimAngles, animLength, mirrorBoneName, AIMED_BONE,
  LIMB_DRIVER_BONES, type AimKind, type Animation, type ChannelName, type Doc, type NumVec3, type Pose, type RefImage,
} from "../../core";
import type { StudioApi, StudioState, ViewName } from "../state";
import type { ViewportApi } from "../studios";
import { playerRigModel, rigFromDoc, rigTree, type RCube, type RigModel } from "../model";
import type { GeoTexLayer } from "../../core";
import { areaSelect, pickCube, selValue, topGroups, ofGroups, ofCubes } from "../selection";
import { moveBoneTree, cmdSetBone, cmdSetCube } from "../ops";
import { RigView, cubeGeometry, sceneVec, type LineKit } from "./rigView";
import { loadImage } from "../resolve";
import { CameraRig, VIEW_SIDE, FOV } from "./camera";
import { buildStage, BB, type Stage } from "./stage";
import { FaceHandles, type FaceHit } from "./faceHandles";
import { groupByBone, multiKeyTargets, valueDelta } from "./multikey";
import { moveStep, rotateStep, selectedCubes, type CubeRef } from "./select";
import { ConstraintsRuntime } from "../constraints/runtime"; // == constraints hook ==
import { perfDraw, perfEnd, perfStart } from "../perf";

type TH = typeof T;
const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;
const rnd = (v: number, dp = 4) => { const m = 10 ** dp; const r = Math.round(v * m) / m; return r === 0 ? 0 : r; };
const rnd3 = (v: ArrayLike<number>, dp = 4): NumVec3 => [rnd(v[0], dp), rnd(v[1], dp), rnd(v[2], dp)];

type DragKind = "cube-move" | "cube-rotate" | "cube-pivot" | "bone-move" | "bone-rotate" | "bone-pivot" | "key-rotation" | "key-position" | "key-scale";
interface Extra { obj: T.Object3D; bone: string; index?: number; pos: T.Vector3; rot: T.Euler; world: T.Vector3 }
interface DragStart {
  kind: DragKind;
  bone: string;
  index?: number;
  pos: T.Vector3;
  rot: T.Euler;
  scale: T.Vector3;
  world: T.Vector3;
  cube?: RCube;
  extras: Extra[];
}
interface FaceDrag {
  hit: FaceHit;
  origin: T.Vector3;
  dir: T.Vector3;
  t0: number;
  cubes: Array<{ bone: string; index: number; cube: RCube; size: NumVec3; originV: NumVec3 }>;
  last: Array<{ size: NumVec3; origin: NumVec3 }>;
}
interface Gesture {
  kind: "orbit" | "pan" | "zoom" | "area" | "click";
  x0: number; y0: number; x: number; y: number;
  moved: boolean;
  add: boolean; toggle: boolean; group: boolean;
}

export interface CamInfo {
  ortho: boolean; zoom: number; view: ViewName; w: number; h: number;
  /** screen position (CSS px, relative to the canvas) of the world origin */
  origin: { x: number; y: number };
}

export class ViewportEngine implements ViewportApi {
  private rig: RigView;
  private ghosts: RigView[] = [];
  private trick: T.Group;
  private proxy: T.Object3D;
  private tc!: import("three/examples/jsm/controls/TransformControls.js").TransformControls;
  private dead = false;
  private shift = false;
  private ctrl = false;
  private alt = false;
  private rigModel: RigModel | null = null;
  private rigDocRoot: unknown = null;
  private externalRig: RigModel | null = null;
  private tex: { host: string; path: string | null } = { host: "local", path: null };
  private texKey = "";
  private layers: { host: string; list: GeoTexLayer[] } | null = null;
  private layerKey = "";
  private texLoaded = 0;
  private framed = false;
  private drag: DragStart | null = null;
  private cancelled = false;
  private dragged = false;
  private target: { obj: T.Object3D; kind: DragKind; bone: string; index?: number } | null = null;
  private attachedKey = "";
  private unsub: () => void;
  private pending = false;
  private cleanups: Array<() => void> = [];
  private poseNow: Pose = {};
  /** "live aim": the draggable web-anchor marker (sphere) and the lines from the aimed joints to it */
  private anchor: { group: T.Group; ball: T.Mesh; lines: T.LineSegments } | null = null;
  private aimJoints: NumVec3[] = [];
  private rollOnly = false;
  private adrag: { plane: T.Plane; off: T.Vector3 } | null = null;
  private gameInfo: Record<string, unknown> = {};
  private ref!: T.LineSegments;
  private stage!: Stage;
  private cam!: CameraRig;
  private faces!: FaceHandles;
  private fdrag: FaceDrag | null = null;
  private gesture: Gesture | null = null;
  private areaEl: HTMLDivElement | null = null;
  private raf = 0;
  private fullSync = true;
  private viewH = 1;
  private lastSync: StudioState | null = null;
  private camSubs = new Set<() => void>();
  private refMeshes = new Map<string, { mesh: T.Mesh; sig: string }>();
  readonly scene: T.Scene;
  private renderer: T.WebGLRenderer;
  /** minimal facade used by the pose / texture code (render requests + scene access) */
  private kit: { scene: T.Scene; render: () => void };
  private dom!: HTMLCanvasElement;
  private host: HTMLElement;
  private ro?: ResizeObserver;
  private lines: LineKit;
  private lastCamKey = "";
  private cons!: ConstraintsRuntime; // == constraints hook ==

  private constructor(private THREE: TH, host: HTMLElement, private api: StudioApi, private tcMod: typeof import("three/examples/jsm/controls/TransformControls.js"), lines: LineKit) {
    const s = api.store.get();
    this.host = host;
    this.lines = lines;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.dom = this.renderer.domElement;
    this.dom.style.cssText = "display:block;width:100%;height:100%;outline:none;touch-action:none";
    host.appendChild(this.dom);
    this.scene = new THREE.Scene();
    this.kit = { scene: this.scene, render: () => this.request() };
    this.trick = new THREE.Group();
    this.rig = new RigView(THREE, { wire: s.wire, xray: s.xray, solid: s.viewMode === "solid" }, lines);
    this.trick.add(this.rig.group);
    this.scene.add(this.trick);
    this.proxy = new THREE.Object3D();
    this.scene.add(this.proxy);
    this.unsub = api.store.subscribe(() => this.schedule(false));
  }

  static async create(host: HTMLElement, api: StudioApi): Promise<ViewportEngine> {
    const THREE = await import("three");
    const [tcMod, ls2, lsg, lm] = await Promise.all([
      import("three/examples/jsm/controls/TransformControls.js"),
      import("three/examples/jsm/lines/LineSegments2.js"),
      import("three/examples/jsm/lines/LineSegmentsGeometry.js"),
      import("three/examples/jsm/lines/LineMaterial.js"),
    ]);
    const e = new ViewportEngine(THREE, host, api, tcMod, { LineSegments2: ls2.LineSegments2, LineSegmentsGeometry: lsg.LineSegmentsGeometry, LineMaterial: lm.LineMaterial });
    e.init();
    return e;
  }

  // ---------------------------------------------------------------- setup

  private init() {
    const { THREE } = this;
    const s0 = this.api.store.get();
    this.cam = new CameraRig(THREE, () => this.onCamera());
    this.stage = buildStage(THREE, this.scene, { shading: s0.shading, grid: s0.grid, ground: s0.ground });
    // player scale reference (0.6 x 1.8 blocks)
    const box = new THREE.BoxGeometry(9.6, 28.8, 9.6);
    box.translate(0, 14.4, 0);
    this.ref = new THREE.LineSegments(new THREE.EdgesGeometry(box), new THREE.LineDashedMaterial({ color: 0x81a1c1, dashSize: 1.5, gapSize: 1.2, transparent: true, opacity: 0.55 }));
    this.ref.computeLineDistances();
    this.ref.visible = false;
    this.scene.add(this.ref);

    // gizmo (move / rotate / animate-scale): three's TransformControls with Blockbench's colours
    const tc = new this.tcMod.TransformControls(this.cam.persp, this.dom);
    tc.setSize(0.7);
    tc.setColors(BB.axisX, BB.axisY, BB.axisZ, BB.accent);
    this.tc = tc;
    const helper = tc.getHelper();
    this.scene.add(helper);
    helper.traverse((o) => {
      const m = (o as T.Mesh).material as T.MeshBasicMaterial | undefined;
      if (!m || !m.color) return;
      const hex = m.color.getHex();
      if (hex === 0xffff00 || hex === 0x787878) { m.color.setHex(BB.accent); (m as unknown as { _color?: T.Color })._color?.setHex(BB.accent); }
    });
    tc.addEventListener("change", () => this.request());
    tc.addEventListener("dragging-changed", (e) => {
      const on = (e as unknown as { value: boolean }).value;
      if (on) this.beginDrag(); else this.endDrag();
    });
    tc.addEventListener("objectChange", () => { this.onObjectChange(); this.consLive(); }); // == constraints hook ==
    this.faces = new FaceHandles(THREE);
    // == constraints hook ==
    this.cons = new ConstraintsRuntime(THREE, { scene: this.scene, dom: this.dom, api: this.api, rig: () => this.rig, rigModel: () => this.rig.rig, camera: () => this.cam.camera, request: () => this.request(), isVisible: (m) => this.isVisible(m) });

    this.bindInput();
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(this.host);
    this.resize();
    this.sync();
  }

  private resize() {
    const w = this.host.clientWidth, h = this.host.clientHeight;
    if (!w || !h) return;
    this.viewH = h; // cached: reading clientHeight in draw() forced a synchronous layout of the whole page every frame
    this.renderer.setSize(w, h, false);
    this.cam.resize(w, h);
    this.rig.setResolution(w, h);
    this.ghosts.forEach((g) => g.setResolution(w, h));
    this.request();
  }

  dispose() {
    this.dead = true;
    cancelAnimationFrame(this.raf);
    this.unsub();
    this.cleanups.forEach((f) => f());
    this.ro?.disconnect();
    this.tc.detach();
    this.tc.dispose();
    this.faces.dispose();
    this.cons.dispose(); // == constraints hook ==
    this.stage.dispose();
    this.rig.dispose();
    this.ghosts.forEach((g) => g.dispose());
    for (const r of this.refMeshes.values()) { r.mesh.geometry.dispose(); (r.mesh.material as T.Material).dispose(); }
    this.areaEl?.remove();
    if (this.anchor) { this.anchor.ball.geometry.dispose(); (this.anchor.ball.material as T.Material).dispose(); this.anchor.lines.geometry.dispose(); (this.anchor.lines.material as T.Material).dispose(); }
    this.renderer.dispose();
    this.renderer.forceContextLoss();
    this.dom.remove();
  }

  // ---------------------------------------------------------------- render loop (on demand)

  private request() {
    if (this.raf || this.dead) return;
    this.raf = requestAnimationFrame(() => { this.raf = 0; this.draw(); });
  }
  private draw() {
    if (this.dead) return;
    const cam = this.cam.camera;
    this.tc.camera = cam;
    this.faces.update(cam, this.viewH);
    const t0 = perfStart();
    this.renderer.render(this.scene, cam);
    if (t0) {
      perfEnd("render", t0);
      const r = this.renderer.info.render;
      perfDraw(r.calls, r.triangles);
    }
  }
  /** render now (QA screenshots / tests that need the frame to exist) */
  render() { this.request(); }
  renderNow() { cancelAnimationFrame(this.raf); this.raf = 0; this.draw(); }
  /** QA bench: block until the GPU has finished the submitted frame (draw() only times the CPU side of `render`) */
  gpuFinish() { this.renderer.getContext().finish(); }

  private onCamera() {
    const c = this.cam;
    this.tc.camera = c.camera;
    if (this.api.store.get().view !== c.view || this.api.store.get().ortho !== c.isOrtho) this.api.store.set({ view: c.view, ortho: c.isOrtho });
    this.camSubs.forEach((f) => f());
    this.request();
  }
  subscribeCamera(f: () => void): () => void { this.camSubs.add(f); return () => this.camSubs.delete(f); }
  camInfo(): CamInfo {
    const v = new this.THREE.Vector3(0, 0, 0).project(this.cam.camera);
    const w = this.dom.clientWidth || 1, h = this.dom.clientHeight || 1;
    return { ortho: this.cam.isOrtho, zoom: this.cam.zoom, view: this.cam.view, w, h, origin: { x: (v.x * 0.5 + 0.5) * w, y: (-v.y * 0.5 + 0.5) * h } };
  }
  canvas() { return this.dom; }

  // ---------------------------------------------------------------- inputs from the shell

  setExternalRig(r: RigModel | null) {
    if (this.externalRig === r) return;
    this.externalRig = r;
    this.rigDocRoot = null;
    this.framed = false;
    this.schedule();
  }
  setTexturePath(host: string, path: string | null) {
    this.tex = { host, path };
    this.schedule();
  }
  /** geo files: stacked preview texture layers (bottom -> top); null / no visible layer falls back to the single texture path */
  setTextureLayers(host: string, list: GeoTexLayer[] | null) {
    const vis = list ? list.filter((l) => l.visible) : [];
    const key = list && list.length ? "L" + vis.map((l) => `${l.path}|${l.blend ?? ""}`).join(";") : "";
    if (key === this.layerKey && (this.layers?.host ?? host) === host) return;
    this.layerKey = key;
    this.layers = key ? { host, list: vis } : null;
    this.schedule();
  }

  /** `full` = something outside the store changed (rig, textures ...): the next sync may not take the playhead-only fast path */
  private schedule(full = true) {
    if (full) this.fullSync = true;
    if (this.pending || this.dead) return;
    this.pending = true;
    queueMicrotask(() => { this.pending = false; if (!this.dead) this.sync(!this.fullSync); });
  }

  // ---------------------------------------------------------------- sync

  private currentRig(s: StudioState): RigModel | null {
    if (s.doc && s.doc.kind !== "animation") {
      if (this.rigDocRoot !== s.doc.root || !this.rigModel) {
        this.rigDocRoot = s.doc.root;
        this.rigModel = rigFromDoc(s.doc);
      }
      return this.rigModel;
    }
    return this.externalRig ?? (s.doc ? (this.rigModel = this.rigModel?.source === "player" ? this.rigModel : playerRigModel()) : null);
  }

  private animSource(s: StudioState): { anim: Animation; doc: Doc } | null {
    if (s.doc && s.doc.kind !== "geo" && s.mode !== "edit" && s.anim) {
      const a = getAnimation(s.doc, s.anim);
      if (a) return { anim: a, doc: s.doc };
    }
    if (s.ext?.anim) {
      const a = getAnimation(s.ext.doc, s.ext.anim);
      if (a) return { anim: a, doc: s.ext.doc };
    }
    return null;
  }

  sync(fast = false) {
    if (this.dead) return;
    const s = this.api.store.get();
    const prev = this.lastSync;
    this.lastSync = s;
    this.fullSync = false;
    // playback ticks only move the playhead: re-pose (and onion / anchor / gizmo, which follow the pose) and skip the rig / style / stage / selection reconcile
    if (fast && prev && this.rig.rig && playheadOnly(prev, s)) {
      const tp = perfStart();
      this.applyPose(s);
      perfEnd("pose", tp);
      this.updateAnchor(s);
      this.applyOnion(s);
      this.updateGizmo(s);
      this.request();
      return;
    }
    const rm = this.currentRig(s);
    if (rm && rm !== this.rig.rig) {
      this.rig.setRig(rm);
      this.ghosts.forEach((g) => g.setRig(rm));
      void this.loadTextures(rm, true);
      if (!this.framed && rm.bones.length) { this.framed = true; this.initialFrame(); }
    } else if (rm) void this.loadTextures(rm, false);
    const solid = s.viewMode === "solid";
    this.rig.setStyle({ wire: s.wire, xray: s.xray, solid });
    this.rig.setHidden(s.hidden);
    const cubes = s.mode === "edit" ? selectedCubes(s) : [];
    // a cube selection outlines the cubes only; a group selection outlines every cube inside the groups (and their child groups)
    const tree = rigTree(rm);
    const groupCubes = s.mode === "edit" && cubes.length ? [] : s.bones.flatMap((b) => tree.cubesUnder(b));
    this.rig.setSelection(s.mode === "edit" && cubes.length ? [] : s.bones, cubes, s.tool === "pivot", groupCubes);
    this.setReference(s.reference);
    this.stage.setGrid(s.grid);
    this.stage.setShading(s.shading);
    this.stage.setGround(s.ground);
    this.syncCamera(s);
    this.syncRefPlanes(s);
    const tp = perfStart();
    this.applyPose(s);
    perfEnd("pose", tp);
    this.cons.sync(s); this.tc.enabled = !s.cons.pick; // == constraints hook ==
    this.updateAnchor(s);
    this.applyOnion(s);
    this.updateGizmo(s);
    this.request();
  }

  /** the store is the interface for other code (keybinds, bridge): make the camera follow `view` / `ortho` changes made there */
  private syncCamera(s: StudioState) {
    const key = `${s.view}|${s.ortho}`;
    if (key === this.lastCamKey) return;
    this.lastCamKey = key;
    const c = this.cam;
    if (s.view !== c.view) { c.setPreset(s.view); return; }
    if (s.ortho !== c.isOrtho) c.setOrtho(s.ortho);
  }

  /** Blockbench opens at its initial camera; only models that do not fit that view get fitted */
  private initialFrame() {
    const box = this.worldBox(null);
    if (!box || box.isEmpty()) return;
    const size = box.getSize(new this.THREE.Vector3());
    if (Math.max(size.x, size.y, size.z) > 56) this.frame(false);
  }

  private applyPose(s: StudioState) {
    const src = this.animSource(s);
    let pose: Pose | null = null;
    this.gameInfo = {};
    this.trick.position.set(0, 0, 0);
    this.trick.quaternion.set(0, 0, 0, 1);
    if (src) {
      pose = samplePose(src.anim, s.time);
      if (s.previewPose) {
        const merged: Pose = { ...pose };
        for (const [b, p] of Object.entries(s.previewPose)) merged[b] = { ...merged[b], ...p };
        pose = merged;
      }
      pose = this.cons.apply(s, pose); // == constraints hook == limb links, before "as the game applies it"
      if (s.asGameApplies) pose = this.applyGame(s, src.anim, pose);
      else this.rig.setGhostBones([]);
    } else {
      this.rig.setGhostBones([]);
      if (s.previewPose) pose = s.previewPose;
    }
    this.poseNow = pose ?? {};
    this.rig.setPose(pose);
  }

  /**
   * "As the game applies it" (core/spidey/game.ts has the Java citations): mirrored clips L<->R, channels the game never reads dropped
   * (position keys of pose-only clips), aimed limbs pointed at the web-anchor marker (pitch / yaw from LimbDriver.aimFrom, the clip's roll),
   * procedural limbs ghosted, and the whole-body spin about the hinge (centre of mass + swing_pivot) over the spin's own ticks.
   * The normal view is Blockbench-identical; file -> scene is also what the game shows for limb rotations / positions (SCENE == BODY frame).
   */
  private applyGame(s: StudioState, anim: Animation, pose: Pose): Pose {
    const info = s.clipInfo[anim.name];
    let p = pose;
    if (info?.mirrored) {
      const m: Pose = {};
      for (const [b, bp] of Object.entries(p)) {
        const nb = mirrorBoneName(b);
        m[nb] = {
          rotation: bp.rotation ? [bp.rotation[0], -bp.rotation[1], -bp.rotation[2]] : undefined,
          position: bp.position ? [-bp.position[0], bp.position[1], bp.position[2]] : undefined,
          scale: bp.scale,
        };
      }
      p = m;
    }
    // channels nothing plays: a pose-only clip is read for the five limbs' rotations and swing_pivot Y only (+ limb positions in the wall crawl)
    const ignored: string[] = [];
    if (info && info.inPoseSet && info.kind !== "drawn" && info.poseOnly) {
      const keep: Pose = {};
      for (const [b, bp] of Object.entries(p)) {
        const limb = LIMB_DRIVER_BONES.includes(b);
        const k: Pose[string] = {};
        if (limb && bp.rotation) k.rotation = bp.rotation;
        if (bp.position && (b === "swing_pivot" || (info.positions === "limb-driver" && limb && b !== "armorHead"))) k.position = bp.position;
        if (bp.position && !k.position) ignored.push(b);
        keep[b] = k;
      }
      p = keep;
    }
    const ghost = LIMB_DRIVER_BONES.filter((b) => !anim.bones.get(b)?.rotation && !anim.bones.get(mirrorBoneName(b))?.rotation);
    this.rig.setGhostBones(ghost);
    // live aim: pitch + yaw of the aimed limbs point at the anchor marker, the roll stays the clip's
    const aimedBones: string[] = [];
    this.aimJoints = [];
    if (info && s.liveAim && info.aimed.length) {
      const q: Pose = { ...p };
      for (const a of info.aimed) {
        let bone = AIMED_BONE[a];
        if (!bone || a === "head") continue;
        if (info.mirrored) bone = mirrorBoneName(bone);
        const kind = (a.startsWith("right") ? "right_" : "left_") + (a.endsWith("arm") ? "arm" : "leg") as AimKind;
        const rb = this.rigModel?.bones.find((x) => x.name === bone) ?? playerRigModel().bones.find((x) => x.name === bone);
        if (!rb) continue;
        const aim = aimAngles(kind, sceneVec(rb.pivot), s.webAnchor, q[bone]?.rotation?.[1] ?? 0);
        q[bone] = { ...q[bone], rotation: [aim.pitch, aim.yaw, q[bone]?.rotation?.[2] ?? 0] };
        aimedBones.push(bone);
        this.aimJoints.push(sceneVec(rb.pivot));
      }
      p = q;
    }
    this.gameInfo = { kind: info?.kind ?? null, positions: info?.positions ?? null, mirrored: !!info?.mirrored, ghost, ignoredPositions: ignored, aimed: aimedBones, spin: info?.spin?.axis ?? null };
    if (info?.spin) {
      const sp = spinPreview(anim, info.spin, s.time, animLength(anim));
      this.trick.quaternion.set(sp.quat[0], sp.quat[1], sp.quat[2], sp.quat[3]);
      this.trick.position.set(sp.position[0], sp.position[1], sp.position[2]);
      this.gameInfo = { ...this.gameInfo, spinAngle: Math.round(sp.angle * 100) / 100, spinProgress: Math.round(sp.progress * 1000) / 1000, hinge: [sp.live[1], sp.live[2]].map((v) => Math.round(v * 100) / 100) };
    }
    return p;
  }

  /** The web-anchor marker: shown while "As game applies" + "Live aim" are on and the clip has aimed limbs. */
  private updateAnchor(s: StudioState) {
    const { THREE } = this;
    const on = s.asGameApplies && s.liveAim && this.aimJoints.length > 0;
    if (!on) { if (this.anchor) this.anchor.group.visible = false; return; }
    if (!this.anchor) {
      const group = new THREE.Group();
      const ball = new THREE.Mesh(new THREE.SphereGeometry(2.6, 16, 12), new THREE.MeshBasicMaterial({ color: 0xebcb8b, depthTest: false, transparent: true, opacity: 0.95 }));
      ball.renderOrder = 20;
      const lines = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: 0xebcb8b, depthTest: false, transparent: true, opacity: 0.8 }));
      lines.renderOrder = 19;
      lines.frustumCulled = false;
      group.add(lines);
      group.add(ball);
      this.scene.add(group);
      this.anchor = { group, ball, lines };
    }
    const a = this.anchor;
    a.group.visible = true;
    a.ball.position.set(s.webAnchor[0], s.webAnchor[1], s.webAnchor[2]);
    const pts: number[] = [];
    for (const j of this.aimJoints) pts.push(j[0], j[1], j[2], s.webAnchor[0], s.webAnchor[1], s.webAnchor[2]);
    a.lines.geometry.setAttribute("position", new THREE.Float32BufferAttribute(pts, 3));
    a.lines.geometry.computeBoundingSphere();
  }
  /** QA: canvas-relative screen position of the anchor marker, null while hidden */
  anchorScreen(): { x: number; y: number } | null {
    const a = this.anchor;
    if (!a || !a.group.visible) return null;
    this.renderNow();
    const v = a.ball.position.clone().project(this.cam.camera);
    return { x: (v.x * 0.5 + 0.5) * this.dom.clientWidth, y: (-v.y * 0.5 + 0.5) * this.dom.clientHeight };
  }
  private hitAnchor(clientX: number, clientY: number): boolean {
    const a = this.anchor;
    if (!a || !a.group.visible) return false;
    this.scene.updateMatrixWorld(true);
    return this.rayAt(clientX, clientY).intersectObject(a.ball, false).length > 0;
  }
  private startAnchorDrag(e: PointerEvent) {
    const { THREE } = this;
    const a = this.anchor!;
    const normal = this.cam.camera.getWorldDirection(new THREE.Vector3());
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(normal, a.ball.position);
    const hit = this.rayAt(e.clientX, e.clientY).ray.intersectPlane(plane, new THREE.Vector3());
    this.adrag = { plane, off: hit ? a.ball.position.clone().sub(hit) : new THREE.Vector3() };
    this.capture(e);
  }
  private moveAnchorDrag(e: PointerEvent) {
    const d = this.adrag;
    if (!d) return;
    const hit = this.rayAt(e.clientX, e.clientY).ray.intersectPlane(d.plane, new this.THREE.Vector3());
    if (!hit) return;
    hit.add(d.off);
    this.api.store.set({ webAnchor: [rnd(hit.x, 2), rnd(hit.y, 2), rnd(hit.z, 2)] });
  }

  private applyOnion(s: StudioState) {
    const { THREE } = this;
    const src = this.animSource(s);
    const want = s.onion.on && s.mode !== "edit" && src && this.rigModel ? s.onion.before + s.onion.after : 0;
    while (this.ghosts.length > want) this.ghosts.pop()!.dispose();
    if (!want || !src) { this.kit.render(); return; }
    while (this.ghosts.length < want) {
      const i = this.ghosts.length;
      const past = i < s.onion.before;
      const g = new RigView(THREE, { wire: false, xray: false, ghost: { color: past ? 0xbf616a : 0xa3be8c, opacity: 0.22 } });
      this.kit.scene.add(g.group);
      this.rig.rig && g.setRig(this.rig.rig);
      this.ghosts.push(g);
    }
    this.ghosts.forEach((g, i) => {
      const past = i < s.onion.before;
      const k = past ? s.onion.before - i : i - s.onion.before + 1;
      const t = s.time + (past ? -k : k) * s.onion.step;
      g.setPose(this.cons.apply(s, samplePose(src.anim, Math.max(0, t)), Math.max(0, t), undefined, false)); // == constraints hook ==
      g.group.visible = t >= 0;
    });
  }

  private async loadTextures(rm: RigModel, force: boolean) {
    const { THREE } = this;
    const key = rm.source === "bbmodel" ? "bb:" + rm.textures.map((t) => t.length + ":" + t.slice(-16)).join(",") : this.layers ? "L:" + this.layerKey : `${this.tex.host}:${this.tex.path ?? ""}`;
    if (!force && key === this.texKey) return;
    this.texKey = key;
    const mk = (img: HTMLImageElement | HTMLCanvasElement | null) => {
      if (!img) return null;
      const t = new THREE.Texture(img);
      t.magFilter = THREE.NearestFilter; t.minFilter = THREE.NearestFilter; t.colorSpace = THREE.SRGBColorSpace; t.flipY = true; t.needsUpdate = true;
      return t;
    };
    let texs: (T.Texture | null)[] = [];
    if (rm.source === "bbmodel") {
      texs = await Promise.all(rm.textures.map((src) => new Promise<T.Texture | null>((res) => {
        if (!src) return res(null);
        const img = new Image();
        img.onload = () => res(mk(img));
        img.onerror = () => res(null);
        img.src = src;
      })));
    } else if (this.layers) {
      texs = [mk(await this.compositeLayers(this.layers.host, this.layers.list))];
    } else if (this.tex.path) {
      texs = [mk(await loadImage(this.tex.host, this.tex.path))];
    }
    if (this.dead || key !== this.texKey) return;
    this.texLoaded = texs.filter(Boolean).length;
    this.rig.setTextures(texs);
    this.kit.render();
  }

  /** Stack preview layers into one canvas image (base = first layer's size; "add" blends additively, e.g. an emissive overlay). */
  private async compositeLayers(host: string, list: GeoTexLayer[]): Promise<HTMLImageElement | HTMLCanvasElement | null> {
    const imgs = await Promise.all(list.map((l) => loadImage(host, l.path)));
    const first = imgs.find((i) => !!i);
    if (!first) return null;
    if (list.length === 1) return first;
    const c = document.createElement("canvas");
    c.width = first.naturalWidth; c.height = first.naturalHeight;
    const g = c.getContext("2d")!;
    g.imageSmoothingEnabled = false;
    imgs.forEach((im, i) => {
      if (!im) return;
      g.globalCompositeOperation = list[i].blend === "add" ? "lighter" : "source-over";
      g.drawImage(im, 0, 0, c.width, c.height);
    });
    return c;
  }

  // ---------------------------------------------------------------- reference planes ("3D Plane" view mode)

  private syncRefPlanes(s: StudioState) {
    const { THREE } = this;
    const want = s.refsHidden ? [] : s.refs.filter((r) => r.view_mode === "plane" && r.visibility && r.opacity >= 0.1 && (!r.modes.length || r.modes.includes(s.mode)));
    for (const [id, r] of [...this.refMeshes]) {
      if (!want.some((w) => w.uuid === id)) { this.scene.remove(r.mesh); r.mesh.geometry.dispose(); (r.mesh.material as T.MeshBasicMaterial).map?.dispose(); (r.mesh.material as T.Material).dispose(); this.refMeshes.delete(id); }
    }
    for (const r of want) {
      const sig = [r.source.length, r.source.slice(-24), r.size.join(), r.plane_position.join(), r.plane_rotation.join(), r.flip_x, r.flip_y, r.opacity, r.cull_backface].join("|");
      let e = this.refMeshes.get(r.uuid);
      if (e && e.sig === sig) continue;
      if (!e) {
        const mat = new THREE.MeshBasicMaterial({ transparent: true, side: THREE.DoubleSide, depthWrite: false });
        const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), mat);
        mesh.renderOrder = -1;
        this.scene.add(mesh);
        e = { mesh, sig: "" };
        this.refMeshes.set(r.uuid, e);
        const img = new Image();
        img.onload = () => { if (this.dead) return; const t = new THREE.Texture(img); t.colorSpace = THREE.SRGBColorSpace; t.needsUpdate = true; mat.map = t; mat.needsUpdate = true; this.request(); };
        img.src = r.source;
      }
      e.sig = sig;
      const mat = e.mesh.material as T.MeshBasicMaterial;
      mat.opacity = r.opacity;
      mat.side = r.cull_backface ? THREE.FrontSide : THREE.DoubleSide;
      // 3D plane size: 8 reference px per model unit (the default ortho scale)
      e.mesh.scale.set((r.size[0] / 8) * (r.flip_x ? -1 : 1), (r.size[1] / 8) * (r.flip_y ? -1 : 1), 1);
      e.mesh.position.set(r.plane_position[0], r.plane_position[1], r.plane_position[2]);
      e.mesh.rotation.set(r.plane_rotation[0] * D2R, r.plane_rotation[1] * D2R, r.plane_rotation[2] * D2R);
    }
  }

  // ---------------------------------------------------------------- gizmo

  private modsFrom(e: { shiftKey: boolean; ctrlKey: boolean; metaKey: boolean; altKey: boolean }) {
    this.shift = e.shiftKey; this.ctrl = e.ctrlKey || e.metaKey; this.alt = e.altKey;
  }

  private applySnap() {
    const s = this.api.store.get();
    const t = moveStep(this.shift, this.ctrl);
    this.tc.setTranslationSnap(s.snap ? t : null);
    this.tc.setRotationSnap(s.snap ? rotateStep(this.shift, this.ctrl) * D2R : null);
    this.tc.setScaleSnap(s.snap ? (this.ctrl ? 0.01 : this.shift ? 0.05 : 0.1) : null);
    this.tc.setSpace(s.space === "global" ? "world" : "local");
  }

  private updateGizmo(s: StudioState) {
    const t = this.pickTarget(s);
    const faceCube = s.mode === "edit" && s.tool === "resize" && s.cube && this.rigModel?.editable && s.doc?.kind !== "animation" && !s.ext?.anim && !s.locked.includes(s.cube.bone) && !s.hidden.includes(s.cube.bone)
      ? this.rig.cubeMesh(s.cube.bone, s.cube.index) ?? null : null;
    if (this.faces && !this.fdrag) this.faces.attach(faceCube);
    // an aimed limb's pitch and yaw are code-driven in game: its rotate gizmo only offers roll
    const info = s.anim ? s.clipInfo[s.anim] : undefined;
    const rollOnly = !!t && t.kind === "key-rotation" && !!info && info.kind !== "drawn" && info.aimed.some((a) => AIMED_BONE[a] === t.bone);
    this.tc.showX = !rollOnly;
    this.tc.showY = !rollOnly;
    this.tc.showZ = true;
    this.rollOnly = rollOnly;
    const key = t ? `${t.kind}:${t.bone}:${t.index ?? ""}:${t.obj.uuid}:${s.space}:${rollOnly}` : "";
    this.applySnap();
    if (this.drag) return;
    if (key === this.attachedKey) return;
    this.attachedKey = key;
    this.target = t;
    if (!t) { this.tc.detach(); (this.tc.getHelper() as T.Object3D).visible = false; return; }
    (this.tc.getHelper() as T.Object3D).visible = true;
    this.tc.setMode(t.kind.endsWith("rotate") || t.kind === "key-rotation" ? "rotate" : t.kind === "key-scale" ? "scale" : "translate");
    this.tc.attach(t.obj);
  }

  /** Which object the gizmo drives for the current mode / tool / selection (resize in Edit mode uses the face handles instead). */
  private pickTarget(s: StudioState): { obj: T.Object3D; kind: DragKind; bone: string; index?: number } | null {
    const tool = s.tool;
    if (!s.doc) return null;
    const tops = s.mode === "edit" && !s.cube ? topGroups(s.bones, rigTree(this.rigModel)) : s.bones;
    const bone = s.cube?.bone ?? tops[0];
    if (!bone || s.locked.includes(bone) || s.hidden.includes(bone)) return null;
    const node = this.rig.boneRest(bone);
    if (!node) return null;
    if (s.mode === "edit") {
      if (!this.rigModel?.editable || s.doc.kind === "animation" || s.ext?.anim) return null;
      if (s.cube) {
        const mesh = this.rig.cubeMesh(s.cube.bone, s.cube.index);
        const cube = this.rigModel.bones.find((b) => b.name === s.cube!.bone)?.cubes.find((c) => c.index === s.cube!.index);
        if (!mesh || !cube) return null;
        const idx = s.cube.index;
        if (tool === "move") return { obj: mesh, kind: "cube-move", bone, index: idx };
        if (tool === "rotate") return { obj: mesh, kind: "cube-rotate", bone, index: idx };
        if (tool === "resize") return null;
        node.group.add(this.proxy);
        this.proxy.rotation.order = "ZYX";
        this.proxy.scale.set(1, 1, 1);
        this.proxy.position.copy(mesh.position);
        this.proxy.rotation.set(0, 0, 0);
        return { obj: this.proxy, kind: "cube-pivot", bone, index: idx };
      }
      if (tool === "move") return { obj: node.group, kind: "bone-move", bone };
      if (tool === "rotate") return { obj: node.group, kind: "bone-rotate", bone };
      if (tool === "pivot") {
        node.group.add(this.proxy);
        this.proxy.position.set(0, 0, 0);
        this.proxy.rotation.set(0, 0, 0);
        this.proxy.scale.set(1, 1, 1);
        return { obj: this.proxy, kind: "bone-pivot", bone };
      }
      return null;
    }
    // animate / pose: keys on the selected bone
    if (s.doc.kind === "geo" || !s.anim || tool === "pivot") return null;
    if (tool === "move") return { obj: node.group, kind: "key-position", bone };
    if (tool === "rotate") return { obj: node.group, kind: "key-rotation", bone };
    return { obj: node.group, kind: "key-scale", bone };
  }

  /** other selected objects that follow the primary during a move / rotate (multi-select transforms all selected) */
  private extrasFor(t: { kind: DragKind; bone: string; index?: number }): Extra[] {
    const s = this.api.store.get();
    const out: Extra[] = [];
    const mk = (obj: T.Object3D, bone: string, index?: number): Extra => ({ obj, bone, index, pos: obj.position.clone(), rot: obj.rotation.clone(), world: obj.getWorldPosition(new this.THREE.Vector3()) });
    if (t.kind.startsWith("cube-") && t.kind !== "cube-pivot") {
      for (const c of selectedCubes(s)) {
        if (c.bone === t.bone && c.index === t.index) continue;
        const m = this.rig.cubeMesh(c.bone, c.index);
        if (m) out.push(mk(m, c.bone, c.index));
      }
    } else if (t.kind === "bone-move" || t.kind === "bone-rotate") {
      for (const b of topGroups(s.bones, rigTree(this.rigModel))) {
        if (b === t.bone || s.locked.includes(b)) continue;
        const g = this.rig.boneGroup(b);
        if (g) out.push(mk(g, b));
      }
    }
    // fork B: Animate / Pose key drags move every selected bone (live preview); commit keys each of them
    if (t.kind.startsWith("key-")) {
      for (const b of s.bones) {
        if (b === t.bone || s.locked.includes(b)) continue;
        const g = this.rig.boneGroup(b);
        if (g) out.push({ ...mk(g, b), scale: g.scale.clone() } as Extra);
      }
    }
    return out;
  }

  private beginDrag() {
    const t = this.target;
    if (!t) return;
    this.dragged = true;
    this.cancelled = false;
    const o = t.obj;
    const rm = this.rigModel;
    this.scene.updateMatrixWorld(true);
    this.drag = {
      kind: t.kind, bone: t.bone, index: t.index, pos: o.position.clone(), rot: o.rotation.clone(), scale: o.scale.clone(), world: o.getWorldPosition(new this.THREE.Vector3()),
      cube: t.index !== undefined ? rm?.bones.find((b) => b.name === t.bone)?.cubes.find((c) => c.index === t.index) : undefined,
      extras: this.extrasFor(t),
    };
    this.api.beginGesture();
  }

  private onObjectChange() {
    const d = this.drag;
    const t = this.target;
    if (!d || !t || !d.extras.length) return;
    const o = t.obj;
    if (d.kind === "cube-move" || d.kind === "bone-move") {
      const wd = o.getWorldPosition(new this.THREE.Vector3()).sub(d.world);
      for (const e of d.extras) {
        e.obj.parent?.updateWorldMatrix(true, false);
        e.obj.position.copy(e.obj.parent ? e.obj.parent.worldToLocal(e.world.clone().add(wd)) : e.world.clone().add(wd));
      }
    } else if (d.kind === "cube-rotate" || d.kind === "bone-rotate") {
      const dx = o.rotation.x - d.rot.x, dy = o.rotation.y - d.rot.y, dz = o.rotation.z - d.rot.z;
      for (const e of d.extras) e.obj.rotation.set(e.rot.x + dx, e.rot.y + dy, e.rot.z + dz);
    } else if (d.kind === "key-rotation") {
      const dx = o.rotation.x - d.rot.x, dy = o.rotation.y - d.rot.y, dz = o.rotation.z - d.rot.z;
      for (const e of d.extras) e.obj.rotation.set(e.rot.x + dx, e.rot.y + dy, e.rot.z + dz);
    } else if (d.kind === "key-position") {
      const dp = o.position.clone().sub(d.pos);
      for (const e of d.extras) e.obj.position.copy(e.pos.clone().add(dp));
    } else if (d.kind === "key-scale") {
      const f = [o.scale.x / (d.scale.x || 1), o.scale.y / (d.scale.y || 1), o.scale.z / (d.scale.z || 1)];
      for (const e of d.extras) { const sc = (e as unknown as { scale?: T.Vector3 }).scale; if (sc) e.obj.scale.set(sc.x * f[0], sc.y * f[1], sc.z * f[2]); }
    }
  }

  private endDrag() {
    const d = this.drag;
    const t = this.target;
    this.drag = null;
    if (!d || !t) return;
    try {
      if (this.cancelled) {
        t.obj.position.copy(d.pos); t.obj.rotation.copy(d.rot); t.obj.scale.copy(d.scale);
        for (const e of d.extras) { e.obj.position.copy(e.pos); e.obj.rotation.copy(e.rot); const sc = (e as unknown as { scale?: T.Vector3 }).scale; if (sc) e.obj.scale.copy(sc); }
      } else this.commitDrag(d, t.obj);
    } finally {
      this.cancelled = false;
      this.api.endGesture();
      this.attachedKey = "";
      this.proxy.scale.set(1, 1, 1);
      this.schedule();
    }
  }

  private commitDrag(d: DragStart, o: T.Object3D) {
    const s = this.api.store.get();
    let doc = s.doc;
    if (!doc) return;
    const all = [{ obj: o, bone: d.bone, index: d.index, pos: d.pos, rot: d.rot }, ...d.extras];
    const delta = (x: { obj: T.Object3D; pos: T.Vector3 }): NumVec3 => {
      const dp = x.obj.position.clone().sub(x.pos);
      return [rnd(-dp.x), rnd(dp.y), rnd(dp.z)];
    };
    switch (d.kind) {
      case "cube-move": {
        let n = 0;
        for (const x of all) {
          const fd = delta(x);
          const c = this.cubeOf(x.bone, x.index!);
          if (c && (fd[0] || fd[1] || fd[2])) {
            const add = (v: NumVec3): NumVec3 => rnd3([v[0] + fd[0], v[1] + fd[1], v[2] + fd[2]]);
            doc = cmdSetCube(doc, x.bone, x.index!, { origin: add(c.origin), pivot: c.pivot ? add(c.pivot) : undefined });
            n++;
          }
        }
        if (n) this.api.commit(doc, n > 1 ? "Move Cubes" : "Move Cube");
        break;
      }
      case "cube-rotate": {
        const dRot = [o.rotation.x - d.rot.x, o.rotation.y - d.rot.y, o.rotation.z - d.rot.z];
        void dRot;
        for (const x of all) {
          const e = x.obj.rotation;
          const rot = rnd3([-e.x * R2D, -e.y * R2D, e.z * R2D], 3);
          const none = rot[0] === 0 && rot[1] === 0 && rot[2] === 0;
          const had = this.rigModel?.bones.find((b) => b.name === x.bone)?.cubes.find((c) => c.index === x.index)?.rotation;
          doc = cmdSetCube(doc, x.bone, x.index!, { rotation: none && !had ? null : rot });
        }
        this.api.commit(doc, all.length > 1 ? "Rotate Cubes" : "Rotate Cube");
        break;
      }
      case "cube-pivot": {
        const fd = delta({ obj: o, pos: d.pos });
        const base = d.cube?.pivot ?? this.rigModel!.bones.find((b) => b.name === d.bone)!.pivot;
        this.api.commit(cmdSetCube(doc, d.bone, d.index!, { pivot: rnd3([base[0] + fd[0], base[1] + fd[1], base[2] + fd[2]]) }), "Move Pivot");
        break;
      }
      case "bone-move": {
        let n = 0;
        for (const x of all) { const fd = delta(x); if (fd[0] || fd[1] || fd[2]) { doc = moveBoneTree(doc, x.bone, fd); n++; } }
        if (n) this.api.commit(doc, n > 1 ? "Move Bones" : "Move Bone");
        break;
      }
      case "bone-rotate": {
        for (const x of all) {
          const e = x.obj.rotation;
          const rot = rnd3([-e.x * R2D, -e.y * R2D, e.z * R2D], 3);
          const none = rot[0] === 0 && rot[1] === 0 && rot[2] === 0;
          const had = this.rigModel!.bones.find((b) => b.name === x.bone)?.rotation;
          doc = cmdSetBone(doc, x.bone, { rotation: none && !had ? null : rot });
        }
        this.api.commit(doc, all.length > 1 ? "Rotate Bones" : "Rotate Bone");
        break;
      }
      case "bone-pivot": {
        const fd = delta({ obj: o, pos: d.pos });
        const b = this.rigModel!.bones.find((x) => x.name === d.bone)!;
        this.api.commit(cmdSetBone(doc, d.bone, { pivot: rnd3([b.pivot[0] + fd[0], b.pivot[1] + fd[1], b.pivot[2] + fd[2]]) }), "Move Pivot");
        break;
      }
      case "key-rotation":
      case "key-position":
      case "key-scale": {
        if (!s.anim) break;
        const channel: ChannelName = d.kind === "key-rotation" ? "rotation" : d.kind === "key-position" ? "position" : "scale";
        const valueOf = (bone: string, eul: T.Euler, pos: T.Vector3, sc: T.Vector3): NumVec3 | null => {
          const node = this.rig.boneRest(bone);
          if (!node) return null;
          if (channel === "rotation") return rnd3([-(eul.x - node.restRot.x) * R2D, -(eul.y - node.restRot.y) * R2D, (eul.z - node.restRot.z) * R2D], 2);
          if (channel === "position") return rnd3([-(pos.x - node.restPos.x), pos.y - node.restPos.y, pos.z - node.restPos.z], 3);
          return rnd3([sc.x, sc.y, sc.z], 3);
        };
        // every dragged bone: the primary plus the other selected bones that followed it
        const dragged = [
          { bone: d.bone, pre: valueOf(d.bone, d.rot, d.pos, d.scale), post: valueOf(d.bone, o.rotation, o.position, o.scale) },
          ...d.extras.map((e) => {
            const sc = (e as unknown as { scale?: T.Vector3 }).scale ?? e.obj.scale;
            return { bone: e.bone, pre: valueOf(e.bone, e.rot, e.pos, sc), post: valueOf(e.bone, e.obj.rotation, e.obj.position, e.obj.scale) };
          }),
        ].filter((x): x is { bone: string; pre: NumVec3; post: NumVec3 } => !!x.pre && !!x.post);
        if (s.autoKey) dragged.push(...this.cons.extraKeyed(s, channel, dragged.map((x) => x.bone))); // == constraints hook == "Key constrained bones"
        if (!dragged.length) break;
        const time = rnd(s.snapTicks ? Math.round(s.time / 0.05) * 0.05 : s.time);
        if (!s.autoKey) {
          const pp = { ...(s.previewPose ?? {}) };
          for (const x of dragged) pp[x.bone] = { ...(pp[x.bone] ?? {}), [channel]: x.post };
          this.api.store.set({ previewPose: pp });
          break;
        }
        const targets = multiKeyTargets(s.keys, channel, time);
        if (targets) {
          // Blockbench: several keys selected and the playhead on one -> the same delta moves all of them (one undo step)
          const prim = dragged[0];
          let out = doc;
          for (const [bone, ks] of groupByBone(targets)) {
            const x = dragged.find((y) => y.bone === bone) ?? prim;
            const dv = valueDelta(x.pre, x.post);
            out = offsetKeys(out, { anim: s.anim, keys: ks, delta: { [channel]: dv } });
          }
          this.api.commit(out, "Move Keyframes");
          this.api.store.set({ previewPose: null });
          break;
        }
        let out = doc;
        for (const x of dragged) out = addKeyframe(out, { anim: s.anim, bone: x.bone, channel, time, value: x.post });
        this.api.commit(out, dragged.length > 1 ? "Set Keyframes" : "Set Keyframe");
        this.api.store.set({ previewPose: null, keys: dragged.map((x) => ({ bone: x.bone, channel, time })) });
        break;
      }
    }
  }

  // ---------------------------------------------------------------- face-drag resize (Blockbench Resize tool)

  /** parameter t of the point on the axis line (o + t*dir) closest to the ray */
  private axisParam(rc: T.Raycaster, o: T.Vector3, dir: T.Vector3, fallback: number): number {
    const v = rc.ray.direction, w0 = o.clone().sub(rc.ray.origin);
    const b = dir.dot(v), d = dir.dot(w0), e = v.dot(w0);
    const den = 1 - b * b;
    if (den < 1e-6) return fallback;
    return (b * e - d) / den;
  }

  private cubeOf(bone: string, index: number) { return this.rigModel?.bones.find((b) => b.name === bone)?.cubes.find((c) => c.index === index); }

  private rayAt(clientX: number, clientY: number): T.Raycaster {
    const r = this.dom.getBoundingClientRect();
    const rc = new this.THREE.Raycaster();
    rc.setFromCamera(new this.THREE.Vector2(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1), this.cam.camera);
    return rc;
  }

  private startFaceDrag(hit: FaceHit, e: PointerEvent) {
    const frame = this.faces.faceFrame(hit);
    const s = this.api.store.get();
    if (!frame || !this.rigModel) return;
    const rc = this.rayAt(e.clientX, e.clientY);
    const t0 = this.axisParam(rc, frame.origin, frame.dir, 0);
    const cubes = selectedCubes(s).map((c) => {
      const cube = this.rigModel!.bones.find((b) => b.name === c.bone)?.cubes.find((x) => x.index === c.index);
      return cube ? { ...c, cube, size: [...cube.size] as NumVec3, originV: [...cube.origin] as NumVec3 } : null;
    }).filter((x): x is NonNullable<typeof x> => !!x);
    if (!cubes.length) return;
    this.fdrag = { hit, origin: frame.origin, dir: frame.dir, t0, cubes, last: cubes.map((c) => ({ size: c.size, origin: c.originV })) };
    this.cancelled = false;
    this.dragged = true;
    this.api.beginGesture();
  }

  /** new (size, origin) of a cube when its `hit` face moved outward by `d` units (file space; scene x is mirrored) */
  private faceResult(c: { size: NumVec3; originV: NumVec3 }, hit: FaceHit, d: number, both: boolean): { size: NumVec3; origin: NumVec3 } {
    const size: NumVec3 = [...c.size], origin: NumVec3 = [...c.originV];
    const a = hit.axis;
    const min = both ? -c.size[a] / 2 : -c.size[a];
    const dd = Math.max(min, d);
    if (both) { size[a] = rnd(c.size[a] + 2 * dd); origin[a] = rnd(c.originV[a] - dd); }
    else {
      size[a] = rnd(c.size[a] + dd);
      // scene x = -file x: the +x scene face is the file-space origin side
      const originSide = a === 0 ? hit.sign === 1 : hit.sign === -1;
      if (originSide) origin[a] = rnd(c.originV[a] - dd);
    }
    return { size, origin };
  }

  private moveFaceDrag(e: PointerEvent) {
    const f = this.fdrag;
    if (!f || !this.rigModel) return;
    this.modsFrom(e);
    const rc = this.rayAt(e.clientX, e.clientY);
    let d = this.axisParam(rc, f.origin, f.dir, f.t0) - f.t0;
    if (this.api.store.get().snap) { const st = moveStep(this.shift, this.ctrl); d = Math.round(d / st) * st; }
    f.cubes.forEach((c, i) => {
      const r = this.faceResult(c, f.hit, d, this.alt);
      f.last[i] = r;
      const mesh = this.rig.cubeMesh(c.bone, c.index);
      if (!mesh) return;
      const bone = this.rigModel!.bones.find((b) => b.name === c.bone)!;
      mesh.geometry.dispose();
      mesh.geometry = cubeGeometry(this.THREE, { ...c.cube, size: r.size, origin: r.origin }, this.rigModel!.texW, this.rigModel!.texH, sceneVec(c.cube.pivot ?? bone.pivot));
      mesh.geometry.computeBoundingBox();
      this.rig.refreshEdges(c.bone, c.index);
    });
    this.request();
  }

  private endFaceDrag(cancel: boolean) {
    const f = this.fdrag;
    this.fdrag = null;
    if (!f) return;
    try {
      const s = this.api.store.get();
      let doc = s.doc;
      if (!doc || cancel) return;
      let n = 0;
      f.cubes.forEach((c, i) => {
        const r = f.last[i];
        if (r.size.every((v, k) => v === c.size[k]) && r.origin.every((v, k) => v === c.originV[k])) return;
        doc = cmdSetCube(doc!, c.bone, c.index, { size: r.size, origin: r.origin });
        n++;
      });
      if (n && doc) this.api.commit(doc, n > 1 ? "Resize Cubes" : "Resize Cube");
    } finally {
      this.api.endGesture();
      this.attachedKey = "";
      this.rigDocRoot = null;
      this.schedule();
    }
  }

  // ---------------------------------------------------------------- mouse navigation + picking (Blockbench 1.4)

  private bindInput() {
    const dom = this.dom;
    const onDown = (e: PointerEvent) => {
      this.modsFrom(e);
      this.applySnap();
      if (this.tc.dragging) { this.dragged = true; return; }
      if (this.cons.pointerDown(e)) return; // == constraints hook == link / pin point picking
      if (e.button === 0 && this.hitAnchor(e.clientX, e.clientY)) { e.preventDefault(); this.startAnchorDrag(e); return; }
      if (e.button === 0 && this.fdrag === null) {
        const hit = this.faces.hit(this.rayAt(e.clientX, e.clientY));
        if (hit) { e.preventDefault(); this.startFaceDrag(hit, e); this.capture(e); return; }
      }
      const r = dom.getBoundingClientRect();
      const x = e.clientX - r.left, y = e.clientY - r.top;
      const g: Gesture = { kind: "click", x0: x, y0: y, x, y, moved: false, add: false, toggle: false, group: false };
      if (e.button === 2) g.kind = "pan";
      else if (e.button === 0 && (e.ctrlKey || e.metaKey)) { g.kind = "area"; g.add = e.shiftKey; g.toggle = true; }
      else if (e.button === 0 && e.shiftKey) g.kind = "zoom";
      else if (e.button === 0) {
        const s = this.api.store.get();
        // Blockbench: a press that hits geometry in Edit mode selects instead of orbiting
        if (s.mode === "edit" && this.pickAt(x, y)) { this.pick(x, y, false, e.altKey); this.dragged = true; return; }
        g.kind = "orbit";
      } else return;
      this.gesture = g;
      this.capture(e);
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", onUp);
    };
    const onMove = (e: PointerEvent) => {
      this.modsFrom(e);
      if (this.fdrag) { this.moveFaceDrag(e); return; }
      const g = this.gesture;
      if (!g) return;
      const r = dom.getBoundingClientRect();
      const x = e.clientX - r.left, y = e.clientY - r.top;
      const dx = x - g.x, dy = y - g.y;
      g.x = x; g.y = y;
      if (!g.moved && Math.hypot(x - g.x0, y - g.y0) > 3) g.moved = true;
      if (!g.moved) return;
      if (g.kind === "orbit") this.cam.rotate(dx, dy);
      else if (g.kind === "pan") this.cam.pan(dx, dy);
      else if (g.kind === "zoom") this.cam.dolly(Math.exp(dy * 0.005 * this.cam.zoomSpeed));
      else if (g.kind === "area") this.drawArea(g);
    };
    const onUp = (e: PointerEvent) => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      try { dom.releasePointerCapture(e.pointerId); } catch { /* not captured */ }
      this.modsFrom(e);
      if (this.fdrag) { this.endFaceDrag(this.cancelled); this.cancelled = false; return; }
      const g = this.gesture;
      this.gesture = null;
      if (!g) return;
      if (g.kind === "area") { this.finishArea(g); return; }
      if (!g.moved && (g.kind === "orbit" || g.kind === "click" || g.kind === "zoom") && e.button === 0) this.pick(g.x0, g.y0, e.ctrlKey || e.metaKey, e.altKey, e.shiftKey);
    };
    // face-drag moves arrive without a gesture
    const onFaceMove = (e: PointerEvent) => { if (this.adrag) this.moveAnchorDrag(e); else if (this.fdrag) this.moveFaceDrag(e); };
    const onFaceUp = (e: PointerEvent) => { if (this.adrag) { this.adrag = null; try { dom.releasePointerCapture(e.pointerId); } catch { /* synthetic */ } return; } if (this.fdrag && !this.gesture) { this.modsFrom(e); this.endFaceDrag(this.cancelled); this.cancelled = false; } };
    const onHover = (e: PointerEvent) => {
      this.modsFrom(e);
      this.cons.hover(e); // == constraints hook ==
      if (this.tc.dragging || this.fdrag || this.gesture) return;
      const hit = this.faces.hit(this.rayAt(e.clientX, e.clientY));
      if (this.faces.setHover(hit)) { dom.style.cursor = hit ? "pointer" : ""; this.request(); }
    };
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      this.cam.wheel(e.deltaY);
    };
    const onCtx = (e: Event) => e.preventDefault();
    const kd = (e: KeyboardEvent) => {
      this.modsFrom(e);
      this.applySnap();
      if (e.key === "Escape" && (this.drag || this.fdrag)) { this.cancelled = true; e.stopPropagation(); this.cancelLive(); }
    };
    const ku = (e: KeyboardEvent) => { this.modsFrom(e); this.applySnap(); };
    dom.addEventListener("pointerdown", onDown);
    dom.addEventListener("pointermove", onHover);
    window.addEventListener("pointermove", onFaceMove);
    window.addEventListener("pointerup", onFaceUp);
    dom.addEventListener("wheel", onWheel, { passive: false });
    dom.addEventListener("contextmenu", onCtx);
    window.addEventListener("keydown", kd, true);
    window.addEventListener("keyup", ku, true);
    this.cleanups.push(() => {
      dom.removeEventListener("pointerdown", onDown); dom.removeEventListener("pointermove", onHover);
      window.removeEventListener("pointermove", onFaceMove); window.removeEventListener("pointerup", onFaceUp);
      window.removeEventListener("pointermove", onMove); window.removeEventListener("pointerup", onUp); window.removeEventListener("pointercancel", onUp);
      dom.removeEventListener("wheel", onWheel); dom.removeEventListener("contextmenu", onCtx);
      window.removeEventListener("keydown", kd, true); window.removeEventListener("keyup", ku, true);
    });
  }

  private capture(e: PointerEvent) { try { this.dom.setPointerCapture(e.pointerId); } catch { /* synthetic pointer ids cannot be captured */ } }

  /** Esc during a drag: put everything back (the commit is skipped on release) */
  private cancelLive() {
    const f = this.fdrag;
    if (f && this.rigModel) {
      f.cubes.forEach((c, i) => {
        f.last[i] = { size: c.size, origin: c.originV };
        const mesh = this.rig.cubeMesh(c.bone, c.index);
        const bone = this.rigModel!.bones.find((b) => b.name === c.bone);
        if (!mesh || !bone) return;
        mesh.geometry.dispose();
        mesh.geometry = cubeGeometry(this.THREE, c.cube, this.rigModel!.texW, this.rigModel!.texH, sceneVec(c.cube.pivot ?? bone.pivot));
        mesh.geometry.computeBoundingBox();
        this.rig.refreshEdges(c.bone, c.index);
      });
      this.request();
    }
    const d = this.drag;
    if (d && this.target) {
      this.target.obj.position.copy(d.pos); this.target.obj.rotation.copy(d.rot); this.target.obj.scale.copy(d.scale);
      for (const e of d.extras) { e.obj.position.copy(e.pos); e.obj.rotation.copy(e.rot); }
      this.request();
    }
  }

  private drawArea(g: Gesture) {
    if (!this.areaEl) {
      this.areaEl = document.createElement("div");
      this.areaEl.className = "as-area-select";
      this.host.parentElement?.appendChild(this.areaEl);
    }
    const x = Math.min(g.x0, g.x), y = Math.min(g.y0, g.y);
    Object.assign(this.areaEl.style, { display: "block", left: x + "px", top: y + "px", width: Math.abs(g.x - g.x0) + "px", height: Math.abs(g.y - g.y0) + "px" });
  }

  /** Ctrl/Cmd + drag: every cube whose projected centre is inside the rectangle (Shift adds to the selection) */
  private finishArea(g: Gesture) {
    if (this.areaEl) this.areaEl.style.display = "none";
    if (!g.moved) { this.pick(g.x0, g.y0, true, false, g.add); return; }
    const s = this.api.store.get();
    const x1 = Math.min(g.x0, g.x), x2 = Math.max(g.x0, g.x), y1 = Math.min(g.y0, g.y), y2 = Math.max(g.y0, g.y);
    const hit: CubeRef[] = [];
    const seenBones = new Set<string>();
    this.scene.updateMatrixWorld(true);
    const w = this.dom.clientWidth, h = this.dom.clientHeight;
    for (const m of this.rig.pickables) {
      const bone = m.userData.bone as string;
      if (s.hidden.includes(bone) || s.locked.includes(bone) || !this.isVisible(m)) continue;
      const c = new this.THREE.Vector3();
      m.geometry.computeBoundingBox();
      m.geometry.boundingBox!.getCenter(c);
      m.localToWorld(c);
      c.project(this.cam.camera);
      const px = (c.x * 0.5 + 0.5) * w, py = (-c.y * 0.5 + 0.5) * h;
      if (px >= x1 && px <= x2 && py >= y1 && py <= y2 && c.z < 1) { hit.push({ bone, index: m.userData.index as number }); seenBones.add(bone); }
    }
    void seenBones;
    const next = areaSelect(selValue(s), hit, g.add, rigTree(this.rigModel), s.mode === "edit");
    this.api.store.set({ bones: next.bones, cube: next.cube, cubes: next.cubes });
  }

  private isVisible(m: T.Object3D) {
    let vis = m.visible;
    m.traverseAncestors((a) => { if (!a.visible) vis = false; });
    return vis;
  }

  /** raycast pickable cube under a canvas point (CSS px) */
  private pickAt(x: number, y: number) {
    const { THREE } = this;
    const s = this.api.store.get();
    const dom = this.dom;
    const rc = new THREE.Raycaster();
    rc.setFromCamera(new THREE.Vector2((x / dom.clientWidth) * 2 - 1, -(y / dom.clientHeight) * 2 + 1), this.cam.camera);
    this.scene.updateMatrixWorld(true);
    const meshes = this.rig.pickables.filter((m) => {
      const b = m.userData.bone as string;
      return this.isVisible(m) && !s.hidden.includes(b) && !s.locked.includes(b);
    });
    return rc.intersectObjects(meshes, false)[0] ?? null;
  }

  /**
   * Click selection (Blockbench, ui/selection.ts): a cube in Edit mode, its group in Animate / Pose. `add` (Cmd) toggles into the
   * multi-selection, `group` (Shift) adds the clicked cube's group (its parent group when that is already selected); empty space
   * deselects unless a modifier is held.
   */
  pick(x: number, y: number, add = false, _loop = false, group = false) {
    const s = this.api.store.get();
    const hit = this.pickAt(x, y);
    if (s.refEdit) this.api.store.set({ refEdit: false, refSel: null });
    const res = hit ? { bone: hit.object.userData.bone as string, cube: { bone: hit.object.userData.bone as string, index: hit.object.userData.index as number } } : null;
    if (!res) {
      if (!add && !group) this.api.store.set({ bones: [], cube: null, cubes: [], keys: [] });
      return null;
    }
    const next = pickCube(selValue(s), res.cube, { meta: add, shift: group }, rigTree(this.rigModel), s.mode === "edit");
    this.api.store.set({ bones: next.bones, cube: next.cube, cubes: next.cubes });
    return res;
  }

  project(bone: string) {
    const g = this.rig.boneGroup(bone);
    if (!g) return null;
    const { THREE } = this;
    const mesh = [...(this.rig.bones.get(bone)?.cubes.values() ?? [])][0]?.mesh;
    const v = new THREE.Vector3();
    this.scene.updateMatrixWorld(true);
    if (mesh) { mesh.geometry.computeBoundingBox(); mesh.geometry.boundingBox!.getCenter(v); mesh.localToWorld(v); }
    else g.getWorldPosition(v);
    v.project(this.cam.camera);
    const dom = this.dom;
    return { x: (v.x * 0.5 + 0.5) * dom.clientWidth, y: (-v.y * 0.5 + 0.5) * dom.clientHeight };
  }
  /** QA: canvas-relative screen position of a resize handle's box (Edit mode, Resize tool, cube selected) */
  faceHandleScreen(axis: 0 | 1 | 2, sign: 1 | -1): { x: number; y: number } | null {
    this.renderNow();
    const p = this.faces.tipWorld(axis, sign);
    if (!p) return null;
    p.project(this.cam.camera);
    return { x: (p.x * 0.5 + 0.5) * this.dom.clientWidth, y: (-p.y * 0.5 + 0.5) * this.dom.clientHeight };
  }
  projectCube(bone: string, index: number) {
    const mesh = this.rig.cubeMesh(bone, index);
    if (!mesh) return null;
    const v = new this.THREE.Vector3();
    this.scene.updateMatrixWorld(true);
    mesh.geometry.computeBoundingBox();
    mesh.geometry.boundingBox!.getCenter(v);
    mesh.localToWorld(v);
    v.project(this.cam.camera);
    return { x: (v.x * 0.5 + 0.5) * this.dom.clientWidth, y: (-v.y * 0.5 + 0.5) * this.dom.clientHeight };
  }

  // ---------------------------------------------------------------- camera framing

  private worldBox(sel: string[] | null): T.Box3 | null {
    const { THREE } = this;
    this.scene.updateMatrixWorld(true);
    const box = new THREE.Box3();
    const tmp = new THREE.Box3();
    for (const [name, n] of this.rig.bones) {
      if (sel && sel.length && !sel.includes(name)) continue;
      n.cubes.forEach((c) => {
        const g = c.mesh.geometry;
        if (!g.boundingBox) g.computeBoundingBox();
        tmp.copy(g.boundingBox!).applyMatrix4(c.mesh.matrixWorld);
        box.union(tmp);
      });
    }
    return box.isEmpty() ? null : box;
  }

  /** F / frame: fit the selection (or the whole model) in view keeping the view direction */
  frame(selected = true) {
    const s = this.api.store.get();
    let box: T.Box3 | null = null;
    if (selected && s.mode === "edit" && s.cube) {
      const cubes = selectedCubes(s);
      const { THREE } = this;
      box = new THREE.Box3();
      for (const c of cubes) {
        const m = this.rig.cubeMesh(c.bone, c.index);
        if (!m) continue;
        m.geometry.computeBoundingBox();
        box.union(m.geometry.boundingBox!.clone().applyMatrix4(m.matrixWorld));
      }
      if (box.isEmpty()) box = null;
    }
    box ??= this.worldBox(selected ? s.bones : null) ?? new this.THREE.Box3(new this.THREE.Vector3(-16, 0, -16), new this.THREE.Vector3(16, 32, 16));
    const sph = box.getBoundingSphere(new this.THREE.Sphere());
    this.cam.focus(sph.center, Math.max(sph.radius, 2));
  }

  /** Blockbench "Center View on Selection": move the orbit target to the selection; zoom = also fit it */
  focusSelection(o: { rotateOnly?: boolean; zoom?: boolean } = {}) {
    const s = this.api.store.get();
    if (o.zoom) { this.frame(true); return; }
    const box = (s.cube ? (() => { const m = this.rig.cubeMesh(s.cube.bone, s.cube.index); if (!m) return null; m.geometry.computeBoundingBox(); return m.geometry.boundingBox!.clone().applyMatrix4(m.matrixWorld); })() : null) ?? this.worldBox(s.bones);
    if (!box) return;
    const c = box.getCenter(new this.THREE.Vector3());
    if (o.rotateOnly) { this.cam.focus(c); return; }
    this.cam.focus(c);
  }

  setView(v: ViewName) {
    this.cam.setPreset(v);
    this.api.store.set({ view: this.cam.view, ortho: this.cam.isOrtho });
  }
  toggleOrtho() {
    this.cam.toggleOrtho();
    this.api.store.set({ view: this.cam.view, ortho: this.cam.isOrtho });
  }
  resetCamera() {
    this.cam.reset();
    this.api.store.set({ view: "persp", ortho: false });
  }

  /** radians: atan2(fx, fz) of the camera forward vector in scene space (arrow nudges are camera-relative) */
  cameraYaw(): number {
    const d = this.cam.camera.getWorldDirection(new this.THREE.Vector3());
    return Math.atan2(d.x, d.z);
  }
  private pixelGrid = false;
  togglePixelGrid(): boolean { this.pixelGrid = !this.pixelGrid; this.request(); return this.pixelGrid; }
  /** PNG data URL of the current frame */
  screenshot(): string { this.renderNow(); return this.dom.toDataURL("image/png"); }
  /** Esc: abort a running gizmo / face drag (nothing is committed) */
  cancelDrag(): boolean {
    if (!this.drag && !this.fdrag) return false;
    this.cancelled = true;
    this.cancelLive();
    return true;
  }
  isDragging(): boolean { return !!this.drag || !!this.fdrag || !!this.gesture; }
  /** Vertex Snap / Stretch are not implemented in this viewport (Blockbench features outside the Bedrock cube workflow) */
  setTool(_name: string): boolean { return false; }

  setReference(on: boolean) {
    const s = this.api.store.get();
    const sc = s.rig?.source === "player" || /\/armor\//.test(s.path) ? 1 / 0.9375 : 1;
    this.ref.scale.set(sc, sc, sc);
    this.ref.visible = on;
    this.request();
  }
  setGrid(on: boolean) { this.stage.setGrid(on); this.request(); }

  nudge(kind: "move" | "rotate" | "resize" | "pivot", delta: [number, number, number], probe?: () => void): boolean {
    const s = this.api.store.get();
    if (s.tool !== kind) this.api.store.set({ tool: kind });
    this.sync();
    this.attachedKey = "";
    this.updateGizmo(this.api.store.get());
    const t = this.target;
    if (!t) {
      // Edit-mode resize has no TC target: drive the +/- face of the cube directly
      const st = this.api.store.get();
      if (kind === "resize" && st.mode === "edit" && st.cube && st.doc && this.rigModel) {
        const c = this.rigModel.bones.find((b) => b.name === st.cube!.bone)?.cubes.find((x) => x.index === st.cube!.index);
        if (!c) return false;
        const size: NumVec3 = [c.size[0] + delta[0], c.size[1] + delta[1], c.size[2] + delta[2]];
        this.api.commit(cmdSetCube(st.doc, c.bone, c.index, { size }), "Resize Cube");
        return true;
      }
      return false;
    }
    this.beginDrag();
    const o = t.obj;
    if (t.kind.endsWith("rotate") || t.kind === "key-rotation") {
      o.rotation.set(o.rotation.x - delta[0] * D2R, o.rotation.y - delta[1] * D2R, o.rotation.z + delta[2] * D2R);
    } else if (t.kind === "key-scale") {
      o.scale.set(o.scale.x * (1 + delta[0]), o.scale.y * (1 + delta[1]), o.scale.z * (1 + delta[2]));
    } else {
      o.position.set(o.position.x - delta[0], o.position.y + delta[1], o.position.z + delta[2]);
    }
    this.onObjectChange();
    this.consLive(); // == constraints hook == (live follow while the drag is still open; `probe` reads it in QA)
    probe?.();
    this.endDrag();
    return true;
  }

  // == constraints hook == (QA / panel)
  private consLive() {
    const d = this.drag, t = this.target;
    if (d && t) this.cons.liveDrag(d.kind, [{ bone: t.bone, obj: t.obj }, ...d.extras.map((e) => ({ bone: e.bone, obj: e.obj }))]);
  }
  consInfo() { return this.cons.info(); }
  consProject(bone: string, p: NumVec3) { return this.cons.project(bone, p); }

  snapshot(): Record<string, unknown> {
    const info = this.renderer.info;
    const bones: Record<string, unknown> = {};
    for (const [name, n] of this.rig.bones) {
      bones[name] = {
        rot: [n.group.rotation.x, n.group.rotation.y, n.group.rotation.z].map((v) => rnd(v * R2D, 2)),
        pos: [n.group.position.x, n.group.position.y, n.group.position.z].map((v) => rnd(v, 3)),
        cubes: n.cubes.size,
      };
    }
    let cubes = 0;
    this.rig.bones.forEach((n) => (cubes += n.cubes.size));
    const c = this.cam.camera;
    const cs = this.cam.state();
    const s = this.api.store.get();
    return {
      canvas: true, rig: this.rigModel?.source ?? null, boneCount: this.rig.bones.size, cubeCount: cubes, bones,
      textureLoaded: this.texLoaded, textureKey: this.texKey, rebuilt: this.rig.rebuilt, ghosts: this.ghosts.length,
      calls: info.render.calls, triangles: info.render.triangles,
      camera: {
        type: (c as T.OrthographicCamera).isOrthographicCamera ? "orthographic" : "perspective", view: cs.view, locked: cs.locked, zoom: rnd(cs.zoom, 4),
        fov: (c as T.PerspectiveCamera).fov ?? null, near: c.near, far: c.far,
        pos: cs.pos.map((v) => rnd(v, 2)), target: cs.target.map((v) => rnd(v, 2)),
        up: c.up.toArray().map((v) => rnd(v, 3)), dir: c.getWorldDirection(new this.THREE.Vector3()).toArray().map((v) => rnd(v, 3)),
      },
      gizmo: this.target ? { kind: this.target.kind, bone: this.target.bone, index: this.target.index ?? null, rollOnly: this.rollOnly, axes: [this.tc.showX, this.tc.showY, this.tc.showZ] } : (this.faces.group.visible ? { kind: "face-handles", bone: s.cube?.bone ?? null, index: s.cube?.index ?? null } : null),
      pose: Object.keys(this.poseNow), game: this.gameInfo,
      trick: [this.trick.quaternion.x, this.trick.quaternion.y, this.trick.quaternion.z, this.trick.quaternion.w].map((v) => rnd(v, 3)),
      stage: (() => {
        let lights = 0, dir = 0, ambient = 0, amb = 0;
        this.scene.traverse((o) => { const l = o as T.Light; if (l.isLight) { lights++; if ((l as T.DirectionalLight).isDirectionalLight) dir += l.visible ? 1 : 0; else { ambient++; amb = l.intensity / Math.PI; } } });
        return { fov: FOV, side: VIEW_SIDE[cs.view] ?? null, refPlanes: this.refMeshes.size, lights, directional: dir, ambient, ambientIntensity: rnd(amb, 3), shading: s.shading, grid: s.grid, ground: s.ground };
      })(),
      selection: this.rig.selectionStats(), tcSize: this.tc.size, tcSnap: { t: this.tc.translationSnap, r: this.tc.rotationSnap ? rnd(this.tc.rotationSnap * R2D, 3) : null },
      cubes: s.cubes.length, canvasSize: [this.dom.clientWidth, this.dom.clientHeight],
    };
  }
}

/** true when `a` -> `b` changed nothing but the playhead (time / stride distance) */
function playheadOnly(a: StudioState, b: StudioState): boolean {
  if (a === b) return true;
  for (const k in b) {
    if (k === "time" || k === "strideDist") continue;
    if (!Object.is(a[k as keyof StudioState], b[k as keyof StudioState])) return false;
  }
  return true;
}
