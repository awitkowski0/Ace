import { useEffect, useRef, useState, type ReactNode } from "react";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import type { StudioHandle } from "../studios";
import { useStudioPick } from "../state";
import { perfRender } from "../perf";
import { PerfHud } from "../PerfHud";
import { ViewportEngine } from "./engine";
import { RefLayers } from "../refimages/RefLayers";
import { RefImportDialog, RefPanel } from "../refimages/RefPanel";
import { IMAGE_EXT, addRefFromFile, addRefFromPath, loadRefs, syncBbRefs } from "../refimages/refs";
import { loadConstraints, syncConstraintSel } from "../constraints/store"; // == constraints hook ==

/** The three.js canvas of one Studio. `onReady` hands the engine to the shell (rig/texture sources). */
export function Viewport({ handle, onReady, children }: { handle: StudioHandle; onReady: (e: ViewportEngine | null) => void; children?: ReactNode }) {
  perfRender("Viewport");
  const host = useRef<HTMLDivElement>(null);
  const root = useRef<HTMLDivElement>(null);
  const [err, setErr] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [engine, setEngine] = useState<ViewportEngine | null>(null);
  const s = useStudioPick("parseError", "rig", "mode", "tool", "view", "cube", "bones", "checker", "doc", "ortho");
  useEffect(() => {
    let dead = false;
    let eng: ViewportEngine | null = null;
    ViewportEngine.create(host.current!, handle.api).then(
      (e) => {
        if (dead) return e.dispose();
        eng = e;
        handle.viewport.current = e;
        setReady(true);
        setEngine(e);
        onReady(e);
      },
      (e) => setErr(String(e?.message ?? e)),
    );
    return () => {
      dead = true;
      handle.viewport.current = null;
      onReady(null);
      setEngine(null);
      eng?.dispose();
    };
  }, [handle]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---- reference images: load project + global scope once the document is known, then follow text changes (undo/redo/external)
  const loadedFor = useRef<unknown>(null);   // this component instance is reused when the tab switches to another document
  useEffect(() => {
    if (!s.doc) return;
    if (loadedFor.current !== handle) { loadedFor.current = handle; void loadRefs(handle.api); void loadConstraints(handle.api); /* == constraints hook == */ } else { syncBbRefs(handle.api); syncConstraintSel(handle.api); }
  }, [s.doc, handle]);

  // ---- drag & drop of image files onto the viewport (HTML5 for in-page drags, Tauri for Finder drops)
  const onDrop = (e: React.DragEvent) => {
    const files = Array.from(e.dataTransfer?.files ?? []).filter((f) => IMAGE_EXT.includes(f.name.split(".").pop()?.toLowerCase() ?? ""));
    if (!files.length) return;
    e.preventDefault();
    for (const f of files) void addRefFromFile(handle.api, f);
  };
  useEffect(() => {
    let un: (() => void) | undefined;
    let dead = false;
    try {
      void getCurrentWebviewWindow().onDragDropEvent((ev) => {
        const p = ev.payload as { type: string; paths?: string[]; position?: { x: number; y: number } };
        if (p.type !== "drop" || !p.paths || !p.position) return;
        const r = root.current?.getBoundingClientRect();
        if (!r || r.width === 0) return;
        const dpr = window.devicePixelRatio || 1;
        const x = p.position.x / dpr, y = p.position.y / dpr;
        if (x < r.left || x > r.right || y < r.top || y > r.bottom) return;
        for (const path of p.paths) if (IMAGE_EXT.includes(path.split(".").pop()?.toLowerCase() ?? "")) void addRefFromPath(handle.api, path);
      }).then((f) => { if (dead) f(); else un = f; }, () => {});
    } catch { /* not running inside Tauri */ }
    return () => { dead = true; un?.(); };
  }, [handle]);

  return (
    <div className="as-vp" data-testid="as-viewport" ref={root} onDragOver={(e) => { if (e.dataTransfer?.types?.includes("Files")) e.preventDefault(); }} onDrop={onDrop}>
      <div className={"as-vp-bgfx" + (s.checker ? " checker" : "")} />
      <div className="as-vp-host" ref={host} />
      <RefLayers engine={engine} />
      {!ready && !err && <div className="as-vp-msg">Loading viewport…</div>}
      {err && <div className="as-vp-msg err">3D viewport unavailable: {err}</div>}
      {s.parseError && <div className="as-vp-banner" data-testid="parse-error" title={s.parseError}>Cannot parse JSON: showing the last valid version. Fix the text to continue editing.</div>}
      {s.rig && <div className="as-vp-chip" data-testid="rig-chip">{s.doc?.kind === "animation" ? `Preview: ${s.rig.label}` : s.rig.label}</div>}
      <div className="as-vp-view" data-testid="view-chip">{viewLabel(s.view, s.ortho)}</div>
      <PerfHud />
      <RefPanel />
      <RefImportDialog />
      {children}
    </div>
  );
}

const VIEW_NAMES: Record<string, string> = { persp: "Perspective", front: "Front", back: "Back", left: "Left", right: "Right", top: "Top", bottom: "Bottom", side: "Left" };
function viewLabel(view: string, ortho: boolean) {
  return view === "persp" ? (ortho ? "Orthographic" : "Perspective") : `${VIEW_NAMES[view] ?? view} (ortho)`;
}
