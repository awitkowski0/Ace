/**
 * Gradle project state of the window: detection, cache, discovery (docs/GRADLE.md).
 * Nothing runs for a non-Gradle project (one directory listing at project open). Discovery spawns only when there is no cache,
 * the cache fingerprint no longer matches, or on Reload. No polling: file events (existing fs watcher) trigger a fingerprint check.
 */
import { createStore } from "../../lib/store";
import { fs, type Location } from "../../lib/ipc";
import { projectStore } from "../../lib/project";
import { pstore } from "../python/api";
import { gradleApi } from "./api";
import { subprojectDirs, type GModel } from "./tree";

export interface GradleState {
  detected: boolean;
  status: "idle" | "loading" | "ready" | "error";
  model: GModel | null;
  error: string | null;
  fromCache: boolean;
  startedAt: number;
  lastMs: number | null;
  offline: boolean | null;
  /** discoveries started by this window since it opened (test hook: a cache hit leaves it at 0) */
  discoveries: number;
  fingerprint: string | null;
}
export const gradleStore = createStore<GradleState>({
  detected: false, status: "idle", model: null, error: null, fromCache: false, startedAt: 0, lastMs: null, offline: null, discoveries: 0, fingerprint: null,
});

const MARKERS = ["settings.gradle", "settings.gradle.kts", "build.gradle", "build.gradle.kts"];
const WATCHED = /(^|\/)(settings|build)\.gradle(\.kts)?$|(^|\/)gradle\.properties$|gradle-wrapper\.properties$|\.gradle(\.kts)?$|libs\.versions\.toml$/;
const IGNORED = /\/(build|\.gradle|node_modules|\.git|\.idea)\//;
const CACHE_V = 1;
interface Cache { v: number; fp: string; model: GModel; at: number; ms: number }

const rootKey = (r: Location | null) => (r ? `${r.host}:${r.path}` : "");
let key = "";
let running = false;
let again = false;
let gen = 0;
const hooks = { onDetected: (_yes: boolean) => {} };
export const setDetectionHook = (f: (yes: boolean) => void) => { hooks.onDetected = f; };

export async function detectGradle(root: Location): Promise<boolean> {
  try {
    const list = await fs.listDir(root);
    return list.some((e) => !e.isDir && MARKERS.includes(e.name));
  } catch { return false; }
}

const fingerprintOf = (root: Location, model: GModel | null) => gradleApi.fingerprint(root, subprojectDirs(model, root.path));

/** Project (window) opened or switched. */
export async function syncProject() {
  const root = projectStore.get().root;
  const k = rootKey(root);
  if (k === key) return;
  const prev = key;
  key = k;
  const g = ++gen;
  if (prev) cancelDiscovery(prevRoot);
  prevRoot = root;
  gradleStore.set({ detected: false, status: "idle", model: null, error: null, fromCache: false, lastMs: null, offline: null, fingerprint: null });
  hooks.onDetected(false);
  if (!root) return;
  await checkDetected(root, g);
}
let prevRoot: Location | null = null;

async function checkDetected(root: Location, g = gen) {
  const yes = await detectGradle(root);
  if (g !== gen || gradleStore.get().detected === yes) return;
  gradleStore.set({ detected: yes });
  hooks.onDetected(yes);
  if (!yes) return gradleStore.set({ status: "idle", model: null });
  const cache = await pstore.get<Cache>(root, "gradle").catch(() => null);
  if (g !== gen) return;
  if (cache && cache.v === CACHE_V && cache.model?.projects) {
    gradleStore.set({ model: cache.model, status: "ready", fromCache: true, lastMs: cache.ms, fingerprint: cache.fp });
    let fp: string | null = null;
    try { fp = await fingerprintOf(root, cache.model); } catch { /* unknown -> reload */ }
    if (g !== gen) return;
    if (fp === cache.fp) return; // valid cache: no spawn
  }
  void reloadGradle();
}

function cancelDiscovery(root: Location | null) {
  if (root && running) void gradleApi.cancel(root).catch(() => {});
}

/** Reload All Gradle Projects: one discovery at a time per window (and per root in Rust). */
export async function reloadGradle() {
  const root = projectStore.get().root;
  if (!root || !gradleStore.get().detected) return;
  if (running) { again = true; return; }
  running = true;
  const g = gen;
  const t0 = Date.now();
  gradleStore.set({ status: "loading", startedAt: t0, error: null });
  try {
    let busy = 0;
    for (;;) {
      gradleStore.set({ discoveries: gradleStore.get().discoveries + 1 });
      try {
        const d = await gradleApi.discover(root);
        if (g !== gen) return;
        const model = JSON.parse(d.json) as GModel;
        let fp = "";
        try { fp = await fingerprintOf(root, model); } catch { /* cache disabled */ }
        gradleStore.set({ model, status: "ready", error: null, fromCache: false, lastMs: d.elapsedMs, offline: d.offline, fingerprint: fp });
        if (fp) void pstore.set(root, "gradle", { v: CACHE_V, fp, model, at: Date.now(), ms: d.elapsedMs } satisfies Cache).catch(() => {});
        break;
      } catch (e) {
        if (g !== gen) return;
        if (String(e) === "busy" && busy++ < 200) { // another window of the same project is discovering: wait for it, then use its cache
          gradleStore.set({ discoveries: gradleStore.get().discoveries - 1 });
          await new Promise((r) => setTimeout(r, 3000));
          if (g !== gen) return;
          const c = await pstore.get<Cache>(root, "gradle").catch(() => null);
          if (c?.model && c.at >= t0) { gradleStore.set({ model: c.model, status: "ready", fromCache: true, fingerprint: c.fp, lastMs: c.ms }); break; }
          continue;
        }
        gradleStore.set({ status: "error", error: String(e), lastMs: Date.now() - t0 });
        break;
      }
    }
  } finally {
    running = false;
    if (again && g === gen) { again = false; void checkChanged(); }
  }
}

export function cancelReload() { cancelDiscovery(projectStore.get().root); }
export const isLoading = () => running;

/** Build files changed on disk: reload only when the fingerprint differs from the cached one. */
async function checkChanged() {
  const root = projectStore.get().root;
  const st = gradleStore.get();
  if (!root || !st.detected) return;
  if (running) { again = true; return; }
  if (st.status === "error") return void reloadGradle(); // any build file change retries a failed sync
  try {
    const fp = await fingerprintOf(root, st.model);
    if (fp !== st.fingerprint) void reloadGradle();
  } catch { void reloadGradle(); }
}

let timer: ReturnType<typeof setTimeout> | undefined;
let started = false;
export function startGradleWatch() {
  if (started) return;
  started = true;
  projectStore.subscribe(() => void syncProject());
  void syncProject();
  fs.onChanged((e) => {
    const root = projectStore.get().root;
    if (!root || e.root !== root.path) return;
    const hits = e.paths.filter((p) => WATCHED.test(p) && !IGNORED.test(p));
    if (!hits.length) return;
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (!gradleStore.get().detected) void checkDetected(root);
      else void checkChanged();
    }, 500);
  });
}
