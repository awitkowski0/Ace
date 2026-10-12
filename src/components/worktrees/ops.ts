import { invoke, sameLoc, type Location } from "../../lib/ipc";
import { openProjectFlow, projectStore } from "../../lib/project";
import { windows } from "../../lib/windows";
import { removeBlocker, type BranchPlan, type WtRow } from "../../lib/worktrees";
import { choiceDialog, confirmDialog } from "../shell/dialogs";
import { toast } from "../profiles/notice";
import { alertError, refreshAll } from "../git/api";
import { loadWorktrees, worktreeStore } from "./store";
import { fileManagerName } from "../../lib/platform";

const rootOrThrow = (): Location => {
  const r = projectStore.get().root;
  if (!r) throw new Error("No project open");
  return r;
};
export const locOf = (path: string): Location => ({ host: rootOrThrow().host, path });

/**
 * Open a worktree as the project. "this" = this window (IntelliJ "This Window": openProjectFlow asks to save/close dirty editors first via
 * confirmWindowClose); "new" = a new native window tab. A worktree already open in another window is focused instead.
 */
export const openWorktree = (path: string, mode: "this" | "new") => openProjectFlow(locOf(path), mode);

export const revealWorktree = (path: string) => {
  if (rootOrThrow().host !== "local") return toast(`Show in ${fileManagerName} works for local worktrees only.`, "info");
  return invoke("claude_reveal", { path }).catch(() => {});
};

export async function createWorktree(o: { path: string; plan: BranchPlan; start: string }): Promise<boolean> {
  const root = rootOrThrow();
  try {
    await invoke<string>("git_worktree_add", {
      root, path: o.path, branch: o.plan.branch, newBranch: o.plan.kind !== "existing",
      start: o.plan.kind === "new" ? o.start || null : null, track: o.plan.kind === "remote",
    });
  } catch (e) {
    await alertError("New Worktree", e);
    return false;
  }
  await loadWorktrees(true);
  return true;
}

const openElsewhere = async (path: string) => {
  const loc = locOf(path);
  const wins = await windows.list().catch(() => []);
  return wins.some((w) => w.project && sameLoc(w.project, loc) && !w.current);
};

/** Remove a linked worktree. Refuses the main/current/open-elsewhere ones; a dirty or locked worktree needs an explicit "Force Remove". Returns true when removed. */
export async function removeWorktreeFlow(row: WtRow): Promise<boolean> {
  const root = rootOrThrow();
  const blocker = removeBlocker(row, await openElsewhere(row.wt.path));
  if (blocker) { toast(blocker, "warn"); return false; }
  let force = false;
  // fresh dirty check (the cache may be up to 15s old)
  let dirty = row.status?.dirty ?? 0;
  if (row.wt.prunable === null) {
    const s = await invoke<{ dirty: number }>("git_worktree_status", { path: locOf(row.wt.path) }).catch(() => null);
    if (s) dirty = s.dirty;
  }
  const label = `${row.name}${row.wt.branch ? ` (${row.wt.branch})` : ""}`;
  if (dirty > 0 || row.wt.locked !== null) {
    const why = dirty > 0 ? `has ${dirty} uncommitted change${dirty === 1 ? "" : "s"}` : `is locked${row.wt.locked ? `: ${row.wt.locked}` : ""}`;
    const r = await choiceDialog({
      title: "Remove Worktree",
      message: `${label} ${why}.\nRemoving it deletes the folder and those changes for good. The branch itself is kept.`,
      buttons: [{ label: "Cancel", value: null, primary: true }, { label: "Force Remove", value: "force" }],
    });
    if (r.value !== "force") return false;
    force = true;
  } else if (!(await confirmDialog({ title: "Remove Worktree", message: `Remove worktree ${label}?\nThe folder ${row.wt.path} is deleted; the branch is kept.`, okLabel: "Remove" }))) return false;
  const attempt = () => invoke<string>("git_worktree_remove", { root, path: row.wt.path, force });
  try {
    await attempt();
  } catch (e) {
    const msg = String(e);
    if (!force && /modified or untracked|use --force|locked/i.test(msg)) {
      const r = await choiceDialog({ title: "Remove Worktree", message: `${msg.slice(0, 400)}\n\nForce removal?`, buttons: [{ label: "Cancel", value: null, primary: true }, { label: "Force Remove", value: "force" }] });
      if (r.value !== "force") return false;
      force = true;
      try { await attempt(); } catch (e2) { await alertError("Remove Worktree", e2); return false; }
    } else { await alertError("Remove Worktree", e); return false; }
  }
  toast(`Removed worktree ${row.name}`, "ok");
  await loadWorktrees(true);
  void refreshAll();
  return true;
}

/** `git worktree prune`: forget entries whose folder is gone. Previews them from the cached `prunable` flags. */
export async function pruneFlow(): Promise<boolean> {
  const root = rootOrThrow();
  await loadWorktrees(true);
  const gone = (worktreeStore.get().list ?? []).filter((w) => w.prunable !== null);
  if (!gone.length) { toast("Nothing to prune: every worktree folder exists.", "info"); return false; }
  const ok = await confirmDialog({ title: "Prune Worktrees", message: `Forget ${gone.length} worktree${gone.length === 1 ? "" : "s"} whose folder is gone?\n${gone.map((w) => w.path).join("\n")}`, okLabel: "Prune" });
  if (!ok) return false;
  try { await invoke("git_worktree_prune", { root }); } catch (e) { await alertError("Prune Worktrees", e); return false; }
  toast(`Pruned ${gone.length} worktree${gone.length === 1 ? "" : "s"}`, "ok");
  await loadWorktrees(true);
  return true;
}
