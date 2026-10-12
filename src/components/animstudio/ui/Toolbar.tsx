/** Studio toolbar: mode switch, gizmo tools, space/snap, view presets, display toggles, preview pickers, spidey toggles. */
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { getAnimations } from "../core";
import { useStudio, useStudioPick, type GizmoTool, type StudioMode, type ViewName } from "./state";
import type { StudioHandle } from "./studios";
import { FrameIcon, GridIcon, MagnetIcon, MoveIcon, OnionIcon, PersonIcon, PivotIcon, ResizeIcon, RotateIcon, WireIcon, XrayIcon } from "./icons";
import { IconBtn, Seg } from "./widgets";
import { togglePerf, usePerfOn } from "./perf";
import { toolAvailable } from "./tools/actions";
import { PreviewModelPicker, type ModelSource } from "./PreviewModelPicker";
import { CheckerIcon, ImageIcon, OrthoIcon, SunIcon } from "./refimages/icons";
import { addRefFromClipboard, addRefFromPicker, toggleRefEditMode } from "./refimages/refs";
import { cycleViewMode, resetCamera, toggleChecker, toggleOrtho, toggleShading, toggleWire } from "./viewport/api";

const base = (p: string) => p.slice(p.lastIndexOf("/") + 1).replace(/\.(geo|animation)\.json$/, "");

export interface ToolbarProps {
  handle: StudioHandle;
  onPickModel(path: string | null): void;
  onPickExt(path: string | null): void;
  rigPath: string | null;
  projectDefault?: string | null;
  onSetProjectDefault?: (p: string | null) => void;
  modelSource?: ModelSource;
}

/** Top bar (Blockbench menu row): the mode tabs and the file-level pickers (preview model / animation). */
export function ModeBar({ handle, onPickModel, onPickExt, rigPath, projectDefault, onSetProjectDefault, modelSource }: ToolbarProps) {
  const api = useStudio();
  const s = useStudioPick("mode", "poseSets", "asGameApplies", "liveAim", "anchorMode", "ext", "siblings");
  const set = api.store.set;
  const kind = handle.kind;
  const isGeo = kind === "geo", isAnim = kind === "animation";
  const modes: { id: StudioMode; label: string; disabled?: boolean; title: string }[] = [
    { id: "edit", label: "Edit", disabled: isAnim, title: isAnim ? "Animation files have no geometry of their own" : "Edit the model" },
    { id: "animate", label: "Animate", disabled: isGeo, title: isGeo ? "Open the .animation.json to animate" : "Animate: keyframes and timeline" },
    { id: "pose", label: "Pose", disabled: isGeo, title: "Pose between frames (breakdown)" },
  ];
  const spidey = s.poseSets.length > 0;
  const anims = handle.kind === "geo" && s.ext ? getAnimations(s.ext.doc) : [];
  return (
    <div className="as-toolbar as-modebar" data-testid="as-modebar">
      <Seg id="mode" value={s.mode} options={modes} onChange={(m) => set({ mode: m })} />
      <span className="as-grow" />
      {spidey && (
        <>
          <button className={"as-chip" + (s.asGameApplies ? " on" : "")} data-id="as-game" tabIndex={-1} title="Preview the clip the way the game plays it: mirrored clips L↔R, channels the game never reads dropped, procedural limbs ghosted, trick spin about the hinge (centre of mass + swing_pivot) over the spin's own ticks" onMouseDown={(e) => e.preventDefault()} onClick={() => set({ asGameApplies: !s.asGameApplies })}>As game applies</button>
          {s.asGameApplies && (
            <button className={"as-chip" + (s.liveAim ? " on" : "")} data-id="live-aim" tabIndex={-1} title="Live aim: aimed limbs point at the web-anchor marker (drag it in the viewport) the way LimbDriver aims them; only their roll is the clip's" onMouseDown={(e) => e.preventDefault()} onClick={() => set({ liveAim: !s.liveAim })}>Live aim</button>
          )}
          <button className={"as-chip" + (s.anchorMode ? " on" : "")} data-id="anchor" tabIndex={-1} title="Anchor mode: moving one key shifts every key of that bone and channel" onMouseDown={(e) => e.preventDefault()} onClick={() => set({ anchorMode: !s.anchorMode })}>Anchor</button>
        </>
      )}
      {isAnim && (
        <PreviewModelPicker geos={s.siblings.geos} value={rigPath} onPick={onPickModel}
          projectDefault={projectDefault ?? null} onSetProjectDefault={onSetProjectDefault ?? (() => {})} modelSource={modelSource} />
      )}
      {isGeo && (
        <>
          <label className="as-pick" title="Preview a sibling animation file on this model (read-only)">
            <span>Animation</span>
            <select data-id="preview-anim-file" value={s.ext?.path ?? ""} onChange={(e) => onPickExt(e.target.value || null)}>
              <option value="">None</option>
              {s.siblings.anims.map((g) => <option key={g} value={g}>{base(g)}</option>)}
            </select>
          </label>
          {s.ext && (
            <select className="as-select" data-id="preview-anim" value={s.ext.anim ?? ""} onChange={(e) => set({ ext: { ...s.ext!, anim: e.target.value || null }, time: 0 })}>
              <option value="">(rest pose)</option>
              {anims.map((a) => <option key={a.name} value={a.name}>{a.name.replace(/^animation\./, "")}</option>)}
            </select>
          )}
        </>
      )}
    </div>
  );
}

/** The tool row above the viewport (Blockbench toolbar under the menu): gizmo tools, camera, display and reference-image buttons. */
export function Toolbar({ handle }: ToolbarProps) {
  const api = useStudio();
  const s = useStudioPick("mode", "tool", "space", "snap", "view", "wire", "xray", "onion", "reference", "grid", "ortho", "shading", "checker", "viewMode", "refEdit", "refs", "cube", "doc");
  const set = api.store.set;
  const fps = usePerfOn();
  const edit = s.mode === "edit";
  const tools: { id: GizmoTool; icon: React.ReactNode; title: string; key: string; disabled?: boolean }[] = [
    { id: "move", icon: <MoveIcon />, title: "Move", key: "V" },
    { id: "resize", icon: <ResizeIcon />, title: edit ? "Resize cube" : "Scale", key: "S", disabled: edit && !s.cube },
    { id: "rotate", icon: <RotateIcon />, title: "Rotate", key: "R" },
    { id: "pivot", icon: <PivotIcon />, title: "Move pivot", key: "P", disabled: !edit },
  ];
  const vp = () => handle.viewport.current;
  const groups: { id: string; node: React.ReactNode }[] = [
    { id: "tools", node: (<>
      {tools.map((t) => (
        <IconBtn key={t.id} id={`tool-${t.id}`} title={`${t.title} (${t.key})`} on={s.tool === t.id} disabled={t.disabled || !toolAvailable(s, t.id)} onClick={() => set({ tool: t.id })}>{t.icon}</IconBtn>
      ))}
      <IconBtn id="space" wide title={`Gizmo space: ${s.space} (click to switch)`} onClick={() => set({ space: s.space === "local" ? "global" : "local" })}><span className="as-tx">{s.space === "local" ? "Local" : "Global"}</span></IconBtn>
      <IconBtn id="snap" title="Snapping: 1 px move, 22.5° rotate (⇧ = fine)" on={s.snap} onClick={() => set({ snap: !s.snap })}><MagnetIcon /></IconBtn>
    </>) },
    { id: "view", node: (<>
      <select className="as-select as-view-sel" data-id="view" title="Camera angle (numpad: 8 top, 2 bottom, 6 front, 4 back, 7 right, 9 left, 1 reset)" value={s.view === "side" ? "left" : s.view} onChange={(e) => vp()?.setView(e.target.value as ViewName)}>
        <option value="persp">Perspective</option>
        <option value="front">Front</option><option value="back">Back</option>
        <option value="left">Left</option><option value="right">Right</option>
        <option value="top">Top</option><option value="bottom">Bottom</option>
      </select>
      <IconBtn id="ortho" title="Orthographic projection (Num5)" on={s.ortho} onClick={() => toggleOrtho(api)}><OrthoIcon /></IconBtn>
      <IconBtn id="cam-reset" title="Reset camera (Num1)" onClick={() => resetCamera(api)}><span className="as-tx">1:1</span></IconBtn>
      <IconBtn id="frame" title="Frame selected (F)" onClick={() => vp()?.frame(true)}><FrameIcon /></IconBtn>
    </>) },
    { id: "display", node: (<>
      <IconBtn id="wire" title="Wireframe" on={s.wire} onClick={() => toggleWire(api)}><WireIcon /></IconBtn>
      <IconBtn id="xray" title="X-ray" on={s.xray} onClick={() => set({ xray: !s.xray })}><XrayIcon /></IconBtn>
      <IconBtn id="onion" title="Onion skin" on={s.onion.on} disabled={edit} onClick={() => set({ onion: { ...s.onion, on: !s.onion.on } })}><OnionIcon /></IconBtn>
      <IconBtn id="ref" title="Player scale reference (0.6 × 1.8 blocks)" on={s.reference} onClick={() => set({ reference: !s.reference })}><PersonIcon /></IconBtn>
      <IconBtn id="grid" title="Grid" on={s.grid} onClick={() => set({ grid: !s.grid })}><GridIcon /></IconBtn>
      <IconBtn id="shading" title="Shading (lighting)" on={s.shading} onClick={() => toggleShading(api)}><SunIcon /></IconBtn>
      <IconBtn id="checker" title="Checkerboard background (T)" on={s.checker} onClick={() => toggleChecker(api)}><CheckerIcon /></IconBtn>
      <IconBtn id="fps" title="Performance readout: FPS, frame time and where each frame goes" on={fps} onClick={togglePerf}><span className="as-tx">FPS</span></IconBtn>
      <IconBtn id="viewmode" title={`View mode: ${s.viewMode} (Z cycles textured / solid / wireframe)`} on={s.viewMode === "solid"} onClick={() => cycleViewMode(api)}><span className="as-tx">{s.viewMode === "textured" ? "Tex" : s.viewMode === "solid" ? "Solid" : "Wire"}</span></IconBtn>
    </>) },
    { id: "refimg", node: (<>
      <IconBtn id="refimages" title={`Reference Images (${s.refs.length}) - edit`} on={s.refEdit} onClick={() => toggleRefEditMode(api)}><ImageIcon /></IconBtn>
      <IconBtn id="ref-add-tb" title="Add Reference Image…" onClick={() => addRefFromPicker(api)}><span className="as-tx">+Img</span></IconBtn>
      <IconBtn id="ref-paste-tb" title="Paste Reference Image" onClick={() => void addRefFromClipboard(api)}><span className="as-tx">Paste</span></IconBtn>
    </>) },
  ];
  return <OverflowBar groups={groups} />;
}

/**
 * IntelliJ-style toolbar: groups are shown in priority order while they fit; the rest collapse into a "»" popup (never clipped).
 * Widths are measured from the visible groups and cached, so a hidden group keeps its last known width.
 */
function OverflowBar({ groups }: { groups: { id: string; node: React.ReactNode }[] }) {
  const bar = useRef<HTMLDivElement>(null);
  const widths = useRef<Record<string, number>>({});
  const [hidden, setHidden] = useState<string[]>([]);
  const [open, setOpen] = useState(false);
  const measure = () => {
    const el = bar.current;
    if (!el) return;
    for (const g of Array.from(el.querySelectorAll<HTMLElement>(":scope > .as-tg"))) if (g.offsetParent !== null || g.offsetWidth > 0) widths.current[g.dataset.g!] = g.offsetWidth + 6;
    const avail = el.clientWidth - 16;
    const total = groups.reduce((n, g) => n + (widths.current[g.id] ?? 0), 0);
    const hide: string[] = [];
    if (total > avail) {
      let used = 30;
      let full = false;
      for (const g of groups) {
        const w = widths.current[g.id] ?? 0;
        if (!full && used + w <= avail) used += w; else { full = true; hide.push(g.id); }
      }
    }
    setHidden((h) => (h.length === hide.length && h.every((x, i) => x === hide[i]) ? h : hide));
  };
  useLayoutEffect(measure);
  useEffect(() => {
    const ro = new ResizeObserver(measure);
    if (bar.current) ro.observe(bar.current);
    return () => ro.disconnect();
  });
  useEffect(() => { if (!hidden.length) setOpen(false); }, [hidden]);
  return (
    <div className="as-toolbar" data-testid="as-toolbar" ref={bar}>
      {groups.map((g) => (
        <div key={g.id} data-g={g.id} className={"as-tg" + (g.id === "extras" ? " end" : "")} style={hidden.includes(g.id) ? { display: "none" } : undefined}>{g.node}</div>
      ))}
      {hidden.length > 0 && (
        <div className="as-tmore">
          <button className={"as-ib" + (open ? " on" : "")} data-testid="as-toolbar-more" title="More toolbar items" onClick={() => setOpen((o) => !o)}>{"\u00bb"}</button>
          {open && (
            <div className="as-tpop" onMouseLeave={() => undefined}>
              {groups.filter((g) => hidden.includes(g.id)).map((g) => <div key={g.id} className="as-tg">{g.node}</div>)}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
