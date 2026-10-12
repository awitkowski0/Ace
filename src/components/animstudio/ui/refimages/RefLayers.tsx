/**
 * Reference-image layers of the viewport (Blockbench layers): Behind Model (under the canvas), Above Model (over the canvas),
 * Above Interface (over everything, may overflow). Flat images are positioned from the viewport centre in screen px;
 * blueprints follow the orthographic camera (position/size scale with the zoom, anchored on the world origin) and only show in
 * the ortho view they are attached to; "3D Plane" images live in the three.js scene (engine.syncRefPlanes).
 * In Reference Image mode every image gets a transparent hit proxy above the canvas; the selected one gets move / corner-resize /
 * rotate handles when it is not locked.
 */
import { useEffect, useRef, useState } from "react";
import type { RefImage } from "../../core";
import { useStudio, useStudioPick, type StudioState } from "../state";
import type { ViewportEngine, CamInfo } from "../viewport/engine";
import { VIEW_SIDE } from "../viewport/camera";
import { naturalSize, selectRef, setRefs, updateRef } from "./refs";

const BP_BASE_ZOOM = 0.5;

export function refVisible(r: RefImage, st: Pick<StudioState, "refsHidden" | "ortho" | "view" | "mode">): boolean {
  if (st.refsHidden || !r.visibility || r.opacity < 0.1) return false;
  if (r.modes.length && !r.modes.includes(st.mode)) return false;
  if (r.view_mode === "plane") return false;
  if (r.view_mode === "blueprint") return st.ortho && VIEW_SIDE[st.view] === r.attached_side;
  return true;
}

function useCam(engine: ViewportEngine | null): CamInfo | null {
  const [cam, setCam] = useState<CamInfo | null>(null);
  useEffect(() => {
    if (!engine) return;
    // timer-coalesced (not rAF): an occluded / unfocused webview throttles rAF to a crawl and the layers must still follow
    let raf: ReturnType<typeof setTimeout> | 0 = 0;
    const upd = () => { if (!raf) raf = setTimeout(() => { raf = 0; setCam(engine.camInfo()); }, 0); };
    upd();
    const un = engine.subscribeCamera(upd);
    const ro = new ResizeObserver(upd);
    ro.observe(engine.canvas());
    return () => { un(); ro.disconnect(); if (raf) clearTimeout(raf); };
  }, [engine]);
  return cam;
}

interface Geo { cx: number; cy: number; w: number; h: number; k: number }
function geoOf(r: RefImage, cam: CamInfo): Geo {
  if (r.view_mode === "blueprint") {
    const k = cam.zoom / BP_BASE_ZOOM;
    return { cx: cam.origin.x + r.position[0] * k, cy: cam.origin.y + r.position[1] * k, w: r.size[0] * k, h: r.size[1] * k, k };
  }
  return { cx: cam.w / 2 + r.position[0], cy: cam.h / 2 + r.position[1], w: r.size[0], h: r.size[1], k: 1 };
}

function ImgEl({ r, g }: { r: RefImage; g: Geo }) {
  const style: React.CSSProperties = {
    position: "absolute", left: g.cx - g.w / 2, top: g.cy - g.h / 2, width: g.w, height: g.h, opacity: r.opacity,
    transform: `rotate(${r.rotation}deg)`, transformOrigin: "50% 50%", pointerEvents: "none",
    ...(r.clear_mode ? { mixBlendMode: "lighten" as const, filter: "contrast(1.2)" } : {}),
  };
  return (
    <div style={style} data-ref={r.uuid}>
      <img src={r.source} draggable={false} alt="" style={{ width: "100%", height: "100%", display: "block", transform: `scale(${r.flip_x ? -1 : 1}, ${r.flip_y ? -1 : 1})`, userSelect: "none" }} />
    </div>
  );
}

export function RefLayers({ engine }: { engine: ViewportEngine | null }) {
  const api = useStudio();
  const s = useStudioPick("refs", "refSel", "refEdit", "refsHidden", "ortho", "view", "mode");
  const cam = useCam(engine);
  if (!cam) return null;
  const vis = s.refs.filter((r) => refVisible(r, s));
  const layer = (l: RefImage["layer"]) => vis.filter((r) => r.layer === l).map((r) => <ImgEl key={r.uuid} r={r} g={geoOf(r, cam)} />);
  return (
    <>
      <div className="as-ref-layer behind" data-testid="ref-layer-behind">{layer("background")}</div>
      <div className="as-ref-layer above" data-testid="ref-layer-above">{layer("viewport")}</div>
      <div className="as-ref-layer float" data-testid="ref-layer-float">{layer("float")}</div>
      {s.refEdit && (
        <div className="as-ref-layer hit" data-testid="ref-hit">
          {vis.map((r) => <RefHit key={r.uuid} r={r} g={geoOf(r, cam)} selected={s.refSel === r.uuid} api={api} />)}
        </div>
      )}
    </>
  );
}

type Api = ReturnType<typeof useStudio>;

function RefHit({ r, g, selected, api }: { r: RefImage; g: Geo; selected: boolean; api: Api }) {
  const live = useRef(r);
  live.current = r;
  const gref = useRef(g);
  gref.current = g;
  const drag = (kind: "move" | "corner" | "rotate") => (e: React.PointerEvent) => {
    e.stopPropagation();
    e.preventDefault();
    if (!selected) { selectRef(api, r.uuid); return; }
    if (r.locked) return;
    const el = e.currentTarget as HTMLElement;
    try { el.setPointerCapture(e.pointerId); } catch { /* synthetic */ }
    const host = el.closest(".as-vp")!.getBoundingClientRect();
    const start = { ...live.current };
    const geo = gref.current;
    const px = (ev: { clientX: number; clientY: number }) => ({ x: ev.clientX - host.left, y: ev.clientY - host.top });
    const p0 = px(e);
    const a0 = Math.atan2(p0.y - geo.cy, p0.x - geo.cx);
    const mv = (ev: PointerEvent) => {
      const p = px(ev);
      if (kind === "move") {
        updateRef(api, r.uuid, { position: [start.position[0] + (p.x - p0.x) / geo.k, start.position[1] + (p.y - p0.y) / geo.k] }, "Move Reference Image", false);
      } else if (kind === "corner") {
        const a = (-start.rotation * Math.PI) / 180;
        const lx = (p.x - geo.cx) * Math.cos(a) - (p.y - geo.cy) * Math.sin(a), ly = (p.x - geo.cx) * Math.sin(a) + (p.y - geo.cy) * Math.cos(a);
        let w = Math.max(8, (Math.abs(lx) * 2) / geo.k), h = Math.max(8, (Math.abs(ly) * 2) / geo.k);
        if (!ev.shiftKey) { const f = Math.max(w / start.size[0], h / start.size[1]); w = start.size[0] * f; h = start.size[1] * f; }
        updateRef(api, r.uuid, { size: [Math.round(w), Math.round(h)] }, "Resize Reference Image", false);
      } else {
        const a = Math.atan2(p.y - geo.cy, p.x - geo.cx);
        let rot = start.rotation + ((a - a0) * 180) / Math.PI;
        rot = ev.shiftKey ? Math.round(rot / 15) * 15 : Math.round(rot * 10) / 10;
        updateRef(api, r.uuid, { rotation: rot }, "Rotate Reference Image", false);
      }
    };
    const up = () => {
      window.removeEventListener("pointermove", mv);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      setRefs(api, api.store.get().refs, kind === "move" ? "Move Reference Image" : kind === "corner" ? "Resize Reference Image" : "Rotate Reference Image", true);
    };
    window.addEventListener("pointermove", mv);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  };
  const style: React.CSSProperties = { position: "absolute", left: g.cx - g.w / 2, top: g.cy - g.h / 2, width: g.w, height: g.h, transform: `rotate(${r.rotation}deg)`, transformOrigin: "50% 50%" };
  return (
    <div className={"as-ref-box" + (selected ? " sel" : "") + (r.locked ? " locked" : "")} style={style} data-ref-hit={r.uuid} onPointerDown={drag("move")} onDoubleClick={() => selectRef(api, r.uuid)}>
      {selected && !r.locked && (
        <>
          {(["tl", "tr", "bl", "br"] as const).map((c) => <span key={c} className={"as-ref-h " + c} data-handle={"corner-" + c} onPointerDown={drag("corner")} />)}
          <span className="as-ref-rot" data-handle="rotate" onPointerDown={drag("rotate")} />
        </>
      )}
    </div>
  );
}

export { naturalSize };
