/**
 * Worktree cache for the current project's repo. The list (`git worktree list --porcelain`, one process) and per-worktree status
 * (`status --porcelain=v2 --branch -uno`, one cheap process each, run concurrently) are cached so the popups open instantly and
 * refresh in the background. The CURRENT worktree's status is derived from gitStore (no process). Invalidation: fs watch events
 * under `.git/worktrees` mark the list stale; entries older than STATUS_TTL are re-queried when a popup opens; no polling.
 */
import { useEffect, useMemo } from "react";
import { fs, invoke, locKey, type Location } from "../../lib/ipc";
import { createStore, useStore } from "../../lib/store";
import { projectStore } from "../../lib/project";
import { normalizePath } from "../../lib/recentProjects";
import { buildRows, parseWorktreePorcelain, type WtRow, type WtStatus, type Worktree } from "../../lib/worktrees";
import { gitStore } from "../git/api";

const STATUS_TTL = 15_000;
const CONCURRENCY = 4;

interface WtState {
  rootKey: string;
  list: Worktree[] | null;
  statuses: Record<string, WtStatus>;
  at: Record<string, number>;
  loading: boolean;
  error: string | null;
}
export const worktreeStore = createStore<WtState>({ rootKey: "", list: null, statuses: {}, at: {}, loading: false, error: null });

const rootLoc = (): Location | null => projectStore.get().root;
let inflight: Promise<void> | null = null;
let listStale = true;
const staleStatus = new Set<string>();

/** Reset when the project changes. */
function syncRoot() {
  const r = rootLoc();
  const k = r ? locKey(r) : "";
  if (k === worktreeStore.get().rootKey) return;
  worktreeStore.set({ rootKey: k, list: null, statuses: {}, at: {}, loading: false, error: null });
  listStale = true;
  inflight = null;
}

/** dirty count of tracked changes, like `status -uno` */
const fromGitStore = (): WtStatus | null => {
  const s = gitStore.get().status;
  if (!s?.isRepo) return null;
  return { dirty: s.changes.filter((c) => c.kind !== "untracked").length, ahead: s.ahead, behind: s.behind, upstream: s.upstream, branch: s.branch, detached: s.detached };
};

function updateCurrentFromGit() {
  const st = fromGitStore();
  const s = gitStore.get().status;
  const { list } = worktreeStore.get();
  if (!st || !s?.toplevel || !list) return;
  const k = normalizePath(s.toplevel);
  const w = list.find((x) => normalizePath(x.path) === k);
  if (!w) return;
  const cur = worktreeStore.get().statuses[k];
  if (cur && cur.dirty === st.dirty && cur.ahead === st.ahead && cur.behind === st.behind && cur.upstream === st.upstream) return;
  worktreeStore.set((o) => ({ statuses: { ...o.statuses, [k]: st }, at: { ...o.at, [k]: Date.now() } }));
}

async function pool<T>(items: T[], n: number, fn: (x: T) => Promise<void>) {
  const q = [...items];
  await Promise.all(Array.from({ length: Math.min(n, q.length) }, async () => { for (let x = q.shift(); x !== undefined; x = q.shift()) await fn(x); }));
}

/**
 * Refresh the list (always, 1 process) and any status that is stale. `force` re-queries every status. Concurrent calls share one run.
 * Never throws: a failure lands in `error` and the cached data stays.
 */
export function loadWorktrees(force = false): Promise<void> {
  syncRoot();
  const root = rootLoc();
  if (!root) return Promise.resolve();
  if (inflight && !force) return inflight;
  const key = locKey(root);
  const run = (async () => {
    worktreeStore.set({ loading: true });
    try {
      const raw = await invoke<string>("git_worktree_list", { root });
      if (worktreeStore.get().rootKey !== key) return;
      const list = parseWorktreePorcelain(raw);
      listStale = false;
      // drop statuses of vanished worktrees
      const keep = new Set(list.map((w) => normalizePath(w.path)));
      worktreeStore.set((o) => ({
        list, error: null,
        statuses: Object.fromEntries(Object.entries(o.statuses).filter(([k]) => keep.has(k))),
      }));
      updateCurrentFromGit();
      const now = Date.now();
      const cur = gitStore.get().status?.toplevel ? normalizePath(gitStore.get().status!.toplevel) : null;
      const todo = list.filter((w) => {
        const k = normalizePath(w.path);
        if (w.bare || w.prunable !== null || k === cur) return false;
        return force || staleStatus.has(k) || !(k in worktreeStore.get().at) || now - worktreeStore.get().at[k] > STATUS_TTL;
      });
      await pool(todo, CONCURRENCY, async (w) => {
        const k = normalizePath(w.path);
        staleStatus.delete(k);
        try {
          const s = await invoke<{ dirty: number; ahead: number; behind: number; upstream: string | null; branch: string | null; detached: boolean }>("git_worktree_status", { path: { host: root.host, path: w.path } });
          if (worktreeStore.get().rootKey !== key) return;
          worktreeStore.set((o) => ({ statuses: { ...o.statuses, [k]: s }, at: { ...o.at, [k]: Date.now() } }));
        } catch { /* a broken worktree just shows no badges */ }
      });
    } catch (e) {
      if (worktreeStore.get().rootKey === key) worktreeStore.set({ error: String(e) });
    } finally {
      if (worktreeStore.get().rootKey === key) worktreeStore.set({ loading: false });
      inflight = null;
    }
  })();
  inflight = run;
  return run;
}

/** Mark cached data stale (fs watch hook); the next popup open re-queries. */
export function invalidateWorktrees(path?: string) {
  listStale = true;
  if (path) staleStatus.add(normalizePath(path));
  else for (const w of worktreeStore.get().list ?? []) staleStatus.add(normalizePath(w.path));
}
export const worktreesStale = () => listStale;

let started = false;
/** Prefetch when a repo project opens, keep the current entry in sync with gitStore, invalidate on `.git/worktrees` changes. */
export function startWorktrees() {
  if (started) return;
  started = true;
  let lastTop = "";
  gitStore.subscribe(() => {
    syncRoot();
    const s = gitStore.get().status;
    if (!s?.isRepo) return;
    if (s.toplevel !== lastTop) { lastTop = s.toplevel; void loadWorktrees(true); }
    else updateCurrentFromGit();
  });
  projectStore.subscribe(syncRoot);
  void fs.onChanged((e) => {
    const root = rootLoc();
    if (!root || root.host !== "local") return;
    const hit = e.paths.filter((p) => p.includes("/.git/worktrees/") || p.endsWith("/.git/worktrees"));
    if (!hit.length) return;
    invalidateWorktrees();
  });
}

export function useWorktreeRows(): { rows: WtRow[]; loading: boolean; ready: boolean; error: string | null; mainPath: string | null } {
  const { list, statuses, loading, error } = useStore(worktreeStore);
  const { root } = useStore(projectStore);
  const { status } = useStore(gitStore);
  const rows = useMemo(() => (list && root ? buildRows(list, statuses, root.path, status?.toplevel) : []), [list, statuses, root, status?.toplevel]);
  return { rows, loading, ready: list !== null, error, mainPath: list?.[0]?.path ?? null };
}

/** Kick a background refresh when a component that shows worktrees mounts. */
export function useWorktreeRefresh() {
  useEffect(() => { void loadWorktrees(); }, []);
}
