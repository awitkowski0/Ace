import { fs, basename } from "../../lib/ipc";
import { openDiff as openDiffTab } from "../../editor/store";
import { absLoc, git, gitStore, type Change, type CommitFile } from "./api";
import type { Location } from "../../lib/ipc";

export interface DiffSpec {
  title: string;
  leftLabel: string;
  rightLabel: string;
  left: () => Promise<string>;
  right: () => Promise<string>;
  name: string; // for language detection
  openLoc?: Location; // "Open in editor" target
}

/** Diffs open as editor tabs (IntelliJ parity); the "GitDiff" popup stays registered as a fallback. */
export function openDiff(spec: DiffSpec) {
  openDiffTab(spec);
}

/** HEAD vs working tree for a Commit-window change. */
export function openChangeDiff(c: Change) {
  const root = gitStore.get().root;
  if (!root) return;
  const loc = absLoc(c.path);
  openDiff({
    title: c.path,
    name: basename(c.path),
    leftLabel: "HEAD",
    rightLabel: c.kind === "deleted" ? "Deleted" : "Your version",
    left: async () => (c.kind === "untracked" ? "" : (await git.show(root, "HEAD", c.orig ?? c.path)) ?? ""),
    right: async () => (c.kind === "deleted" ? "" : fs.readFile(loc).catch(() => "")),
    openLoc: c.kind === "deleted" ? undefined : loc,
  });
}

/** parent vs commit for a Log-tab file. */
export function openCommitFileDiff(hash: string, f: CommitFile) {
  const root = gitStore.get().root;
  if (!root) return;
  openDiff({
    title: `${f.path} @ ${hash.slice(0, 8)}`,
    name: basename(f.path),
    leftLabel: `${hash.slice(0, 8)}^`,
    rightLabel: hash.slice(0, 8),
    left: async () => (f.status === "A" ? "" : (await git.show(root, `${hash}^`, f.orig ?? f.path)) ?? ""),
    right: async () => (f.status === "D" ? "" : (await git.show(root, hash, f.path)) ?? ""),
    openLoc: f.status === "D" ? undefined : absLoc(f.path),
  });
}
