import { useEffect } from "react";
import { perfRender } from "../perf";
import { animLength, setLength, strideBlocks } from "../../core";
import { runAction } from "../../../../actions/registry";
import { promptDialog } from "../../../shell/dialogs";
import { showContextMenu, type MenuItem } from "../../../shell/contextMenu";
import { useStudio } from "../state";
import { useToolsUi, toolsStore } from "../toolsUi";
import { DopeSheet } from "./DopeSheet";
import { GraphEditor } from "./GraphEditor";
import { IcDope, IcGraph, IcLoop, IcPause, IcPlay, IcSnap } from "./icons";
import { cur, insertKeyAtPlayhead } from "./ops";
import { startPlayback } from "./playback";
import { ensureStyles } from "./styles";
import { fmtTime } from "./layout";
import { useCurrentAnim, useStudioSel } from "./hooks";
import { ProblemsChip, ProblemsList, SemanticsChip } from "../tools/ProblemsStrip";
import { LiveConstraintsChip } from "../constraints/LiveChip"; // == constraints hook ==

const SPEEDS = [0.25, 0.5, 1, 1.5, 2];

export function Timeline() {
  perfRender("Timeline");
  const api = useStudio();
  ensureStyles();
  const ui = useToolsUi(api);
  useEffect(() => startPlayback(api), [api]);
  return (
    <div className="as-tl" data-testid="as-timeline">
      <TimelineToolbar tab={ui.tlTab} setTab={(t) => toolsStore(api).set({ tlTab: t })} />
      <ProblemsList />
      {ui.tlTab === "dope" ? <DopeSheet /> : <GraphEditor />}
    </div>
  );
}

/**
 * Slim Blockbench-style header: play / loop / time / speed / snap on the left, Dope Sheet <-> Graph Editor toggle and the "..." menu on the right.
 * Everything else (auto-key, anchor, mirror animating, pose between frames, noise, markers, length, frame all) lives in the menu; the keys still work.
 */
function TimelineToolbar({ tab, setTab }: { tab: "dope" | "graph"; setTab: (t: "dope" | "graph") => void }) {
  perfRender("TimelineToolbar");
  const api = useStudio();
  const playing = useStudioSel((s) => s.playing);
  const loop = useStudioSel((s) => s.loopPreview);
  const speed = useStudioSel((s) => s.speed);
  const autoKey = useStudioSel((s) => s.autoKey);
  const snap = useStudioSel((s) => s.snapTicks);
  const anchor = useStudioSel((s) => s.anchorMode);
  const time = useStudioSel((s) => s.time);
  const hasAnim = useStudioSel((s) => !!s.anim && !!s.doc);
  const anim = useCurrentAnim();
  const gait = useStudioSel((s) => (s.mode === "animate" && s.anim ? s.clipInfo[s.anim]?.strideGait ?? null : null));
  const strideSpeed = useStudioSel((s) => s.strideSpeed);
  const strideDist = useStudioSel((s) => s.strideDist);
  const mirrorAnim = useToolsUi(api).mirrorAnimating;
  const set = api.store.set;
  const act = (id: string) => () => runAction(id);
  const check = (on: boolean, label: string) => (on ? "\u2713  " : "\u2003  ") + label;
  const setLen = async () => {
    const c = cur(api);
    if (!c) return;
    const v = await promptDialog({ title: "Animation length (seconds)", initial: String(+animLength(c.anim).toFixed(4)), okLabel: "Set" });
    const n = parseFloat(v ?? "");
    if (!isFinite(n) || n <= 0 || Math.abs(n - animLength(c.anim)) < 1e-9) return;
    api.commit(setLength(c.doc, { anim: c.name, length: Math.round(n * 10000) / 10000 }), "Change Animation Length");
  };
  const menu = (e: React.MouseEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const items: MenuItem[] = [
      { label: "Add Keyframe", shortcut: "Q", disabled: !hasAnim, run: () => insertKeyAtPlayhead(api) },
      { label: check(autoKey, "Auto-key"), run: () => set({ autoKey: !autoKey }) },
      { label: check(anchor, "Anchor mode (moving a key shifts the whole channel)"), run: () => set({ anchorMode: !anchor }) },
      { label: check(mirrorAnim, "Mirror animating"), disabled: !hasAnim, run: act("Studio.MirrorAnimating") },
      { separator: true, label: "" },
      { label: "Pose Between Frames\u2026", shortcut: "\u2325B", disabled: !hasAnim, run: act("Studio.Breakdown") },
      { label: "Paste with Noise\u2026", shortcut: "\u2318\u2325V", disabled: !hasAnim, run: act("Studio.PasteWithNoise") },
      { label: "Add Noise to Selection\u2026", shortcut: "\u2318\u2325N", disabled: !hasAnim, run: act("Studio.AddNoise") },
      { label: "Snap Keyframes to Ticks", disabled: !hasAnim, run: act("Studio.SnapKeys") },
      { separator: true, label: "" },
      { label: "Set Marker", shortcut: "\u2318M", disabled: !hasAnim, run: act("Studio.AddMarker") },
      { label: "Set Animation Length\u2026", disabled: !hasAnim, run: setLen },
      { label: "Set Animation End to Playhead", shortcut: "\u2318End", disabled: !hasAnim, run: act("Studio.SetAnimationEnd") },
      { label: "Frame All", run: () => window.dispatchEvent(new Event("animstudio:fit")) },
    ];
    showContextMenu(r.right - 250, r.bottom + 2, items);
  };
  return (
    <div className="as-tb">
      <button className="as-btn" disabled={!hasAnim} title={playing ? "Pause (Space)" : "Play (Space)"} onClick={() => set({ playing: !playing })} data-testid="as-play">
        {playing ? <IcPause /> : <IcPlay />}
      </button>
      <button className={"as-btn" + (loop ? " on" : "")} title="Loop preview" onClick={() => set({ loopPreview: !loop })}><IcLoop /></button>
      <span className="as-time" data-testid="as-time">{fmtTime(time)}</span>
      <select className="as-sel" value={speed} title="Playback speed" onChange={(e) => set({ speed: parseFloat(e.target.value) })}>
        {(SPEEDS.includes(speed) ? SPEEDS : [...SPEEDS, speed].sort((a, b) => a - b)).map((s) => <option key={s} value={s}>{s}×</option>)}
      </select>
      {gait && (
        <span className="as-stride" data-testid="as-stride" title={gait === "gait" ? "Stride clip walked by the wall-crawl gait: one clip length per stride, the phase follows distance (CrawlGait.stride). Drag to set the pace, then play." : "Stride clip walked by vanilla's walk cycle: one clip length per stride, the phase follows distance. Drag to set the pace, then play."}>
          <span className="as-hint">Pace</span>
          <input type="range" min={0} max={10} step={0.1} value={strideSpeed} data-testid="as-stride-speed" onChange={(e) => set({ strideSpeed: parseFloat(e.target.value) })} />
          <span className="as-time" data-testid="as-stride-readout">{strideSpeed.toFixed(1)} b/s</span>
          <span className="as-hint" data-testid="as-stride-len">stride {strideBlocks(gait, Math.max(strideSpeed, 0.01)).toFixed(2)} blocks</span>
          <button className="as-btn" title="Reset the walked distance" onClick={() => set({ strideDist: 0 })}>{strideDist.toFixed(1)}m</button>
        </span>
      )}
      <button className={"as-btn" + (snap ? " on" : "")} title="Snap to ticks (20 tps)" onClick={() => set({ snapTicks: !snap })}><IcSnap /></button>
      {autoKey && <button className="as-state" title="Auto-key is on: gizmo edits create keys at the playhead (click to turn off)" onClick={() => set({ autoKey: false })}><i className="rec" />Auto-key</button>}
      {anchor && <button className="as-state" title="Anchor mode is on (click to turn off)" onClick={() => set({ anchorMode: false })}>Anchor</button>}
      {mirrorAnim && <button className="as-state" title="Mirror animating is on (click to turn off)" onClick={act("Studio.MirrorAnimating")}>Mirror</button>}
      <div className="grow" />
      <LiveConstraintsChip />{/* == constraints hook == */}
      <SemanticsChip />
      <ProblemsChip />
      <button className={"as-btn" + (tab === "graph" ? " on" : "")} data-testid="as-tl-graph" title={tab === "graph" ? "Back to Dope Sheet (F3)" : "Graph Editor (F3)"} onClick={() => setTab(tab === "graph" ? "dope" : "graph")}>
        {tab === "graph" ? <IcDope /> : <IcGraph />}
      </button>
      <button className="as-btn" title="More timeline actions" data-testid="as-tl-more" onClick={menu}>{"\u22ef"}</button>
    </div>
  );
}
