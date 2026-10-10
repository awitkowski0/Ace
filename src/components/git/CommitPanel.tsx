import { useEffect, useMemo, useRef } from "react";
import { createStore, useStore } from "../../lib/store";
import { basename } from "../../lib/ipc";
import { ChevronDown, ChevronRight, FileIcon, FolderIcon } from "../shell/icons";
import { showContextMenu } from "../shell/contextMenu";
import { confirmDialog } from "../shell/dialogs";
import { openFile, saveAll } from "../../editor/store";
import { absLoc, alertError, git, gitStore, log, pushCurrent, refreshAll, type Change } from "./api";
import { CollapseAllIcon, DiffIcon, ExpandAllIcon, RefreshIcon, RollbackIcon } from "./icons";
import { VirtualList } from "./VirtualList";
import { openChangeDiff } from "./diff";
import type { ToolWindowProps } from "../../toolwindows/registry";

interface CommitState {
  message: string;
  amend: boolean;
  uncheckedTracked: Set<string>;
  checkedUntracked: Set<string>;
  collapsed: Set<string>;
  selected: string | null; // row id
  busy: boolean;
}
export const commitStore = createStore<CommitState>({
  message: "", amend: false, uncheckedTracked: new Set(), checkedUntracked: new Set(), collapsed: new Set(), selected: null, busy: false,
});
const patch = (p: Partial<CommitState>) => commitStore.set(p);

const isChecked = (c: Change, s: CommitState) => (c.kind === "untracked" ? s.checkedUntracked.has(c.path) : !s.uncheckedTracked.has(c.path));
function setChecked(cs: Change[], on: boolean) {
  const s = commitStore.get();
  const ut = new Set(s.uncheckedTracked), cu = new Set(s.checkedUntracked);
  for (const c of cs) {
    if (c.kind === "untracked") { if (on) cu.add(c.path); else cu.delete(c.path); }
    else if (on) ut.delete(c.path);
    else ut.add(c.path);
  }
  patch({ uncheckedTracked: ut, checkedUntracked: cu });
}
export function toggleAmend() {
  const on = !commitStore.get().amend;
  patch({ amend: on });
  const root = gitStore.get().root;
  if (on && root && !commitStore.get().message.trim()) git.body(root, "HEAD").then((m) => patch({ message: m })).catch(() => {});
}

type Row =
  | { t: "group"; id: string; label: string; changes: Change[] }
  | { t: "dir"; id: string; label: string; depth: number; changes: Change[] }
  | { t: "file"; id: string; depth: number; change: Change };

interface Node { name: string; dirs: Map<string, Node>; files: Change[]; all: Change[] }
function buildTree(changes: Change[]): Node {
  const root: Node = { name: "", dirs: new Map(), files: [], all: changes };
  for (const c of changes) {
    const parts = c.path.split("/");
    let n = root;
    for (const seg of parts.slice(0, -1)) {
      let d = n.dirs.get(seg);
      if (!d) n.dirs.set(seg, (d = { name: seg, dirs: new Map(), files: [], all: [] }));
      d.all.push(c);
      n = d;
    }
    n.files.push(c);
  }
  return root;
}
function flatten(gid: string, n: Node, depth: number, collapsed: Set<string>, out: Row[], prefix: string) {
  const dirs = [...n.dirs.values()].sort((a, b) => a.name.localeCompare(b.name));
  for (let d of dirs) {
    let label = d.name;
    // compress single-child directory chains like IntelliJ ("src/components/git")
    while (d.files.length === 0 && d.dirs.size === 1) {
      d = [...d.dirs.values()][0];
      label += "/" + d.name;
    }
    const id = `${gid}:d:${prefix}${label}`;
    out.push({ t: "dir", id, label, depth, changes: d.all });
    if (!collapsed.has(id)) flatten(gid, d, depth + 1, collapsed, out, `${prefix}${label}/`);
  }
  for (const f of [...n.files].sort((a, b) => basename(a.path).localeCompare(basename(b.path)))) out.push({ t: "file", id: `${gid}:f:${f.path}`, depth, change: f });
}

const KIND_COLOR: Record<string, string> = {
  modified: "var(--nord9)", added: "var(--nord14)", renamed: "var(--nord9)", copied: "var(--nord9)", typechange: "var(--nord9)",
  deleted: "var(--fg-faint)", conflict: "var(--nord11)", untracked: "var(--nord12)",
};

function useRows(): Row[] {
  const { status } = useStore(gitStore);
  const { collapsed } = useStore(commitStore);
  return useMemo(() => {
    const out: Row[] = [];
    const tracked = (status?.changes ?? []).filter((c) => c.kind !== "untracked");
    const untracked = (status?.changes ?? []).filter((c) => c.kind === "untracked");
    if (tracked.length) {
      out.push({ t: "group", id: "g:changes", label: "Changes", changes: tracked });
      if (!collapsed.has("g:changes")) flatten("c", buildTree(tracked), 1, collapsed, out, "");
    }
    if (untracked.length) {
      out.push({ t: "group", id: "g:untracked", label: "Unversioned Files", changes: untracked });
      if (!collapsed.has("g:untracked")) flatten("u", buildTree(untracked), 1, collapsed, out, "");
    }
    return out;
  }, [status, collapsed]);
}

function Check({ state, onChange }: { state: "on" | "off" | "mixed"; onChange: (on: boolean) => void }) {
  return (
    <span className={"gcheck " + state} onMouseDown={(e) => e.stopPropagation()} onClick={(e) => { e.stopPropagation(); onChange(state !== "on"); }} onDoubleClick={(e) => e.stopPropagation()}>
      {state === "on" ? "✓" : state === "mixed" ? "–" : ""}
    </span>
  );
}

export async function doCommit(andPush: boolean) {
  const { root, status } = gitStore.get();
  const s = commitStore.get();
  if (!root || !status || s.busy) return;
  const sel = status.changes.filter((c) => isChecked(c, s));
  const msg = s.message.trim();
  if (!msg) { await confirmDialog({ title: "Commit", message: "Please enter a commit message.", okLabel: "OK" }); return; }
  if (!sel.length && !s.amend) { await confirmDialog({ title: "Commit", message: "No files selected for commit.", okLabel: "OK" }); return; }
  patch({ busy: true });
  try {
    await saveAll();
    const paths = sel.map((c) => c.path);
    const origs = sel.flatMap((c) => (c.orig ? [c.orig] : []));
    log(`$ git commit${s.amend ? " --amend" : ""} -m "${msg.split("\n")[0]}" (${sel.length} files)`, "cmd");
    const out = await git.commit(root, msg, s.amend, paths, origs);
    log(out.trim(), "out");
    patch({ message: "", amend: false });
    await refreshAll();
    if (andPush) await pushCurrent();
  } catch (e) {
    await alertError("Commit Failed", e);
  } finally {
    patch({ busy: false });
  }
}

async function rollback(cs: Change[]) {
  const root = gitStore.get().root;
  if (!root || !cs.length) return;
  const ok = await confirmDialog({
    title: "Rollback Changes",
    message: `Discard changes in ${cs.length === 1 ? cs[0].path : cs.length + " files"}? This cannot be undone.`,
    okLabel: "Rollback",
  });
  if (!ok) return;
  try {
    await saveAll();
    await git.rollback(root, cs.map((c) => ({ path: c.path, orig: c.orig, kind: c.kind })));
  } catch (e) { await alertError("Rollback Failed", e); }
  refreshAll();
}

export function selectedChange(): Change | null {
  const st = gitStore.get().status;
  const id = commitStore.get().selected;
  if (!st || !id?.includes(":f:")) return null;
  const p = id.slice(id.indexOf(":f:") + 3);
  return st.changes.find((c) => c.path === p) ?? null;
}

export function CommitPanel(_: ToolWindowProps) {
  const { status } = useStore(gitStore);
  const cs = useStore(commitStore);
  const rows = useRows();
  const ta = useRef<HTMLTextAreaElement>(null);
  const idx = rows.findIndex((r) => r.id === cs.selected);
  const checkedCount = (status?.changes ?? []).filter((c) => isChecked(c, cs)).length;

  const stateOf = (changes: Change[]): "on" | "off" | "mixed" => {
    const n = changes.filter((c) => isChecked(c, cs)).length;
    return n === 0 ? "off" : n === changes.length ? "on" : "mixed";
  };
  const toggleCollapse = (id: string) => {
    const s = new Set(cs.collapsed);
    if (s.has(id)) s.delete(id); else s.add(id);
    patch({ collapsed: s });
  };
  const activate = (r: Row) => (r.t === "file" ? openChangeDiff(r.change) : toggleCollapse(r.id));
  const menu = (e: React.MouseEvent, r: Row) => {
    e.preventDefault();
    patch({ selected: r.id });
    const changes = r.t === "file" ? [r.change] : r.changes;
    const root = gitStore.get().root!;
    showContextMenu(e.clientX, e.clientY, [
      { label: "Show Diff", shortcut: "⌘D", disabled: r.t !== "file", run: () => r.t === "file" && openChangeDiff(r.change) },
      { label: "Jump to Source", disabled: r.t !== "file" || r.change.kind === "deleted", run: () => r.t === "file" && openFile(absLoc(r.change.path)) },
      { separator: true, label: "" },
      { label: "Rollback…", shortcut: "⌥⌘Z", run: () => rollback(changes) },
      { label: "Add to VCS", disabled: !changes.some((c) => c.kind === "untracked"), run: () => git.stage(root, changes.filter((c) => c.kind === "untracked").map((c) => c.path)).then(refreshAll) },
      { label: "Unstage", disabled: !changes.some((c) => c.index !== "." && c.index !== "?"), run: () => git.unstage(root, changes.map((c) => c.path)).then(refreshAll) },
    ]);
  };

  useEffect(() => {
    if (cs.selected && idx < 0) patch({ selected: null });
  }, [idx, cs.selected]);

  if (status && !status.isRepo) return <div className="git-empty">This project is not under Git version control.</div>;

  const sc = selectedChange();
  return (
    <div className="commitpanel">
      <div className="gtoolbar">
        <button className="icon-btn sm" title="Refresh" onClick={() => refreshAll()}><RefreshIcon /></button>
        <button className="icon-btn sm" title="Rollback… (⌥⌘Z)" onClick={() => rollback((status?.changes ?? []).filter((c) => isChecked(c, cs)))}><RollbackIcon /></button>
        <button className="icon-btn sm" title="Show Diff (⌘D)" onClick={() => sc && openChangeDiff(sc)}><DiffIcon /></button>
        <span className="gsep" />
        <button className="icon-btn sm" title="Expand All" onClick={() => patch({ collapsed: new Set() })}><ExpandAllIcon /></button>
        <button className="icon-btn sm" title="Collapse All" onClick={() => patch({ collapsed: new Set(rows.filter((r) => r.t !== "file").map((r) => r.id)) })}><CollapseAllIcon /></button>
      </div>
      <div
        className="gtree"
        data-gtree
        tabIndex={0}
        onKeyDown={(e) => {
          const move = (d: number) => { const r = rows[Math.max(0, Math.min(rows.length - 1, idx + d))]; if (r) patch({ selected: r.id }); };
          const cur = rows[idx];
          if (e.key === "ArrowDown") { e.preventDefault(); move(1); }
          else if (e.key === "ArrowUp") { e.preventDefault(); move(-1); }
          else if (e.key === "Enter" && cur) activate(cur);
          else if (e.key === " " && cur) { e.preventDefault(); const ch = cur.t === "file" ? [cur.change] : cur.changes; setChecked(ch, stateOf(ch) !== "on"); }
          else if (e.key === "ArrowRight" && cur && cur.t !== "file" && cs.collapsed.has(cur.id)) toggleCollapse(cur.id);
          else if (e.key === "ArrowLeft" && cur && cur.t !== "file" && !cs.collapsed.has(cur.id)) toggleCollapse(cur.id);
        }}
      >
        {rows.length === 0 ? (
          <div className="git-empty">{status ? "No changes" : "Loading…"}</div>
        ) : (
          <VirtualList
            count={rows.length}
            scrollToIndex={idx >= 0 ? idx : null}
            render={(i) => {
              const r = rows[i];
              const changes = r.t === "file" ? [r.change] : r.changes;
              const pad = r.t === "group" ? 6 : 6 + r.depth * 16;
              return (
                <div
                  className={"grow-row" + (r.id === cs.selected ? " selected" : "")}
                  style={{ paddingLeft: pad }}
                  onMouseDown={(e) => { patch({ selected: r.id }); e.currentTarget.closest<HTMLElement>("[data-gtree]")?.focus(); }}
                  onDoubleClick={() => activate(r)}
                  onContextMenu={(e) => menu(e, r)}
                >
                  {r.t !== "file" ? (
                    <span className="gchev" onMouseDown={(e) => e.stopPropagation()} onClick={() => toggleCollapse(r.id)}>
                      {cs.collapsed.has(r.id) ? <ChevronRight /> : <ChevronDown />}
                    </span>
                  ) : <span className="gchev" />}
                  <Check state={stateOf(changes)} onChange={(on) => setChecked(changes, on)} />
                  {r.t === "file" ? (
                    <>
                      <span className="gicon" style={{ color: KIND_COLOR[r.change.kind] }}><FileIcon /></span>
                      <span className="gname" style={{ color: KIND_COLOR[r.change.kind] }}>{basename(r.change.path)}</span>
                      {r.change.orig && <span className="gdim">← {r.change.orig}</span>}
                    </>
                  ) : r.t === "dir" ? (
                    <>
                      <span className="gicon"><FolderIcon /></span>
                      <span className="gname">{r.label}</span>
                      <span className="gdim">{r.changes.length} file{r.changes.length === 1 ? "" : "s"}</span>
                    </>
                  ) : (
                    <>
                      <span className="gname gbold">{r.label}</span>
                      <span className="gdim">{r.changes.length} file{r.changes.length === 1 ? "" : "s"}</span>
                    </>
                  )}
                </div>
              );
            }}
          />
        )}
      </div>
      <div className="gcommit">
        <textarea
          ref={ta}
          data-autofocus
          className="gmsg"
          placeholder="Commit Message"
          spellCheck={false}
          value={cs.message}
          onChange={(e) => patch({ message: e.target.value })}
          onKeyDown={(e) => {
            if (e.key === "Enter" && e.metaKey) { e.preventDefault(); doCommit(false); }
          }}
        />
        <div className="gcommit-row">
          <label className="gamend" onClick={toggleAmend}><span className={"gcheck " + (cs.amend ? "on" : "off")}>{cs.amend ? "✓" : ""}</span> Amend</label>
          <div className="grow" />
          <button className="gbtn primary" disabled={cs.busy} onClick={() => doCommit(false)}>{cs.amend ? "Amend Commit" : "Commit"}{checkedCount ? ` (${checkedCount})` : ""}</button>
          <button className="gbtn" disabled={cs.busy} onClick={() => doCommit(true)}>Commit and Push…</button>
        </div>
      </div>
    </div>
  );
}
