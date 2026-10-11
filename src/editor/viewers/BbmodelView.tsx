import { useEffect, useMemo, useRef, useState } from "react";
import type * as T from "three";
import { registerController } from "./controllers";
import { createScene, type SceneKit } from "./scene3d";
import { parseBbmodel, type BbCube, type BbGroup, type BbModel, type Face } from "./bbmodel";
import { Message } from "./Placeholders";
import type { ViewerProps } from "./ImageViewer";

/** Quad corners (TL, TR, BR, BL as seen from outside) per Minecraft face. */
const corners = (f: Face, a: [number, number, number], b: [number, number, number]) => {
  const [x1, y1, z1] = a, [x2, y2, z2] = b;
  switch (f) {
    case "north": return [[x2, y2, z1], [x1, y2, z1], [x1, y1, z1], [x2, y1, z1]];
    case "south": return [[x1, y2, z2], [x2, y2, z2], [x2, y1, z2], [x1, y1, z2]];
    case "east": return [[x2, y2, z2], [x2, y2, z1], [x2, y1, z1], [x2, y1, z2]];
    case "west": return [[x1, y2, z1], [x1, y2, z2], [x1, y1, z2], [x1, y1, z1]];
    case "up": return [[x1, y2, z1], [x2, y2, z1], [x2, y2, z2], [x1, y2, z2]];
    default: return [[x1, y1, z2], [x2, y1, z2], [x2, y1, z1], [x1, y1, z1]];
  }
};

export function buildBbmodel(THREE: typeof T, m: BbModel, textures: (T.Texture | null)[]) {
  const rad = Math.PI / 180;
  const rootG = new THREE.Group();
  rootG.scale.setScalar(1 / 16);
  let cubeCount = 0, faceCount = 0;
  const mats = new Map<number, T.Material>();
  const matFor = (i: number) => {
    let mt = mats.get(i);
    if (!mt) {
      const tex = textures[i] ?? null;
      mt = new THREE.MeshLambertMaterial({ map: tex, transparent: true, alphaTest: 0.05, side: THREE.DoubleSide, color: tex ? 0xffffff : 0xb48ead });
      mats.set(i, mt);
    }
    return mt;
  };
  const cubeMesh = (c: BbCube, parentOrigin: [number, number, number]) => {
    const pos: number[] = [], uv: number[] = [], idx: number[] = [], groups: { start: number; count: number; mat: number }[] = [];
    const inf = c.inflate;
    const a: [number, number, number] = [c.from[0] - c.origin[0] - inf, c.from[1] - c.origin[1] - inf, c.from[2] - c.origin[2] - inf];
    const b: [number, number, number] = [c.to[0] - c.origin[0] + inf, c.to[1] - c.origin[1] + inf, c.to[2] - c.origin[2] + inf];
    for (const [f, face] of Object.entries(c.faces) as [Face, NonNullable<BbCube["faces"][Face]>][]) {
      if (face.texture === null || face.texture === undefined) continue;
      const t = m.textures[face.texture];
      const W = t?.uvW ?? m.res[0], H = t?.uvH ?? m.res[1];
      const [u1, v1, u2, v2] = face.uv;
      let q: [number, number][] = [[u1, v1], [u2, v1], [u2, v2], [u1, v2]];
      const rot = ((face.rotation ?? 0) / 90) | 0;
      for (let r = 0; r < ((rot % 4) + 4) % 4; r++) q = [q[3], q[0], q[1], q[2]];
      const base = pos.length / 3;
      corners(f, a, b).forEach((p, k) => { pos.push(...p); uv.push(q[k][0] / W, 1 - q[k][1] / H); });
      const start = idx.length;
      idx.push(base, base + 2, base + 1, base, base + 3, base + 2);
      groups.push({ start, count: 6, mat: face.texture });
      faceCount++;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
    g.setIndex(idx);
    g.computeVertexNormals();
    groups.forEach((gr) => g.addGroup(gr.start, gr.count, gr.mat));
    const maxMat = Math.max(0, ...groups.map((x) => x.mat));
    const mesh = new THREE.Mesh(g, Array.from({ length: maxMat + 1 }, (_, i) => matFor(i)));
    mesh.position.set(c.origin[0] - parentOrigin[0], c.origin[1] - parentOrigin[1], c.origin[2] - parentOrigin[2]);
    mesh.rotation.order = "ZYX";
    mesh.rotation.set(c.rotation[0] * rad, c.rotation[1] * rad, c.rotation[2] * rad);
    mesh.name = c.name;
    cubeCount++;
    return mesh;
  };
  const add = (parent: T.Object3D, parentOrigin: [number, number, number], n: BbGroup | string) => {
    if (typeof n === "string") { const c = m.cubes.get(n); if (c) parent.add(cubeMesh(c, parentOrigin)); return; }
    const g = new THREE.Group();
    g.name = n.name;
    g.position.set(n.origin[0] - parentOrigin[0], n.origin[1] - parentOrigin[1], n.origin[2] - parentOrigin[2]);
    g.rotation.order = "ZYX";
    g.rotation.set(n.rotation[0] * rad, n.rotation[1] * rad, n.rotation[2] * rad);
    parent.add(g);
    n.children.forEach((c) => add(g, n.origin, c));
  };
  m.root.forEach((n) => add(rootG, [0, 0, 0], n));
  return { group: rootG, cubeCount, faceCount };
}

async function loadTexture(THREE: typeof T, src: string): Promise<T.Texture | null> {
  if (!src) return null;
  return new Promise((res) => {
    const img = new Image();
    img.onload = () => {
      const t = new THREE.Texture(img);
      t.magFilter = THREE.NearestFilter; t.minFilter = THREE.NearestFilter; t.colorSpace = THREE.SRGBColorSpace; t.flipY = true; t.needsUpdate = true;
      res(t);
    };
    img.onerror = () => res(null);
    img.src = src;
  });
}

export default function BbmodelView({ groupId, text }: ViewerProps & { text: string }) {
  const host = useRef<HTMLDivElement>(null);
  const kit = useRef<SceneKit>();
  const root = useRef<T.Object3D>();
  const [info, setInfo] = useState<{ cubes: number; faces: number; textures: number; texturesLoaded: number; skipped: number }>();
  const [wire, setWire] = useState(false);
  const parsed = useMemo(() => { try { return { m: parseBbmodel(text) }; } catch (e) { return { err: String(e) }; } }, [text]);
  useEffect(() => {
    if (!host.current || !parsed.m) return;
    let dead = false;
    (async () => {
      const k = await createScene(host.current!);
      if (dead) return k.dispose();
      kit.current = k;
      const texs = await Promise.all(parsed.m!.textures.map((t) => loadTexture(k.THREE, t.source)));
      if (dead) return;
      const { group, cubeCount, faceCount } = buildBbmodel(k.THREE, parsed.m!, texs);
      root.current = group;
      k.scene.add(group);
      k.frame(group);
      setInfo({ cubes: cubeCount, faces: faceCount, textures: texs.length, texturesLoaded: texs.filter(Boolean).length, skipped: parsed.m!.skipped });
    })().catch(() => {});
    return () => { dead = true; kit.current?.dispose(); kit.current = undefined; root.current = undefined; };
  }, [parsed]);
  useEffect(() => { kit.current?.setWire(wire); }, [wire, info]);
  useEffect(() => registerController(groupId, {
    frameAll: () => root.current && kit.current?.frame(root.current),
    snapshot: () => ({ kind: "bbmodel", ...info, wire, canvas: !!host.current?.querySelector("canvas") }),
  }), [groupId, info, wire]);
  if (parsed.err) return <Message title="Invalid .bbmodel" detail={parsed.err} />;
  return (
    <div className="mv" data-viewer="bbmodel">
      <div className="iv-bar">
        <button onClick={() => root.current && kit.current?.frame(root.current)}>Frame</button>
        <button className={wire ? "on" : ""} onClick={() => setWire(!wire)}>Wireframe</button>
        <span className="grow" />
        {info && <span className="iv-dim">{info.cubes} cubes · {info.faces} faces · {info.texturesLoaded}/{info.textures} textures{info.skipped ? ` · ${info.skipped} non-cube elements skipped` : ""}</span>}
      </div>
      <div className="mv-host" ref={host} />
    </div>
  );
}
