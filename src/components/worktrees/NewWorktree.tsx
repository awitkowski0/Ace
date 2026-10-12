import { isAbsPath } from "../../lib/paths";
import { useEffect, useMemo, useRef, useState } from "react";
import { PopupShell, type PopupProps } from "../shell/popups";
import { BranchIcon } from "../shell/icons";
import { Hl } from "../search/ui";
import { matchName } from "../../lib/speedSearch";
import { useStore } from "../../lib/store";
import { projectStore } from "../../lib/project";
import { defaultWorktreePath, freeBranches, planBranch } from "../../lib/worktrees";
import { git, gitStore } from "../git/api";
import { createWorktree } from "./ops";
import { rangesToIdx, openSwitchWorktree } from "./SwitchWorktree";
import { useWorktreeRows } from "./store";

/** "New Worktree…": pick an existing branch or type a new branch name, and a folder (default: sibling `<repo>-<branch>`). */
export function NewWorktree({ onClose }: PopupProps) {
  const { root } = useStore(projectStore);
  const { status } = useStore(gitStore);
  const { rows, mainPath } = useWorktreeRows();
  const [branch, setBranch] = useState("");
  const [start, setStart] = useState(status?.branch ?? "HEAD");
  const [folder, setFolder] = useState("");
  const [folderTouched, setFolderTouched] = useState(false);
  const [br, setBr] = useState<{ local: string[]; remote: string[] }>({ local: [], remote: [] });
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const base = mainPath ?? root?.path ?? "";

  useEffect(() => {
    input.current?.focus();
    if (root) void git.branches(root).then((b) => setBr({ local: b.local.map((x) => x.name), remote: b.remote.map((x) => x.name) })).catch(() => {});
  }, [root]);
  useEffect(() => { if (!folderTouched && base) setFolder(defaultWorktreePath(base, branch.trim())); }, [branch, base, folderTouched]);

  const list = useMemo(() => rows.map((r) => r.wt), [rows]);
  const free = useMemo(() => freeBranches(br.local, list), [br.local, list]);
  const remoteOnly = useMemo(() => br.remote.filter((r) => !br.local.includes(r.slice(r.indexOf("/") + 1))), [br.remote]);
  const sugg = useMemo(() => {
    const t = branch.trim();
    const all = [...free.map((n) => ({ n, tag: "" })), ...remoteOnly.map((n) => ({ n, tag: "remote" }))];
    return all.map((x) => ({ ...x, m: t ? matchName(t, x.n) : [] })).filter((x) => x.m && x.n !== t).slice(0, 8);
  }, [branch, free, remoteOnly]);

  const t = branch.trim();
  const plan = planBranch(t, br.local, br.remote);
  const usedBy = plan.kind === "existing" ? rows.find((r) => r.wt.branch === t) : undefined;
  const err = !t ? "" : usedBy ? `${t} is already checked out in ${usedBy.name}` : /\s|\.\.|[~^:?*[\\]/.test(t) ? "Not a valid branch name" : "";
  const note = !t ? "Type a branch name, or pick an existing branch below."
    : err ? err
    : plan.kind === "existing" ? `Checks out the existing branch ${t}`
    : plan.kind === "remote" ? `Creates a local branch tracking ${plan.branch}`
    : `Creates new branch ${t} from ${start || "HEAD"}`;
  const ok = !!t && !err && !!isAbsPath(folder.trim()) && !busy;

  const create = async () => {
    if (!ok) return;
    setBusy(true);
    const path = folder.trim().replace(/\/+$/, "");
    onClose();
    const done = await createWorktree({ path, plan, start: start.trim() });
    openSwitchWorktree(done ? path : undefined);
  };
  const onKey = (e: React.KeyboardEvent) => { if (e.key === "Enter") { e.preventDefault(); void create(); } };

  return (
    <PopupShell onClose={onClose} width={580}>
      <div className="popup-tabs"><span className="popup-title">New Worktree</span></div>
      <div className="wt-form" onKeyDown={onKey}>
        <label htmlFor="wt-branch">Branch</label>
        <input id="wt-branch" ref={input} data-testid="wt-branch" value={branch} placeholder="existing branch or new name" spellCheck={false}
          onChange={(e) => setBranch(e.target.value)} />
        {sugg.length > 0 && (
          <div className="wt-sugg" data-testid="wt-sugg">
            {sugg.map((s) => (
              <div key={s.n} className="popup-row" data-name={s.n} onMouseDown={(e) => { e.preventDefault(); setBranch(s.n); }}>
                <span className="gicon"><BranchIcon /></span>&nbsp;<Hl text={s.n} indices={rangesToIdx(s.m ?? [])} />
                {s.tag && <span className="gdim">{s.tag}</span>}
              </div>
            ))}
          </div>
        )}
        {plan.kind === "new" && !!t && !err && (
          <>
            <label htmlFor="wt-start">Start from</label>
            <input id="wt-start" data-testid="wt-start" value={start} spellCheck={false} onChange={(e) => setStart(e.target.value)} />
          </>
        )}
        <label htmlFor="wt-folder">Folder</label>
        <input id="wt-folder" data-testid="wt-folder" value={folder} spellCheck={false} onChange={(e) => { setFolder(e.target.value); setFolderTouched(true); }} />
        <div className={"wt-note" + (err ? " err" : "")} data-testid="wt-note">{note}</div>
      </div>
      <div className="rp-actions" style={{ justifyContent: "flex-end" }}>
        <button onClick={() => { onClose(); openSwitchWorktree(); }}>Cancel</button>
        <button className="primary" data-testid="wt-create" disabled={!ok} style={ok ? undefined : { opacity: 0.5 }} onClick={() => void create()}>Create</button>
      </div>
    </PopupShell>
  );
}
