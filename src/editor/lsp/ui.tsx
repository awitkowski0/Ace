/** Problems + Usages tool windows, status widget, File Structure and Intentions popups. No monaco imports. */
import { isWithin, relativeTo } from "../../lib/paths";
import { useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "../../lib/store";
import { basename } from "../../lib/ipc";
import { projectStore } from "../../lib/project";
import { editorStore } from "../store";
import { activeEditor } from "../editorRegistry";
import { PopupShell, type PopupProps } from "../../components/shell/popups";
import { showToolWindow } from "../../lib/layout";
import { showContextMenu } from "../../components/shell/contextMenu";
import { runProblems } from "../../components/run/problems";
import { diagStore, godotPaused, lspSettings, setAutoGodot, statusStore, usagesStore, type Diag } from "./state";
import { activeDoc, activeServerId, lsp } from "./api";
import { openAt } from "./navigate";
import { SERVER_LABEL } from "./servers";
import type { SymbolRow, Intention } from "./manager";

const COLORS = { 1: "var(--nord11)", 2: "var(--nord13)", 3: "var(--nord8)", 4: "var(--fg-faint)" } as const;
export function SevIcon({ sev }: { sev: 1 | 2 | 3 | 4 }) {
  const c = COLORS[sev];
  return (
    <svg className="lsp-sev" viewBox="0 0 16 16" fill="none" stroke={c} strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
      {sev === 2 ? <path d="M8 2l6.2 11H1.8zM8 6.5v3.2M8 11.6v.1" /> : sev === 1 ? <path d="M8 1.8a6.2 6.2 0 1 0 0 12.4A6.2 6.2 0 0 0 8 1.8zM5.7 5.7l4.6 4.6M10.3 5.7l-4.6 4.6" /> : <path d="M8 1.8a6.2 6.2 0 1 0 0 12.4A6.2 6.2 0 0 0 8 1.8zM8 7.2v4M8 4.9v.1" />}
    </svg>
  );
}

const relPath = (p: string, root?: string) => (root && isWithin(root, p) ? relativeTo(root, p) : p);

interface Row { kind: "file" | "item"; path: string; title?: string; text: string; sub?: string; sev?: 1 | 2 | 3 | 4; range?: Diag["range"]; count?: number }

function List({ rows, empty }: { rows: Row[]; empty: string }) {
  const [sel, setSel] = useState(-1);
  const ref = useRef<HTMLDivElement>(null);
  const items = rows.map((r, i) => (r.kind === "item" ? i : -1)).filter((i) => i >= 0);
  const go = (r: Row) => { if (r.path) void openAt(r.path, r.range); };
  if (!rows.length) return <div className="lsp-empty" tabIndex={0} data-autofocus>{empty}</div>;
  return (
    <div
      className="lsp-list" tabIndex={0} data-autofocus ref={ref}
      onKeyDown={(e) => {
        const at = items.indexOf(sel);
        if (e.key === "ArrowDown" || e.key === "ArrowUp") {
          e.preventDefault();
          const n = items[Math.max(0, Math.min(items.length - 1, at + (e.key === "ArrowDown" ? 1 : -1)))];
          setSel(n);
          ref.current?.querySelector(`[data-i="${n}"]`)?.scrollIntoView({ block: "nearest" });
        } else if (e.key === "Enter" && rows[sel]) go(rows[sel]);
      }}
    >
      {rows.map((r, i) =>
        r.kind === "file" ? (
          <div key={i} className="lsp-file"><span>{r.title ?? basename(r.path)}</span><span className="dim">{r.sub}</span><span className="dim">{r.count}</span></div>
        ) : (
          <div key={i} data-i={i} className={"lsp-row" + (i === sel ? " selected" : "")} onClick={() => { setSel(i); go(r); }}>
            {r.sev && <SevIcon sev={r.sev} />}
            <span className="msg">{r.text}</span>
            {r.sub && <span className="dim">{r.sub}</span>}
          </div>
        ),
      )}
    </div>
  );
}

function sortDiags(a: Diag, b: Diag) {
  return a.severity - b.severity || a.range.start.line - b.range.start.line || a.range.start.character - b.range.start.character;
}
const diagRow = (d: Diag): Row => ({
  kind: "item", path: d.uri, text: d.message.split("\n")[0], sev: d.severity, range: d.range,
  sub: `${d.source ?? ""}${d.code !== undefined ? " " + d.code : ""} :${d.range.start.line + 1}:${d.range.start.character + 1}`.trim(),
});

export function ProblemsPanel() {
  const { byUri } = useStore(diagStore);
  const { root } = useStore(projectStore);
  const { servers } = useStore(statusStore);
  useStore(editorStore);
  const sid = activeServerId();
  const sst = sid ? servers[sid] : undefined;
  const [tab, setTab] = useState<"file" | "project" | "run">("file");
  const { runs } = useStore(runProblems);
  const runTotal = runs.reduce((n, r) => n + r.items.length, 0);
  const cur = activeDoc()?.loc.path;
  // hint-level results (grey "unnecessary code" fading) only decorate the editor; they are not problems
  const shown = (l: Diag[]) => l.filter((d) => d.severity <= 3);
  const curDiags = cur ? shown(byUri[cur] ?? []) : [];
  const total = useMemo(() => Object.values(byUri).reduce((n, l) => n + shown(l).length, 0), [byUri]);
  const rows = useMemo<Row[]>(() => {
    // errors and warnings parsed from run output (Godot), grouped by run
    if (tab === "run") {
      return [...runs].reverse().filter((r) => r.items.length).flatMap((r) => [
        { kind: "file", path: r.name, title: r.name, text: "", sub: "", count: r.items.length } as Row,
        ...r.items.map((p): Row => ({
          kind: "item", path: p.path ?? "", text: p.message.split("\n")[0], sev: p.sev,
          range: p.path ? { start: { line: p.line - 1, character: p.col - 1 }, end: { line: p.line - 1, character: p.col - 1 } } : undefined,
          sub: p.path ? `${basename(p.path)}:${p.line}${p.detail ? "  " + p.detail : ""}` : p.detail,
        })),
      ]);
    }
    if (tab === "file") return [...curDiags].sort(sortDiags).map(diagRow);
    return Object.entries(byUri).map(([p, l]) => [p, shown(l)] as const).filter(([, l]) => l.length).sort(([a], [b]) => a.localeCompare(b)).flatMap(([p, l]) => [
      { kind: "file", path: p, text: "", sub: relPath(p, root?.path), count: l.length } as Row,
      ...[...l].sort(sortDiags).map(diagRow),
    ]);
  }, [tab, byUri, cur, root, runs]);
  return (
    <div className="lsp-panel">
      <div className="lsp-tabs">
        <span className={"lsp-tab" + (tab === "file" ? " active" : "")} onClick={() => setTab("file")}>Current File {curDiags.length || ""}</span>
        <span className={"lsp-tab" + (tab === "project" ? " active" : "")} onClick={() => setTab("project")}>Project Errors {total || ""}</span>
        {(runTotal > 0 || tab === "run") && <span className={"lsp-tab" + (tab === "run" ? " active" : "")} data-testid="problems-run-tab" onClick={() => setTab("run")}>Run {runTotal || ""}</span>}
      </div>
      {sst?.state === "unavailable" && sst.action && (
        <div className="lsp-notice" data-testid="lsp-install-notice">
          <span>{sst.hint}: no language server was found for {SERVER_LABEL[sid!] ?? sid}, so only linter results are shown.</span>
          <button onClick={sst.action}>{sst.actionLabel ?? sst.hint}</button>
        </div>
      )}
      <div style={{ flex: 1, minHeight: 0 }}>
        <List rows={rows} empty={tab === "file" ? "No problems found in the current file" : tab === "run" ? "No errors or warnings in run output" : "No problems reported by language servers"} />
      </div>
    </div>
  );
}

export function UsagesPanel() {
  const { title, items, busy } = useStore(usagesStore);
  const { root } = useStore(projectStore);
  const rows = useMemo<Row[]>(() => {
    const out: Row[] = [];
    let last = "", fileIdx = -1;
    for (const it of items) {
      const p = it.loc.uri;
      if (p !== last) { last = p; fileIdx = out.push({ kind: "file", path: p, text: "", sub: relPath(p, root?.path), count: 0 }) - 1; }
      out[fileIdx].count!++;
      out.push({ kind: "item", path: p, text: it.line, sub: `:${it.loc.range.start.line + 1}`, range: it.loc.range });
    }
    return out;
  }, [items, root]);
  return (
    <div className="lsp-panel">
      <div className="lsp-tabs"><span className="lsp-tab active">{title || "Usages"} {items.length ? `(${items.length})` : ""}</span></div>
      <div style={{ flex: 1, minHeight: 0 }}><List rows={rows} empty={busy ? "Searching…" : "No usages found"} /></div>
    </div>
  );
}

export function InspectionWidget() {
  const { byUri } = useStore(diagStore);
  const { servers } = useStore(statusStore);
  useStore(editorStore);
  useStore(lspSettings);
  const { paused } = useStore(godotPaused);
  const d = activeDoc();
  const sid = activeServerId();
  if (!d || !sid) return null;
  const st = servers[sid];
  const ds = byUri[d.loc.path] ?? [];
  const errs = ds.filter((x) => x.severity === 1).length;
  const warns = ds.filter((x) => x.severity === 2).length;
  const label = SERVER_LABEL[sid] ?? sid;
  const menu = (e: React.MouseEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const auto = lspSettings.get().autoGodot;
    showContextMenu(r.left, r.top - 90, [
      { label: "Retry connection", run: () => lsp.retry() },
      ...(sid === "godot" ? [{ label: `${auto ? "\u2713" : "\u2003"} Auto-start headless Godot`, run: () => setAutoGodot(!auto) }] : []),
      { label: "Show Problems", run: () => showToolWindow("problems") },
    ]);
  };
  if (st?.state === "unavailable" && st.action) {
    return <span className="sb-item sb-lsp warn" data-testid="lsp-install-hint" title={st.actionLabel ?? st.hint} onClick={st.action}>{st.hint}</span>;
  }
  if (st?.state === "waiting") {
    return <span className="sb-item sb-lsp warn" title="Click for options" onClick={menu}>{st.hint}</span>;
  }
  if (st?.state === "starting") return <span className="sb-item sb-lsp" onClick={menu}>Starting {label} language server…</span>;
  if (st?.state === "error") return <span className="sb-item sb-lsp warn" title={st.hint}>{label} language server failed</span>;
  if (st?.state !== "ready") return null;
  if (sid === "godot" && paused) {
    return <span className="sb-item sb-lsp" title="Headless Godot is suspended while idle; it resumes on the next request" onClick={menu}>{label}: paused</span>;
  }
  return (
    <span className="sb-item sb-lsp" title={`${label} language server`} onClick={menu}>
      {st.progress && <span className="dim" style={{ color: "var(--fg-dim)" }}>{st.progress}</span>}
      {errs > 0 && <span className="n"><SevIcon sev={1} />{errs}</span>}
      {warns > 0 && <span className="n"><SevIcon sev={2} />{warns}</span>}
      {errs === 0 && warns === 0 && <span style={{ color: "var(--nord14)" }}>✓</span>}
    </span>
  );
}

/** F2 / Shift+F2: jump to next/previous error or warning in the current file (wraps). */
export function gotoProblem(dir: 1 | -1) {
  const ed = activeEditor();
  const m = ed?.getModel();
  const pos = ed?.getPosition();
  if (!ed || !m || !pos) return;
  const ds = (diagStore.get().byUri[m.uri.path] ?? []).filter((d) => d.severity <= 2)
    .sort((a, b) => a.range.start.line - b.range.start.line || a.range.start.character - b.range.start.character);
  if (!ds.length) return;
  const key = (l: number, c: number) => l * 100000 + c;
  const cur = key(pos.lineNumber - 1, pos.column - 1);
  const pick = dir === 1
    ? (ds.find((d) => key(d.range.start.line, d.range.start.character) > cur) ?? ds[0])
    : ([...ds].reverse().find((d) => key(d.range.start.line, d.range.start.character) < cur) ?? ds[ds.length - 1]);
  ed.setPosition({ lineNumber: pick.range.start.line + 1, column: pick.range.start.character + 1 });
  ed.revealPositionInCenterIfOutsideViewport({ lineNumber: pick.range.start.line + 1, column: pick.range.start.character + 1 });
  ed.focus();
}

// ---------- popups ----------
const KIND_CHAR = ["", "F", "M", "N", "P", "C", "m", "p", "f", "c", "E", "I", "ƒ", "v", "K", "s", "n", "b", "a", "o", "k", "e", "e", "S", "E", "O", "T"];
const KIND_COLOR: Record<string, string> = { C: "var(--nord13)", I: "var(--nord14)", E: "var(--nord15)", m: "var(--nord9)", ƒ: "var(--nord9)", f: "var(--nord12)", p: "var(--nord12)", v: "var(--nord8)" };

function Chooser<T>({ items, filter, render, onPick, onClose, placeholder, width }: {
  items: T[]; filter?: (t: T, q: string) => boolean; render: (t: T) => React.ReactNode; onPick: (t: T) => void;
  onClose: () => void; placeholder?: string; width: number;
}) {
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const shown = useMemo(() => (filter && q ? items.filter((t) => filter(t, q.toLowerCase())) : items), [items, q, filter]);
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => { list.current?.querySelector(".selected")?.scrollIntoView({ block: "nearest" }); }, [sel]);
  return (
    <PopupShell onClose={onClose} width={width} height={Math.min(420, 90 + shown.length * 24)}>
      {filter && (
        <input
          className="popup-input" autoFocus placeholder={placeholder} value={q}
          onChange={(e) => { setQ(e.target.value); setSel(0); }}
          onKeyDown={(e) => onKey(e)}
        />
      )}
      {!filter && <div tabIndex={0} autoFocus ref={(el) => el?.focus()} onKeyDown={(e) => onKey(e)} style={{ outline: "none", height: 6 }} />}
      <div className="popup-list" ref={list}>
        {shown.map((t, i) => (
          <div key={i} className={"popup-row" + (i === sel ? " selected" : "")} onMouseMove={() => setSel(i)} onClick={() => { onPick(t); onClose(); }}>{render(t)}</div>
        ))}
      </div>
    </PopupShell>
  );
  function onKey(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown") { e.preventDefault(); setSel((s) => Math.min(shown.length - 1, s + 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setSel((s) => Math.max(0, s - 1)); }
    else if (e.key === "Enter" && shown[sel]) { e.preventDefault(); onPick(shown[sel]); onClose(); }
  }
}

export function FileStructurePopup({ onClose, props }: PopupProps) {
  const rows = (props as SymbolRow[]) ?? [];
  return (
    <Chooser
      items={rows} width={520} onClose={onClose} placeholder="Type to filter file structure"
      filter={(r, q) => r.name.toLowerCase().includes(q)}
      onPick={(r) => {
        const ed = activeEditor();
        ed?.setPosition({ lineNumber: r.line, column: r.col });
        ed?.revealLineInCenter(r.line);
      }}
      render={(r) => {
        const ch = KIND_CHAR[r.kind] ?? "?";
        return (<>
          <span style={{ width: r.depth * 14 }} />
          <span className="lsp-kind" style={{ background: KIND_COLOR[ch] ?? "var(--nord9)" }}>{ch}</span>
          <span style={{ marginLeft: 6 }}>{r.name}</span>
          {r.detail && <span className="dim" style={{ marginLeft: 8, color: "var(--fg-faint)" }}>{r.detail}</span>}
        </>);
      }}
    />
  );
}

export function IntentionsPopup({ onClose, props }: PopupProps) {
  const items = (props as Intention[]) ?? [];
  return (
    <Chooser items={items} width={420} onClose={onClose} onPick={(a) => { a.run().catch((e) => console.error(e)); }} render={(a) => <span>{a.title}</span>} />
  );
}
