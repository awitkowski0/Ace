/** Pure git-worktree model (no IPC, unit-tested in worktrees.test.ts): porcelain parsing, row model, filtering, default folder naming. */
import { basename, dirname, joinPath } from "./paths";
import { matchName, type Range } from "./speedSearch";
import { normalizePath } from "./recentProjects";

export interface Worktree {
  path: string;
  head: string | null;
  /** short branch name ("feature/x"), null when detached / bare */
  branch: string | null;
  detached: boolean;
  bare: boolean;
  /** lock reason ("" = locked without a reason), null = not locked */
  locked: string | null;
  /** prune reason ("gitdir file points to non-existent location"), null = fine */
  prunable: string | null;
  /** the first entry of `git worktree list` (the main working tree) */
  main: boolean;
}

export interface WtStatus { dirty: number; ahead: number; behind: number; upstream: string | null; branch?: string | null; detached?: boolean }

/** `git worktree list --porcelain`: blocks separated by a blank line; the first block is the main working tree. */
export function parseWorktreePorcelain(text: string): Worktree[] {
  const out: Worktree[] = [];
  let cur: Worktree | null = null;
  const flush = () => { if (cur) out.push(cur); cur = null; };
  for (const line of text.split(/\r?\n/)) {
    if (!line) { flush(); continue; }
    const sp = line.indexOf(" ");
    const key = sp < 0 ? line : line.slice(0, sp);
    const val = sp < 0 ? "" : line.slice(sp + 1);
    if (key === "worktree") { flush(); cur = { path: val, head: null, branch: null, detached: false, bare: false, locked: null, prunable: null, main: false }; continue; }
    if (!cur) continue;
    if (key === "HEAD") cur.head = /^0+$/.test(val) ? null : val;
    else if (key === "branch") cur.branch = val.replace(/^refs\/heads\//, "");
    else if (key === "detached") cur.detached = true;
    else if (key === "bare") cur.bare = true;
    else if (key === "locked") cur.locked = val;
    else if (key === "prunable") cur.prunable = val || "gone";
  }
  flush();
  if (out[0]) out[0].main = true;
  return out;
}

const base = (p: string) => basename(p) || p;

export interface WtRow {
  wt: Worktree;
  /** folder name */
  name: string;
  /** branch name, or "detached @ abc1234" / "bare" */
  branch: string;
  current: boolean;
  status: WtStatus | null;
}

export const branchLabel = (w: Worktree): string =>
  w.branch ?? (w.bare ? "bare" : w.detached || w.head ? `detached @ ${(w.head ?? "").slice(0, 7)}` : "no commits");

/** Index of the worktree containing `root` (longest path prefix; `toplevel` = git's own top-level for the project, preferred when given). */
export function currentIndex(list: Worktree[], root: string, toplevel?: string | null): number {
  const cands = [toplevel, root].filter(Boolean).map((p) => normalizePath(p as string));
  for (const c of cands) {
    let best = -1, len = -1;
    list.forEach((w, i) => {
      const p = normalizePath(w.path);
      if ((c === p || c.startsWith(p + "/")) && p.length > len) { best = i; len = p.length; }
    });
    if (best >= 0) return best;
  }
  return -1;
}

export function buildRows(list: Worktree[], statuses: Record<string, WtStatus | undefined>, root: string, toplevel?: string | null): WtRow[] {
  const cur = currentIndex(list, root, toplevel);
  return list.map((wt, i) => ({ wt, name: base(wt.path), branch: branchLabel(wt), current: i === cur, status: statuses[normalizePath(wt.path)] ?? null }));
}

export interface WtHit { row: WtRow; name: Range[]; branch: Range[]; path: Range[] }

/** Search over folder name, branch and path with the shared speed-search matcher. Empty query keeps the order. Name hits rank first. */
export function filterRows(rows: WtRow[], query: string): WtHit[] {
  const q = query.trim();
  if (!q) return rows.map((row) => ({ row, name: [], branch: [], path: [] }));
  const hits: { h: WtHit; rank: number; i: number }[] = [];
  rows.forEach((row, i) => {
    const n = matchName(q, row.name), b = matchName(q, row.branch);
    const p = n || b ? null : matchName(q, row.wt.path);
    if (!n && !b && !p) return;
    hits.push({ h: { row, name: n ?? [], branch: b ?? [], path: p ?? [] }, rank: n ? 0 : b ? 1 : 2, i });
  });
  return hits.sort((a, b) => a.rank - b.rank || a.i - b.i).map((x) => x.h);
}

/** Folder-name safe version of a branch: "feature/foo bar" -> "feature-foo-bar". */
export const folderSafe = (branch: string): string => branch.trim().replace(/^refs\/(heads|remotes)\//, "").replace(/[\\/:*?"<>|\s]+/g, "-").replace(/^-+|-+$/g, "");

/**
 * Default folder for a new worktree: a sibling of the main working tree named `<repo>-<branch>` (the layout Welcome's
 * groupWorktrees recognises). `mainPath` is the main working tree, so a worktree of a worktree still names after the repo.
 */
export function defaultWorktreePath(mainPath: string, branch: string): string {
  const m = normalizePath(mainPath);
  const slug = folderSafe(branch);
  return joinPath(dirname(m), base(m) + (slug ? "-" + slug : ""));
}

/** Short status badges for a row: "3" (dirty), "↑2", "↓1". */
export interface Badge { kind: "dirty" | "ahead" | "behind" | "locked" | "prunable"; text: string; title: string }
export function badges(r: WtRow): Badge[] {
  const out: Badge[] = [];
  const s = r.status;
  if (s && s.dirty > 0) out.push({ kind: "dirty", text: String(s.dirty), title: `${s.dirty} changed file${s.dirty === 1 ? "" : "s"}` });
  if (s && s.ahead > 0) out.push({ kind: "ahead", text: `↑${s.ahead}`, title: `${s.ahead} commit${s.ahead === 1 ? "" : "s"} ahead of ${s.upstream ?? "upstream"}` });
  if (s && s.behind > 0) out.push({ kind: "behind", text: `↓${s.behind}`, title: `${s.behind} commit${s.behind === 1 ? "" : "s"} behind ${s.upstream ?? "upstream"}` });
  if (r.wt.locked !== null) out.push({ kind: "locked", text: "locked", title: r.wt.locked ? `Locked: ${r.wt.locked}` : "Locked" });
  if (r.wt.prunable !== null) out.push({ kind: "prunable", text: "missing", title: `Folder is gone (${r.wt.prunable}); Prune removes the entry` });
  return out;
}

/** Why a worktree cannot be removed right now (null = removable, git may still object). */
export function removeBlocker(r: WtRow, openElsewhere = false): string | null {
  if (r.wt.main) return "The main working tree cannot be removed.";
  if (r.current) return "This is the worktree you are in. Switch to another one first.";
  if (openElsewhere) return "This worktree is open in another window. Close that window first.";
  return null;
}

/** Local branch names that can still get a worktree (git allows each branch in one worktree only). */
export function freeBranches(local: string[], list: Worktree[]): string[] {
  const used = new Set(list.map((w) => w.branch).filter(Boolean));
  return local.filter((b) => !used.has(b));
}

/** What `git worktree add` should do for the typed branch: check out an existing local branch, track a remote one, or create a new branch. */
export type BranchPlan = { kind: "existing" | "remote" | "new"; branch: string };
export function planBranch(typed: string, local: string[], remote: string[]): BranchPlan {
  const t = typed.trim();
  if (local.includes(t)) return { kind: "existing", branch: t };
  if (remote.includes(t)) return { kind: "remote", branch: t };
  const viaOrigin = remote.find((r) => r.slice(r.indexOf("/") + 1) === t);
  if (viaOrigin && !local.includes(t)) return { kind: "remote", branch: viaOrigin };
  return { kind: "new", branch: t };
}

/** Claude agent worktrees (`<repo>/.claude/worktrees/*`): listed in a collapsed group at the bottom. */
export const isAgentPath = (p: string): boolean => p.includes("/.claude/worktrees/");
export type AgentEntry<T> = { row: T } | { group: { count: number; open: boolean } };
/** Normal rows first, then (if any agent rows) a "Agent worktrees (n)" header, then the agent rows when expanded or while searching. */
export function layoutAgents<T>(items: T[], isAgent: (t: T) => boolean, expanded: boolean, searching: boolean): AgentEntry<T>[] {
  const normal = items.filter((x) => !isAgent(x)), agents = items.filter(isAgent);
  const out: AgentEntry<T>[] = normal.map((row) => ({ row }));
  if (agents.length) {
    const open = expanded || searching;
    out.push({ group: { count: agents.length, open } });
    if (open) out.push(...agents.map((row) => ({ row })));
  }
  return out;
}
