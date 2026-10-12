/**
 * Blockbench camera model (docs/BLOCKBENCH-PARITY.md 2.4): one logical camera = orbit around `target` at spherical (r, theta, phi),
 * rendered by either a perspective camera (FOV 45, near 1, far 30000) or a true orthographic camera (frustum +-8000 equivalent,
 * near -8000, far 12000, zoom 0.5 on the presets). Presets are locked-angle orthographic views; Num5 switches projection at the
 * current angle. Replaces three's OrbitControls so ortho, locked angles and Blockbench's mouse map work exactly.
 */
import type * as T from "three";
import type { ViewName } from "../state";

type TH = typeof T;

export const FOV = 45;
export const MIN_DIST = 1;
export const MAX_DIST = 4000;
/** px per model unit at ortho zoom 1 (zoom 0.5 = 8 px/unit: a 32-unit player is ~256 px tall) */
export const ORTHO_PX = 16;
const EPS = 1e-4;

export const PRESETS: Record<Exclude<ViewName, "persp" | "side">, [number, number, number]> = {
  top: [0, 512, 0], bottom: [0, -512, 0],
  back: [0, 0, 512], front: [0, 0, -512],   // Blockbench camera_south / camera_north
  right: [512, 0, 0], left: [-512, 0, 0],   // camera_east / camera_west
};
export const INITIAL_POS: [number, number, number] = [-40, 32, -40];
export const INITIAL_TARGET: [number, number, number] = [0, 12, 0];
/** side of the model a preset looks at (reference-image blueprint attachment) */
export const VIEW_SIDE: Record<string, "north" | "south" | "east" | "west" | "top" | "bottom"> = {
  front: "north", back: "south", right: "east", left: "west", side: "west", top: "top", bottom: "bottom",
};

export class CameraRig {
  readonly persp: T.PerspectiveCamera;
  readonly ortho: T.OrthographicCamera;
  readonly target: T.Vector3;
  r = 60; theta = 0; phi = Math.PI / 3;
  zoom = 0.5;
  isOrtho = false;
  /** a preset locks rotation */
  locked = false;
  view: ViewName = "persp";
  w = 1; h = 1;
  rotateSpeed = 1; zoomSpeed = 1.5;

  constructor(private THREE: TH, private onChange: () => void) {
    this.persp = new THREE.PerspectiveCamera(FOV, 1, 1, 30000);
    this.ortho = new THREE.OrthographicCamera(-1, 1, 1, -1, -8000, 12000);
    this.target = new THREE.Vector3(...INITIAL_TARGET);
    this.reset(false);
  }

  get camera(): T.PerspectiveCamera | T.OrthographicCamera { return this.isOrtho ? this.ortho : this.persp; }

  resize(w: number, h: number) {
    this.w = Math.max(1, w); this.h = Math.max(1, h);
    this.persp.aspect = this.w / this.h;
    this.persp.updateProjectionMatrix();
    this.updateOrtho();
    this.apply();
  }
  private updateOrtho() {
    this.ortho.left = -this.w / 2 / ORTHO_PX; this.ortho.right = this.w / 2 / ORTHO_PX;
    this.ortho.top = this.h / 2 / ORTHO_PX; this.ortho.bottom = -this.h / 2 / ORTHO_PX;
    this.ortho.zoom = this.zoom;
    this.ortho.updateProjectionMatrix();
  }

  /** push (target, r, theta, phi, zoom) into both cameras */
  apply(notify = true) {
    const { THREE } = this;
    const s = Math.sin(this.phi), p = new THREE.Vector3(this.r * s * Math.sin(this.theta), this.r * Math.cos(this.phi), this.r * s * Math.cos(this.theta));
    for (const c of [this.persp, this.ortho]) {
      c.position.copy(this.target).add(p);
      c.up.set(0, 1, 0);
      c.lookAt(this.target);
      c.updateMatrixWorld(true);
    }
    this.updateOrtho();
    if (notify) this.onChange();
  }

  private setFromPosition(pos: ArrayLike<number>, target: ArrayLike<number>) {
    const d = new this.THREE.Vector3(pos[0] - target[0], pos[1] - target[1], pos[2] - target[2]);
    this.target.set(target[0], target[1], target[2]);
    this.r = Math.max(MIN_DIST, d.length());
    this.phi = Math.min(Math.PI - EPS, Math.max(EPS, Math.acos(Math.max(-1, Math.min(1, d.y / (d.length() || 1))))));
    this.theta = Math.atan2(d.x, d.z);
  }

  reset(notify = true) {
    this.isOrtho = false; this.locked = false; this.view = "persp"; this.zoom = 0.5;
    this.setFromPosition(INITIAL_POS, INITIAL_TARGET);
    this.apply(notify);
  }

  setPreset(v: ViewName) {
    if (v === "persp") { this.unlock(); if (this.isOrtho) this.toggleOrtho(); else this.apply(); return; }
    const key = (v === "side" ? "left" : v) as keyof typeof PRESETS;
    this.setFromPosition(PRESETS[key], [0, 0, 0]);
    this.r = 512; this.zoom = 0.5; this.isOrtho = true; this.locked = true; this.view = key;
    this.apply();
  }
  private unlock() { this.locked = false; this.view = "persp"; }

  /** distance <-> zoom conversion keeps the visible height constant when switching projection */
  toggleOrtho() {
    const visH = 2 * this.r * Math.tan((FOV * Math.PI) / 360);
    if (!this.isOrtho) {
      this.zoom = Math.min(200, Math.max(0.02, this.h / (visH * ORTHO_PX)));
      this.isOrtho = true;
    } else {
      this.r = Math.min(MAX_DIST, Math.max(MIN_DIST, this.h / (this.zoom * ORTHO_PX) / (2 * Math.tan((FOV * Math.PI) / 360))));
      this.isOrtho = false;
    }
    this.unlock();
    this.apply();
  }
  setOrtho(on: boolean) { if (on !== this.isOrtho) this.toggleOrtho(); }

  rotate(dx: number, dy: number) {
    if (this.locked) return;
    this.theta -= (2 * Math.PI * dx / this.h) * this.rotateSpeed;
    this.phi = Math.min(Math.PI - EPS, Math.max(EPS, this.phi - (2 * Math.PI * dy / this.h) * this.rotateSpeed));
    this.apply();
  }
  pan(dx: number, dy: number) {
    const c = this.camera;
    const k = this.isOrtho ? 1 / (ORTHO_PX * this.zoom) : (2 * this.r * Math.tan((FOV * Math.PI) / 360)) / this.h;
    const m = c.matrixWorld.elements;
    this.target.x += (-dx * m[0] + dy * m[4]) * k;
    this.target.y += (-dx * m[1] + dy * m[5]) * k;
    this.target.z += (-dx * m[2] + dy * m[6]) * k;
    this.apply();
  }
  /** scale < 1 zooms in */
  dolly(scale: number) {
    if (this.isOrtho) this.zoom = Math.min(200, Math.max(0.02, this.zoom / scale));
    else this.r = Math.min(MAX_DIST, Math.max(MIN_DIST, this.r * scale));
    this.apply();
  }
  /** wheel step: Blockbench/OrbitControls zoom scale 0.95^zoomSpeed per notch */
  wheel(deltaY: number) {
    const s = Math.pow(0.95, this.zoomSpeed * Math.min(4, Math.max(0.25, Math.abs(deltaY) / 100)));
    this.dolly(deltaY < 0 ? s : 1 / s);
  }

  /** world-space view-aligned position/target (QA + persistence) */
  state() {
    const p = this.camera.position;
    return { pos: [p.x, p.y, p.z] as [number, number, number], target: this.target.toArray() as [number, number, number], ortho: this.isOrtho, zoom: this.zoom, r: this.r, view: this.view, locked: this.locked };
  }

  /** Move the target to `center`, optionally fitting `radius` into view (distance / zoom). */
  focus(center: T.Vector3, radius?: number) {
    this.target.copy(center);
    if (radius !== undefined) {
      if (this.isOrtho) this.zoom = Math.min(200, Math.max(0.02, (Math.min(this.w, this.h) / 2) / (radius * ORTHO_PX * 1.15)));
      else this.r = Math.min(MAX_DIST, Math.max(MIN_DIST * 4, (radius / Math.tan((FOV * Math.PI) / 360)) * 1.15));
    }
    this.apply();
  }
}
