/** The Debug tool window: session tabs, left toolbar, "Debugger" (Frames | Variables | Watches) and "Console" tabs. */
import { memo, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { useStore } from "../../../lib/store";
import { openFile } from "../../../editor/store";
import { keysFor } from "../../../actions/keymap";
import { formatKeystroke } from "../../../actions/keystroke";
import { showContextMenu } from "../../shell/contextMenu";
import { addWatch, bpStore, removeWatch, replaceWatch, watchStore } from "./bps";
import { ops } from "./ops";
import { parseAnsi, splitLinks, shortValue, type Span } from "./pure";
import { debugStore, type DebugSession, type Frame, type OutChunk, type SessionState } from "./session";
import { ResultNode, ScopeNode, useExpander, VarProvider, VarNode } from "./VarTree";
import "./debug.css";

const Svg = ({ children, c }: { children: ReactNode; c?: string }) => (
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" className={c}>{children}</svg>
);
const I = {
  rerun: <Svg c="g"><path d="M13 8a5 5 0 1 1-1.6-3.7" /><path d="M13 2.5v3h-3" /></Svg>,
  resume: <Svg c="g"><path d="M4.5 3v10" /><path d="M7.5 3l6 5-6 5z" fill="currentColor" /></Svg>,
  pause: <Svg c="b"><path d="M5.5 3.5v9M10.5 3.5v9" strokeWidth="2" /></Svg>,
  stop: <Svg c="r"><rect x="3.5" y="3.5" width="9" height="9" rx="1" fill="currentColor" /></Svg>,
  bps: <Svg c="r"><circle cx="5" cy="5" r="2.5" fill="currentColor" /><circle cx="10" cy="10.5" r="2.5" fill="currentColor" /></Svg>,
  mute: <Svg c="r"><circle cx="7.5" cy="8" r="3.6" fill="currentColor" /><path d="M2.5 13.5l11-11" stroke="currentColor" strokeWidth="1.6" /></Svg>,
  point: <Svg><circle cx="8" cy="8" r="3" /><path d="M8 1.5v2.5M8 12v2.5M1.5 8H4M12 8h2.5" /></Svg>,
  over: <Svg c="b"><path d="M2.5 10.5a5.5 5.5 0 0 1 11 0" /><path d="M11 8l2.5 2.5L16 8" /><circle cx="8" cy="12.5" r="1.2" fill="currentColor" /></Svg>,
  into: <Svg c="b"><path d="M8 2v8.5M4.5 7.5L8 11l3.5-3.5" /><circle cx="8" cy="13.5" r="1.2" fill="currentColor" /></Svg>,
  force: <Svg c="b"><path d="M8 2v8.5M4.5 7.5L8 11l3.5-3.5" /><path d="M3 14h10" /></Svg>,
  out: <Svg c="b"><path d="M8 11.5V3M4.5 6L8 2.5 11.5 6" /><circle cx="8" cy="13.5" r="1.2" fill="currentColor" /></Svg>,
  cursor: <Svg c="b"><path d="M3.5 2.5l9 4.5-4 1.2-1.2 4z" /></Svg>,
};

const keyHint = (id: string) => { const k = keysFor(id)[0]; return k ? ` (${formatKeystroke(k)})` : ""; };

function Btn({ icon, title, action, onClick, disabled, on }: { icon: ReactNode; title: string; action?: string; onClick: () => void; disabled?: boolean; on?: boolean }) {
  return <button className={"dbg-btn" + (on ? " on" : "")} title={title + (action ? keyHint(action) : "")} disabled={disabled} onMouseDown={(e) => e.preventDefault()} onClick={onClick}>{icon}</button>;
}

export default function DebugWindow() {
  const { sessions, activeId } = useStore(debugStore);
  const s = sessions.find((x) => x.id === activeId) ?? sessions[sessions.length - 1] ?? null;
  return (
    <div className="dbg" tabIndex={0} data-autofocus data-dbg-window>
      {sessions.length > 0 && (
        <div className="dbg-tabs">
          {sessions.map((x) => <SessionTab key={x.id} s={x} on={x === s} />)}
        </div>
      )}
      {s ? <SessionView key={s.id} s={s} /> : <Empty />}
    </div>
  );
}

function Empty() {
  return (
    <div className="dbg-main">
      <div className="dbg-side">
        <Btn icon={I.bps} title="View Breakpoints" action="ViewBreakpoints" onClick={ops.viewBreakpoints} />
      </div>
      <div className="dbg-empty">No debug session is running. Debug a run configuration with {formatKeystroke(keysFor("Debug")[0] ?? "control D")} or the toolbar button.</div>
    </div>
  );
}

function SessionTab({ s, on }: { s: DebugSession; on: boolean }) {
  const st = useStore(s.store);
  return (
    <div className={"dbg-stab" + (on ? " on" : "")} data-session={s.id} onMouseDown={() => ops.select(s.id)}>
      <span className={"st " + st.status} />
      <span>{st.title}</span>
      <span className="x" title="Close" onMouseDown={(e) => e.stopPropagation()} onClick={() => void ops.closeSession(s)}>×</span>
    </div>
  );
}

function SessionView({ s }: { s: DebugSession }) {
  const st = useStore(s.store);
  const { muted } = useStore(bpStore);
  const [tab, setTab] = useState<"debugger" | "console">("debugger");
  const paused = st.status === "paused";
  const statusText =
    st.status === "starting" ? "Connecting to the debugger…" :
    st.status === "running" ? "Running" :
    st.status === "ended" ? (st.exitCode != null ? `Process finished with exit code ${st.exitCode}` : "Finished") :
    st.exception ? `${st.exception.type}${st.exception.message ? ": " + st.exception.message : ""}` :
    st.stopReason === "breakpoint" ? "Paused at breakpoint" : st.stopReason === "step" ? "Paused" : `Paused (${st.stopReason ?? "paused"})`;
  return (
    <div className="dbg-main">
      <div className="dbg-side">
        <Btn icon={I.rerun} title="Rerun" action="Rerun" onClick={() => void ops.rerun(s)} />
        <Btn icon={I.resume} title="Resume Program" action="Resume" disabled={!paused} onClick={() => void ops.resume()} />
        <Btn icon={I.pause} title="Pause Program" disabled={st.status !== "running"} onClick={() => void ops.pause()} />
        <Btn icon={I.stop} title="Stop" action="Stop" disabled={!s.live} onClick={() => void s.stop()} />
        <div className="dbg-sep" />
        <Btn icon={I.bps} title="View Breakpoints" action="ViewBreakpoints" onClick={ops.viewBreakpoints} />
        <Btn icon={I.mute} title="Mute Breakpoints" on={muted} onClick={ops.toggleMute} />
      </div>
      <div className="dbg-content">
        <div className="dbg-sub">
          <span className={"tab" + (tab === "debugger" ? " on" : "")} data-tab="debugger" onMouseDown={() => setTab("debugger")}>Debugger</span>
          <span className={"tab" + (tab === "console" ? " on" : "")} data-tab="console" onMouseDown={() => setTab("console")}>Console</span>
          <span className="bar" />
          <Btn icon={I.point} title="Show Execution Point" action="ShowExecutionPoint" disabled={!paused} onClick={ops.showExecutionPoint} />
          <Btn icon={I.over} title="Step Over" action="StepOver" disabled={!paused} onClick={() => void ops.stepOver()} />
          <Btn icon={I.into} title="Step Into" action="StepInto" disabled={!paused} onClick={() => void ops.stepInto()} />
          <Btn icon={I.force} title="Force Step Into" action="ForceStepInto" disabled={!paused} onClick={() => void ops.forceStepInto()} />
          <Btn icon={I.out} title="Step Out" action="StepOut" disabled={!paused} onClick={() => void ops.stepOut()} />
          <Btn icon={I.cursor} title="Run to Cursor" action="RunToCursor" disabled={!paused} onClick={() => void ops.runToCursor()} />
          <span className={"status" + (st.exception ? " exc" : "")}>{statusText}</span>
        </div>
        {tab === "debugger" ? <DebuggerTab s={s} st={st} /> : <ConsoleView s={s} st={st} />}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- Debugger tab
function DebuggerTab({ s, st }: { s: DebugSession; st: SessionState }) {
  const ex = useExpander();
  const wex = useExpander();
  const paused = st.status === "paused";
  return (
    <VarProvider s={s} ex={ex}>
      <div className="dbg-panels">
        <div className="dbg-panel" style={{ width: "30%" }} data-panel="frames"><FramesPanel s={s} st={st} /></div>
        <div className="dbg-panel" style={{ flex: 1 }} data-panel="variables">
          <div className="dbg-panel-head">Variables</div>
          <div className="dbg-list">
            {!paused ? <div className="dbg-empty">Variables are not available</div> : st.scopes.length === 0 ? <div className="dbg-empty">Loading…</div> : (
              <>
                {st.scopes.map((sc, i) => (i > 1 || (i === 1 && st.frames[st.frameIdx]?.name === "<module>")) ? null : <ScopeNode key={st.frameIdx + sc.name} name={sc.name} vref={sc.ref} flat={i === 0} />)}
              </>
            )}
          </div>
        </div>
        <div className="dbg-panel" style={{ width: "30%" }} data-panel="watches">
          <VarProvider s={s} ex={wex}><WatchesPanel s={s} st={st} /></VarProvider>
        </div>
      </div>
    </VarProvider>
  );
}

function FramesPanel({ s, st }: { s: DebugSession; st: SessionState }) {
  const paused = st.status === "paused";
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    void s.selectFrame(Math.min(Math.max(0, st.frameIdx + (e.key === "ArrowDown" ? 1 : -1)), st.frames.length - 1));
  };
  return (
    <>
      <div className="dbg-panel-head">
        {st.threads.length > 1 ? (
          <select value={st.threadId ?? ""} disabled={!paused} onChange={(e) => void s.selectThread(Number(e.target.value))}>
            {st.threads.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
        ) : <span>Frames{st.threads[0] ? ` · ${st.threads[0].name}` : ""}</span>}
      </div>
      <div className="dbg-list" tabIndex={0} onKeyDown={onKey}>
        {!paused ? <div className="dbg-empty">Frames are not available</div> : st.frames.map((f, i) => <FrameRow key={f.id} f={f} i={i} sel={i === st.frameIdx} s={s} />)}
      </div>
    </>
  );
}

function FrameRow({ f, i, sel, s }: { f: Frame; i: number; sel: boolean; s: DebugSession }) {
  const file = f.path ? f.path.slice(f.path.lastIndexOf("/") + 1) : "";
  const dim = f.hint === "subtle" || f.hint === "deemphasize" || !f.path;
  return (
    <div className={"dbg-row dbg-frame" + (sel ? " sel" : "") + (dim ? " dim" : "") + (i === 0 ? " top" : "")} data-frame={i} onClick={() => void s.selectFrame(i)} title={f.path ?? undefined}>
      <span className="fn">{f.name}</span>
      {file && <span className="loc">{file}:{f.line}</span>}
    </div>
  );
}

function WatchesPanel({ s, st }: { s: DebugSession; st: SessionState }) {
  const { list } = useStore(watchStore);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [sel, setSel] = useState<string | null>(null);
  const done = (old: string | null, v: string) => {
    setAdding(false); setEditing(null);
    if (old == null) addWatch(v); else replaceWatch(old, v);
    void s.refreshWatches();
  };
  return (
    <>
      <div className="dbg-panel-head">
        <span className="grow">Watches</span>
        <button className="add" title="Add Watch" onClick={() => setAdding(true)}>+</button>
        <button className="add" title="Remove Watch" disabled={!sel} onClick={() => { if (sel) { removeWatch(sel); setSel(null); } }}>−</button>
      </div>
      <div className="dbg-list" tabIndex={0} onKeyDown={(e) => { if ((e.key === "Backspace" || e.key === "Delete") && sel && !editing) { removeWatch(sel); setSel(null); } }}>
        {list.map((expr) => {
          if (editing === expr) return <WatchInput key={expr} initial={expr} onDone={(v) => done(expr, v)} />;
          const r = st.watchResults[expr];
          return (
            <div key={expr} className={"dbg-watch"} data-watch={expr} onMouseDown={() => setSel(expr)} onDoubleClick={() => setEditing(expr)}
              onContextMenu={(e) => { e.preventDefault(); showContextMenu(e.clientX, e.clientY, [{ label: "Edit", run: () => setEditing(expr) }, { label: "Remove Watch", run: () => removeWatch(expr) }]); }}>
              {st.status !== "paused" || !r ? (
                <div className={"dbg-row dbg-var" + (sel === expr ? " sel" : "")}><span className="chev" /><span className="ic w">w</span><span className="nm">{expr}</span><span className="eq">=</span><span className="va" style={{ color: "var(--fg-dim)" }}>{st.status === "paused" ? "…" : "not available"}</span></div>
              ) : <ResultNode name={expr} value={r.value} type={r.type} vref={r.ref} error={r.error} path={`w:${expr}`} />}
            </div>
          );
        })}
        {adding && <WatchInput initial="" onDone={(v) => done(null, v)} />}
        {!list.length && !adding && <div className="dbg-empty">No watches. Press + to add one.</div>}
      </div>
    </>
  );
}

function WatchInput({ initial, onDone }: { initial: string; onDone: (v: string) => void }) {
  const [v, setV] = useState(initial);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => { ref.current?.focus(); ref.current?.select(); }, []);
  return (
    <input ref={ref} className="dbg-input" style={{ width: "calc(100% - 12px)" }} value={v} placeholder="Expression" spellCheck={false}
      onChange={(e) => setV(e.target.value)} onBlur={() => onDone(v.trim() ? v : "")}
      onKeyDown={(e) => { e.stopPropagation(); if (e.key === "Enter") onDone(v); else if (e.key === "Escape") onDone(""); }} />
  );
}

// ---------------------------------------------------------------- Console tab
// props are immutable strings (the chunk objects are appended to in place), so memo skips every chunk that did not grow
const ChunkView = memo(function ChunkView({ kind, d, cwd, host }: { kind: OutChunk["s"]; d: string; cwd: string; host: string }) {
  const text = d.length > 300_000 ? "…" + d.slice(-300_000) : d;
  const { spans } = parseAnsi(text);
  return <>{spans.map((sp, i) => <SpanView key={i} sp={sp} cls={kind} cwd={cwd} host={host} />)}</>;
});

function SpanView({ sp, cls, cwd, host }: { sp: Span; cls: string; cwd: string; host: string }) {
  const style = sp.fg || sp.bg || sp.bold || sp.dim || sp.italic || sp.underline
    ? { color: sp.fg, background: sp.bg, fontWeight: sp.bold ? 600 : undefined, opacity: sp.dim ? 0.7 : undefined, fontStyle: sp.italic ? "italic" : undefined, textDecoration: sp.underline ? "underline" : undefined } : undefined;
  const parts = splitLinks(sp.t);
  return (
    <span className={cls} style={style}>
      {parts.map((p, i) => p.path ? (
        <a key={i} data-link={`${p.path}:${p.line}`} onClick={() => void openFile({ host, path: p.path!.startsWith("/") ? p.path! : `${cwd}/${p.path}` }, { line: p.line, col: 1 })}>{p.t}</a>
      ) : p.t)}
    </span>
  );
}

function ConsoleView({ s, st }: { s: DebugSession; st: SessionState }) {
  const box = useRef<HTMLPreElement>(null);
  const stick = useRef(true);
  const [tick, setTick] = useState(0);
  // coalesce bursts of output into one render per frame
  useEffect(() => {
    const id = requestAnimationFrame(() => setTick(st.outRev));
    return () => cancelAnimationFrame(id);
  }, [st.outRev]);
  useLayoutEffect(() => {
    const b = box.current;
    if (b && stick.current) b.scrollTop = b.scrollHeight;
  }, [tick]);
  const [stdin, setStdin] = useState("");
  const [repl, setRepl] = useState("");
  const [hist, setHist] = useState<string[]>([]);
  return (
    <div className="dbg-console" data-console>
      <pre ref={box} className="dbg-out" data-out onScroll={(e) => { const b = e.currentTarget; stick.current = b.scrollHeight - b.scrollTop - b.clientHeight < 40; }}>
        {s.out.map((c, i) => <ChunkView key={i} kind={c.s} d={c.d} cwd={s.target.cwd} host={s.target.host} />)}
      </pre>
      <div className="dbg-inputs">
        <div className="line">
          <span>stdin</span>
          <input className="dbg-input" data-stdin disabled={!s.live} value={stdin} placeholder="Type input for the program and press Enter" spellCheck={false}
            onChange={(e) => setStdin(e.target.value)}
            onKeyDown={(e) => { e.stopPropagation(); if (e.key === "Enter") { const t = stdin; setStdin(""); s.print("sys", t + "\n"); void s.write(t + "\n"); } }} />
        </div>
        <div className="line">
          <span>eval</span>
          <input className="dbg-input" data-repl disabled={st.status !== "paused"} value={repl} placeholder={st.status === "paused" ? "Evaluate an expression in the selected frame and press Enter" : "Available while paused"} spellCheck={false}
            onChange={(e) => setRepl(e.target.value)}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === "Enter" && repl.trim()) { const t = repl; setHist((h) => [...h, t]); setRepl(""); void s.repl(t); }
              else if (e.key === "ArrowUp" && hist.length) { e.preventDefault(); setRepl(hist[hist.length - 1]); }
            }} />
        </div>
      </div>
    </div>
  );
}

// re-exported for the tool window registration
export { VarNode, shortValue };
