import { useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "../../lib/store";
import { projectStore, projectKey } from "../../lib/project";
import { runAction } from "../../actions/registry";
import { keysFor } from "../../actions/keymap";
import { formatKeystroke } from "../../actions/keystroke";
import { showContextMenu } from "../shell/contextMenu";
import { promptDialog } from "../shell/dialogs";
import { ChevronDown, ChevronRight, PinIcon } from "../shell/icons";
import type { ToolWindowProps } from "../../toolwindows/registry";
import { gradleStore, reloadGradle } from "./model";
import { allContainers, visibleRows, type Row } from "./tree";
import { createRunConfiguration, editPinArgs, gradleUi, isPinned, movePin, pinTask, runTask, unpinAt, unpinTask, usePins } from "./ops";
import { CollapseAllIcon, ExecIcon, ExpandAllIcon, GradleIcon, ReloadIcon, TaskIcon } from "./icons";
import { repoConfigStore } from "../../lib/repoConfig";
import "./gradle.css";

const OPEN_DEFAULT = ["pinned", "proj::", "tasks::"];
const storeKey = () => { const r = projectStore.get().root; return r ? `atelier.gradle.open.${projectKey(r)}` : null; };
function loadOpen(): Set<string> {
  try { const k = storeKey(); const v = k && localStorage.getItem(k); if (v) return new Set(JSON.parse(v) as string[]); } catch { /* ignore */ }
  return new Set(OPEN_DEFAULT);
}
let openLoaded = "";
export function ensureOpen() {
  const k = storeKey() ?? "";
  if (openLoaded !== k) { openLoaded = k; gradleUi.set({ open: loadOpen(), selected: null }); }
}
function setOpen(open: Set<string>) {
  gradleUi.set((s) => ({ open, rev: s.rev + 1 }));
  try { const k = storeKey(); if (k) localStorage.setItem(k, JSON.stringify([...open])); } catch { /* ignore */ }
}
export function toggleRow(id: string, force?: boolean) {
  const o = new Set(gradleUi.get().open);
  const want = force ?? !o.has(id);
  if (want) o.add(id); else o.delete(id);
  setOpen(o);
}
export const expandAll = () => setOpen(new Set([...gradleUi.get().open, ...allContainers(gradleStore.get().model, [])]));
export const collapseAll = () => setOpen(new Set());

export function openMenu(x: number, y: number, row: Row) {
  gradleUi.set({ selected: row });
  if (row.kind === "task" || row.kind === "pinned") {
    const task = row.task!;
    const args = row.args ?? "";
    const pinned = row.kind === "pinned" || isPinned(task, args);
    const kb = (a: string) => { const k = keysFor(a)[0]; return k ? formatKeystroke(k) : undefined; };
    showContextMenu(x, y, [
      { label: `Run '${task}'`, shortcut: kb("Gradle.RunSelected"), run: () => void runTask(task, args, row.kind === "pinned" ? row.label !== task ? row.label : "" : "") },
      { label: "Create Run Configuration…", run: () => createRunConfiguration(task, args) },
      { separator: true, label: "" },
      pinned ? { label: "Unpin", shortcut: kb("Gradle.Unpin"), run: () => void (row.kind === "pinned" ? unpinAt(row.pinIndex!) : unpinTask(task, args)) } : { label: "Pin", run: () => void pinTask(task) },
      ...(row.kind === "pinned" ? [{ label: "Edit Arguments…", run: () => void promptDialog({ title: "Task Arguments", initial: args, okLabel: "OK" }).then((v) => { if (v !== null) return editPinArgs(row.pinIndex!, v); }) }] : []),
      { label: "Copy Task Path", shortcut: kb("Gradle.CopyPath"), run: () => void navigator.clipboard?.writeText(task).catch(() => {}) },
    ]);
  } else if (row.kind === "project") {
    showContextMenu(x, y, [{ label: "Reload All Gradle Projects", run: () => void reloadGradle() }, { label: "Copy Project Path", run: () => void navigator.clipboard?.writeText(row.project!).catch(() => {}) }]);
  }
}

function Elapsed({ since }: { since: number }) {
  const [, tick] = useState(0);
  useEffect(() => { const t = setInterval(() => tick((n) => n + 1), 1000); return () => clearInterval(t); }, []);
  return <>{Math.max(0, Math.round((Date.now() - since) / 1000))}s</>;
}

export function GradleWindow(_: ToolWindowProps) {
  const g = useStore(gradleStore);
  const ui = useStore(gradleUi);
  const pins = usePins();
  const cfgErr = useStore(repoConfigStore).error;
  const body = useRef<HTMLDivElement>(null);
  const [full, setFull] = useState(false);
  const [dragOver, setDragOver] = useState<number | null>(null);
  const rows = useMemo(() => visibleRows(g.model, pins, ui.open), [g.model, pins, ui.open]);
  const sel = ui.selected ? rows.find((r) => r.id === ui.selected!.id) ?? null : null;
  useEffect(() => { body.current?.querySelector(".gj-row.selected")?.scrollIntoView({ block: "nearest" }); }, [sel?.id]);

  const select = (r: Row) => gradleUi.set({ selected: r });
  const key = (e: React.KeyboardEvent) => {
    const i = sel ? rows.findIndex((r) => r.id === sel.id) : -1;
    if (e.key === "ArrowDown") { e.preventDefault(); select(rows[Math.min(rows.length - 1, i + 1)] ?? rows[0]); }
    else if (e.key === "ArrowUp") { e.preventDefault(); if (rows.length) select(rows[Math.max(0, i - 1)]); }
    else if (e.key === "ArrowRight" && sel?.hasChildren) { e.preventDefault(); if (!ui.open.has(sel.id)) toggleRow(sel.id, true); else select(rows[i + 1]); }
    else if (e.key === "ArrowLeft" && sel) {
      e.preventDefault();
      if (sel.hasChildren && ui.open.has(sel.id)) toggleRow(sel.id, false);
      else for (let j = i - 1; j >= 0; j--) if (rows[j].depth < sel.depth) { select(rows[j]); break; }
    }
  };
  const err = g.status === "error" ? g.error ?? "" : "";
  const errLines = err.split("\n");
  return (
    <div className="gj" data-testid="gradle-window">
      {g.status === "loading" && <div className="gj-prog" data-testid="gradle-progress" />}
      <div className="gj-body" ref={body} tabIndex={0} data-autofocus onKeyDown={key} data-testid="gradle-tree">
        {g.status === "error" && (
          <div className="gj-err" data-testid="gradle-error">
            <div className="gj-err-head"><b>Gradle sync failed</b><span className="gj-link" onClick={() => void reloadGradle()}>Retry</span></div>
            <pre>{full ? err : errLines.slice(0, 14).join("\n")}</pre>
            {errLines.length > 14 && <div className="gj-link" style={{ padding: "0 8px 6px" }} onClick={() => setFull(!full)}>{full ? "Show less" : `Show full output (${errLines.length} lines)`}</div>}
          </div>
        )}
        {cfgErr && <div className="gj-err"><div className="gj-err-head">{cfgErr}</div></div>}
        {rows.map((r) => {
          const open = ui.open.has(r.id);
          const kindCls = r.kind === "project" ? "proj" : r.kind === "pinned-root" || r.kind === "pinned" ? "pin" : r.kind === "group" ? "group" : "";
          return (
            <div key={r.id} className={"gj-row" + (sel?.id === r.id ? " selected" : "") + (dragOver === r.pinIndex && r.kind === "pinned" ? " dragover" : "")}
              data-row={r.id} data-kind={r.kind} data-task={r.task} style={{ paddingLeft: r.depth * 16 }} title={r.description ?? undefined}
              draggable={r.kind === "pinned"}
              onDragStart={(e) => { e.dataTransfer.setData("text/gradle-pin", String(r.pinIndex)); e.dataTransfer.effectAllowed = "move"; }}
              onDragOver={(e) => { if (r.kind === "pinned") { e.preventDefault(); setDragOver(r.pinIndex!); } }}
              onDragLeave={() => setDragOver(null)}
              onDrop={(e) => { setDragOver(null); const from = Number(e.dataTransfer.getData("text/gradle-pin")); if (r.kind === "pinned" && Number.isInteger(from)) void movePin(from, r.pinIndex!); }}
              onMouseDown={() => select(r)}
              onDoubleClick={() => (r.task ? void runTask(r.task, r.args ?? "", r.kind === "pinned" && r.label !== r.task ? r.label : "") : r.hasChildren && toggleRow(r.id))}
              onContextMenu={(e) => { e.preventDefault(); openMenu(e.clientX, e.clientY, r); }}>
              <span className="gj-chev" onMouseDown={(e) => { if (r.hasChildren) { e.stopPropagation(); select(r); toggleRow(r.id); } }}>
                {r.hasChildren ? open ? <ChevronDown /> : <ChevronRight /> : null}
              </span>
              <span className={"gj-ico " + kindCls}>
                {r.kind === "project" ? <GradleIcon size={14} /> : r.kind === "pinned-root" || r.kind === "pinned" ? <PinIcon /> : r.kind === "task" ? <TaskIcon /> : null}
              </span>
              <span className="gj-label">{r.label}</span>
              {r.kind === "pinned" && <span className="gj-hint">{[r.label !== r.task ? r.task : "", r.args].filter(Boolean).join("  ")}</span>}
            </div>
          );
        })}
        {!g.model && g.status !== "error" && <div className="gj-empty">{g.status === "loading" ? "Loading Gradle projects…" : "No Gradle model yet."}</div>}
      </div>
      <div className="gj-status" data-testid="gradle-status" data-status={g.status} data-cached={g.fromCache ? "1" : "0"}>
        {g.status === "loading" ? <span>Syncing Gradle project… <Elapsed since={g.startedAt} /></span> : null}
        {g.status !== "loading" && g.model && <span>Gradle {g.model.gradleVersion}{g.lastMs != null ? ` · ${(g.lastMs / 1000).toFixed(1)}s` : ""}{g.fromCache ? " · cached" : ""}{g.model.daemonPid && !g.fromCache ? ` · daemon ${g.model.daemonPid}` : ""}</span>}
      </div>
    </div>
  );
}

export function GradleHeaderActions(_: ToolWindowProps) {
  const g = useStore(gradleStore);
  const ui = useStore(gradleUi);
  const pins = usePins();
  const sel = ui.selected;
  const t = sel?.task;
  const pinned = !!t && (sel!.kind === "pinned" || pins.some((p) => p.task === t && !p.args));
  const k = (a: string) => { const x = keysFor(a)[0]; return x ? `  ${formatKeystroke(x)}` : ""; };
  return (
    <>
      <button className="icon-btn sm" data-act="reload" title={`Reload All Gradle Projects${k("Gradle.Refresh")}`} onClick={() => runAction("Gradle.Refresh")} disabled={g.status === "loading"}><ReloadIcon /></button>
      <button className="icon-btn sm" data-act="execute" title="Execute Gradle Task" onClick={() => runAction("Gradle.ExecuteTask")}><ExecIcon /></button>
      <button className="icon-btn sm" data-act="pin" title={pinned ? "Unpin Task" : "Pin Task"} disabled={!t} onClick={() => runAction(pinned ? "Gradle.Unpin" : "Gradle.Pin")}><PinIcon /></button>
      <button className="icon-btn sm" data-act="expand" title="Expand All" onClick={expandAll}><ExpandAllIcon /></button>
      <button className="icon-btn sm" data-act="collapse" title="Collapse All" onClick={collapseAll}><CollapseAllIcon /></button>
    </>
  );
}
