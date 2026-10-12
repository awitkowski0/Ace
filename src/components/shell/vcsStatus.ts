/** Project-tree VCS colouring (read-only use of the git module's status; see git/api.ts). */
import { isWithin, relativeTo } from "../../lib/paths";
import { useEffect, useMemo, useState } from "react";
import { fs, joinPath, type Location } from "../../lib/ipc";
import { useStore } from "../../lib/store";
import { absLoc, gitStore } from "../git/api";
import { isIgnored, parseGitignore, type IgnoreRule } from "./gitignore";

export type VcsClass = "" | "vcs-modified" | "vcs-added" | "vcs-deleted" | "vcs-conflict" | "vcs-ignored" | "vcs-dir-modified";

export function useVcsClass(root: Location): (path: string, isDir: boolean) => string {
  const { status, root: gitRoot } = useStore(gitStore);
  const [rules, setRules] = useState<IgnoreRule[]>([]);

  useEffect(() => {
    let live = true;
    fs.readFile({ host: root.host, path: joinPath(root.path, ".gitignore") })
      .then((t) => live && setRules(parseGitignore(t)))
      .catch(() => live && setRules([]));
    return () => { live = false; };
  }, [root.host, root.path, status?.oid]);

  const model = useMemo(() => {
    const kinds = new Map<string, VcsClass>();
    const dirs = new Set<string>();
    const untrackedDirs: string[] = [];
    for (const c of status?.changes ?? []) {
      const rel = c.path.replace(/\/$/, "");
      const abs = absLoc(rel).path;
      const cls: VcsClass = c.kind === "conflict" ? "vcs-conflict" : c.kind === "deleted" ? "vcs-deleted"
        : c.kind === "added" || c.kind === "untracked" ? "vcs-added" : "vcs-modified";
      kinds.set(abs, cls);
      if (c.kind === "untracked" && c.path.endsWith("/")) untrackedDirs.push(abs + "/");
      for (let d = abs.slice(0, abs.lastIndexOf("/")); d.length > root.path.length; d = d.slice(0, d.lastIndexOf("/"))) dirs.add(d);
    }
    return { kinds, dirs, untrackedDirs };
  }, [status, root.path]);

  return (path, isDir) => {
    if (!status?.isRepo || !gitRoot || gitRoot.host !== root.host) return "";
    if (path === root.path) return "";
    const direct = model.kinds.get(path);
    if (direct) return direct;
    if (model.untrackedDirs.some((d) => path.startsWith(d))) return "vcs-added";
    const rel = isWithin(root.path, path) ? relativeTo(root.path, path) : null;
    if (rel && rules.length && isIgnored(rules, rel, isDir)) return "vcs-ignored";
    if (isDir && model.dirs.has(path)) return "vcs-dir-modified";
    return "";
  };
}
