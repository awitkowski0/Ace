import { useEffect, useMemo, useState } from "react";
import { fs, local, type Location } from "../../lib/ipc";
import { windows } from "../../lib/windows";
import { dedupe, groupWorktrees, mainRepoFromGitFile, recentKey } from "../../lib/recentProjects";

/** Lazy per-folder probes, cached for the life of the window: exists? and (worktree) main repo? Local folders only; remote entries are never pruned. */
const exists = new Map<string, boolean>();
const mainOf = new Map<string, string | null>();
const branches = new Map<string, string | null>();
const tmpdir = ""; // $TMPDIR on macOS lives under /private/var/folders, which dedupe() already filters
let home = "";
let envLoaded: Promise<void> | null = null;
const loadEnv = () => (envLoaded ??= (async () => {
  home = await fs.home().catch(() => "");
})());

async function probe(l: Location) {
  const k = recentKey(l);
  if (exists.has(k)) return;
  const st = await fs.stat(l).catch(() => null);
  exists.set(k, !!st?.exists && !!st.isDir);
  if (!st?.exists || !st.isDir) return;
  const g = await fs.stat(local(l.path + "/.git")).catch(() => null);
  if (g?.isFile) {
    const txt = await fs.readFile(local(l.path + "/.git")).catch(() => "");
    mainOf.set(k, mainRepoFromGitFile(txt));
  } else mainOf.set(k, null);
}

export function useHome() {
  const [h, setH] = useState(home);
  useEffect(() => { void loadEnv().then(() => setH(home)); }, []);
  return h;
}

/** Declutter pipeline shared by the Welcome screen and the project switcher: temp filter -> dedupe -> hide vanished folders -> worktree groups. */
export function useRecentModel(recent: Location[]) {
  const [rev, setRev] = useState(0);
  const base = useMemo(() => dedupe(recent, { tmpdir }), [recent, rev]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    let dead = false;
    void loadEnv().then(async () => {
      if (dead) return;
      const again = dedupe(recent, { tmpdir });
      const todo = again.filter((l) => l.host === "local" && !exists.has(recentKey(l)));
      if (!todo.length && again.length === base.length) return;
      await Promise.all(todo.map(probe));
      if (!dead) setRev((r) => r + 1);
    });
    return () => { dead = true; };
  }, [recent]); // eslint-disable-line react-hooks/exhaustive-deps
  const visible = useMemo(() => base.filter((l) => l.host !== "local" || exists.get(recentKey(l)) !== false), [base, rev]); // eslint-disable-line react-hooks/exhaustive-deps
  const entries = useMemo(() => groupWorktrees(visible, Object.fromEntries(mainOf)), [visible, rev]); // eslint-disable-line react-hooks/exhaustive-deps
  return { visible, entries };
}

/** Current branch (local: Rust reads .git/HEAD, no process); fetched once per project, only for rows that are rendered. */
export function useBranch(l: Location, enabled = true): string | null {
  const k = recentKey(l);
  const [b, setB] = useState<string | null>(branches.get(k) ?? null);
  useEffect(() => {
    if (!enabled || l.host !== "local") return;
    if (branches.has(k)) return void setB(branches.get(k) ?? null);
    let dead = false;
    windows.branch(l).then((x) => { branches.set(k, x); if (!dead) setB(x); }).catch(() => {});
    return () => { dead = true; };
  }, [k, enabled]); // eslint-disable-line react-hooks/exhaustive-deps
  return b;
}
