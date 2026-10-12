import { formatShortcut } from "../../../lib/platform";
import { memo, useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { useStore } from "../../../lib/store";
import { projectStore } from "../../../lib/project";
import { openFile } from "../../../editor/store";
import { parseAnsi } from "./ansi";
import { findLinks, resolveLinkPath } from "./links";
import { clear, consoleStore, interrupt, isAlive, restart, setShowVars, start, stop, type Entry } from "./session";
import { InputEditor } from "./InputEditor";
import "./console.css";

const Ico = ({ children }: { children: React.ReactNode }) => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">{children}</svg>
);

function openLink(path: string, line: number) {
  const r = projectStore.get().root;
  if (!r) return;
  const abs = resolveLinkPath(path, r.path);
  if (abs) void openFile({ host: r.host, path: abs }, { line, col: 1 });
}

/** One output line with ANSI colours and traceback links. */
function OutLine({ text }: { text: string }) {
  const nodes = useMemo(() => {
    const links = findLinks(text.replace(/\x1b\[[0-9;:?]*[ -/]*[@-~]/g, "")); // eslint-disable-line no-control-regex
    const spans = parseAnsi(text);
    if (!links.length) return spans.map((s, i) => <Span key={i} s={s} />);
    // links are computed on the stripped text; walk spans with a running offset
    const out: React.ReactNode[] = [];
    let off = 0;
    spans.forEach((s, si) => {
      let pos = 0;
      for (const l of links) {
        const a = Math.max(l.start, off) - off;
        const b = Math.min(l.end, off + s.text.length) - off;
        if (b <= a || a < pos) continue;
        if (a > pos) out.push(<Span key={`${si}-${pos}`} s={{ ...s, text: s.text.slice(pos, a) }} />);
        out.push(
          <a key={`${si}-l${a}`} className="pyc-link" data-path={l.path} data-line={l.line} style={style(s)} onClick={() => openLink(l.path, l.line)} title="Open in editor">
            {s.text.slice(a, b)}
          </a>,
        );
        pos = b;
      }
      if (pos < s.text.length) out.push(<Span key={`${si}-t`} s={{ ...s, text: s.text.slice(pos) }} />);
      off += s.text.length;
    });
    return out;
  }, [text]);
  return <div className="pyc-line">{nodes.length ? nodes : "​"}</div>;
}
const style = (s: { fg?: string; bg?: string; bold?: boolean; dim?: boolean; italic?: boolean; underline?: boolean }): React.CSSProperties => ({
  color: s.fg, background: s.bg, fontWeight: s.bold ? 600 : undefined, opacity: s.dim ? 0.7 : undefined, fontStyle: s.italic ? "italic" : undefined, textDecoration: s.underline ? "underline" : undefined,
});
const Span = ({ s }: { s: Parameters<typeof style>[0] & { text: string } }) => <span style={style(s)}>{s.text}</span>;

const EntryView = memo(function EntryView({ e, ipy }: { e: Entry; ipy: boolean }) {
  if (e.kind === "in") {
    return (
      <div className="pyc-in" data-n={e.n}>
        {e.code.split("\n").map((l, i) => (
          <div key={i} className="pyc-in-line">
            <span className="pyc-prompt">{i === 0 ? (ipy ? `In [${e.n}]:` : ">>>") : ipy ? "   ...:" : "..."}</span>
            <span className="pyc-code">{l || "​"}</span>
          </div>
        ))}
      </div>
    );
  }
  if (e.kind === "sys") return <div className={"pyc-sys" + (e.error ? " err" : "")}>{e.text}</div>;
  const lines = e.text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return <div className="pyc-out">{lines.map((l, i) => <OutLine key={i} text={l} />)}</div>;
});

export function ConsolePanel() {
  const st = useStore(consoleStore);
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  useEffect(() => {
    if (consoleStore.get().status === "stopped" && !consoleStore.get().entries.length) void start();
  }, []);
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [st.rev]);

  const alive = st.status !== "stopped";
  return (
    <div
      className="pyc"
      data-status={st.status}
      onKeyDown={(e) => {
        if (e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "c" && !(window.getSelection()?.toString())) { e.preventDefault(); interrupt(); }
      }}
    >
      <div className="pyc-bar">
        <button className="pyc-btn" title="Rerun (restart console)" data-act="restart" onClick={() => void restart()}><Ico><path d="M13 8a5 5 0 1 1-1.8-3.8M13 2.5v3h-3" /></Ico></button>
        <button className="pyc-btn" title="Stop" data-act="stop" disabled={!alive} onClick={() => void stop()}><Ico><rect x="4" y="4" width="8" height="8" rx="1" fill="currentColor" /></Ico></button>
        <button className="pyc-btn" title={`Interrupt (${formatShortcut("⌃C")})`} data-act="interrupt" disabled={st.status !== "busy"} onClick={() => interrupt()}><Ico><path d="M6 3.500v9M10 3.500v9" /></Ico></button>
        <button className="pyc-btn" title="Clear All" data-act="clear" onClick={() => clear()}><Ico><path d="M3 4.500h10M6 4.500V3h4v1.500M4.500 4.500l.7 8h5.600l.7-8M7 7v3.500M9 7v3.500" /></Ico></button>
        <div className="pyc-sep" />
        <button className={"pyc-btn" + (st.showVars ? " on" : "")} title="Show Variables" data-act="vars" onClick={() => setShowVars(!st.showVars)}><Ico><path d="M2 4h12M2 8h12M2 12h12M6 3v10" /></Ico></button>
      </div>
      <div className="pyc-main">
        <div
          className="pyc-transcript"
          ref={scroller}
          onScroll={(e) => {
            const el = e.currentTarget;
            stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
          }}
        >
          {st.entries.map((e) => <EntryView key={e.id} e={e} ipy={st.ipython} />)}
          {st.status === "starting" && <div className="pyc-sys">Starting Python Console…</div>}
        </div>
        <div className="pyc-inputrow">
          <span className="pyc-prompt pyc-inprompt">{st.status === "busy" ? "…" : st.ipython ? `In [${st.n}]:` : ">>>"}</span>
          <InputEditor />
        </div>
        {st.status === "stopped" && st.entries.length > 0 && (
          <div className="pyc-hint">Process stopped. Press Enter to run code in a new console, or click Rerun.</div>
        )}
      </div>
      {st.showVars && (
        <div className="pyc-vars" data-testid="pyc-vars">
          <div className="pyc-vars-head"><span>Name</span><span>Type</span><span>Value</span></div>
          <div className="pyc-vars-body">
            {st.vars.map((v) => (
              <div className="pyc-var" key={v.name} data-name={v.name}>
                <span className="n">{v.name}</span>
                <span className="t">{v.type}</span>
                <span className="v" title={v.repr}>{v.repr}</span>
              </div>
            ))}
            {!st.vars.length && <div className="pyc-empty">{isAlive() ? "No variables yet" : "Console is not running"}</div>}
          </div>
        </div>
      )}
    </div>
  );
}
