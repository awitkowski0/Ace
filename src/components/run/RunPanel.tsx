import { formatShortcut } from "../../lib/platform";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useStore } from "../../lib/store";
import { CloseIcon } from "../shell/icons";
import { Console } from "./Console";
import { ClassIcon, RerunIcon, ScrollEndIcon, StopIcon, TrashIcon, WrapIcon, RunningIcon } from "./icons";
import { clearSession, closeSession, getSession, rerunSession, scheduleRender, sessionStore, stopSession, writeStdin, type Session } from "./sessions";
import { typeOf } from "./configs";
import { TestsView } from "./TestsView";
import { confirmDialog } from "../shell/dialogs";
import { OutcomeIcon } from "./TestsView";

interface View { wrap: boolean; follow: boolean; tab: "tests" | "console" }
const views = new Map<string, View>();
const viewOf = (id: string): View => { let v = views.get(id); if (!v) views.set(id, (v = { wrap: false, follow: true, tab: "tests" })); return v; };

function statusIcon(s: Session) {
  if (s.status !== "finished") return <RunningIcon />;
  if (s.tests) {
    const bad = s.tests.root.counts.failed + s.tests.root.counts.error > 0;
    return <OutcomeIcon o={bad ? "failed" : "passed"} />;
  }
  const ok = s.exit?.display === 0;
  return <OutcomeIcon o={ok ? "passed" : s.stopRequested ? "skipped" : "failed"} />;
}

function Tab({ s, active }: { s: Session; active: boolean }) {
  useSyncExternalStore(sessionStore.subscribe, () => sessionStore.get().rev);
  return (
    <div className={"run-tab" + (active ? " active" : "") + (s.status !== "finished" ? " running" : "")} data-session={s.id} data-status={s.status} title={s.commandLine || s.name}
      onMouseDown={(e) => { if (e.button === 1) { e.preventDefault(); void closeSession(s); } else sessionStore.set({ activeId: s.id }); }}>
      <span className="run-tab-icon">{typeOf(s.cfg)?.icon ?? <ClassIcon />}</span>
      <span className="run-tab-name">{s.name}</span>
      <span className="run-tab-state">{statusIcon(s)}</span>
      <button className="run-tab-close" title="Close" onMouseDown={(e) => e.stopPropagation()} onClick={() => void closeSession(s)}><CloseIcon /></button>
    </div>
  );
}

function StdinRow({ s }: { s: Session }) {
  const [v, setV] = useState("");
  const ref = useRef<HTMLInputElement>(null);
  const open = s.status === "running" && s.stdinOpen;
  if (!open) return null;
  return (
    <div className="run-stdin">
      <span className="run-stdin-prompt">›</span>
      <input ref={ref} data-autofocus data-stdin className="run-stdin-input" value={v} spellCheck={false} placeholder="Type input and press Enter (⌃D closes stdin)" onChange={(e) => setV(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") { e.preventDefault(); const t = v; setV(""); void writeStdin(s, t); }
          else if (e.key === "c" && e.ctrlKey) { e.preventDefault(); stopSession(s); }
        }} />
    </div>
  );
}

function MissingBanner({ s }: { s: Session }) {
  const m = s.missing;
  if (!m || s.status !== "finished") return null;
  return (
    <div className="run-banner">
      <span>{m.message}</span>
      <button className="gbtn primary" onClick={async () => {
        if (!(await confirmDialog({ title: `Install ${m.name}`, message: m.detail, okLabel: "Install" }))) return;
        s.missing = null;
        sessionStore.set((x) => ({ rev: x.rev + 1 }));
        s.buf.sys(`\nInstalling ${m.name}…\n`);
        const ok = await m.install((t) => { s.buf.sys(t); scheduleRender(s); });
        if (ok) await rerunSession(s);
      }}>Install {m.name}</button>
    </div>
  );
}

export function RunPanel() {
  const { list, activeId } = useStore(sessionStore);
  useSyncExternalStore(sessionStore.subscribe, () => sessionStore.get().rev);
  const [, force] = useState(0);
  const s = getSession(activeId) ?? list[list.length - 1] ?? null;
  const v = s ? viewOf(s.id) : null;
  useEffect(() => { if (s && s.id !== activeId) sessionStore.set({ activeId: s.id }); }, [s, activeId]);
  if (!s || !v) {
    return (
      <div className="run-panel">
        <div className="run-empty-all">Nothing has been run yet.<div className="sub">Run a configuration with ⌃R, or Run Context Configuration with ⌃⇧R.</div></div>
      </div>
    );
  }
  const rerender = () => force((x) => x + 1);
  const showTests = !!s.tests && v.tab === "tests";
  return (
    <div className="run-panel" data-toolwindow-inner="run">
      <div className="run-tabs">
        {list.map((x) => <Tab key={x.id} s={x} active={x === s} />)}
      </div>
      <div className="run-main">
        <div className="run-vbar">
          <button className="icon-btn sm" title={`Rerun (${formatShortcut("⌘R")})`} data-act="rerun" onClick={() => void rerunSession(s)}><RerunIcon /></button>
          <button className="icon-btn sm" title={`Stop (${formatShortcut("⌘F2")})`} data-act="stop" disabled={s.status === "finished"} onClick={() => stopSession(s)}><StopIcon /></button>
          <span className="run-vsep" />
          <button className={"icon-btn sm" + (v.follow ? " on" : "")} title="Scroll to the End" data-act="scroll-end" onClick={() => { v.follow = true; rerender(); }}><ScrollEndIcon /></button>
          <button className={"icon-btn sm" + (v.wrap ? " on" : "")} title="Soft-Wrap" data-act="soft-wrap" onClick={() => { v.wrap = !v.wrap; rerender(); }}><WrapIcon /></button>
          <button className="icon-btn sm" title="Clear All" data-act="clear" onClick={() => clearSession(s)}><TrashIcon /></button>
        </div>
        <div className="run-content">
          {s.tests && (
            <div className="run-subtabs">
              <button className={"run-subtab" + (showTests ? " active" : "")} data-act="tab-tests" onClick={() => { v.tab = "tests"; rerender(); }}>Test Results</button>
              <button className={"run-subtab" + (!showTests ? " active" : "")} data-act="tab-console" onClick={() => { v.tab = "console"; rerender(); }}>Console</button>
            </div>
          )}
          <MissingBanner s={s} />
          <div className="run-body">
            {showTests ? <TestsView key={s.id + ":" + s.startedAt} session={s} wrap={v.wrap} follow={v.follow} onFollow={(f) => { v.follow = f; rerender(); }} /> : (
              <Console key={s.id} session={s} wrap={v.wrap} follow={v.follow} onFollow={(f) => { if (v.follow !== f) { v.follow = f; rerender(); } }} />
            )}
          </div>
          <StdinRow s={s} />
        </div>
      </div>
    </div>
  );
}

