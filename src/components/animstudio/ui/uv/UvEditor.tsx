/**
 * UV editor panel (Blockbench Edit mode, left sidebar top). Shows the active texture with a pixel grid, and for the selected cube(s)
 * every face rectangle (per-face UV) or the box-UV unwrap island. Drag a rectangle to move the selected faces of ALL selected cubes
 * together, drag a handle to resize, drag a box island to move its offset. Snaps to texture pixels (Shift 0.25, Cmd 0.1, both 0.025).
 * Wheel / drag navigation like Blockbench: Cmd (or pinch) + wheel zooms at the cursor, wheel pans, RMB / MMB drag pans.
 * Drags draw from a local draft and commit ONE core edit on release (one undo stop); numbers in the panel follow the document.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import {
  FACES, applyUvDrag, bbTextureInfos, boxUvRects, cubeFaceRects, normRect, snapDelta, uvSnapStep,
  type CubeUv, type Face, type Rect, type Side, type UvDrag,
} from "../../core";
import { useStudio, useStudioPick } from "../state";
import type { RCube, RigModel } from "../model";
import { Section, IconBtn, NumField } from "../widgets";
import { loadImage } from "../resolve";
import { BoxUvI, FitI, MirrorXI, MirrorYI, RotateUvI } from "../icons";
import { cubeUvOf, opSetUvs, opUvFlip, opUvRotate, opUvSetNumber, opUvToggleBox, uvCubes } from "../uvOps";
import { opToggleFlag } from "../ops";
import { keyOf, type CubeRef } from "../selection";

const FACE_NAME: Record<Face, string> = { north: "North", east: "East", south: "South", west: "West", up: "Up", down: "Down" };
const HANDLES: Array<{ id: string; xs: Side; ys: Side; fx: number; fy: number }> = [
  { id: "nw", xs: -1, ys: -1, fx: 0, fy: 0 }, { id: "n", xs: 0, ys: -1, fx: 0.5, fy: 0 }, { id: "ne", xs: 1, ys: -1, fx: 1, fy: 0 },
  { id: "e", xs: 1, ys: 0, fx: 1, fy: 0.5 }, { id: "se", xs: 1, ys: 1, fx: 1, fy: 1 }, { id: "s", xs: 0, ys: 1, fx: 0.5, fy: 1 },
  { id: "sw", xs: -1, ys: 1, fx: 0, fy: 1 }, { id: "w", xs: -1, ys: 0, fx: 0, fy: 0.5 },
];
const MIN_ZOOM = 0.25, MAX_ZOOM = 48;

interface View { zoom: number; cx: number; cy: number }
type Draft = Map<string, CubeUv>;
interface Drag {
  kind: "move" | "resize" | "pan";
  x0: number; y0: number;
  view0: View;
  bases: Array<{ ref: CubeRef; cube: RCube; base: CubeUv }>;
  xs: Side; ys: Side;
  faces: Face[];
  moved: boolean;
}

export function UvPanel({ rig, host }: { rig: RigModel | null; host: string }) {
  const api = useStudio();
  const s = useStudioPick("doc", "bones", "cube", "cubes", "uvFaces", "texActive", "geoTex", "locked", "mode");
  const vp = useRef<HTMLDivElement>(null);
  const cv = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState({ w: 280, h: 280 });
  const [view, setView] = useState<View>({ zoom: 1, cx: 0, cy: 0 });
  const [draft, setDraft] = useState<Draft | null>(null);
  const [img, setImg] = useState<HTMLImageElement | null>(null);
  const [cursor, setCursor] = useState<{ u: number; v: number } | null>(null);
  const [grid, setGrid] = useState(true);
  const drag = useRef<Drag | null>(null);
  const draftRef = useRef<Draft | null>(null);
  const uvW = rig?.texW ?? 16, uvH = rig?.texH ?? 16;

  // ---- active texture image
  const texSrc = useMemo<{ kind: "data" | "file"; ref: string } | null>(() => {
    if (s.doc?.kind === "bbmodel") {
      const t = bbTextureInfos(s.doc)[Math.min(s.texActive, Math.max(0, bbTextureInfos(s.doc).length - 1))];
      return t?.source ? { kind: "data", ref: t.source } : null;
    }
    if (s.doc?.kind === "geo") {
      const l = s.geoTex.layers[Math.min(s.texActive, Math.max(0, s.geoTex.layers.length - 1))];
      return l ? { kind: "file", ref: l.path } : null;
    }
    return null;
  }, [s.doc, s.texActive, s.geoTex]);
  useEffect(() => {
    let dead = false;
    setImg(null);
    if (!texSrc) return;
    if (texSrc.kind === "file") void loadImage(host, texSrc.ref).then((i) => { if (!dead) setImg(i); });
    else { const i = new Image(); i.onload = () => { if (!dead) setImg(i); }; i.src = texSrc.ref; }
    return () => { dead = true; };
  }, [texSrc, host]);
  useEffect(() => {
    const c = cv.current;
    if (!c) return;
    if (!img) { c.width = 1; c.height = 1; c.getContext("2d")?.clearRect(0, 0, 1, 1); return; }
    c.width = img.naturalWidth; c.height = img.naturalHeight;
    const g = c.getContext("2d")!;
    g.imageSmoothingEnabled = false;
    g.clearRect(0, 0, c.width, c.height);
    g.drawImage(img, 0, 0);
  }, [img]);
  const texW = img?.naturalWidth ?? uvW, texH = img?.naturalHeight ?? uvH;

  // ---- viewport size / initial view
  useEffect(() => {
    const el = vp.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: Math.max(40, el.clientWidth), h: Math.max(40, el.clientHeight) }));
    ro.observe(el);
    setSize({ w: Math.max(40, el.clientWidth), h: Math.max(40, el.clientHeight) });
    return () => ro.disconnect();
  }, []);
  useEffect(() => { setView({ zoom: 1, cx: uvW / 2, cy: uvH / 2 }); }, [uvW, uvH]);
  const fit = Math.min((size.w - 12) / uvW, (size.h - 12) / uvH);
  const k = Math.max(0.01, fit * view.zoom); // screen px per UV unit
  const fx = size.w / 2 - view.cx * k, fy = size.h / 2 - view.cy * k;

  // ---- selected cubes (group selections expand to their cubes)
  const cubes = useMemo(() => uvCubes(api, rig), [api, rig, s.doc, s.bones, s.cube, s.cubes]); // eslint-disable-line react-hooks/exhaustive-deps
  const primary = cubes.find((c) => s.cube && c.ref.bone === s.cube.bone && c.ref.index === s.cube.index) ?? cubes[cubes.length - 1];
  const anyFaces = cubes.some((c) => c.cube.uv && c.cube.uv.kind !== "box");
  const isBb = s.doc?.kind === "bbmodel";
  const activeTex = isBb ? Math.min(s.texActive, Math.max(0, bbTextureInfos(s.doc!).length - 1)) : 0;

  const uvOf = (c: { ref: CubeRef; cube: RCube }): CubeUv => draft?.get(keyOf(c.ref)) ?? cubeUvOf(c.cube);

  // ---- coordinate helpers
  const toUv = (clientX: number, clientY: number): { u: number; v: number } => {
    const r = vp.current!.getBoundingClientRect();
    return { u: (clientX - r.left - fx) / k, v: (clientY - r.top - fy) / k };
  };
  const clampView = (v: View): View => ({ zoom: v.zoom, cx: Math.min(uvW, Math.max(0, v.cx)), cy: Math.min(uvH, Math.max(0, v.cy)) });
  const resetView = () => setView({ zoom: 1, cx: uvW / 2, cy: uvH / 2 });

  // ---- wheel: Cmd / pinch zoom at the cursor, otherwise pan
  const kRef = useRef({ k, fx, fy, view, size, uvW, uvH });
  kRef.current = { k, fx, fy, view, size, uvW, uvH };
  useEffect(() => {
    const el = vp.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const c = kRef.current;
      const r = el.getBoundingClientRect();
      if (e.ctrlKey || e.metaKey) {
        const step = Math.abs(e.deltaY) < 10 ? Math.exp(-e.deltaY * 0.012) : e.deltaY < 0 ? 1.15 : 1 / 1.15;
        const zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, c.view.zoom * step));
        const fit0 = Math.min((c.size.w - 12) / c.uvW, (c.size.h - 12) / c.uvH);
        const k2 = Math.max(0.01, fit0 * zoom);
        const px = e.clientX - r.left, py = e.clientY - r.top;
        const u = (px - c.fx) / c.k, v = (py - c.fy) / c.k;
        setView({ zoom, cx: Math.min(c.uvW, Math.max(0, u - (px - c.size.w / 2) / k2)), cy: Math.min(c.uvH, Math.max(0, v - (py - c.size.h / 2) / k2)) });
      } else {
        setView((v) => clampView({ ...v, cx: v.cx + (e.shiftKey && !e.deltaX ? e.deltaY : e.deltaX) / c.k, cy: v.cy + (e.shiftKey && !e.deltaX ? 0 : e.deltaY) / c.k }));
      }
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [uvW, uvH]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---- drags (move / resize / pan)
  const start = (e: React.PointerEvent, d: Omit<Drag, "x0" | "y0" | "view0" | "moved" | "bases"> & { bases?: Drag["bases"] }) => {
    drag.current = { ...d, x0: e.clientX, y0: e.clientY, view0: view, moved: false, bases: d.bases ?? cubes.map((c) => ({ ref: c.ref, cube: c.cube, base: cubeUvOf(c.cube) })) };
    const onMove = (ev: PointerEvent) => {
      const dr = drag.current;
      if (!dr) return;
      const dxp = ev.clientX - dr.x0, dyp = ev.clientY - dr.y0;
      if (!dr.moved && Math.hypot(dxp, dyp) < 3) return;
      dr.moved = true;
      if (dr.kind === "pan") { setView(clampView({ zoom: dr.view0.zoom, cx: dr.view0.cx - dxp / k, cy: dr.view0.cy - dyp / k })); return; }
      const ctrl = ev.metaKey || ev.ctrlKey;
      const next: Draft = new Map();
      for (const b of dr.bases) {
        const box = b.base?.kind === "box";
        const step = box ? 1 : uvSnapStep(ev.shiftKey, ctrl, texW / uvW);
        const dx = snapDelta(dxp / k, step), dy = snapDelta(dyp / k, step);
        const spec: UvDrag = dr.kind === "resize" ? { kind: "resize", faces: dr.faces, xs: dr.xs, ys: dr.ys } : box ? { kind: "island" } : { kind: "move", faces: dr.faces };
        let uv = applyUvDrag(b.base, spec, dx, dy);
        if (uv?.kind === "box") uv = { kind: "box", uv: [Math.max(0, uv.uv[0]), Math.max(0, uv.uv[1])] };
        next.set(keyOf(b.ref), uv);
      }
      draftRef.current = next;
      setDraft(next);
    };
    const finish = (ev: PointerEvent | null) => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("keydown", onKey, true);
      const dr = drag.current;
      const cur = draftRef.current;
      drag.current = null;
      draftRef.current = null;
      setDraft(null);
      if (ev && dr && dr.kind !== "pan" && dr.moved && cur) {
        const edits = dr.bases.map((b) => ({ ref: b.ref, prev: b.base, next: cur.get(keyOf(b.ref)) ?? b.base }));
        opSetUvs(api, edits, dr.kind === "resize" ? "Resize UV" : "Move UV");
      }
    };
    const onUp = (ev: PointerEvent) => finish(ev);
    const onKey = (ev: KeyboardEvent) => { if (ev.key === "Escape") { ev.stopPropagation(); finish(null); } };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("keydown", onKey, true);
  };

  const faceDown = (e: React.PointerEvent, face: Face) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    const add = e.shiftKey || e.metaKey || e.ctrlKey;
    let faces = s.uvFaces;
    if (add) {
      // Blockbench: Shift / Cmd on a face adds it to (or removes it from) the face selection; a face that stays selected can then be dragged
      faces = faces.includes(face) ? faces.filter((f) => f !== face) : [...faces, face];
      api.store.set({ uvFaces: faces });
      if (!faces.includes(face)) return;
    } else if (!faces.includes(face)) {
      faces = [face];
      api.store.set({ uvFaces: faces });
    }
    start(e, { kind: "move", xs: 0, ys: 0, faces });
  };
  const islandDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    start(e, { kind: "move", xs: 0, ys: 0, faces: s.uvFaces });
  };
  const handleDown = (e: React.PointerEvent, h: { xs: Side; ys: Side }) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    start(e, { kind: "resize", xs: h.xs, ys: h.ys, faces: s.uvFaces });
  };
  const bgDown = (e: React.PointerEvent) => {
    if (e.button === 1 || e.button === 2) { e.preventDefault(); start(e, { kind: "pan", xs: 0, ys: 0, faces: [] }); return; }
    if (e.button === 0 && !(e.shiftKey || e.metaKey || e.ctrlKey)) api.store.set({ uvFaces: [] });
  };

  // ---- numbers (shared by every selected cube; mixed = blank)
  const numFace: Face | null = s.uvFaces.find((f) => cubes.some((c) => c.cube.uv?.kind === "rects" && c.cube.uv.faces[f])) ?? null;
  const numbers = (field: "u" | "v" | "w" | "h"): number | undefined => {
    const vals: number[] = [];
    for (const c of cubes) {
      const uv = uvOf(c);
      if (!uv) continue;
      if (uv.kind === "box") { if (field === "u" || field === "v") vals.push(uv.uv[field === "u" ? 0 : 1]); continue; }
      const r = numFace && uv.faces[numFace] ? cubeFaceRects(uv, [0, 0, 0], false)![numFace] : undefined;
      if (r) vals.push(field === "u" ? r[0] : field === "v" ? r[1] : field === "w" ? r[2] - r[0] : r[3] - r[1]);
    }
    return vals.length && vals.every((x) => Math.abs(x - vals[0]) < 1e-6) ? Math.round(vals[0] * 1e4) / 1e4 : undefined;
  };
  const hasBox = cubes.some((c) => c.cube.uv?.kind === "box");
  const hasRects = cubes.some((c) => c.cube.uv?.kind === "rects");

  // ---- render
  const gridPx = (k * uvW) / Math.max(1, texW); // screen px per texture pixel
  const frameStyle: React.CSSProperties = { left: fx, top: fy, width: uvW * k, height: uvH * k };
  const nodes: React.ReactNode[] = [];
  for (const c of cubes) {
    const uv = uvOf(c);
    if (!uv) continue;
    const ck = keyOf(c.ref);
    if (uv.kind === "box") {
      const r = boxUvRects(uv.uv, c.cube.size);
      const x0 = Math.min(...FACES.map((f) => normRect(r[f]).x)), y0 = Math.min(...FACES.map((f) => normRect(r[f]).y));
      const x1 = Math.max(...FACES.map((f) => normRect(r[f]).x + normRect(r[f]).w)), y1 = Math.max(...FACES.map((f) => normRect(r[f]).y + normRect(r[f]).h));
      nodes.push(
        <div key={ck + ":island"} className="as-uvbox" data-uvisland={ck} style={{ left: x0 * k, top: y0 * k, width: (x1 - x0) * k, height: (y1 - y0) * k }} onPointerDown={islandDown}>
          {FACES.map((f) => {
            const n = normRect(r[f]);
            if (n.w <= 0 || n.h <= 0) return null;
            return <div key={f} className={"as-uvbf " + (f === "up" || f === "down" ? "v" : "h")} data-uvface={f} style={{ left: (n.x - x0) * k, top: (n.y - y0) * k, width: n.w * k, height: n.h * k }}><span>{f[0].toUpperCase()}</span></div>;
          })}
        </div>,
      );
      continue;
    }
    const rects = cubeFaceRects(uv, c.cube.size, c.cube.mirror)!;
    for (const f of FACES) {
      const r = rects[f];
      if (!r) continue;
      const slot = c.cube.faceTex?.[f];
      if (isBb && slot !== undefined && slot !== null && slot >= 0 && slot !== activeTex) continue; // face belongs to another texture
      const n = normRect(r);
      const sel = s.uvFaces.includes(f);
      nodes.push(
        <div key={`${ck}:${f}`} className={"as-uvf" + (sel ? " sel" : "")} data-uvface={f} data-cube={ck} title={FACE_NAME[f]}
          style={{ left: n.x * k - 1, top: n.y * k - 1, width: n.w * k + 2, height: n.h * k + 2 }} onPointerDown={(e) => faceDown(e, f)}>
          <span className="as-uvfl">{FACE_NAME[f]}</span>
          {sel && HANDLES.map((h) => (
            <i key={h.id} className={"as-uvh " + h.id} data-uvh={h.id} style={{ left: h.fx * (n.w * k + 2), top: h.fy * (n.h * k + 2) }} onPointerDown={(e) => handleDown(e, h)} />
          ))}
        </div>,
      );
    }
  }

  const primaryUv = primary?.cube.uv;
  const faceDisabled = (f: Face) => primary?.cube.faceTex?.[f] === null;
  const status = cursor ? `${cursor.u}, ${cursor.v}` : `${uvW} × ${uvH}`;
  const note = !texSrc ? (s.doc?.kind === "geo" ? "No texture found next to this model." : "This model has no texture. Add one in Textures.") : null;

  return (
    <Section title="UV Editor" right={<span className="as-uvres" data-testid="uv-status" title="UV size (cursor position while hovering)">{status}</span>}>
      <div className="as-uvp" data-testid="uv-panel">
        {anyFaces && (
          <div className="as-uvfaces" data-testid="uv-facebar">
            {FACES.map((f) => (
              <button key={f} tabIndex={-1} className={(s.uvFaces.includes(f) ? "on " : "") + (faceDisabled(f) ? "off" : "")} data-uvtab={f} onMouseDown={(e) => e.preventDefault()}
                onClick={(e) => api.store.set({ uvFaces: e.shiftKey || e.metaKey || e.ctrlKey ? (s.uvFaces.includes(f) ? s.uvFaces.filter((x) => x !== f) : [...s.uvFaces, f]) : [f] })}>{FACE_NAME[f]}</button>
            ))}
          </div>
        )}
        <div className="as-uvvp" ref={vp} data-testid="uv-viewport" onPointerDown={bgDown} onContextMenu={(e) => e.preventDefault()}
          onPointerMove={(e) => { const p = toUv(e.clientX, e.clientY); const u = Math.floor(p.u), v = Math.floor(p.v); setCursor((c) => (u >= 0 && v >= 0 && u < uvW && v < uvH ? (c && c.u === u && c.v === v ? c : { u, v }) : null)); }}
          onPointerLeave={() => setCursor(null)}>
          <div className="as-uvframe" style={frameStyle} data-testid="uv-frame" data-k={k.toFixed(3)} data-zoom={view.zoom.toFixed(3)} data-fx={fx.toFixed(1)} data-fy={fy.toFixed(1)}>
            <canvas ref={cv} className="as-uvtex" data-testid="uv-canvas" />
            {grid && gridPx >= 3 && (
              <div className="as-uvgrid" style={{ backgroundSize: `${(uvW * k) / texW}px ${(uvH * k) / texH}px` }} />
            )}
            {nodes}
          </div>
          {!cubes.length && <div className="as-uvhint">Select a cube to edit its UV</div>}
          {note && <div className="as-uvnote">{note}</div>}
          <div className="as-uvzoom">{Math.round(view.zoom * 100)}%</div>
        </div>
        <div className="as-uvbar" data-testid="uv-toolbar">
          <IconBtn id="uv-box" title="Box UV / per-face UV (toggle for the selected cubes)" on={hasBox && !hasRects} disabled={!cubes.length} onClick={() => opUvToggleBox(api, rig)}><BoxUvI /></IconBtn>
          <IconBtn id="uv-mirror-x" title={hasBox && !hasRects ? "Mirror UV (box UV)" : "Mirror the selected faces horizontally"} disabled={!cubes.length} onClick={() => opUvFlip(api, rig, "x")}><MirrorXI /></IconBtn>
          <IconBtn id="uv-mirror-y" title="Mirror the selected faces vertically" disabled={!hasRects} onClick={() => opUvFlip(api, rig, "y")}><MirrorYI /></IconBtn>
          <IconBtn id="uv-rotate" title={isBb ? "Rotate the selected faces 90°" : "Bedrock geometry has no face rotation"} disabled={!isBb || !hasRects} onClick={() => opUvRotate(api, rig)}><RotateUvI /></IconBtn>
          <IconBtn id="uv-mirror-flag" title="Toggle Mirror UV of the selected cubes" disabled={!cubes.length} onClick={() => opToggleFlag(api, "mirror_uv")}><span className="as-tx">Mir</span></IconBtn>
          <span className="as-grow" />
          <IconBtn id="uv-grid" title="Pixel grid" on={grid} onClick={() => setGrid((g) => !g)}><span className="as-tx">#</span></IconBtn>
          <IconBtn id="uv-fit" title="Reset zoom" onClick={resetView}><FitI /></IconBtn>
        </div>
        {cubes.length > 0 && primaryUv && (
          <div className="as-uvnums" data-testid="uv-numbers">
            {hasBox && !hasRects ? (
              <>
                <NumField id="uv-u" label="U" value={numbers("u")} placeholder="—" onCommit={(v) => opUvSetNumber(api, rig, null, "u", v)} />
                <NumField id="uv-v" label="V" value={numbers("v")} placeholder="—" onCommit={(v) => opUvSetNumber(api, rig, null, "v", v)} />
              </>
            ) : numFace ? (
              <>
                <span className="as-uvnl">{FACE_NAME[numFace]}</span>
                <NumField id="uv-u" label="U" value={numbers("u")} placeholder="—" step={0.25} onCommit={(v) => opUvSetNumber(api, rig, numFace, "u", v)} />
                <NumField id="uv-v" label="V" value={numbers("v")} placeholder="—" step={0.25} onCommit={(v) => opUvSetNumber(api, rig, numFace, "v", v)} />
                <NumField id="uv-w" label="W" value={numbers("w")} placeholder="—" step={0.25} onCommit={(v) => opUvSetNumber(api, rig, numFace, "w", v)} />
                <NumField id="uv-h" label="H" value={numbers("h")} placeholder="—" step={0.25} onCommit={(v) => opUvSetNumber(api, rig, numFace, "h", v)} />
              </>
            ) : <span className="as-uvnl dim">Select a face</span>}
          </div>
        )}
      </div>
    </Section>
  );
}
