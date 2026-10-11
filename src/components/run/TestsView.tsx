import { useEffect, useMemo, useRef, useState } from "react";
import { openAt } from "./openAt";
import { showContextMenu } from "../shell/contextMenu";
import { Console, LinkedText } from "./Console";
import { CollapseAllIcon, ErrorIcon, ExpandAllIcon, FailIcon, FilterPassed, FilterSkipped, ClassIcon, ModuleIcon, PassIcon, PendingIcon, RerunIcon, RunningIcon, SkipIcon, SortIcon } from "./icons";
import { ensureConfig, typeOf } from "./configs";
import { rerunFailed, startRun, type Session } from "./sessions";
import { fmtDuration, flatten, nodeOutcome, type Outcome, type Row, type TestModel, type TestNode } from "./testModel";
import { relPath } from "./util";
import { projectStore } from "../../lib/project";

/** Re-render when the model changes, at most once per frame. */
function useModelRev(m: TestModel) {
  const [, setN] = useState(0);
  useEffect(() => {
    let q = false;
    const tick = () => { if (q) { q = false; setN((x) => x + 1); } };
    const un = m.subscribe(() => {
      if (q) return;
      q = true;
      requestAnimationFrame(tick);
      setTimeout(tick, 100);
    });
    setN((x) => x + 1);
    return () => { un(); q = false; };
  }, [m]);
}

export const OutcomeIcon = ({ o }: { o: Outcome }) =>
  o === "passed" || o === "xpassed" ? <PassIcon /> : o === "failed" ? <FailIcon /> : o === "error" ? <ErrorIcon /> : o === "skipped" || o === "xfailed" ? <SkipIcon /> : o === "running" ? <RunningIcon /> : <PendingIcon />;

const ROW_H = 24;

export interface TestsUi {
  showPassed: boolean; showSkipped: boolean; alpha: boolean;
  collapsed: Set<string>; sel: string | null; split: number;
}
const uiBySession = new Map<string, TestsUi>();
const uiOf = (id: string): TestsUi => {
  let u = uiBySession.get(id);
  if (!u) uiBySession.set(id, (u = { showPassed: true, showSkipped: true, alpha: false, collapsed: new Set(), sel: null, split: 0.42 }));
  return u;
};
export const testsUiOf = uiOf;

export async function jumpToSource(s: Session, n: TestNode) {
  if (n.kind === "root") return;
  let file = n.file || n.id.split("::")[0];
  if (!file) return;
  // collected items carry absolute paths; module / result paths are relative to pytest's rootdir (= project root or the run cwd)
  if (!file.startsWith("/")) file = `${(projectStore.get().root?.path ?? s.cwd).replace(/\/$/, "")}/${file}`;
  await openAt({ host: s.host, path: file }, n.kind === "test" && n.line ? n.line : 1, 1);
}

async function runNode(s: Session, n: TestNode, mode: "run" | "debug") {
  const t = typeOf(s.cfg);
  if (!t?.forTestNodes) return;
  const { id: _id, ...variant } = t.forTestNodes(s.cfg, [n.id]);
  void _id;
  const stored = ensureConfig(variant);
  await startRun(stored.id, mode);
}

export function TestsView({ session, wrap, follow, onFollow }: { session: Session; wrap: boolean; follow: boolean; onFollow: (f: boolean) => void }) {
  const model = session.tests!;
  useModelRev(model);
  const ui = uiOf(session.id);
  const [, force] = useState(0);
  const redraw = () => force((x) => x + 1);
  const rows = flatten(model, ui);
  const listRef = useRef<HTMLDivElement>(null);
  const [view, setView] = useState({ top: 0, h: 300 });
  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setView((v) => ({ ...v, h: el.clientHeight })));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const selNode = ui.sel ? model.find(ui.sel) : null;
  const selIdx = selNode ? rows.findIndex((r) => r.node === selNode) : -1;
  const first = Math.max(0, Math.floor(view.top / ROW_H) - 3);
  const last = Math.min(rows.length, Math.ceil((view.top + view.h) / ROW_H) + 3);
  const select = (key: string | null) => { ui.sel = key; redraw(); };
  const toggle = (n: TestNode, open?: boolean) => {
    const isOpen = !ui.collapsed.has(n.key);
    if (open === undefined) open = !isOpen;
    if (open) ui.collapsed.delete(n.key); else ui.collapsed.add(n.key);
    redraw();
  };
  const scrollIntoView = (i: number) => {
    const el = listRef.current;
    if (!el) return;
    if (i * ROW_H < el.scrollTop) el.scrollTop = i * ROW_H;
    else if ((i + 1) * ROW_H > el.scrollTop + el.clientHeight) el.scrollTop = (i + 1) * ROW_H - el.clientHeight;
  };
  const onKey = (e: React.KeyboardEvent) => {
    const i = selIdx;
    const go = (j: number) => { const r = rows[Math.max(0, Math.min(rows.length - 1, j))]; if (r) { select(r.node.key); scrollIntoView(rows.indexOf(r)); } };
    if (e.key === "ArrowDown") { go(i + 1); e.preventDefault(); }
    else if (e.key === "ArrowUp") { go(i - 1); e.preventDefault(); }
    else if (e.key === "ArrowRight" && selNode?.children.length) { if (ui.collapsed.has(selNode.key)) toggle(selNode, true); else go(i + 1); e.preventDefault(); }
    else if (e.key === "ArrowLeft" && selNode) {
      if (selNode.children.length && !ui.collapsed.has(selNode.key)) toggle(selNode, false);
      else if (selNode.parent) { select(selNode.parent.key); scrollIntoView(rows.findIndex((r) => r.node === selNode.parent)); }
      e.preventDefault();
    } else if ((e.key === "Enter" || e.key === "F4") && selNode) { void jumpToSource(session, selNode); e.preventDefault(); }
    else if (e.key === "Home") { go(0); e.preventDefault(); }
    else if (e.key === "End") { go(rows.length - 1); e.preventDefault(); }
  };
  const menu = (e: React.MouseEvent, n: TestNode) => {
    e.preventDefault();
    select(n.key);
    const name = n.kind === "root" ? "all tests" : `'${n.name}'`;
    showContextMenu(e.clientX, e.clientY, [
      { label: `Run ${name}`, run: () => void runNode(session, n.kind === "root" ? model.root : n, "run"), disabled: n.kind === "root" },
      { label: `Debug ${name}`, run: () => void runNode(session, n, "debug"), disabled: n.kind === "root" },
      { separator: true, label: "" },
      { label: "Jump to Source", shortcut: "F4", run: () => void jumpToSource(session, n), disabled: n.kind === "root" },
    ]);
  };

  // split drag
  const wrapRef = useRef<HTMLDivElement>(null);
  const drag = (e: React.MouseEvent) => {
    e.preventDefault();
    const box = wrapRef.current!.getBoundingClientRect();
    const mv = (m: MouseEvent) => { ui.split = Math.max(0.15, Math.min(0.8, (m.clientX - box.left) / box.width)); redraw(); };
    const up = () => { window.removeEventListener("mousemove", mv); window.removeEventListener("mouseup", up); };
    window.addEventListener("mousemove", mv);
    window.addEventListener("mouseup", up);
  };

  const failed = model.failedIds().length;
  const c = model.root.counts;
  const pct = Math.round(model.progress() * 100);
  const bad = c.failed + c.error > 0;
  return (
    <div className="tests-view" ref={wrapRef}>
      <div className="tests-left" style={{ width: `${ui.split * 100}%` }}>
        <div className="tests-bar">
          <button className="icon-btn sm" title="Rerun Failed Tests" disabled={!failed || session.status !== "finished"} onClick={() => void rerunFailed(session)} data-act="rerun-failed"><RerunIcon /></button>
          <span className="gsep" />
          <button className={"icon-btn sm" + (ui.showPassed ? " on" : "")} title="Show Passed" onClick={() => { ui.showPassed = !ui.showPassed; redraw(); }} data-act="show-passed"><FilterPassed /></button>
          <button className={"icon-btn sm" + (ui.showSkipped ? " on" : "")} title="Show Ignored" onClick={() => { ui.showSkipped = !ui.showSkipped; redraw(); }} data-act="show-skipped"><FilterSkipped /></button>
          <button className={"icon-btn sm" + (ui.alpha ? " on" : "")} title="Sort Alphabetically" onClick={() => { ui.alpha = !ui.alpha; redraw(); }} data-act="sort-alpha"><SortIcon /></button>
          <span className="gsep" />
          <button className="icon-btn sm" title="Expand All" onClick={() => { ui.collapsed.clear(); redraw(); }} data-act="expand-all"><ExpandAllIcon /></button>
          <button className="icon-btn sm" title="Collapse All" onClick={() => { for (const r of flatten(model, { ...ui, collapsed: new Set() })) if (r.node.children.length && r.node.kind !== "root") ui.collapsed.add(r.node.key); redraw(); }} data-act="collapse-all"><CollapseAllIcon /></button>
        </div>
        <div className={"tests-status" + (bad ? " bad" : "")} data-testid="tests-status">
          <span className="tests-status-text">{model.statusText()}</span>
          <div className="tests-progress"><div className={bad ? "bad" : ""} style={{ width: `${pct}%` }} /></div>
        </div>
        <div className="tests-list" ref={listRef} tabIndex={0} data-autofocus onKeyDown={onKey} onScroll={(e) => setView((v) => ({ ...v, top: (e.target as HTMLElement).scrollTop }))}>
          <div style={{ height: rows.length * ROW_H, position: "relative" }}>
            {rows.slice(first, last).map((r, k) => (
              <TestRow key={r.node.key} row={r} y={(first + k) * ROW_H} selected={r.node === selNode} onSelect={() => select(r.node.key)} onToggle={() => toggle(r.node)} onOpen={() => void jumpToSource(session, r.node)} onMenu={(e) => menu(e, r.node)} />
            ))}
          </div>
        </div>
      </div>
      <div className="tests-split" onMouseDown={drag} />
      <div className="tests-right">
        {selNode && selNode.kind === "test" ? <TestDetail node={selNode} session={session} /> : <Console session={session} wrap={wrap} follow={follow} onFollow={onFollow} />}
      </div>
    </div>
  );
}

function TestRow({ row, y, selected, onSelect, onToggle, onOpen, onMenu }: { row: Row; y: number; selected: boolean; onSelect: () => void; onToggle: () => void; onOpen: () => void; onMenu: (e: React.MouseEvent) => void }) {
  const n = row.node;
  const o = nodeOutcome(n);
  const label = n.kind === "root" ? "Test Results" : n.name;
  return (
    <div className={"grow-row test-row" + (selected ? " selected" : "")} style={{ position: "absolute", top: y, left: 0, right: 0, paddingLeft: 6 + row.depth * 14 }} data-key={n.key} data-outcome={o} data-kind={n.kind}
      onMouseDown={onSelect} onDoubleClick={onOpen} onContextMenu={onMenu}>
      <span className="gchev" onMouseDown={(e) => { e.stopPropagation(); if (n.children.length) { onSelect(); onToggle(); } }}>{n.children.length ? (row.expanded ? "▾" : "▸") : ""}</span>
      <span className="gicon"><OutcomeIcon o={o} /></span>
      {n.kind === "module" && <span className="gicon"><ModuleIcon /></span>}
      {n.kind === "class" && <span className="gicon"><ClassIcon /></span>}
      <span className="gname">{label}</span>
      {n.kind !== "root" && n.counts.total > 0 && <span className="gdim">{n.counts.total} tests</span>}
      <span className="grow" />
      <span className="gdim test-dur">{n.kind === "test" ? (o === "pending" || o === "running" ? "" : fmtDuration(n.duration)) : n.counts.duration ? fmtDuration(n.counts.duration) : ""}</span>
    </div>
  );
}

function TestDetail({ node, session }: { node: TestNode; session: Session }) {
  const o = node.outcome;
  const sections = useMemo(() => node.output, [node.output]);
  return (
    <div className="test-detail" data-testid="test-detail">
      <div className="test-detail-head">
        <OutcomeIcon o={o} />
        <b>{node.name}</b>
        <span className="gdim">{o}{node.duration ? ` · ${fmtDuration(node.duration)}` : ""}</span>
        <span className="grow" />
        <span className="gdim">{node.file ? relPath(projectStore.get().root?.path ?? "", node.file) : ""}{node.line ? `:${node.line}` : ""}</span>
      </div>
      <div className="test-detail-body">
        {node.message && <div className={"test-msg" + (o === "failed" || o === "error" ? " bad" : "")}>{node.message}</div>}
        {node.longrepr && <LinkedText text={node.longrepr} host={session.host} cwd={session.cwd} />}
        {sections && <><div className="test-sec">Output</div><LinkedText text={sections} host={session.host} cwd={session.cwd} /></>}
        {!node.message && !node.longrepr && !sections && <div className="run-empty">{o === "pending" || o === "running" ? "Waiting for the result…" : "No output."}</div>}
      </div>
    </div>
  );
}
