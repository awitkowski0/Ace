/** Modal dialogs of the debugger: View Breakpoints (list + condition/log/pass count + exception breakpoints) and Evaluate Expression. */
import { useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "../../../lib/store";
import { openFile } from "../../../editor/store";
import { projectStore } from "../../../lib/project";
import { closePopup, openPopup, registerPopup, type PopupProps } from "../../shell/popups";
import { addWatch, bpStore, removeBreakpoint, setExceptionBreakpoints, updateBreakpoint, type Bp } from "./bps";
import { pausedSession, type DebugSession, type EvalResult } from "./session";
import { ResultNode, useExpander, VarProvider } from "./VarTree";
import "./debug.css";

const base = (p: string) => p.slice(p.lastIndexOf("/") + 1);
const rel = (p: string) => { const r = projectStore.get().root?.path; return r && p.startsWith(r + "/") ? p.slice(r.length + 1) : p; };

function Shell({ title, width, height, children, onClose }: { title: string; width: number; height?: number; children: React.ReactNode; onClose: () => void }) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); onClose(); } };
    window.addEventListener("keydown", h, true);
    return () => window.removeEventListener("keydown", h, true);
  }, [onClose]);
  return (
    <div className="dbg-dialog-bg" onMouseDown={onClose}>
      <div className="dbg-dialog" style={{ width, height }} onMouseDown={(e) => e.stopPropagation()} data-dialog={title}>
        <div className="dbg-dialog-title">{title}</div>
        {children}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- Breakpoints
type Sel = { kind: "bp"; id: string } | { kind: "exc" } | null;

function BreakpointsDialog({ onClose, props }: PopupProps) {
  const { list, exceptions } = useStore(bpStore);
  const initial = (props as { select?: string } | undefined)?.select;
  const [sel, setSel] = useState<Sel>(initial ? { kind: "bp", id: initial } : list[0] ? { kind: "bp", id: list[0].id } : { kind: "exc" });
  const sorted = useMemo(() => [...list].sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line), [list]);
  const cur = sel?.kind === "bp" ? list.find((b) => b.id === sel.id) : undefined;
  return (
    <Shell title="Breakpoints" width={720} height={420} onClose={onClose}>
      <div className="dbg-dialog-body" style={{ minHeight: 0 }}>
        <div className="dbg-bpl">
          <div className="dbg-bpl-tools">
            <button className="dbg-btn" title="Remove" disabled={!cur} onClick={() => { if (cur) { const i = sorted.indexOf(cur); removeBreakpoint(cur.id); const n = sorted[i + 1] ?? sorted[i - 1]; setSel(n ? { kind: "bp", id: n.id } : { kind: "exc" }); } }}>−</button>
          </div>
          <div className="dbg-bpl-list">
            <div className="dbg-bpl-grp">Line Breakpoints</div>
            {sorted.map((b) => (
              <div key={b.id} className={"dbg-row" + (sel?.kind === "bp" && sel.id === b.id ? " sel" : "")} data-bp-row={`${base(b.path)}:${b.line}`}
                onClick={() => setSel({ kind: "bp", id: b.id })} onDoubleClick={() => { void openFile({ host: projectStore.get().root?.host ?? "local", path: b.path }, { line: b.line, col: 1 }); onClose(); }}>
                <input type="checkbox" checked={b.enabled} onChange={(e) => updateBreakpoint(b.id, { enabled: e.target.checked })} onClick={(e) => e.stopPropagation()} />
                <span className={"dot" + (b.enabled ? "" : " off")} />
                <span className="fl">{base(b.path)}</span><span className="ln">:{b.line}</span>
              </div>
            ))}
            {!sorted.length && <div className="dbg-empty" style={{ padding: "4px 12px" }}>No line breakpoints</div>}
            <div className="dbg-bpl-grp">Python Exception Breakpoints</div>
            <div className={"dbg-row" + (sel?.kind === "exc" ? " sel" : "")} data-bp-row="exceptions" onClick={() => setSel({ kind: "exc" })}>
              <input type="checkbox" checked={exceptions.raised || exceptions.uncaught || exceptions.userUnhandled}
                onChange={(e) => setExceptionBreakpoints(e.target.checked ? { uncaught: true } : { raised: false, uncaught: false, userUnhandled: false })} onClick={(e) => e.stopPropagation()} />
              <span className="dot" /><span className="fl">Any exception</span>
            </div>
          </div>
        </div>
        <div className="dbg-form">
          {cur ? <LineForm key={cur.id} b={cur} /> : sel?.kind === "exc" ? (
            <>
              <div className="dbg-sec" style={{ marginTop: 0 }}>Break on</div>
              <label><input type="checkbox" data-exc="raised" checked={exceptions.raised} onChange={(e) => setExceptionBreakpoints({ raised: e.target.checked })} /> Raised exceptions (every exception, even if caught)</label>
              <label><input type="checkbox" data-exc="uncaught" checked={exceptions.uncaught} onChange={(e) => setExceptionBreakpoints({ uncaught: e.target.checked })} /> Uncaught exceptions (terminate the program)</label>
              <label><input type="checkbox" data-exc="userUnhandled" checked={exceptions.userUnhandled} onChange={(e) => setExceptionBreakpoints({ userUnhandled: e.target.checked })} /> User-unhandled exceptions (not handled in your code)</label>
              <div className="hint">Library code is skipped unless “Just my code” is turned off.</div>
            </>
          ) : <div className="dbg-empty">Select a breakpoint</div>}
        </div>
      </div>
      <div className="dbg-dialog-foot"><button className="primary" onClick={onClose} autoFocus>Done</button></div>
    </Shell>
  );
}

function LineForm({ b }: { b: Bp }) {
  const [cond, setCond] = useState(b.condition ?? "");
  const [log, setLog] = useState(b.logMessage ?? "");
  const [hits, setHits] = useState(b.hitCount ?? "");
  const save = (patch: Partial<Bp>) => updateBreakpoint(b.id, patch);
  return (
    <>
      <div style={{ color: "var(--fg-dim)", fontSize: 12 }}>{rel(b.path)}:{b.line}</div>
      <label><input type="checkbox" data-f="enabled" checked={b.enabled} onChange={(e) => save({ enabled: e.target.checked })} /> Enabled</label>
      <label className="fld">Condition
        <input className="dbg-input" data-f="condition" value={cond} spellCheck={false} placeholder="e.g. i == 3" onChange={(e) => setCond(e.target.value)} onBlur={() => save({ condition: cond })} onKeyDown={(e) => { e.stopPropagation(); if (e.key === "Enter") save({ condition: cond }); }} />
      </label>
      <label className="fld">Evaluate and log
        <input className="dbg-input" data-f="log" value={log} spellCheck={false} placeholder="message, {expressions} in braces" onChange={(e) => setLog(e.target.value)} onBlur={() => save({ logMessage: log })} onKeyDown={(e) => { e.stopPropagation(); if (e.key === "Enter") save({ logMessage: log }); }} />
      </label>
      <label className="fld">Pass count
        <input className="dbg-input" data-f="hits" value={hits} spellCheck={false} placeholder="stop on the Nth hit, e.g. 3 or >5" onChange={(e) => setHits(e.target.value)} onBlur={() => save({ hitCount: hits })} onKeyDown={(e) => { e.stopPropagation(); if (e.key === "Enter") save({ hitCount: hits }); }} />
      </label>
    </>
  );
}

export function openBreakpointsDialog(select?: string) {
  registerPopup("DebugBreakpoints", BreakpointsDialog);
  openPopup("DebugBreakpoints", { select });
}

// ---------------------------------------------------------------- Evaluate Expression
function EvaluateDialog({ onClose, props }: PopupProps) {
  const [expr, setExpr] = useState((props as { expression?: string } | undefined)?.expression ?? "");
  const [res, setRes] = useState<{ expr: string; r: EvalResult } | null>(null);
  const [s] = useState<DebugSession | null>(() => pausedSession());
  const ex = useExpander();
  const ta = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { ta.current?.focus(); ta.current?.select(); }, []);
  const run = async () => {
    const e = expr.trim();
    if (!e || !s) return;
    setRes({ expr: e, r: await s.evaluate(e, e.includes("\n") ? "repl" : "watch") });
  };
  useEffect(() => { if (expr.trim() && s) void run(); /* evaluate the preset selection immediately like IntelliJ */ }, []);
  return (
    <Shell title="Evaluate" width={640} height={440} onClose={onClose}>
      <div className="dbg-dialog-body" style={{ flexDirection: "column", gap: 6, minHeight: 0 }}>
        <div className="dbg-sec" style={{ marginTop: 0 }}>Expression:</div>
        <textarea ref={ta} className="dbg-input dbg-eval-in" data-eval-in rows={3} value={expr} spellCheck={false}
          placeholder="Enter an expression (Enter evaluates, ⇧Enter adds a line)"
          onChange={(e) => setExpr(e.target.value)}
          onKeyDown={(e) => { e.stopPropagation(); if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void run(); } }} />
        <div className="dbg-sec">Result:</div>
        <div className="dbg-eval-res" data-eval-res>
          {!s ? <div className="dbg-empty">The program is not paused</div> : res ? (
            <VarProvider s={s} ex={ex}><ResultNode name="result" value={res.r.value} type={res.r.type} vref={res.r.ref} error={res.r.error} path="r" /></VarProvider>
          ) : null}
        </div>
      </div>
      <div className="dbg-dialog-foot">
        <button onClick={() => { if (expr.trim()) { addWatch(expr.trim()); void s?.refreshWatches(); } }} disabled={!expr.trim()}>Add to Watches</button>
        <button onClick={onClose}>Close</button>
        <button className="primary" data-eval-go onClick={() => void run()} disabled={!s}>Evaluate</button>
      </div>
    </Shell>
  );
}

export function openEvaluateDialog(expression = "") {
  registerPopup("DebugEvaluate", EvaluateDialog);
  openPopup("DebugEvaluate", { expression });
}
export { closePopup };
