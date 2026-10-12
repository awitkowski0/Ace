import { useEffect, useMemo, useRef, useState } from "react";
import { PopupShell, openPopup, closePopup, type PopupProps } from "../shell/popups";
import { fuzzy } from "../search/fuzzy";
import { Hl } from "../search/ui";
import { BranchIcon } from "../shell/icons";
import { promptDialog } from "../shell/dialogs";
import { cleanBranchName, newBranchPrefix } from "./assets";
import { gitStore } from "../git/api";
import { listBranches, myUser, newBranch, switchBranch, type BranchRow } from "./gitops";
import { saveFlow } from "./SaveDialog";
import { toast } from "./notice";
// == worktrees hook == "Other copies of this project" (git worktrees, in plain language)
import { useWorktreeRefresh, useWorktreeRows } from "../worktrees/store";
import { openWorktree } from "../worktrees/ops";
import { filterRows, isAgentPath, layoutAgents } from "../../lib/worktrees";

export const openBranches = () => openPopup("AssetBranches");

/** "New branch for my work": names start with assets/<you>/ */
export async function newBranchFlow(): Promise<boolean> {
  const u = await myUser();
  const prefix = newBranchPrefix(u.slug, gitStore.get().status?.branch ?? null);
  const typed = await promptDialog({ title: "Start a new branch for my work", initial: prefix, okLabel: "Create" });
  if (typed === null) return false;
  const name = cleanBranchName(prefix, typed);
  if (!name) { toast("Give your branch a name, for example walk-cycle.", "warn"); return false; }
  return newBranch(name);
}

export function BranchPopup({ onClose }: PopupProps) {
  const [rows, setRows] = useState<BranchRow[] | null>(null);
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { void listBranches().then(setRows).catch(() => setRows([])); input.current?.focus(); }, []);
  const list = useMemo(() => {
    const all = rows ?? [];
    if (!q) return all.map((r) => ({ r, idx: [] as number[] }));
    return all.map((r) => ({ r, f: fuzzy(q, r.name) })).filter((x) => x.f).sort((a, b) => b.f!.score - a.f!.score).map((x) => ({ r: x.r, idx: x.f!.indices }));
  }, [rows, q]);
  const wtm = useWorktreeRows(); useWorktreeRefresh(); // == worktrees hook ==
  const [agentsOpen, setAgentsOpen] = useState(false);
  const copyEnts = useMemo(() => layoutAgents(wtm.rows.length > 1 ? filterRows(wtm.rows, q) : [], (h) => isAgentPath(h.row.wt.path), agentsOpen, !!q.trim()), [wtm.rows, q, agentsOpen]);
  const copies = useMemo(() => copyEnts.map((e) => ("row" in e ? e.row : null)), [copyEnts]); // null = "Helper copies" header
  const total = list.length + copies.length;
  useEffect(() => setSel((s) => Math.min(s, Math.max(0, total - 1))), [total]);
  const choose = async (r?: BranchRow) => {
    if (!r || r.current) return onClose();
    closePopup();
    await switchBranch(r.name, r.remote, saveFlow);
  };
  const openCopy = (i: number) => { if (!copies[i]) return setAgentsOpen((o) => !o); const c = copies[i]?.row; closePopup(); if (c && !c.current) void openWorktree(c.wt.path, "this"); };
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") setSel((s) => (total ? (s + 1) % total : 0));
    else if (e.key === "ArrowUp") setSel((s) => (total ? (s - 1 + total) % total : 0));
    else if (e.key === "Enter") { if (sel >= list.length) openCopy(sel - list.length); else void choose(list[sel]?.r); }
    else return;
    e.preventDefault();
  };
  return (
    <PopupShell onClose={onClose} width={520}>
      <div className="popup-tabs"><span className="popup-title">Branches</span></div>
      <div className="se-inputrow"><input ref={input} data-testid="branch-search" className="se-input" placeholder="Search branches" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={onKey} spellCheck={false} /></div>
      <div className="rp-list" data-testid="branch-list" style={{ maxHeight: 340 }}>
        <div className="ap-newbranch popup-row se-row" data-testid="branch-new" onClick={() => { closePopup(); void newBranchFlow(); }}>
          <span className="se-icon"><BranchIcon /></span><span className="se-label">New branch for my work…</span>
        </div>
        {list.map(({ r, idx }, i) => (
          <div key={(r.remote ? "r:" : "l:") + r.name} data-name={r.name} data-remote={r.remote ? "1" : "0"} className={"popup-row se-row" + (i === sel ? " selected" : "")}
            onMouseDown={(e) => { e.preventDefault(); setSel(i); }} onClick={() => void choose(r)}>
            <span className="rp-check">{r.current ? "✓" : ""}</span>
            <span className="se-label"><Hl text={r.name} indices={idx} /></span>
            <span className="se-sec">{r.remote ? "on the server" : r.current ? "you are here" : ""}</span>
          </div>
        ))}
        {rows && !list.length && !copies.length && <div className="se-empty">No branches match</div>}
        {copies.length > 0 && <div className="popup-section" data-testid="copies-head">Other copies of this project</div>}
        {copies.map((h, i) => {
          if (!h) {
            const g = (copyEnts[i] as { group: { count: number; open: boolean } }).group;
            return (
              <div key="agents" data-testid="agent-group" className={"popup-row se-row" + (list.length + i === sel ? " selected" : "")} onMouseDown={(e) => { e.preventDefault(); setSel(list.length + i); }} onClick={() => openCopy(i)}>
                <span className="rp-check">{g.open ? "▾" : "▸"}</span><span className="se-label">Automatic helper copies ({g.count})</span>
              </div>
            );
          }
          const r = h.row, s = r.status;
          const n = s?.dirty ?? 0;
          return (
            <div key={r.wt.path} data-copy={r.name} data-current={r.current ? "1" : undefined} className={"popup-row se-row" + (list.length + i === sel ? " selected" : "")}
              title={r.wt.path} onMouseDown={(e) => { e.preventDefault(); setSel(list.length + i); }} onClick={() => openCopy(i)}>
              <span className="rp-check">{r.current ? "✓" : ""}</span>
              <span className="se-label"><Hl text={r.name} indices={h.name.flatMap(([a, b]) => Array.from({ length: b - a }, (_, k) => a + k))} /></span>
              <span className="se-sec">{r.current ? "you are here" : `working on ${r.wt.branch ?? "an earlier version"}`}{n > 0 ? ` · ${n} unsaved change${n === 1 ? "" : "s"}` : ""}</span>
            </div>
          );
        })}
      </div>
    </PopupShell>
  );
}
