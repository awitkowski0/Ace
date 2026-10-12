import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { CameraRig, FOV, INITIAL_POS, INITIAL_TARGET } from "./camera";
import { moveStep, rotateStep, selectedCubes } from "./select";

describe("Blockbench snapping steps (docs 1.4)", () => {
  it("move: 1 / 0.25 / 0.1 / 0.025", () => {
    expect([moveStep(false, false), moveStep(true, false), moveStep(false, true), moveStep(true, true)]).toEqual([1, 0.25, 0.1, 0.025]);
  });
  it("rotate: 2.5 / 22.5 / 1 / 0.25", () => {
    expect([rotateStep(false, false), rotateStep(true, false), rotateStep(false, true), rotateStep(true, true)]).toEqual([2.5, 22.5, 1, 0.25]);
  });
  it("multi-selection is ignored when stale", () => {
    const a = { bone: "a", index: 0 }, b = { bone: "a", index: 1 };
    expect(selectedCubes({ cube: b, cubes: [a, b] })).toEqual([a, b]);
    expect(selectedCubes({ cube: b, cubes: [a] })).toEqual([b]);
    expect(selectedCubes({ cube: null, cubes: [a] })).toEqual([]);
  });
});

describe("camera rig (docs 2.4)", () => {
  const mk = () => { const r = new CameraRig(THREE, () => {}); r.resize(800, 600); return r; };
  it("starts perspective FOV 45 at [-40,32,-40] looking at [0,12,0]", () => {
    const r = mk();
    expect(r.persp.fov).toBe(FOV);
    expect(r.persp.near).toBe(1); expect(r.persp.far).toBe(30000);
    expect(r.persp.position.toArray().map((v) => Math.round(v * 1000) / 1000)).toEqual(INITIAL_POS);
    expect(r.target.toArray()).toEqual(INITIAL_TARGET);
    expect(r.isOrtho).toBe(false);
  });
  it("presets are true orthographic, locked, 512 away, zoom 0.5, looking at the origin", () => {
    const r = mk();
    const want: Record<string, number[]> = { top: [0, 512, 0], bottom: [0, -512, 0], front: [0, 0, -512], back: [0, 0, 512], right: [512, 0, 0], left: [-512, 0, 0] };
    for (const [v, p] of Object.entries(want)) {
      r.setPreset(v as never);
      expect(r.camera).toBe(r.ortho);
      expect(r.locked).toBe(true);
      expect(r.zoom).toBe(0.5);
      expect(r.ortho.position.toArray().map((x) => Math.round(x))).toEqual(p);
      expect(r.ortho.near).toBe(-8000); expect(r.ortho.far).toBe(12000);
      const dir = r.ortho.getWorldDirection(new THREE.Vector3());
      expect(dir.dot(new THREE.Vector3(...p).normalize())).toBeCloseTo(-1, 3);
    }
  });
  it("top view has north (-z) up on screen; locked views do not rotate; Num5 unlocks", () => {
    const r = mk();
    r.setPreset("top");
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(r.ortho.quaternion);
    expect(up.z).toBeLessThan(-0.99);
    const before = r.ortho.position.clone();
    r.rotate(40, 20);
    expect(r.ortho.position.distanceTo(before)).toBe(0);
    r.toggleOrtho();
    expect(r.isOrtho).toBe(false); expect(r.locked).toBe(false); expect(r.view).toBe("persp");
    r.rotate(40, 20);
    expect(r.persp.position.distanceTo(before)).toBeGreaterThan(1);
  });
  it("wheel dollies (persp) / zooms (ortho) and projection toggle keeps the visible height", () => {
    const r = mk();
    const d0 = r.r;
    r.wheel(-100);
    expect(r.r).toBeLessThan(d0);
    const vis = 2 * r.r * Math.tan((FOV * Math.PI) / 360);
    r.toggleOrtho();
    expect(r.isOrtho).toBe(true);
    expect(600 / (r.zoom * 16)).toBeCloseTo(vis, 3);
    const z0 = r.zoom; r.wheel(-100);
    expect(r.zoom).toBeGreaterThan(z0);
  });
});
