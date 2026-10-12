/**
 * RigView: the three.js object tree of one RigModel (bones = Groups, cubes = Meshes), updated incrementally.
 *
 * Scene space is Blockbench space in model px: x = -file x, rotations (-rx, -ry, rz) in ZYX order, animation channels
 * applied additively on top of the rest transform (rotation -x,-y,+z; position -x,+y,+z; scale as is) — exactly how
 * Blockbench shows Bedrock models. Face names are Blockbench's; file box-UV/per-face uv map onto them unchanged.
 */
import type * as T from "three";
import { BONE_ALIASES, FACES, boxUvRects as coreBoxUvRects, cubeFaceRects, type Face, type NumVec3, type Pose } from "../../core";
import type { RBone, RCube, RigModel } from "../model";

type TH = typeof T;
/** three/examples fat-line classes (loaded lazily by the engine) used for the 2px selection outline */
export interface LineKit {
  LineSegments2: typeof import("three/examples/jsm/lines/LineSegments2.js").LineSegments2;
  LineSegmentsGeometry: typeof import("three/examples/jsm/lines/LineSegmentsGeometry.js").LineSegmentsGeometry;
  LineMaterial: typeof import("three/examples/jsm/lines/LineMaterial.js").LineMaterial;
}
const D2R = Math.PI / 180;

export interface RigStyle {
  wire: boolean;
  xray: boolean;
  /** Blockbench "solid" view mode: flat #c1c1c1, no textures */
  solid?: boolean;
  /** ghost rig (onion skin / procedural limbs): flat tinted translucent material, no textures, not pickable */
  ghost?: { color: number; opacity: number };
}

interface CubeNode { mesh: T.Mesh; sig: string; cube: RCube; edges?: T.Object3D; axes?: T.AxesHelper }
interface BoneNode {
  group: T.Group; bone: RBone; sig: string; cubes: Map<number, CubeNode>;
  restPos: T.Vector3; restRot: T.Euler; marker?: T.AxesHelper;
}

/** Quad corners (TL, TR, BR, BL as seen from outside) per face, `a` = min corner, `b` = max corner. */
function corners(f: Face, a: NumVec3, b: NumVec3): NumVec3[] {
  const [x1, y1, z1] = a, [x2, y2, z2] = b;
  switch (f) {
    case "north": return [[x2, y2, z1], [x1, y2, z1], [x1, y1, z1], [x2, y1, z1]];
    case "south": return [[x1, y2, z2], [x2, y2, z2], [x2, y1, z2], [x1, y1, z2]];
    case "east": return [[x2, y2, z2], [x2, y2, z1], [x2, y1, z1], [x2, y1, z2]];
    case "west": return [[x1, y2, z1], [x1, y2, z2], [x1, y1, z2], [x1, y1, z1]];
    case "up": return [[x1, y2, z1], [x2, y2, z1], [x2, y2, z2], [x1, y2, z2]];
    default: return [[x1, y1, z2], [x2, y1, z2], [x2, y1, z1], [x1, y1, z1]];
  }
}

/** Blockbench box-UV layout (core/uv.ts). */
export const boxUvRects = (off: [number, number], size: NumVec3) => coreBoxUvRects(off, size);

export const sceneVec = (v: NumVec3): NumVec3 => [-v[0], v[1], v[2]];

/** Face rects of a cube in texture px (undefined cube.uv: all faces, no texture mapping). */
export function faceRects(c: RCube): Partial<Record<Face, [number, number, number, number]>> | null {
  if (!c.uv) return null;
  if (c.uv.kind === "rects") return c.uv.faces;
  return cubeFaceRects({ kind: "box", uv: c.uv.uv }, c.size, c.mirror);
}

/** Texture slot of every rendered face when the cube mixes textures (bbmodel per-face `texture`); null = one material is enough. */
export function faceSlots(c: RCube): Record<Face, number> | null {
  if (!c.faceTex) return null;
  const out = {} as Record<Face, number>;
  const seen = new Set<number>();
  for (const f of FACES) {
    const t = c.faceTex[f];
    out[f] = t == null ? -1 : t;
    if (t !== null) seen.add(out[f]);
  }
  return seen.size > 1 ? out : null;
}

export function cubeGeometry(THREE: TH, c: RCube, texW: number, texH: number, pivotScene: NumVec3): T.BufferGeometry {
  const inf = c.inflate || 0;
  const a: NumVec3 = [-(c.origin[0] + c.size[0]) - inf - pivotScene[0], c.origin[1] - inf - pivotScene[1], c.origin[2] - inf - pivotScene[2]];
  const b: NumVec3 = [-c.origin[0] + inf - pivotScene[0], c.origin[1] + c.size[1] + inf - pivotScene[1], c.origin[2] + c.size[2] + inf - pivotScene[2]];
  const rects = faceRects(c);
  const slots = faceSlots(c);
  const pos: number[] = [], uv: number[] = [], idx: number[] = [];
  const groups: Array<{ start: number; mat: number }> = [];
  for (const f of FACES) {
    let q: [number, number][] | null = null;
    if (rects) {
      const r = rects[f];
      if (!r) continue;
      q = [[r[0], r[1]], [r[2], r[1]], [r[2], r[3]], [r[0], r[3]]];
      const steps = ((c.faceRot?.[f] ?? 0) / 90) & 3;
      if (steps) q = q.map((_, k) => q![(k - steps + 4) % 4]);
    }
    const base = pos.length / 3;
    groups.push({ start: idx.length, mat: slots ? slots[f] + 1 : 0 });
    corners(f, a, b).forEach((p, k) => {
      pos.push(p[0], p[1], p[2]);
      uv.push(q ? q[k][0] / texW : 0, q ? 1 - q[k][1] / texH : 0);
    });
    idx.push(base, base + 2, base + 1, base, base + 3, base + 2);
  }
  const g = new THREE.BufferGeometry();
  if (slots) for (const gr of groups) g.addGroup(gr.start, 6, gr.mat);
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

const rotSig = (v?: NumVec3) => (v ? v.join(",") : "");
const cubeSig = (c: RCube, tw: number, th: number) =>
  [c.origin.join(","), c.size.join(","), rotSig(c.pivot), rotSig(c.rotation), c.inflate, c.mirror ? 1 : 0, JSON.stringify(c.uv ?? null), c.tex ?? "", JSON.stringify(c.faceTex ?? null), JSON.stringify(c.faceRot ?? null), tw, th].join("|");
const boneSig = (b: RBone) => [b.parent ?? "", b.pivot.join(","), rotSig(b.rotation)].join("|");

/** Blockbench cube marker colours (standard set, docs 2.6): untextured cubes are tinted with one of these */
const PALETTE = [0x58c0ff, 0xf4d714, 0xec9218, 0xfa565d, 0xb55af8, 0x4d89ff, 0x00ce71, 0xafff62, 0xf96bc5, 0xc7d5f6];
export const colorFor = (name: string) => {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) | 0;
  return PALETTE[Math.abs(h) % PALETTE.length];
};

export class RigView {
  readonly group: T.Group;
  readonly bones = new Map<string, BoneNode>();
  readonly pickables: T.Mesh[] = [];
  rig: RigModel | null = null;
  private textures: (T.Texture | null)[] = [];
  private mats = new Map<string, T.MeshLambertMaterial | T.MeshBasicMaterial>();
  private selBones = new Set<string>();
  private selCubes = new Set<string>();
  /** cubes outlined because their group (or a parent group) is selected; no pivot marker */
  private selOutline = new Set<string>();
  private showPivot = false;
  private lineMat?: import("three/examples/jsm/lines/LineMaterial.js").LineMaterial;
  private hidden = new Set<string>();
  private ghostBones = new Set<string>();
  rebuilt = 0;

  constructor(private THREE: TH, private style: RigStyle, private lines?: LineKit) {
    this.group = new THREE.Group();
  }

  // ---------------------------------------------------------------- materials

  private matFor(c: RCube, bone: string): T.Material | T.Material[] {
    const slots = !this.style.ghost && !this.style.wire && !this.style.solid ? faceSlots(c) : null;
    if (slots) {
      const max = Math.max(...Object.values(slots));
      return Array.from({ length: max + 2 }, (_, i) => this.matFor1({ ...c, faceTex: undefined, tex: i === 0 ? undefined : i - 1 }, bone, i === 0 ? "c" : undefined));
    }
    return this.matFor1(c, bone);
  }

  private matFor1(c: RCube, bone: string, force?: "c"): T.Material {
    const { THREE } = this;
    if (this.style.ghost) {
      let m = this.mats.get("ghost");
      if (!m) {
        m = new THREE.MeshBasicMaterial({ color: this.style.ghost.color, transparent: true, opacity: this.style.ghost.opacity, depthWrite: false, side: THREE.DoubleSide, forceSinglePass: true });
        this.mats.set("ghost", m);
      }
      return m;
    }
    if (this.style.wire) {
      let m = this.mats.get("wire") as T.MeshBasicMaterial | undefined;
      if (!m) { m = new THREE.MeshBasicMaterial({ color: 0x576f82, wireframe: true }); this.mats.set("wire", m); }
      return m;
    }
    const tex = this.style.solid || force === "c" || c.tex === undefined && this.rig?.source === "bbmodel" ? null : (this.textures[c.tex ?? 0] ?? null);
    const proceduralGhost = this.ghostBones.has(bone);
    const key = (this.style.solid ? "solid" : tex ? `t${c.tex ?? 0}` : `c${bone}`) + (proceduralGhost ? "g" : "");
    let m = this.mats.get(key) as T.MeshLambertMaterial | undefined;
    if (!m) {
      m = new THREE.MeshLambertMaterial({
        map: tex, color: this.style.solid ? 0xc1c1c1 : tex ? 0xffffff : colorFor(bone), transparent: true, alphaTest: 0.05, side: THREE.DoubleSide,
        opacity: proceduralGhost ? 0.3 : 1, depthWrite: !proceduralGhost,
        // push faces back a hair so the depth-tested selection outline never z-fights with them
        polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1,
        // DoubleSide + transparent would draw every cube twice (back faces, then front faces): one pass is enough for alpha-tested skins
        forceSinglePass: true,
      });
      this.mats.set(key, m);
    }
    if (this.style.xray) { m.opacity = proceduralGhost ? 0.2 : 0.5; m.depthWrite = false; m.forceSinglePass = false; }
    return m;
  }

  private refreshMaterials() {
    for (const n of this.bones.values()) for (const cn of n.cubes.values()) cn.mesh.material = this.matFor(cn.cube, cn.cube.bone);
  }

  setTextures(texs: (T.Texture | null)[]) {
    this.textures = texs;
    for (const m of this.mats.values()) m.dispose();
    this.mats.clear();
    this.refreshMaterials();
  }
  setStyle(s: Partial<RigStyle>) {
    // the engine calls this on every store change (playback ticks included): rebuilding every material each time recompiled shaders per frame
    if ((Object.keys(s) as Array<keyof RigStyle>).every((k) => this.style[k] === s[k])) return;
    this.style = { ...this.style, ...s };
    for (const m of this.mats.values()) m.dispose();
    this.mats.clear();
    this.refreshMaterials();
  }
  /** limbs drawn ghosted ("procedural" in the game: no channel in the clip) */
  setGhostBones(names: Iterable<string>) {
    const next = new Set(names);
    if (next.size === this.ghostBones.size && [...next].every((n) => this.ghostBones.has(n))) return;
    this.ghostBones = next;
    this.mats.clear();
    this.refreshMaterials();
  }

  // ---------------------------------------------------------------- rig diff

  setRig(rig: RigModel) {
    const { THREE } = this;
    this.rig = rig;
    const names = new Set(rig.bones.map((b) => b.name));
    for (const [name, n] of [...this.bones]) {
      if (!names.has(name)) {
        this.disposeBone(n);
        this.bones.delete(name);
      }
    }
    const byName = new Map(rig.bones.map((b) => [b.name, b]));
    for (const b of rig.bones) {
      let n = this.bones.get(b.name);
      if (!n) {
        const group = new THREE.Group();
        group.name = b.name;
        n = { group, bone: b, sig: "", cubes: new Map(), restPos: new THREE.Vector3(), restRot: new THREE.Euler(0, 0, 0, "ZYX") };
        this.bones.set(b.name, n);
      }
      n.bone = b;
      n.group.visible = !this.hidden.has(b.name);
      const parent = b.parent ? byName.get(b.parent) : undefined;
      const sig = boneSig(b) + "|" + (parent ? parent.pivot.join(",") : "");
      if (sig !== n.sig) {
        n.sig = sig;
        const pv = sceneVec(b.pivot);
        const qv = parent ? sceneVec(parent.pivot) : ([0, 0, 0] as NumVec3);
        n.restPos.set(pv[0] - qv[0], pv[1] - qv[1], pv[2] - qv[2]);
        const r = b.rotation ?? [0, 0, 0];
        n.restRot.set(-r[0] * D2R, -r[1] * D2R, r[2] * D2R, "ZYX");
        n.group.position.copy(n.restPos);
        n.group.rotation.copy(n.restRot);
      }
      // cubes
      const live = new Set<number>();
      for (const c of b.cubes) {
        live.add(c.index);
        const csig = cubeSig(c, rig.texW, rig.texH) + "|" + sig;
        let cn = n.cubes.get(c.index);
        if (cn && cn.sig === csig) { cn.cube = c; cn.mesh.userData.cube = c; continue; }
        if (cn) this.disposeCube(cn);
        const piv = sceneVec(c.pivot ?? b.pivot);
        const geo = cubeGeometry(THREE, c, rig.texW, rig.texH, piv);
        const mesh = new THREE.Mesh(geo, this.matFor(c, b.name));
        const bv = sceneVec(b.pivot);
        mesh.position.set(piv[0] - bv[0], piv[1] - bv[1], piv[2] - bv[2]);
        mesh.rotation.order = "ZYX";
        const cr = c.rotation ?? [0, 0, 0];
        mesh.rotation.set(-cr[0] * D2R, -cr[1] * D2R, cr[2] * D2R);
        mesh.userData = { bone: b.name, index: c.index, cube: c };
        mesh.name = `${b.name}#${c.index}`;
        n.group.add(mesh);
        cn = { mesh, sig: csig, cube: c };
        n.cubes.set(c.index, cn);
        if (!this.style.ghost) this.pickables.push(mesh);
        this.rebuilt++;
      }
      for (const [i, cn] of [...n.cubes]) if (!live.has(i)) { this.disposeCube(cn); n.cubes.delete(i); }
    }
    // (re)attach in hierarchy
    for (const b of rig.bones) {
      const n = this.bones.get(b.name)!;
      const p = b.parent ? this.bones.get(b.parent) : undefined;
      const target = p && p !== n ? p.group : this.group;
      if (n.group.parent !== target) target.add(n.group);
    }
    this.applySelection();
  }

  private disposeCube(cn: CubeNode) {
    cn.mesh.removeFromParent();
    cn.mesh.geometry.dispose();
    (cn.edges as unknown as { geometry?: T.BufferGeometry } | undefined)?.geometry?.dispose();
    const i = this.pickables.indexOf(cn.mesh);
    if (i >= 0) this.pickables.splice(i, 1);
  }
  private disposeBone(n: BoneNode) {
    for (const cn of n.cubes.values()) this.disposeCube(cn);
    n.group.removeFromParent();
    n.marker?.geometry.dispose();
  }

  // ---------------------------------------------------------------- pose

  setPose(pose: Pose | null, skip?: ReadonlySet<string>) {
    const { THREE } = this;
    for (const [name, n] of this.bones) {
      if (skip?.has(name)) continue; // == constraints hook == bones a gizmo drag is controlling
      const p = pose ? (pose[name] ?? pose[BONE_ALIASES[name] ?? ""]) : undefined;
      const g = n.group;
      if (p?.rotation) g.rotation.set(n.restRot.x - p.rotation[0] * D2R, n.restRot.y - p.rotation[1] * D2R, n.restRot.z + p.rotation[2] * D2R, "ZYX");
      else g.rotation.copy(n.restRot);
      if (p?.position) g.position.set(n.restPos.x - p.position[0], n.restPos.y + p.position[1], n.restPos.z + p.position[2]);
      else g.position.copy(n.restPos);
      if (p?.scale) g.scale.set(p.scale[0], p.scale[1], p.scale[2]);
      else g.scale.set(1, 1, 1);
    }
    void THREE;
  }

  // ---------------------------------------------------------------- selection / visibility

  setHidden(names: string[]) {
    this.hidden = new Set(names);
    for (const [name, n] of this.bones) n.group.visible = !this.hidden.has(name);
  }
  setSelection(bones: string[], cubes: Array<{ bone: string; index: number }>, pivot = false, outline: Array<{ bone: string; index: number }> = []) {
    this.selOutline = new Set(outline.map((c) => `${c.bone}#${c.index}`));
    this.selBones = new Set(bones);
    this.selCubes = new Set(cubes.map((c) => `${c.bone}#${c.index}`));
    this.showPivot = pivot;
    this.applySelection();
  }
  /** keep the fat-line materials sized to the canvas (CSS px) */
  setResolution(w: number, h: number) { this.lineMat?.resolution.set(w, h); }

  private edgeLines(cn: CubeNode) {
    if (cn.edges) return cn.edges;
    const { THREE, lines } = this;
    const eg = new THREE.EdgesGeometry(cn.mesh.geometry);
    if (lines) {
      // Blockbench selection outline: LineBasicMaterial linewidth 2, #3e90ff, depth tested. WebGL ignores linewidth, so use fat lines.
      this.lineMat ??= new lines.LineMaterial({ color: 0x3e90ff, linewidth: 2, depthTest: true, resolution: new THREE.Vector2(800, 600) });
      const g = new lines.LineSegmentsGeometry().fromEdgesGeometry(eg);
      eg.dispose();
      cn.edges = new lines.LineSegments2(g, this.lineMat);
    } else {
      cn.edges = new THREE.LineSegments(eg, new THREE.LineBasicMaterial({ color: 0x3e90ff }));
    }
    cn.edges.renderOrder = 20;
    cn.mesh.add(cn.edges);
    return cn.edges;
  }
  /** QA: visible selection outlines (fat-line width / colour) and pivot markers */
  selectionStats() {
    let outlines = 0, pivots = 0;
    for (const n of this.bones.values()) {
      for (const cn of n.cubes.values()) { if (cn.edges?.visible) outlines++; if (cn.axes?.visible) pivots++; }
      if (n.marker?.visible) pivots++;
    }
    return { outlines, pivots, width: this.lineMat?.linewidth ?? null, color: this.lineMat ? "#" + this.lineMat.color.getHexString() : null, fat: !!this.lines };
  }
  /** a cube's geometry changed in place (live resize drag): rebuild its outline */
  refreshEdges(bone: string, index: number) {
    const cn = this.bones.get(bone)?.cubes.get(index);
    if (!cn?.edges) return;
    cn.edges.removeFromParent();
    (cn.edges as unknown as { geometry: T.BufferGeometry }).geometry.dispose();
    cn.edges = undefined;
    this.applySelection();
  }

  private applySelection() {
    const { THREE } = this;
    for (const [name, n] of this.bones) {
      const boneSel = this.selBones.has(name);
      for (const cn of n.cubes.values()) {
        const cubeSel = this.selCubes.has(`${name}#${cn.cube.index}`);
        const on = (boneSel || cubeSel || this.selOutline.has(`${name}#${cn.cube.index}`)) && !this.style.ghost;
        if (!on) { if (cn.edges) cn.edges.visible = false; }
        else this.edgeLines(cn).visible = true;
        // pivot marker (Pivot tool): AxesHelper(2) at the cube's pivot (= its mesh origin)
        if (on && this.showPivot && cubeSel) {
          if (!cn.axes) { cn.axes = new THREE.AxesHelper(2); (cn.axes.material as T.Material).depthTest = false; cn.axes.renderOrder = 30; cn.mesh.add(cn.axes); }
          cn.axes.visible = true;
        } else if (cn.axes) cn.axes.visible = false;
      }
      if (boneSel && this.showPivot && !this.style.ghost) {
        if (!n.marker) { n.marker = new THREE.AxesHelper(2); (n.marker.material as T.Material).depthTest = false; n.marker.renderOrder = 30; n.group.add(n.marker); }
        n.marker.visible = true;
      } else if (n.marker) n.marker.visible = false;
    }
  }

  /** Mesh of a cube (for the gizmo) or bone group. */
  cubeMesh(bone: string, index: number): T.Mesh | undefined {
    return this.bones.get(bone)?.cubes.get(index)?.mesh;
  }
  boneGroup(bone: string): T.Group | undefined {
    return this.bones.get(bone)?.group;
  }
  boneRest(bone: string) {
    return this.bones.get(bone);
  }

  dispose() {
    for (const n of this.bones.values()) this.disposeBone(n);
    this.bones.clear();
    for (const m of this.mats.values()) m.dispose();
    this.mats.clear();
    this.group.removeFromParent();
  }
}
