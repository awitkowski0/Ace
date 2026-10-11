/**
 * Repo config: `.ace/config.json` at the project root (local or remote), shared with the team through git.
 * Schema: `{ "version": 1, "<section>": {...} }`. Every feature owns ONE top-level section (`gradle`, ...); unknown keys are kept.
 * See docs/CONVENTIONS.md ("Repo config").
 *
 *   const gradle = repoSection<GradleCfg>("gradle");   gradle.get(); gradle.subscribe(fn); await gradle.set({...});
 *   useRepoSection<GradleCfg>("gradle")                React hook (call ensureRepoConfig() once from non-render code first)
 *
 * Reads are lazy (nothing happens until `ensureRepoConfig()` / the first section use in a window). Writes are read-modify-write
 * of the whole file (so an edit made by git or an editor between load and save is not lost), pretty-printed with 2 spaces,
 * `version` first and the other keys in their existing order, trailing newline. The file is created (with `.ace/`) on the first write.
 * A file that is not valid JSON is never overwritten (the error is exposed in `repoConfigStore`).
 */
import { useSyncExternalStore } from "react";
import { createStore } from "./store";
import { fs, joinPath, type Location } from "./ipc";
import { projectStore } from "./project";

export const REPO_CONFIG_VERSION = 1;
export type RepoConfigRaw = Record<string, unknown>;

export function parseRepoConfig(text: string): RepoConfigRaw {
  const v = JSON.parse(text);
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error(".ace/config.json must contain a JSON object");
  return v as RepoConfigRaw;
}
export function serializeRepoConfig(raw: RepoConfigRaw): string {
  const { version: _v, ...rest } = raw;
  return JSON.stringify({ version: REPO_CONFIG_VERSION, ...rest }, null, 2) + "\n";
}

export const repoConfigStore = createStore<{ raw: RepoConfigRaw; loaded: boolean; error: string | null; exists: boolean }>({ raw: {}, loaded: false, error: null, exists: false });

const dirLoc = (r: Location): Location => ({ host: r.host, path: joinPath(r.path, ".ace") });
const fileLoc = (r: Location): Location => ({ host: r.host, path: joinPath(r.path, ".ace/config.json") });
const rootKey = (r: Location | null) => (r ? `${r.host}:${r.path}` : "");

let lastText: string | null = null; // text we last read or wrote (own writes do not trigger a reload)
let watching = "";
let unlisten: (() => void) | null = null;
let timer: ReturnType<typeof setTimeout> | undefined;
let writeChain: Promise<unknown> = Promise.resolve();

async function readFile(root: Location): Promise<string | null> {
  const st = await fs.stat(fileLoc(root)).catch(() => null);
  if (!st?.exists || !st.isFile) return null;
  return fs.readFile(fileLoc(root));
}

/** (Re)read the file into the store. */
export async function reloadRepoConfig(): Promise<void> {
  const root = projectStore.get().root;
  if (!root) return void repoConfigStore.set({ raw: {}, loaded: false, error: null, exists: false });
  const k = rootKey(root);
  let text: string | null;
  try { text = await readFile(root); } catch (e) { text = null; repoConfigStore.set({ error: String(e) }); }
  if (rootKey(projectStore.get().root) !== k) return;
  if (text === lastText && repoConfigStore.get().loaded) return;
  lastText = text;
  if (text === null) return void repoConfigStore.set({ raw: {}, loaded: true, error: null, exists: false });
  try {
    repoConfigStore.set({ raw: parseRepoConfig(text), loaded: true, error: null, exists: true });
  } catch (e) {
    repoConfigStore.set({ raw: {}, loaded: true, error: `.ace/config.json: ${(e as Error).message}`, exists: true });
  }
}

/** Start watching + load for the current project (idempotent, per window). */
export function ensureRepoConfig() {
  const root = projectStore.get().root;
  const k = rootKey(root);
  if (!root || watching === k) return;
  watching = k;
  lastText = null;
  repoConfigStore.set({ raw: {}, loaded: false, error: null, exists: false });
  unlisten?.();
  let off = false;
  fs.onChanged((e) => {
    if (off || e.root !== root.path) return;
    if (!e.paths.some((p) => p.endsWith("/.ace/config.json") || p.endsWith("/.ace"))) return;
    clearTimeout(timer);
    timer = setTimeout(() => void reloadRepoConfig(), 120);
  }).then((u) => { if (off) u(); else unlisten = () => { off = true; u(); }; });
  unlisten = () => { off = true; };
  void reloadRepoConfig();
}
projectStore.subscribe(() => {
  if (watching && rootKey(projectStore.get().root) !== watching) {
    unlisten?.(); unlisten = null; watching = ""; lastText = null;
    repoConfigStore.set({ raw: {}, loaded: false, error: null, exists: false });
  }
});

/** Replace one top-level section (read-modify-write). `undefined` removes it. Throws if the existing file is invalid. */
export function setRepoSection(key: string, value: unknown): Promise<void> {
  const run = async () => {
    const root = projectStore.get().root;
    if (!root) throw new Error("no project");
    let raw: RepoConfigRaw = {};
    const cur = await readFile(root);
    if (cur !== null) raw = parseRepoConfig(cur); // throws on invalid JSON: never clobber a broken file
    if (value === undefined) delete raw[key]; else raw[key] = value;
    const text = serializeRepoConfig(raw);
    if (text === cur) return;
    const st = await fs.stat(dirLoc(root)).catch(() => null);
    if (!st?.exists) await fs.createDir(dirLoc(root));
    lastText = text;
    await fs.writeFile(fileLoc(root), text);
    // a reload that ran meanwhile (external edit right after our write) is newer than this text
    if (lastText === text) repoConfigStore.set({ raw: parseRepoConfig(text), loaded: true, error: null, exists: true });
  };
  const p = writeChain.then(run, run);
  writeChain = p.catch(() => {});
  return p;
}

export function repoSection<T>(key: string) {
  return {
    get: (): T | undefined => repoConfigStore.get().raw[key] as T | undefined,
    subscribe: repoConfigStore.subscribe,
    set: (v: T | undefined) => setRepoSection(key, v),
  };
}
export function useRepoSection<T>(key: string): T | undefined {
  return useSyncExternalStore(repoConfigStore.subscribe, () => repoConfigStore.get().raw[key] as T | undefined);
}
