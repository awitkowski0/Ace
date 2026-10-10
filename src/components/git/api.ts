import { invoke, listen, fs, locKey, type Location } from "../../lib/ipc";
import { createStore } from "../../lib/store";
import { projectStore } from "../../lib/project";
import { setBranch } from "../../lib/shell";
import { saveAll } from "../../editor/store";
import { confirmDialog } from "../shell/dialogs";

export interface Change {
  path: string;
  orig: string | null;
  index: string;
  worktree: string;
  kind: "modified" | "added" | "deleted" | "renamed" | "copied" | "typechange" | "conflict" | "untracked";
}
export interface Status {
  isRepo: boolean;
  toplevel: string;
  branch: string | null;
  detached: boolean;
  oid: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  changes: Change[];
}
export interface Branch { name: string; upstream: string | null; current: boolean }
export interface Branches { local: Branch[]; remote: Branch[] }
export interface Commit { hash: string; parents: string[]; author: string; email: string; time: number; refs: string[]; subject: string }
export interface CommitFile { status: string; path: string; orig: string | null }
export interface BlameRange { start: number; count: number; hash: string; author: string; time: number; summary: string }
export interface LineChange { kind: "added" | "modified" | "deleted"; start: number; end: number }

export const git = {
  status: (root: Location) => invoke<Status>("git_status", { root }),
  show: (root: Location, rev: string, path: string) => invoke<string | null>("git_show", { root, rev, path }),
  lineChanges: (root: Location, path: string) => invoke<LineChange[]>("git_line_changes", { root, path }),
  stage: (root: Location, paths: string[]) => invoke<void>("git_stage", { root, paths }),
  unstage: (root: Location, paths: string[]) => invoke<void>("git_unstage", { root, paths }),
  rollback: (root: Location, items: { path: string; orig: string | null; kind: string }[]) => invoke<void>("git_rollback", { root, items }),
  commit: (root: Location, message: string, amend: boolean, paths: string[], origs: string[]) => invoke<string>("git_commit", { root, message, amend, paths, origs }),
  body: (root: Location, rev: string) => invoke<string>("git_commit_body", { root, rev }),
  branches: (root: Location) => invoke<Branches>("git_branches", { root }),
  checkout: (root: Location, name: string, create = false, startPoint?: string, track = false) =>
    invoke<string>("git_checkout", { root, name, create, startPoint: startPoint ?? null, track }),
  deleteBranch: (root: Location, name: string, force = false) => invoke<string>("git_delete_branch", { root, name, force }),
  stream: (root: Location, op: "fetch" | "pull" | "push", args: string[]) => invoke<number>("git_stream", { root, op, args }),
  log: (root: Location, skip: number, limit: number, all: boolean, search?: string) =>
    invoke<Commit[]>("git_log", { root, skip, limit, all, rev: null, search: search ?? null }),
  commitFiles: (root: Location, hash: string) => invoke<CommitFile[]>("git_commit_files", { root, hash }),
  blame: (root: Location, path: string) => invoke<BlameRange[]>("git_blame", { root, path }),
  cancel: (job: number) => invoke<void>("procs_kill", { id: job }),
};

// ---------------- state ----------------

export interface ConsoleLine { text: string; kind: "cmd" | "out" | "err" | "ok"; job?: number }
interface GitState {
  root: Location | null;
  status: Status | null;
  console: ConsoleLine[];
  job: number | null; // running streamed job
  logVersion: number; // bump to make the Log tab reload
}
export const gitStore = createStore<GitState>({ root: null, status: null, console: [], job: null, logVersion: 0 });

export const absLoc = (rel: string): Location => {
  const { root, status } = gitStore.get();
  const base = status?.toplevel || root?.path || "";
  return { host: root?.host ?? "local", path: `${base}/${rel}` };
};
/** Repo-relative path for a Location inside the current repo, else null. */
export const relPath = (loc: Location): string | null => {
  const { root, status } = gitStore.get();
  if (!root || !status?.isRepo || loc.host !== root.host) return null;
  const base = status.toplevel + "/";
  return loc.path.startsWith(base) ? loc.path.slice(base.length) : null;
};

export function log(text: string, kind: ConsoleLine["kind"] = "out", job?: number) {
  gitStore.set((s) => {
    const last = s.console[s.console.length - 1];
    // collapse progress updates ("Receiving objects: 45%") into one line
    const prog = (t: string) => (/\d+%/.test(t) ? t.split(":")[0] : null);
    const lines =
      last && job !== undefined && last.job === job && prog(text) && prog(text) === prog(last.text)
        ? [...s.console.slice(0, -1), { text, kind, job }]
        : [...s.console, { text, kind, job }];
    return { console: lines.length > 2000 ? lines.slice(-1500) : lines };
  });
}

// ---------------- refresh ----------------

let seq = 0;
let timer: number | undefined;
export function refreshNow() {
  const root = gitStore.get().root;
  if (!root) return Promise.resolve();
  const my = ++seq;
  return git
    .status(root)
    .then((st) => {
      if (my !== seq) return;
      gitStore.set({ status: st });
      setBranch(!st.isRepo ? null : st.branch ?? (st.oid ? `${st.oid.slice(0, 7)} (detached)` : "No commits"));
    })
    .catch((e) => {
      if (my !== seq) return;
      gitStore.set({ status: null });
      log(String(e), "err");
    });
}
export function refreshSoon(ms = 300) {
  clearTimeout(timer);
  timer = window.setTimeout(refreshNow, ms);
}
export const bumpLog = () => gitStore.set((s) => ({ logVersion: s.logVersion + 1 }));
export const refreshAll = () => Promise.all([refreshNow(), Promise.resolve(bumpLog())]);

const interesting = (p: string) => {
  const i = p.indexOf("/.git/");
  if (i < 0) return !p.endsWith("/.git");
  const rest = p.slice(i + 6);
  return rest === "HEAD" || rest === "index" || rest.startsWith("refs/");
};

let started = false;
export function startGit() {
  if (started) return;
  started = true;
  let last = "";
  const onProject = () => {
    const root = projectStore.get().root;
    const k = root ? locKey(root) : "";
    if (k === last) return;
    last = k;
    gitStore.set({ root, status: null, console: [], job: null });
    if (root) refreshNow();
    else setBranch(null);
  };
  projectStore.subscribe(onProject);
  onProject();
  fs.onChanged((e) => {
    const root = gitStore.get().root;
    if (root && root.host === "local" && e.paths.some(interesting)) refreshSoon();
  });
  window.addEventListener("focus", () => refreshSoon(150));

  const waiters = new Map<number, (ok: boolean) => void>();
  const finished = new Map<number, boolean>();
  streamWaiters.waiters = waiters;
  streamWaiters.finished = finished;
  listen<{ job: number; line: string }>("git://output", (e) => log(e.payload.line, "out", e.payload.job));
  listen<{ job: number; op: string; ok: boolean; code: number | null }>("git://done", (e) => {
    const { job, op, ok, code } = e.payload;
    log(ok ? `git ${op} finished` : `git ${op} failed (exit ${code ?? "killed"})`, ok ? "ok" : "err", job);
    gitStore.set({ job: null });
    const w = waiters.get(job);
    if (w) { waiters.delete(job); w(ok); } else finished.set(job, ok);
    refreshAll();
  });
}
const streamWaiters: { waiters: Map<number, (ok: boolean) => void>; finished: Map<number, boolean> } = { waiters: new Map(), finished: new Map() };

// ---------------- operations ----------------

const rootOrNull = () => gitStore.get().root;

export async function alertError(title: string, e: unknown) {
  log(String(e), "err");
  await confirmDialog({ title, message: String(e).slice(0, 600), okLabel: "OK" });
}

/** Run a streamed network op; resolves with success. Shows an error dialog on failure. */
export async function stream(op: "fetch" | "pull" | "push", args: string[] = []): Promise<boolean> {
  const root = rootOrNull();
  if (!root) return false;
  if (gitStore.get().job !== null) { log("Another git operation is still running", "err"); return false; }
  log(`$ git ${[op, ...args].join(" ")}`, "cmd");
  try {
    const job = await git.stream(root, op, args);
    gitStore.set({ job });
    const ok = await new Promise<boolean>((resolve) => {
      if (streamWaiters.finished.has(job)) { resolve(streamWaiters.finished.get(job)!); streamWaiters.finished.delete(job); }
      else streamWaiters.waiters.set(job, resolve);
    });
    if (!ok) {
      const tail = gitStore.get().console.filter((l) => l.job === job).slice(-4).map((l) => l.text).join("\n");
      await confirmDialog({ title: `${op[0].toUpperCase()}${op.slice(1)} Failed`, message: tail || `git ${op} failed`, okLabel: "OK" });
    }
    return ok;
  } catch (e) {
    await alertError("Git", e);
    return false;
  }
}

export const fetchAll = () => stream("fetch", ["--all", "--prune"]);
export async function updateProject() {
  await saveAll();
  return stream("pull");
}
export async function pushCurrent() {
  const st = gitStore.get().status;
  if (!st?.isRepo || !st.branch) return false;
  return stream("push", st.upstream ? [] : ["-u", "origin", st.branch]);
}

/** Run a short git command with console logging + error dialog. */
export async function exec<T>(label: string, fn: () => Promise<T>): Promise<T | undefined> {
  log(`$ git ${label}`, "cmd");
  try {
    const r = await fn();
    if (typeof r === "string" && r.trim()) log(r.trim(), "out");
    return r;
  } catch (e) {
    await alertError("Git", e);
    return undefined;
  } finally {
    refreshAll();
  }
}

export async function checkout(name: string, opts: { create?: boolean; startPoint?: string; track?: boolean } = {}) {
  const root = rootOrNull();
  if (!root) return;
  await saveAll();
  await exec(`checkout ${opts.create ? "-b " : opts.track ? "--track " : ""}${name}`, () => git.checkout(root, name, !!opts.create, opts.startPoint, !!opts.track));
}
