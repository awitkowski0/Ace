import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { fs } from "../../lib/ipc";
import type { Doc } from "../store";
import { dropPrefs, getPrefs, mimeOf, setPrefs, siblingOf, useBlobUrl, useBytes, usePrefs } from "./io";
import { registerController } from "./controllers";
import { decodeTga, sniffImage } from "./imageInfo";
import { parseMcmeta, schedule, sheetLayout, type McAnimation } from "./mcmeta";
import { extOf, formatSize } from "./registry";
import { Message } from "./Placeholders";

export interface ViewerProps { doc: Doc; groupId: string }

const STEPS = [0.05, 0.1, 0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4, 6, 8, 12, 16, 24, 32, 48, 64, 96, 128, 192, 256];
const nextStep = (z: number, dir: 1 | -1) => (dir > 0 ? STEPS.find((s) => s > z * 1.001) ?? STEPS[STEPS.length - 1] : [...STEPS].reverse().find((s) => s < z / 1.001) ?? STEPS[0]);
const hex = (n: number) => n.toString(16).padStart(2, "0");

export default function ImageViewer({ doc, groupId }: ViewerProps) {
  const { data, error, loading } = useBytes(doc);
  if (error) return <Message title="Cannot read image" detail={error} />;
  if (!data) return <div className="vw-empty">{loading ? "Loading…" : ""}</div>;
  return <ImageView doc={doc} groupId={groupId} data={data} />;
}

/** SVG tab preview: renders the live text. */
export function SvgPreview({ doc, groupId, text }: ViewerProps & { text: string }) {
  const data = useMemo(() => new TextEncoder().encode(text).buffer as ArrayBuffer, [text]);
  return <ImageView doc={doc} groupId={groupId} data={data} forceExt="svg" />;
}

export function ImageView({ doc, groupId, data, forceExt }: { doc: Doc; groupId: string; data: ArrayBuffer; forceExt?: string }) {
  const ext = forceExt ?? extOf(doc.name);
  const prefs = usePrefs(doc.key);
  const bg = prefs.bg ?? "checker";
  const grid = prefs.grid ?? false;
  const scrollRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [nat, setNat] = useState<{ w: number; h: number } | null>(null);
  const [zoomMode, setZoomMode] = useState<"smart" | "fit" | "manual">("smart");
  const [zoom, setZoom] = useState(1);
  const [pick, setPick] = useState<{ x: number; y: number; rgba: [number, number, number, number] } | null>(null);
  const [broken, setBroken] = useState<string | null>(null);
  const meta = useMemo(() => sniffImage(new Uint8Array(data, 0, Math.min(data.byteLength, 65536 * 4)), ext), [data, ext]);

  // TGA is not browser-decodable: convert to a PNG blob
  const [tgaBlob, setTgaBlob] = useState<Blob>();
  useEffect(() => {
    if (ext !== "tga") return;
    const t = decodeTga(new Uint8Array(data));
    if (!t) return setBroken("Unsupported TGA variant");
    const c = document.createElement("canvas");
    c.width = t.w; c.height = t.h;
    c.getContext("2d")!.putImageData(new ImageData(t.rgba as unknown as Uint8ClampedArray<ArrayBuffer>, t.w, t.h), 0, 0);
    c.toBlob((b) => b && setTgaBlob(b));
  }, [data, ext]);
  const plainUrl = useBlobUrl(ext === "tga" ? undefined : data, mimeOf(ext));
  const tgaUrl = useMemo(() => (tgaBlob ? URL.createObjectURL(tgaBlob) : undefined), [tgaBlob]);
  useEffect(() => () => { if (tgaUrl) URL.revokeObjectURL(tgaUrl); }, [tgaUrl]);
  const url = ext === "tga" ? tgaUrl : plainUrl;

  // pixel reader backed by an offscreen canvas of the decoded image
  const readerRef = useRef<((x: number, y: number) => [number, number, number, number] | null) | null>(null);
  const onLoad = useCallback(() => {
    const img = imgRef.current;
    if (!img) return;
    let w = img.naturalWidth, h = img.naturalHeight;
    if (!w || !h) { w = 300; h = 150; } // SVG without intrinsic size
    setNat({ w, h });
    setBroken(null);
    try {
      if (w * h > 64_000_000) throw new Error("too big");
      const c = document.createElement("canvas");
      c.width = w; c.height = h;
      const ctx = c.getContext("2d", { willReadFrequently: true })!;
      ctx.drawImage(img, 0, 0, w, h);
      readerRef.current = (x, y) => (x < 0 || y < 0 || x >= w || y >= h ? null : (Array.from(ctx.getImageData(x, y, 1, 1).data) as [number, number, number, number]));
    } catch { readerRef.current = null; }
  }, []);

  // ---- animated texture (png + sibling .png.mcmeta) ----
  const [mc, setMc] = useState<McAnimation | null>(null);
  const [importInfo, setImportInfo] = useState<Record<string, string> | null>(null);
  const [showImport, setShowImport] = useState(false);
  useEffect(() => {
    let dead = false;
    setMc(null); setImportInfo(null);
    if (doc.kind === "diff") return;
    if (ext === "png") {
      fs.readFile(siblingOf(doc.loc, doc.name + ".mcmeta")).then((t) => { if (!dead) setMc(parseMcmeta(t)); }, () => {});
    }
    fs.readFile(siblingOf(doc.loc, doc.name + ".import")).then((t) => { if (!dead) setImportInfo(parseImport(t)); }, () => {});
    return () => { dead = true; };
  }, [doc.key, doc.rev]); // eslint-disable-line react-hooks/exhaustive-deps
  const animated = !!mc && (prefs.animated ?? true);
  const sheet = useMemo(() => (mc && nat ? sheetLayout(mc, nat.w, nat.h) : null), [mc, nat]);
  const dims = animated && sheet ? { w: sheet.fw, h: sheet.fh } : nat;

  // ---- zoom ----
  const fitZoom = useCallback(() => {
    const sc = scrollRef.current;
    if (!sc || !dims) return 1;
    return Math.max(0.02, Math.min((sc.clientWidth - 24) / dims.w, (sc.clientHeight - 24) / dims.h));
  }, [dims]);
  const applyMode = useCallback(() => {
    if (!dims) return;
    if (zoomMode === "fit") setZoom(fitZoom());
    else if (zoomMode === "smart") {
      const f = fitZoom();
      const small = dims.w <= 256 && dims.h <= 256;
      setZoom(f < 1 ? f : small ? Math.max(1, Math.floor(f * 0.7)) : 1);
    }
  }, [dims, zoomMode, fitZoom]);
  useLayoutEffect(applyMode, [applyMode]);
  useEffect(() => {
    const sc = scrollRef.current;
    if (!sc) return;
    const ro = new ResizeObserver(() => zoomMode !== "manual" && applyMode());
    ro.observe(sc);
    return () => ro.disconnect();
  }, [applyMode, zoomMode]);

  const anchor = useRef<{ px: number; py: number; cx: number; cy: number } | null>(null);
  const animRef = useRef(animated);
  animRef.current = animated;
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;
  const setManual = (z: number, at?: { cx: number; cy: number }) => {
    z = Math.min(256, Math.max(0.02, z));
    const el = (animRef.current ? canvasRef.current : imgRef.current) ?? null;
    const sc = scrollRef.current;
    if (el && sc) {
      const r = el.getBoundingClientRect();
      const cx = at?.cx ?? sc.getBoundingClientRect().left + sc.clientWidth / 2;
      const cy = at?.cy ?? sc.getBoundingClientRect().top + sc.clientHeight / 2;
      anchor.current = { px: (cx - r.left) / zoomRef.current, py: (cy - r.top) / zoomRef.current, cx, cy };
    }
    setZoomMode("manual");
    setZoom(z);
  };
  useLayoutEffect(() => {
    const a = anchor.current, sc = scrollRef.current, el = animated ? canvasRef.current : imgRef.current;
    if (!a || !sc || !el) return;
    anchor.current = null;
    const r = el.getBoundingClientRect();
    sc.scrollLeft += r.left + a.px * zoom - a.cx;
    sc.scrollTop += r.top + a.py * zoom - a.cy;
  }, [zoom, animated]);

  const ctl = useRef({ zoom, dims, pick });
  ctl.current = { zoom, dims, pick };
  const doPick = useCallback((x: number, y: number) => {
    const rgba = readerRef.current?.(x, y) ?? null;
    setPick(rgba ? { x, y, rgba } : null);
    return rgba;
  }, []);
  const [frameInfo, setFrameInfo] = useState({ frame: 0, count: 0 });
  const [playing, setPlaying] = useState(true);
  const playRef = useRef({ playing, setPlaying });
  playRef.current = { playing, setPlaying };
  useEffect(() => registerController(groupId, {
    zoomIn: () => setManual(nextStep(ctl.current.zoom, 1)),
    zoomOut: () => setManual(nextStep(ctl.current.zoom, -1)),
    actualSize: () => setManual(1),
    fit: () => setZoomMode("fit"),
    toggleGrid: () => setPrefs(doc.key, { grid: !(getPrefs(doc.key).grid ?? false) }),
    playPause: () => playRef.current.setPlaying(!playRef.current.playing),
    snapshot: () => {
      const el = (animated ? canvasRef.current : imgRef.current);
      return {
        kind: "image", zoom: ctl.current.zoom, mode: zoomMode, natural: nat, dims: ctl.current.dims, pick: ctl.current.pick, bg: getPrefs(doc.key).bg ?? "checker",
        grid: getPrefs(doc.key).grid ?? false, animated, rendering: el ? getComputedStyle(el).imageRendering : null,
        shown: el ? { w: el.clientWidth, h: el.clientHeight } : null, format: meta, frame: frameRef.current, frames: sheet ? schedule(mc!, sheet.total).length : 0,
        playing: playRef.current.playing, imported: importInfo,
      };
    },
    // test hooks (no real mouse): color under image pixel, wheel zoom around a client point
    ...( { pick: doPick, wheel: (dy: number, cx: number, cy: number) => scrollRef.current?.dispatchEvent(new WheelEvent("wheel", { deltaY: dy, ctrlKey: true, clientX: cx, clientY: cy, bubbles: true, cancelable: true })) } as object),
  }), [groupId, doc.key, animated, nat, zoomMode, meta, sheet, mc, importInfo]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => { /* keep prefs for the session */ }, []);

  const onWheel = useCallback((e: WheelEvent) => {
    if (!(e.ctrlKey || e.metaKey)) return;
    e.preventDefault();
    setManual(ctl.current.zoom * Math.exp(-e.deltaY * (e.ctrlKey && !e.metaKey ? 0.01 : 0.004)), { cx: e.clientX, cy: e.clientY });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const sc = scrollRef.current;
    sc?.addEventListener("wheel", onWheel, { passive: false });
    return () => sc?.removeEventListener("wheel", onWheel);
  }, [onWheel, nat]);

  // ---- animation playback (rAF only while playing) ----
  const frameRef = useRef(0);
  useEffect(() => {
    if (!animated || !mc || !sheet || !nat) return;
    const img = imgRef.current, cv = canvasRef.current;
    if (!img || !cv) return;
    const ctx = cv.getContext("2d")!;
    const frames = schedule(mc, sheet.total);
    const total = frames.reduce((s, f) => s + f.ticks, 0);
    setFrameInfo((s) => ({ ...s, count: frames.length }));
    const draw = (slot: number, alpha = 1) => {
      const i = frames[slot].index % sheet.total;
      const sx = (i % sheet.cols) * sheet.fw, sy = Math.floor(i / sheet.cols) * sheet.fh;
      ctx.globalAlpha = alpha;
      ctx.drawImage(img, sx, sy, sheet.fw, sheet.fh, 0, 0, sheet.fw, sheet.fh);
    };
    const render = (ticks: number) => {
      let t = ticks % total, slot = 0;
      while (slot < frames.length - 1 && t >= frames[slot].ticks) { t -= frames[slot].ticks; slot++; }
      ctx.imageSmoothingEnabled = false;
      ctx.clearRect(0, 0, cv.width, cv.height);
      draw(slot);
      if (mc.interpolate) draw((slot + 1) % frames.length, t / frames[slot].ticks);
      ctx.globalAlpha = 1;
      if (frameRef.current !== slot) { frameRef.current = slot; setFrameInfo({ frame: slot, count: frames.length }); }
      readerRef.current = (x, y) => (x < 0 || y < 0 || x >= sheet.fw || y >= sheet.fh ? null : (Array.from(ctx.getImageData(x, y, 1, 1).data) as [number, number, number, number]));
    };
    if (!playing) { render(frames.slice(0, frameRef.current).reduce((s, f) => s + f.ticks, 0)); return; }
    const t0 = performance.now() - frames.slice(0, frameRef.current).reduce((s, f) => s + f.ticks, 0) * 50;
    let raf = 0;
    const loop = () => { render((performance.now() - t0) / 50); raf = requestAnimationFrame(loop); };
    loop();
    return () => cancelAnimationFrame(raf);
  }, [animated, mc, sheet, nat, playing, url]);

  const onMove = (e: React.MouseEvent) => {
    const el = animated ? canvasRef.current : imgRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    doPick(Math.floor((e.clientX - r.left) / zoom), Math.floor((e.clientY - r.top) / zoom));
  };

  if (broken) return <Message title="Cannot display image" detail={broken} />;
  const w = dims ? dims.w * zoom : 0, h = dims ? dims.h * zoom : 0;
  const pixelated = zoom > 1 || (animated && zoom >= 1);
  const showGrid = grid && zoom >= 6;
  const bgClass = bg === "checker" ? "iv-checker" : bg === "light" ? "iv-light" : bg === "dark" ? "iv-dark" : "iv-none";
  const imgStyle: React.CSSProperties = { width: w || undefined, height: h || undefined, imageRendering: pixelated ? "pixelated" : "auto" };

  return (
    <div className="iv" tabIndex={0} data-viewer="image">
      <div className="iv-bar">
        <button title="Zoom Out (⌘-)" onClick={() => setManual(nextStep(zoom, -1))}>−</button>
        <span className="iv-zoom" data-testid="zoom">{Math.round(zoom * 100)}%</span>
        <button title="Zoom In (⌘=)" onClick={() => setManual(nextStep(zoom, 1))}>+</button>
        <button title="Actual Size (⌘/)" onClick={() => setManual(1)}>1:1</button>
        <button title="Fit to Window (⌘0)" className={zoomMode === "fit" ? "on" : ""} onClick={() => setZoomMode("fit")}>Fit</button>
        <span className="iv-sep" />
        <button title="Checkerboard" className={"sw checker" + (bg === "checker" ? " on" : "")} onClick={() => setPrefs(doc.key, { bg: "checker" })} />
        <button title="Light background" className={"sw light" + (bg === "light" ? " on" : "")} onClick={() => setPrefs(doc.key, { bg: "light" })} />
        <button title="Dark background" className={"sw dark" + (bg === "dark" ? " on" : "")} onClick={() => setPrefs(doc.key, { bg: "dark" })} />
        <span className="iv-sep" />
        <button title="Show Pixel Grid (⌘')" className={grid ? "on" : ""} onClick={() => setPrefs(doc.key, { grid: !grid })}>Grid</button>
        {mc && (
          <>
            <span className="iv-sep" />
            <button title="Play the .mcmeta animation" className={animated ? "on" : ""} onClick={() => setPrefs(doc.key, { animated: !animated })}>Animated</button>
            {animated && <button title="Play / Pause (Space)" onClick={() => setPlaying(!playing)}>{playing ? "Pause" : "Play"}</button>}
            {animated && <span className="iv-dim">frame {frameInfo.frame + 1}/{frameInfo.count} · {mc.frametime} tick{mc.frametime === 1 ? "" : "s"}{mc.interpolate ? " · interpolated" : ""}</span>}
          </>
        )}
        {importInfo && <button title="Godot import settings (.import sidecar)" className={showImport ? "on" : ""} onClick={() => setShowImport(!showImport)}>Import</button>}
      </div>
      <div className={"iv-scroll " + bgClass} ref={scrollRef} onMouseMove={onMove} onMouseLeave={() => setPick(null)}
        onKeyDown={(e) => { if (e.key === " " && mc) { e.preventDefault(); setPlaying(!playing); } }}>
        <div className="iv-stage" style={{ width: w || undefined, height: h || undefined }}>
          {/* the <img> always exists (decoder + pixel source); animated mode shows a canvas over it */}
          <img ref={imgRef} src={url} alt={doc.name} draggable={false} onLoad={onLoad} onError={() => setBroken(`The ${meta.format} image could not be decoded`)}
            style={{ ...imgStyle, display: animated ? "none" : "block" }} />
          {animated && sheet && <canvas ref={canvasRef} width={sheet.fw} height={sheet.fh} style={imgStyle} />}
          {showGrid && dims && (
            <div className="iv-grid" style={{ width: w, height: h, backgroundSize: `${zoom}px ${zoom}px` }} />
          )}
        </div>
        {showImport && importInfo && (
          <div className="iv-import">
            <div className="iv-import-h">Godot import — {doc.name}.import</div>
            {Object.entries(importInfo).map(([k, v]) => <div key={k}><span>{k}</span><b>{v}</b></div>)}
          </div>
        )}
      </div>
      <div className="iv-status">
        <span>{nat ? `${nat.w} × ${nat.h} px` : ""}{animated && sheet ? ` (frame ${sheet.fw} × ${sheet.fh})` : ""}</span>
        <span>{meta.format}{meta.depth ? ` · ${meta.depth}` : ""}</span>
        <span>{formatSize(data.byteLength)}</span>
        <span className="grow" />
        {pick ? (
          <span className="iv-pick" data-testid="pick">
            <i style={{ background: `rgba(${pick.rgba.join(",")})`.replace(/,(\d+)\)$/, (_, a) => `,${+a / 255})`) }} />
            {pick.x}, {pick.y} · #{hex(pick.rgba[0])}{hex(pick.rgba[1])}{hex(pick.rgba[2])}{pick.rgba[3] !== 255 ? hex(pick.rgba[3]) : ""} · rgba({pick.rgba.join(", ")})
          </span>
        ) : <span className="iv-dim">hover for pixel colour</span>}
      </div>
    </div>
  );
}

function parseImport(t: string): Record<string, string> {
  const want = new Set(["importer", "type", "compress/mode", "compress/lossy_quality", "compress/normal_map", "mipmaps/generate", "process/fix_alpha_border",
    "process/premult_alpha", "process/hdr_as_srgb", "detect_3d/compress_to", "roughness/mode", "process/size_limit", "svg/scale", "compress/channel_pack"]);
  const out: Record<string, string> = {};
  for (const line of t.split("\n")) {
    const m = /^([\w/]+)=(.*)$/.exec(line.trim());
    if (m && want.has(m[1])) out[m[1]] = m[2].replace(/^"|"$/g, "");
  }
  return out;
}
export { dropPrefs };
