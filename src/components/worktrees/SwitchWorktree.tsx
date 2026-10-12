import { useEffect, useMemo, useRef, useState } from "react";
import { PopupShell, openPopup, type PopupProps } from "../shell/popups";
import { showContextMenu } from "../shell/contextMenu";
import { BranchIcon, FolderIcon } from "../shell/icons";
import { Hl } from "../search/ui";
import { abbrevPath, normalizePath } from "../../lib/recentProjects";
import { badges, filterRows, isAgentPath, layoutAgents, removeBlocker, type WtHit } from "../../lib/worktrees";
import type { Range } from "../../lib/speedSearch";
import { useStore } from "../../lib/store";
import { projectStore } from "../../lib/project";
import { gitStore } from "../git/api";
import { openWorktree, pruneFlow, removeWorktreeFlow, revealWorktree } from "./ops";
import { loadWorktrees, useWorktreeRows } from "./store";
import "./worktrees.css";
import { fileManagerName, formatShortcut, isMod } from "../../lib/platform";
import { homeOf } from "../../lib/paths";

export const openSwitchWorktree = (select?: string) => openPopup("SwitchWorktree", { select });
export const openNewWorktree = () => openPopup("NewWorktree");

export const rangesToIdx = (r: Range[]): number[] => r.flatMap(([s, e]) => Array.from({ length: e - s }, (_, i) => s + i));

/** Row badges (dirty / ahead / behind / locked / missing) shared by every worktree list. */
export function Badges({ row }: { row: WtHit["row"] }) {
  return <>{badges(row).map((b) => <span key={b.kind} className={"wt-badge " + b.kind} data-badge={b.kind} title={b.title}>{b.text}</span>)}</>;
}

/** IntelliJ-style "Switch Worktree" popup: opens from the cache, refreshes in the background. */
export function SwitchWorktree({ onClose, props }: PopupProps) {
  const want = (props as { select?: string } | undefined)?.select;
  const { rows, ready, loading } = useWorktreeRows();
  const { root } = useStore(projectStore);
  const { status } = useStore(gitStore);
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const moved = useRef(false);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const home = useMemo(() => (root ? homeOf(root.path) : undefined), [root]);

  useEffect(() => { input.current?.focus(); void loadWorktrees(true); }, []);
  const [agentsOpen, setAgentsOpen] = useState(false);
  const matches = useMemo(() => filterRows(rows, q), [rows, q]);
  // Claude agent worktrees sit in a collapsed group at the bottom; a search auto-expands it
  const ents = useMemo(() => layoutAgents(matches, (h) => isAgentPath(h.row.wt.path), agentsOpen, !!q.trim()), [matches, agentsOpen, q]);
  const hits = useMemo(() => ents.map((e) => ("row" in e ? e.row : null)), [ents]); // null = the group header
  const gi = ents.findIndex((e) => "group" in e);

  // preselect: the requested path, else the first worktree that is not the current one ("jump somewhere else")
  useEffect(() => {
    if (moved.current && !q) return;
    const byPath = want ? hits.findIndex((h) => h && normalizePath(h.row.wt.path) === normalizePath(want)) : -1;
    const i = byPath >= 0 ? byPath : Math.max(0, hits.findIndex((h) => h && !h.row.current));
    setSel(i);
  }, [hits.length, q, want]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { list.current?.querySelector(".popup-row.selected")?.scrollIntoView({ block: "nearest" }); }, [sel, hits.length]);

  const cur = hits[Math.min(sel, hits.length - 1)]?.row;
  const toggleAgents = () => { moved.current = true; setAgentsOpen((o) => !o); };
  const act = (h: WtHit | undefined, how: "this" | "new" | "reveal") => {
    if (!h) return;
    const p = h.row.wt.path;
    if (how === "reveal") return void revealWorktree(p);
    onClose();
    if (h.row.current) return;
    void openWorktree(p, how);
  };
  // dialogs live outside the popup: close it, run the flow, come back with a fresh list
  const flow = (fn: () => Promise<unknown>, select?: () => string | undefined) => { onClose(); void fn().finally(() => openSwitchWorktree(select?.())); };
  const remove = (h: WtHit | undefined) => { if (h) flow(() => removeWorktreeFlow(h.row)); };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") { moved.current = true; setSel((s) => (hits.length ? (s + 1) % hits.length : 0)); }
    else if (e.key === "ArrowUp") { moved.current = true; setSel((s) => (hits.length ? (s - 1 + hits.length) % hits.length : 0)); }
    else if (e.key === "Enter") { if (hits[sel] === null) toggleAgents(); else act(hits[sel] ?? undefined, isMod(e) ? "new" : e.altKey ? "reveal" : "this"); }
    else if (e.key === "ArrowRight" && hits[sel] === null && !(ents[gi] as { group: { open: boolean } }).group.open && !input.current?.value) setAgentsOpen(true);
    else if (e.key === "ArrowLeft" && hits[sel] === null && !input.current?.value) setAgentsOpen(false);
    else return;
    e.preventDefault();
  };
  const menu = (e: React.MouseEvent, h: WtHit) => {
    e.preventDefault();
    const blocker = removeBlocker(h.row);
    showContextMenu(e.clientX, e.clientY, [
      { label: "Open", shortcut: "↩", disabled: h.row.current, run: () => act(h, "this") },
      { label: "Open in New Window", shortcut: "⌘↩", disabled: h.row.current, run: () => act(h, "new") },
      { label: `Show in ${fileManagerName}`, shortcut: "⌥↩", disabled: root?.host !== "local", run: () => act(h, "reveal") },
      { label: "Copy Path", run: () => void navigator.clipboard?.writeText(h.row.wt.path).catch(() => {}) },
      { label: "", separator: true },
      { label: "Remove Worktree…", disabled: !!blocker, run: () => remove(h) },
    ]);
  };

  const removeBlock = cur ? removeBlocker(cur) : "Nothing selected";
  return (
    <PopupShell onClose={onClose} width={660}>
      <div className="popup-tabs"><span className="popup-title">Switch Worktree</span>
        {status?.isRepo && <span className="gdim">{rows.length ? `${rows.length} worktree${rows.length === 1 ? "" : "s"}` : ""}{loading && ready ? " · refreshing" : ""}</span>}
      </div>
      <div className="se-inputrow">
        <input ref={input} className="se-input" data-testid="worktree-search" placeholder="Search worktrees by folder, branch or path" value={q}
          onChange={(e) => setQ(e.target.value)} onKeyDown={onKey} spellCheck={false} />
      </div>
      <div className="wt-list" ref={list} data-testid="worktree-list">
        {hits.map((h, i) => !h ? (
          <div key="agents" className={"popup-row se-row rp-row wt-row wt-group" + (i === sel ? " selected" : "")} data-testid="agent-group" data-open={(ents[i] as { group: { open: boolean } }).group.open ? "1" : "0"}
            onMouseDown={(e) => { e.preventDefault(); moved.current = true; setSel(i); }} onClick={toggleAgents}>
            <span className="rp-check">{(ents[i] as { group: { open: boolean } }).group.open ? "▾" : "▸"}</span>
            <span className="se-label">Agent worktrees ({(ents[i] as { group: { count: number } }).group.count})</span>
          </div>
        ) : (
          <div key={h.row.wt.path} className={"popup-row se-row rp-row wt-row" + (i === sel ? " selected" : "") + (h.row.current ? " cur" : "")}
            data-name={h.row.name} data-branch={h.row.branch} data-current={h.row.current ? "1" : undefined} data-main={h.row.wt.main ? "1" : undefined}
            onMouseDown={(e) => { e.preventDefault(); moved.current = true; setSel(i); }}
            onClick={(e) => act(h, isMod(e) ? "new" : e.altKey ? "reveal" : "this")} onContextMenu={(e) => menu(e, h)}>
            <span className="rp-check">{h.row.current ? "✓" : ""}</span>
            <span className="se-icon"><FolderIcon /></span>
            <span className="se-label"><Hl text={h.row.name} indices={rangesToIdx(h.name)} /></span>
            <span className="wt-chip" title={h.row.branch}><BranchIcon /><span><Hl text={h.row.branch} indices={rangesToIdx(h.branch)} /></span></span>
            <Badges row={h.row} />
            <span className="wt-path" title={h.row.wt.path}><bdi>{abbrevPath({ host: root?.host ?? "local", path: h.row.wt.path }, home)}</bdi></span>
          </div>
        ))}
        {ready && !matches.length && <div className="se-empty">{rows.length ? "No worktrees match" : status?.isRepo ? "No worktrees" : "This project is not in a Git repository"}</div>}
        {!ready && <div className="se-empty">Loading…</div>}
      </div>
      <div className="rp-actions wt-foot">
        <button data-act="new" onClick={() => { onClose(); openNewWorktree(); }}>New Worktree…</button>
        <button data-act="remove" disabled={!!removeBlock} title={removeBlock ?? "Remove the selected worktree"} onClick={() => remove(hits[sel] ?? undefined)}>Remove Worktree…</button>
        <button data-act="prune" title="Forget worktrees whose folder is gone" onClick={() => flow(pruneFlow)}>Prune</button>
        <span className="wt-hints">↩ Open · {formatShortcut("⌘↩")} New Window · {formatShortcut("⌥↩")} Show in {fileManagerName}</span>
      </div>
    </PopupShell>
  );
}
