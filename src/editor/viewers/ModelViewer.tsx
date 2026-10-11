import { useEffect, useRef, useState } from "react";
import type * as T from "three";
import { fs } from "../../lib/ipc";
import { registerController } from "./controllers";
import { mimeOf, siblingOf, useBytes } from "./io";
import { createScene, type SceneKit } from "./scene3d";
import { extOf, formatSize } from "./registry";
import { Message } from "./Placeholders";
import type { ViewerProps } from "./ImageViewer";

interface Stats { meshes: number; triangles: number; materials: number; textures: number; animations: string[]; size: [number, number, number] | null; nodes: number }

export default function ModelViewer({ doc, groupId }: ViewerProps) {
  const { data, error } = useBytes(doc);
  const host = useRef<HTMLDivElement>(null);
  const kit = useRef<SceneKit>();
  const [stats, setStats] = useState<Stats>();
  const [err, setErr] = useState<string>();
  const [wire, setWire] = useState(false);
  const [grid, setGrid] = useState(true);
  const [anim, setAnim] = useState(-1);
  const [playing, setPlaying] = useState(false);
  const mixer = useRef<{ m: T.AnimationMixer; clips: T.AnimationClip[]; action?: T.AnimationAction }>();
  const root = useRef<T.Object3D>();

  useEffect(() => {
    if (!data || !host.current) return;
    let dead = false;
    const urls: string[] = [];
    setErr(undefined); setStats(undefined);
    (async () => {
      const k = await createScene(host.current!);
      if (dead) return k.dispose();
      kit.current = k;
      const { GLTFLoader } = await import("three/examples/jsm/loaders/GLTFLoader.js");
      const manager = new k.THREE.LoadingManager();
      let input: ArrayBuffer | string = data;
      if (extOf(doc.name) === "gltf") {
        // .gltf is JSON with external buffers/images: pre-load them from the same host and map the URIs to blob URLs
        const text = new TextDecoder().decode(data);
        input = text;
        const j = JSON.parse(text);
        const map = new Map<string, string>();
        for (const e of [...(j.buffers ?? []), ...(j.images ?? [])]) {
          const uri: string | undefined = e.uri;
          if (!uri || uri.startsWith("data:") || map.has(uri)) continue;
          try {
            const b = await fs.readBytes(siblingOf(doc.loc, decodeURI(uri)));
            const u = URL.createObjectURL(new Blob([b], { type: mimeOf(extOf(uri)) }));
            urls.push(u); map.set(uri, u);
          } catch { /* missing texture: glTF loader will report */ }
        }
        // URIs are resolved against the (empty) base: loader asks for the bare uri
        manager.setURLModifier((u) => { for (const [kk, v] of map) if (u === kk || u.endsWith("/" + kk) || decodeURI(u).endsWith(kk)) return v; return u; });
      }
      new GLTFLoader(manager).parse(input, "", (gltf) => {
        if (dead) return;
        root.current = gltf.scene;
        k.scene.add(gltf.scene);
        let meshes = 0, tris = 0, nodes = 0;
        const mats = new Set<T.Material>(), texs = new Set<T.Texture>();
        gltf.scene.traverse((o) => {
          nodes++;
          const m = o as T.Mesh;
          if (!m.isMesh) return;
          meshes++;
          const g = m.geometry;
          tris += (g.index ? g.index.count : g.attributes.position.count) / 3;
          for (const mt of Array.isArray(m.material) ? m.material : [m.material]) {
            mats.add(mt);
            for (const v of Object.values(mt)) if ((v as T.Texture | undefined)?.isTexture) texs.add(v as T.Texture);
          }
        });
        const box = new k.THREE.Box3().setFromObject(gltf.scene);
        const sz = box.isEmpty() ? null : box.getSize(new k.THREE.Vector3());
        mixer.current = { m: new k.THREE.AnimationMixer(gltf.scene), clips: gltf.animations };
        setStats({ meshes, triangles: Math.round(tris), materials: mats.size, textures: texs.size, animations: gltf.animations.map((a, i) => a.name || `Animation ${i + 1}`), size: sz ? [sz.x, sz.y, sz.z] : null, nodes });
        k.frame(gltf.scene);
      }, (e) => !dead && setErr(String((e as unknown as Error).message ?? e)));
    })().catch((e) => !dead && setErr(String(e?.message ?? e)));
    return () => {
      dead = true;
      mixer.current?.m.stopAllAction(); mixer.current = undefined;
      kit.current?.dispose(); kit.current = undefined; root.current = undefined;
      urls.forEach((u) => URL.revokeObjectURL(u));
    };
  }, [data, doc.key]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { kit.current?.setWire(wire); }, [wire, stats]);
  useEffect(() => { if (kit.current) { kit.current.grid.visible = grid; kit.current.render(); } }, [grid, stats]);
  useEffect(() => {
    const k = kit.current, mx = mixer.current;
    if (!k || !mx) return;
    mx.action?.stop();
    mx.action = undefined;
    if (anim < 0) { mx.m.stopAllAction(); k.animate(false); k.render(); return; }
    mx.action = mx.m.clipAction(mx.clips[anim]);
    mx.action.reset().play();
    mx.action.paused = !playing;
    k.animate(playing, (dt) => mx.m.update(dt));
    if (!playing) { mx.m.update(0); k.render(); }
  }, [anim, playing, stats]);

  useEffect(() => registerController(groupId, {
    frameAll: () => root.current && kit.current?.frame(root.current),
    playPause: () => setPlaying((p) => !p),
    snapshot: () => ({ kind: "model", ...stats, wire, playing, anim, canvas: !!host.current?.querySelector("canvas"), camera: kit.current ? kit.current.camera.position.toArray() : null }),
  }), [groupId, stats, wire, playing, anim]);

  if (error || err) return <Message title="Cannot load 3D model" detail={error ?? err} />;
  return (
    <div className="mv" data-viewer="model" tabIndex={0} onKeyDown={(e) => { if (e.key === "f") root.current && kit.current?.frame(root.current); }}>
      <div className="iv-bar">
        <button title="Frame All (F)" onClick={() => root.current && kit.current?.frame(root.current)}>Frame</button>
        <button className={wire ? "on" : ""} onClick={() => setWire(!wire)}>Wireframe</button>
        <button className={grid ? "on" : ""} onClick={() => setGrid(!grid)}>Grid</button>
        {stats && stats.animations.length > 0 && (
          <>
            <span className="iv-sep" />
            <select value={anim} onChange={(e) => { setAnim(+e.target.value); setPlaying(+e.target.value >= 0); }}>
              <option value={-1}>No animation</option>
              {stats.animations.map((n, i) => <option key={i} value={i}>{n}</option>)}
            </select>
            <button disabled={anim < 0} onClick={() => setPlaying(!playing)}>{playing ? "Pause" : "Play"}</button>
          </>
        )}
        <span className="grow" />
        {stats && <span className="iv-dim">{stats.meshes} meshes · {stats.triangles.toLocaleString()} tris · {stats.materials} materials · {stats.textures} textures · {stats.animations.length} animations{stats.size ? ` · ${stats.size.map((v) => v.toFixed(2)).join(" × ")}` : ""} · {formatSize(data?.byteLength ?? 0)}</span>}
      </div>
      <div className="mv-host" ref={host} />
      {!stats && !err && <div className="vw-empty mv-loading">Loading model…</div>}
    </div>
  );
}
