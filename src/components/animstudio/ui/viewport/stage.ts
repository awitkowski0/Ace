/**
 * Static scene dressing with Blockbench's values (docs/BLOCKBENCH-PARITY.md 2.2 - 2.5): centred (Bedrock) grid, axis lines,
 * north marker, ground plane and the 6-directional-light + ambient rig. Colours are the default dark theme tokens.
 */
import type * as T from "three";

type TH = typeof T;

/** --color-* tokens of the default Blockbench dark theme (docs 2.1) */
export const BB = {
  grid: 0x30333d, back: 0x181b1f, dark: 0x101316, checker: 0x14171b, accent: 0x3e90ff,
  axisX: 0xfd3043, axisY: 0x26ec45, axisZ: 0x2d5ee8, solid: 0xc1c1c1, wireframe: 0x576f82, ground: 0x181b1f,
  hoverLine: 0xa4a5ca,
} as const;

/** legacy-light intensity factor: three >= r155 dropped the implicit PI of Lambert lighting; Blockbench's numbers assume it */
const PI = Math.PI;

export interface Stage {
  setShading(on: boolean): void;
  setGrid(on: boolean): void;
  setGround(on: boolean): void;
  dispose(): void;
}

export function buildStage(THREE: TH, scene: T.Scene, opts: { shading: boolean; grid: boolean; ground: boolean }): Stage {
  const root = new THREE.Group();
  root.name = "bb-stage";
  scene.add(root);
  const disposables: Array<{ dispose(): void }> = [];

  // ---- grids (Format.centered_grid = true for Bedrock): base 16x16 cells of 1 unit, large grid 3x3 cells of 16 units
  const gridGroup = new THREE.Group();
  const base = new THREE.GridHelper(16, 16, BB.grid, BB.grid);
  const large = new THREE.GridHelper(48, 3, BB.grid, BB.grid);
  for (const g of [base, large]) { (g.material as T.LineBasicMaterial).depthWrite = false; disposables.push(g.geometry, g.material as T.Material); }
  gridGroup.add(base, large);
  // axis lines from the origin along +X (red) and +Z (blue), length 8 (centred grid), at y = 0.01
  const axis = (to: [number, number, number], color: number) => {
    const g = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0.01, 0), new THREE.Vector3(...to)]);
    const m = new THREE.LineBasicMaterial({ color });
    disposables.push(g, m);
    return new THREE.Line(g, m);
  };
  gridGroup.add(axis([8, 0.01, 0], BB.axisX), axis([0, 0.01, 8], BB.axisZ));
  // north marker: 2.4-unit plane just outside the block's north edge, nearest filter, alphaTest 0.2, tinted with the grid colour
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const ctx = c.getContext("2d")!;
  ctx.fillStyle = "#fff";
  ctx.beginPath();
  // an "N" glyph: two stems and a diagonal
  ctx.rect(14, 12, 9, 40); ctx.rect(41, 12, 9, 40);
  ctx.moveTo(14, 12); ctx.lineTo(23, 12); ctx.lineTo(50, 52); ctx.lineTo(41, 52); ctx.closePath();
  ctx.fill();
  const tex = new THREE.CanvasTexture(c);
  tex.magFilter = THREE.NearestFilter; tex.minFilter = THREE.NearestFilter;
  const nm = new THREE.MeshBasicMaterial({ map: tex, color: BB.grid, transparent: true, alphaTest: 0.2, side: THREE.DoubleSide, depthWrite: false });
  const ng = new THREE.PlaneGeometry(2.4, 2.4);
  const north = new THREE.Mesh(ng, nm);
  north.rotation.x = -Math.PI / 2;
  north.position.set(0, 0.02, -8 - 1.44);
  north.name = "north-marker";
  gridGroup.add(north);
  disposables.push(tex, nm, ng);
  root.add(gridGroup);

  // ---- ground plane (off by default): 4096 units at y = -0.025
  const gg = new THREE.PlaneGeometry(4096, 4096);
  const gm = new THREE.MeshBasicMaterial({ color: BB.ground, alphaTest: 0.2, side: THREE.FrontSide });
  const ground = new THREE.Mesh(gg, gm);
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -0.025;
  ground.visible = opts.ground;
  root.add(ground);
  disposables.push(gg, gm);

  // ---- lights: ambient "sun" 0.5 (brightness 50/50 x 0.5) + six directionals (top .46, bottom -.02, north/south .3, east/west .1)
  const sun = new THREE.AmbientLight(0xffffff, 0.5 * PI);
  const dir = (pos: [number, number, number], intensity: number) => {
    const l = new THREE.DirectionalLight(0xffffff, intensity * PI);
    l.position.set(...pos);
    return l;
  };
  const dirs = [dir([0, 100, 0], 0.46), dir([0, -100, 0], -0.02), dir([0, 0, -100], 0.3), dir([0, 0, 100], 0.3), dir([-100, 0, 0], 0.1), dir([100, 0, 0], 0.1)];
  root.add(sun, ...dirs);

  const stage: Stage = {
    setShading(on) {
      sun.intensity = (on ? 0.5 : 1) * PI;
      dirs.forEach((d) => (d.visible = on));
    },
    setGrid(on) { gridGroup.visible = on; },
    setGround(on) { ground.visible = on; },
    dispose() { root.removeFromParent(); disposables.forEach((d) => d.dispose()); },
  };
  stage.setShading(opts.shading);
  stage.setGrid(opts.grid);
  return stage;
}
