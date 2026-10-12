/**
 * Git flows for Asset Dev (docs/PROFILES.md): Get latest, branch switching, Save to Git, and the "newer version" check.
 * Built on the git module (git/api.ts + the profiles block in src-tauri/src/git.rs). Local changes are never stashed with a bare
 * `git stash`: they get a unique tagged stash that is re-applied and dropped BY COMMIT ID.
 */
import { invoke, listen, basename, type Location } from "../../lib/ipc";
import { git as gitApi, gitStore, refreshNow, bumpLog, type Change, type Status } from "../git/api";
import { saveAll } from "../../editor/store";
import { projectStore } from "../../lib/project";
import { ask, toast } from "./notice";
import { classifyAsset, userSlug } from "./assets";

const rootOf = (): Location => {
  const r = projectStore.get().root;
  if (!r) throw new Error("No project is open.");
  return r;
};

export interface GitUser { name: string; email: string }
export interface Incoming { behind: number; authors: string[]; tip: string | null; base: string | null; baseBehind: number; baseTip: string | null; baseAuthors: string[] }

export const gx = {
  lsFiles: (root: Location, pathspecs: string[]) => invoke<string[]>("git_ls_files", { root, pathspecs }),
  stashPush: (root: Location, message: string) => invoke<string | null>("git_stash_push", { root, message }),
  stashApply: (root: Location, sha: string) => invoke<string>("git_stash_apply", { root, sha }),
  stashDrop: (root: Location, sha: string) => invoke<boolean>("git_stash_drop", { root, sha }),
  repoState: (root: Location) => invoke<{ rebasing: boolean; merging: boolean }>("git_repo_state", { root }),
  resolve: (root: Location, path: string, side: "ours" | "theirs") => invoke<void>("git_resolve", { root, path, side }),
  rebase: (root: Location, action: "continue" | "abort") => invoke<string>("git_rebase", { root, action }),
  mergeAbort: (root: Location) => invoke<string>("git_merge_abort", { root }),
  user: (root: Location) => invoke<GitUser>("git_user", { root }),
  gh: (root: Location, args: string[]) => invoke<string>("git_gh", { root, args }),
  fetchQuiet: (root: Location) => invoke<void>("git_fetch_quiet", { root }),
  incoming: (root: Location, base: string | null = null) => invoke<Incoming>("git_incoming", { root, base }),
};

const rand = () => Math.random().toString(36).slice(2, 8);
/** unique tag so an autostash is never confused with anybody's own stash */
export const stashTag = () => `ace-autostash-${Date.now().toString(36)}-${rand()}`;

/** Run fetch / pull / push through the git module's streamed job and wait for it (no dialogs; the caller words the failure). */
export async function net(op: "fetch" | "pull" | "push", args: string[]): Promise<{ ok: boolean; text: string }> {
  const root = rootOf();
  const lines = new Map<number, string[]>();
  const done = new Map<number, boolean>();
  const waiters = new Map<number, (ok: boolean) => void>();
  const u1 = await listen<{ job: number; line: string }>("git://output", (e) => { const l = lines.get(e.payload.job) ?? []; l.push(e.payload.line); lines.set(e.payload.job, l); });
  const u2 = await listen<{ job: number; ok: boolean }>("git://done", (e) => { done.set(e.payload.job, e.payload.ok); waiters.get(e.payload.job)?.(e.payload.ok); });
  try {
    const job = await gitApi.stream(root, op, args);
    const ok = done.has(job) ? done.get(job)! : await new Promise<boolean>((res) => waiters.set(job, res));
    return { ok, text: (lines.get(job) ?? []).filter((l) => !/^(Receiving|Resolving|remote:|Counting|Compressing|Writing|Unpacking|Enumerating|Delta)/.test(l)).join("\n").trim() };
  } catch (e) {
    return { ok: false, text: String(e) };
  } finally {
    u1(); u2();
  }
}

export const fresh = async (): Promise<Status> => gitApi.status(rootOf());
export const isCode = (c: { path: string }) => !classifyAsset(c.path);
export const assetChanges = (changes: Change[]) => changes.filter((c) => !!classifyAsset(c.path));

export async function myUser(): Promise<GitUser & { slug: string }> {
  const u = await gx.user(rootOf()).catch(() => ({ name: "", email: "" }));
  return { ...u, slug: userSlug(u.name, u.email) };
}

const friendly = (t: string) => {
  if (/Could not resolve host|unable to access|Connection (refused|timed out)|Network is unreachable|Could not read from remote|Permission denied|Authentication failed/i.test(t))
    return "Couldn't reach the server. Check your internet connection and that you're signed in to GitHub, then try again.";
  return t.split("\n").slice(-3).join(" ").slice(0, 300) || "Something went wrong.";
};

// ---------- conflicts ----------
/** Ask per conflicted file: keep mine / take theirs. `mineIs` = which git side holds the user's version. Returns false when the user cancelled. */
async function resolveConflicts(root: Location, mineIs: "ours" | "theirs", canCancel: boolean): Promise<boolean> {
  const theirsIs = mineIs === "ours" ? "theirs" : "ours";
  let all: "ours" | "theirs" | null = null;
  for (let guard = 0; guard < 500; guard++) {
    const st = await gitApi.status(root);
    const c = st.changes.find((x) => x.kind === "conflict");
    if (!c) return true;
    let side: "ours" | "theirs" | null = all;
    if (!side) {
      const r = await ask({
        title: `Both of you changed ${basename(c.path)}`,
        message: "You and a teammate both changed this file. Which version do you want to keep? The other one is not used.",
        buttons: [{ label: "Keep mine", value: "mine", primary: true }, { label: "Take theirs", value: "theirs" }, ...(canCancel ? [{ label: "Cancel", value: null }] : [])],
        checkbox: "Do the same for the remaining files",
      });
      if (r.value === null) return false;
      side = r.value === "mine" ? mineIs : theirsIs;
      if (r.checked) all = side;
    }
    await gx.resolve(root, c.path, side);
  }
  return true;
}

// ---------- Get latest ----------
export interface LatestResult { ok: boolean; message: string; pulled: number }

export async function getLatest(): Promise<LatestResult> {
  const root = rootOf();
  await saveAll();
  let st = await fresh();
  if (!st.isRepo) return fin(false, "This folder isn't under Git, so there's nothing to get.");
  if (!st.branch) return fin(false, "You're not on a branch. Pick a branch first.");
  if (!st.upstream) return fin(true, `Your branch ${st.branch} hasn't been shared yet, so there's nothing newer to get.`);
  const f = await net("fetch", ["--prune"]);
  if (!f.ok) return fin(false, friendly(f.text));
  st = await fresh();
  if (st.behind === 0) return fin(true, "You already have the latest version.");
  const behind = st.behind;
  const dirty = st.changes.length > 0;
  let sha: string | null = null;
  if (dirty) {
    sha = await gx.stashPush(root, stashTag());
    if (dirty && !sha) return fin(false, "Couldn't set your changes aside safely, so nothing was changed.");
  }
  const restore = async (): Promise<string> => {
    if (!sha) return "";
    try {
      await gx.stashApply(root, sha);
    } catch (e) {
      const s2 = await gitApi.status(root);
      if (s2.changes.some((c) => c.kind === "conflict")) {
        await resolveConflicts(root, "theirs", false);
      } else {
        return ` Your changes are saved safely but couldn't be put back automatically (${friendly(String(e))}). Saved copy: ${sha.slice(0, 8)}.`;
      }
    }
    await gx.stashDrop(root, sha).catch(() => {});
    return "";
  };
  // fast-forward first; if you also saved something that isn't shared yet, put your work on top of the new version
  let p = await net("pull", ["--ff-only"]);
  if (!p.ok && st.ahead > 0) {
    p = await net("pull", ["--rebase"]);
    if (!p.ok) {
      const state = await gx.repoState(root).catch(() => ({ rebasing: false, merging: false }));
      if (state.rebasing) {
        const resolved = await resolveConflicts(root, "theirs", true);
        if (resolved) {
          const c = await gx.rebase(root, "continue").then(() => true, () => false);
          if (c) p = { ok: true, text: "" };
        }
        if (!p.ok) await gx.rebase(root, "abort").catch(() => {});
      }
    }
  }
  if (!p.ok) {
    const note = await restore();
    return fin(false, `Couldn't get the latest version: ${friendly(p.text)}${note}`);
  }
  const note = await restore();
  return fin(true, `You're up to date — got ${behind} update${behind === 1 ? "" : "s"}.${note}`, behind);

  async function fin(ok: boolean, message: string, pulled = 0): Promise<LatestResult> {
    await refreshNow();
    bumpLog();
    toast(message, ok ? "ok" : "warn", ok ? 3500 : 7000);
    return { ok, message, pulled };
  }
}

// ---------- branches ----------
export interface BranchRow { name: string; remote: boolean; current: boolean }
export async function listBranches(): Promise<BranchRow[]> {
  const b = await gitApi.branches(rootOf());
  const local = b.local.map((x) => ({ name: x.name, remote: false, current: x.current }));
  const have = new Set(local.map((x) => x.name));
  const remote = b.remote.map((x) => ({ name: x.name, remote: true, current: false })).filter((x) => !have.has(x.name.replace(/^[^/]+\//, "")));
  return [...local, ...remote];
}

/** Switch branches; with unsaved changes ask whether to bring them along or save first (`saveFirst` runs the Save to Git dialog). */
export async function switchBranch(name: string, remote: boolean, saveFirst: () => Promise<boolean>): Promise<boolean> {
  const root = rootOf();
  await saveAll();
  const st = await fresh();
  const local = remote ? name.replace(/^[^/]+\//, "") : name;
  let sha: string | null = null;
  if (st.changes.length) {
    const r = await ask({
      title: "You have changes that aren't saved to Git",
      message: `Before switching to ${local}: bring your changes with you, or save them to Git first?`,
      buttons: [{ label: "Bring my changes", value: "bring", primary: true }, { label: "Save to Git first", value: "save" }, { label: "Cancel", value: null }],
    });
    if (r.value === null) return false;
    if (r.value === "save") {
      if (!(await saveFirst())) return false;
    } else {
      sha = await gx.stashPush(root, stashTag());
    }
  }
  try {
    const haveLocal = (await gitApi.branches(root)).local.some((b) => b.name === local);
    if (remote && !haveLocal) await gitApi.checkout(root, name, false, undefined, true);
    else await gitApi.checkout(root, local, false);
  } catch (e) {
    if (sha) await gx.stashApply(root, sha).then(() => gx.stashDrop(root, sha!)).catch(() => {});
    toast(`Couldn't switch to ${local}: ${friendly(String(e))}`, "warn", 7000);
    await refreshNow();
    return false;
  }
  let note = "";
  if (sha) {
    try {
      await gx.stashApply(root, sha);
    } catch {
      const s2 = await gitApi.status(root);
      if (s2.changes.some((c) => c.kind === "conflict")) await resolveConflicts(root, "theirs", false);
      else note = ` Your changes are saved safely but couldn't be put back automatically (saved copy ${sha.slice(0, 8)}).`;
    }
    if (!note) await gx.stashDrop(root, sha).catch(() => {});
  }
  await refreshNow();
  bumpLog();
  toast(`Now working on ${local}.${note}`, note ? "warn" : "ok", note ? 7000 : 2500);
  return true;
}

export async function newBranch(fullName: string): Promise<boolean> {
  const root = rootOf();
  await saveAll();
  try {
    await gitApi.checkout(root, fullName, true);
  } catch (e) {
    toast(`Couldn't create that branch: ${friendly(String(e))}`, "warn", 7000);
    return false;
  }
  await refreshNow();
  bumpLog();
  toast(`Started ${fullName}. Your changes came along.`, "ok");
  return true;
}

// ---------- Save to Git ----------
export interface SaveOpts { message: string; changes: Change[]; push: boolean; pr: boolean }
export interface SaveResult { ok: boolean; committed: boolean; pushed: boolean; prUrl: string | null; message: string }

export async function ghAvailable(): Promise<boolean> {
  return gx.gh(rootOf(), ["--version"]).then(() => true, () => false);
}

export async function saveToGit(o: SaveOpts): Promise<SaveResult> {
  const root = rootOf();
  await saveAll();
  const paths = o.changes.map((c) => c.path);
  const origs = o.changes.flatMap((c) => (c.orig ? [c.orig] : []));
  try {
    await gitApi.commit(root, o.message, false, paths, origs);
  } catch (e) {
    await refreshNow();
    return { ok: false, committed: false, pushed: false, prUrl: null, message: `Couldn't save: ${friendly(String(e))}` };
  }
  let st = await fresh();
  let pushed = false;
  let prUrl: string | null = null;
  let message = `Saved ${paths.length} file${paths.length === 1 ? "" : "s"} to Git.`;
  if (o.push && st.branch) {
    const remote = (st.upstream?.split("/")[0]) || "origin";
    const p = await net("push", st.upstream ? [] : ["-u", remote, st.branch]);
    if (p.ok) { pushed = true; message += " Shared with your team."; }
    else if (/rejected|non-fast-forward|fetch first|behind/i.test(p.text)) message += " It's saved on your computer, but someone else shared changes first. Choose Get latest, then Save again.";
    else message += ` It's saved on your computer, but sharing failed: ${friendly(p.text)}`;
  }
  if (o.pr && pushed && st.branch) {
    try {
      const out = await gx.gh(root, ["pr", "create", "--title", o.message.split("\n")[0], "--body", "Asset changes saved from Ace.", "--head", st.branch]);
      prUrl = out.split("\n").map((l) => l.trim()).find((l) => /^https?:\/\//.test(l)) ?? null;
      message += prUrl ? " Review request opened." : " Review request opened.";
    } catch (e) {
      const t = String(e);
      if (/already exists/i.test(t)) {
        prUrl = await gx.gh(root, ["pr", "view", "--json", "url", "--jq", ".url"]).catch(() => null);
        message += " A review request already exists for this branch.";
      } else message += ` Couldn't open a review request: ${friendly(t)}`;
    }
  }
  st = await fresh().catch(() => st);
  await refreshNow();
  bumpLog();
  return { ok: true, committed: true, pushed, prUrl, message };
}
