import { useEffect, useMemo, useRef, useState } from "react";
import { animLength, breakdown, insertBreakdown, insertPushRelax, pushRelax, type Animation, type BreakdownOptions, type Doc, type Pose } from "../../core";
import { useStudio, type StudioApi } from "../state";
import { toolsStore, useToolsUi } from "../toolsUi";
import { allKeyTimes, r4, snapTick, surroundingTimes } from "../timeline/layout";
import { cur, playheadTime } from "../timeline/ops";
import { useStudioSel } from "../timeline/hooks";
import { IcClose } from "../timeline/icons";
import { ensureStyles } from "../timeline/styles";

export type BreakdownMode = "between" | "pushrelax";
export interface BreakdownSetup { tA: number; tB: number }

/** Default A/B: the two selected keys' times; else the keys surrounding the playhead (of the scoped bones); else clip ends. */
export function defaultAB(anim: Animation, keyTimes: readonly number[], bones: readonly string[] | undefined, playhead: number): BreakdownSetup {
  const distinct = [...new Set(keyTimes.map((t) => r4(t)))].sort((a, b) => a - b);
  if (distinct.length === 2) return { tA: distinct[0], tB: distinct[1] };
  const times = allKeyTimes(anim, bones && bones.length ? bones : undefined);
  const { a, b } = surroundingTimes(times, playhead);
  const len = animLength(anim);
  return { tA: a ?? Math.max(0, Math.min(playhead, times[0] ?? 0)), tB: b ?? (times.length ? times[times.length - 1] : len) };
}

export function breakdownPose(doc: Doc, anim: string, mode: BreakdownMode, o: BreakdownOptions, amount: number, t: number, push: number): Pose | null {
  try {
    return mode === "between" ? breakdown(doc, anim, { ...o, factor: amount }) : pushRelax(doc, anim, { bones: o.bones, t, amount: push });
  } catch {
    return null;
  }
}

const num = (t: string) => { const v = parseFloat(t); return Number.isFinite(v) ? v : null; };

export function BreakdownPanel() {
  const api = useStudio();
  ensureStyles();
  const ui = useToolsUi(api);
  if (!ui.breakdownOpen) return null;
  return <BreakdownBody api={api} />;
}

function BreakdownBody({ api }: { api: StudioApi }) {
  const doc = useStudioSel((s) => s.doc);
  const animName = useStudioSel((s) => s.anim);
  const time = useStudioSel((s) => s.time);
  const bonesSel = useStudioSel((s) => s.bones);
  const rootRef = useRef<HTMLDivElement>(null);
  const [mode, setMode] = useState<BreakdownMode>("between");
  const [factor, setFactor] = useState(0.5);
  const [push, setPush] = useState(0);
  const [follow, setFollow] = useState(false);
  const [scope, setScope] = useState<"selected" | "all">(bonesSel.length ? "selected" : "all");
  const [ab, setAb] = useState<BreakdownSetup>(() => {
    const c = cur(api);
    const s = api.store.get();
    return c ? defaultAB(c.anim, s.keys.map((k) => k.time), s.bones, s.time) : { tA: 0, tB: 1 };
  });
  const [tAText, setTAText] = useState<string | null>(null);
  const [tBText, setTBText] = useState<string | null>(null);
  const [at, setAt] = useState<"playhead" | "custom">("playhead");
  const [atText, setAtText] = useState("0");

  const bones = scope === "selected" && bonesSel.length ? bonesSel : undefined;
  const insertTime = at === "playhead" ? (() => { const c = cur(api); return c ? playheadTime(api, c.anim) : time; })() : (num(atText) ?? time);
  const opts: BreakdownOptions = { bones, tA: ab.tA, tB: ab.tB, factor, followCurve: follow };
  const valid = !!doc && !!animName && (mode === "pushrelax" || Math.abs(ab.tA - ab.tB) > 1e-4);

  const pose = useMemo(
    () => (doc && animName && valid ? breakdownPose(doc, animName, mode, opts, factor, mode === "pushrelax" ? time : insertTime, push) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [doc, animName, mode, ab.tA, ab.tB, factor, follow, bones?.join("|"), push, time, insertTime, valid],
  );
  useEffect(() => { api.store.set({ previewPose: pose }); }, [api, pose]);
  useEffect(() => () => { api.store.set({ previewPose: null }); }, [api]);
  useEffect(() => { rootRef.current?.focus({ preventScroll: true }); }, []);

  const close = () => { api.store.set({ previewPose: null }); toolsStore(api).set({ breakdownOpen: false }); };
  const commit = () => {
    const c = cur(api);
    if (!c || !valid) return;
    try {
      if (mode === "between") {
        const t = at === "playhead" ? playheadTime(api, c.anim) : r4(num(atText) ?? time);
        api.commit(insertBreakdown(c.doc, c.name, opts, t), "Pose Between Frames");
        api.store.set({ time: t });
      } else {
        api.commit(insertPushRelax(c.doc, c.name, { bones, t: playheadTime(api, c.anim), amount: push }), push >= 0 ? "Push Pose" : "Relax Pose");
      }
    } finally { close(); }
  };
  const commitRef = useRef(commit); commitRef.current = commit;
  const closeRef = useRef(close); closeRef.current = close;

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      const t = e.target as HTMLElement | null;
      if (t?.closest?.(".monaco-editor")) return;
      const inside = !!t?.closest?.(".as-float");
      const typing = !inside && !!t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT");
      if (e.key === "Escape" && !typing) { e.preventDefault(); closeRef.current(); }
      else if (e.key === "Enter" && inside && (t as HTMLElement).tagName !== "BUTTON") { e.preventDefault(); commitRef.current(); }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, []);

  const setFromPlayhead = (which: "A" | "B") => { const t = snapTick(time); setAb((p) => (which === "A" ? { ...p, tA: t } : { ...p, tB: t })); };
  const pct = Math.round((mode === "between" ? factor : push) * 100);
  const [lo, hi, step] = mode === "between" ? [-0.5, 1.5, 0.01] : [-1, 1, 0.01];
  const val = mode === "between" ? factor : push;
  const setVal = (v: number) => (mode === "between" ? setFactor(v) : setPush(v));
  // emphasized track: 0..1 for breakdown, -1..0..1 whole for push/relax
  const e0 = mode === "between" ? (0 - lo) / (hi - lo) : 0;
  const e1 = mode === "between" ? (1 - lo) / (hi - lo) : 1;

  return (
    <div className="as-float" ref={rootRef} tabIndex={-1} data-testid="as-breakdown" style={{ outline: "none" }}>
      <div className="hd">
        <span>Pose Between Frames</span>
        <button className="as-btn" title="Cancel (Esc)" onClick={close}><IcClose /></button>
      </div>
      <div className="bd">
        <div className="as-seg" style={{ alignSelf: "flex-start" }}>
          <button className={mode === "between" ? "on" : ""} onClick={() => setMode("between")}>Breakdown</button>
          <button className={mode === "pushrelax" ? "on" : ""} onClick={() => setMode("pushrelax")}>Push / Relax</button>
        </div>
        {mode === "between" && (
          <>
            <div className="as-row">
              <label style={{ width: 22 }}>A</label>
              <input className="as-in num" style={{ width: 70 }} data-testid="as-bd-a" value={tAText ?? String(ab.tA)} onChange={(e) => { setTAText(e.target.value); const v = num(e.target.value); if (v !== null && v >= 0) setAb((p) => ({ ...p, tA: v })); }} onBlur={() => setTAText(null)} />
              <button className="as-btn" title="Set A to playhead" onClick={() => setFromPlayhead("A")}>◂ playhead</button>
              <label style={{ width: 22, textAlign: "right" }}>B</label>
              <input className="as-in num" style={{ width: 70 }} data-testid="as-bd-b" value={tBText ?? String(ab.tB)} onChange={(e) => { setTBText(e.target.value); const v = num(e.target.value); if (v !== null && v >= 0) setAb((p) => ({ ...p, tB: v })); }} onBlur={() => setTBText(null)} />
              <button className="as-btn" title="Set B to playhead" onClick={() => setFromPlayhead("B")}>◂</button>
            </div>
            {Math.abs(ab.tA - ab.tB) <= 1e-4 && <div className="as-hint" style={{ color: "var(--nord13)" }}>A and B are the same time: pick two different frames.</div>}
          </>
        )}
        {mode === "pushrelax" && <div className="as-hint">Exaggerates (push) or softens (relax) the pose at the playhead relative to its neighbouring keys.</div>}
        <div className="as-row">
          <div style={{ position: "relative", flex: 1, height: 22, display: "flex", alignItems: "center" }}>
            <div style={{ position: "absolute", left: 0, right: 0, height: 4, borderRadius: 2, background: "var(--bg-input)" }} />
            <div style={{ position: "absolute", left: `${e0 * 100}%`, width: `${(e1 - e0) * 100}%`, height: 4, borderRadius: 2, background: "var(--accent-bg)" }} />
            <input
              className="as-slider" type="range" min={lo} max={hi} step={step} value={val} data-testid="as-bd-slider"
              style={{ position: "relative", width: "100%", background: "transparent" }}
              onChange={(e) => setVal(parseFloat(e.target.value))}
              onDoubleClick={() => setVal(mode === "between" ? 0.5 : 0)}
            />
          </div>
          <span className="as-pct" data-testid="as-bd-pct">{pct}%</span>
        </div>
        {mode === "between" && (
          <div className="as-hint" style={{ display: "flex", justifyContent: "space-between", marginTop: -4 }}>
            <span>−50%</span><span>A (0)</span><span>B (100%)</span><span>150%</span>
          </div>
        )}
        {mode === "between" && (
          <label className="as-chk"><input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} /> Follow curve (use B&apos;s easing)</label>
        )}
        <div className="as-row">
          <label style={{ width: 40 }}>Bones</label>
          <div className="as-seg">
            <button className={scope === "selected" ? "on" : ""} disabled={!bonesSel.length} onClick={() => setScope("selected")} title={bonesSel.length ? bonesSel.join(", ") : "Select bones first"}>Selected ({bonesSel.length})</button>
            <button className={scope === "all" || !bonesSel.length ? "on" : ""} onClick={() => setScope("all")}>All animated</button>
          </div>
        </div>
        {mode === "between" && (
          <div className="as-row">
            <label style={{ width: 40 }}>Insert</label>
            <div className="as-seg">
              <button className={at === "playhead" ? "on" : ""} onClick={() => setAt("playhead")}>At playhead</button>
              <button className={at === "custom" ? "on" : ""} onClick={() => { setAt("custom"); setAtText(String(insertTime)); }}>At time</button>
            </div>
            {at === "custom" && <input className="as-in num" style={{ width: 64 }} value={atText} onChange={(e) => setAtText(e.target.value)} />}
          </div>
        )}
        <div className="as-hint">{Object.keys(pose ?? {}).length} bone(s) previewed · live in the viewport</div>
      </div>
      <div className="ft">
        <button className="as-btn" onClick={close}>Cancel</button>
        <button className="as-btn primary" disabled={!valid || !pose} onClick={commit} data-testid="as-bd-commit">Commit</button>
      </div>
    </div>
  );
}
