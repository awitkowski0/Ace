import { open } from "@tauri-apps/plugin-dialog";
import { createStore } from "./store";
import { basename, fs, invoke, local, locKey, type Location } from "./ipc";

const RECENT_KEY = "atelier.recent";

function readRecent(): Location[] {
  try {
    return JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]");
  } catch {
    return [];
  }
}

export const projectStore = createStore<{ root: Location | null; recent: Location[]; ready: boolean }>({
  root: null,
  recent: readRecent(),
  ready: false,
});

export const projectName = (l: Location) => basename(l.path) || l.path;
export const projectKey = (l: Location) => locKey(l);

export async function openProject(loc: Location) {
  const prev = projectStore.get().root;
  if (prev) fs.unwatch(prev).catch(() => {});
  const recent = [loc, ...projectStore.get().recent.filter((r) => locKey(r) !== locKey(loc))].slice(0, 10);
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(recent));
  } catch {}
  projectStore.set({ root: loc, recent });
  fs.watch(loc).catch((e) => console.warn("watch failed", e));
}

export function closeProject() {
  const prev = projectStore.get().root;
  if (prev) fs.unwatch(prev).catch(() => {});
  projectStore.set({ root: null });
}

export async function pickAndOpenFolder() {
  const dir = await open({ directory: true, multiple: false, title: "Open Folder" });
  if (typeof dir === "string") await openProject(local(dir));
}

/** Parse "mc:/srv/app" / "host:~/x" / "ssh://host/path" into a Location (null if not remote syntax). */
export function parseRemote(text: string): Location | null {
  const t = text.trim();
  const m = /^(?:ssh:\/\/)?([A-Za-z0-9._-]+)[:](\/.*|~.*)$/.exec(t) ?? /^ssh:\/\/([A-Za-z0-9._-]+)(\/.*)$/.exec(t);
  return m ? { host: m[1], path: m[2].length > 1 ? m[2].replace(/\/+$/, "") : m[2] } : null;
}

/** "Open Remote Project…": prompt for `host:/path` (e.g. `mc:/home/alexw/app`) and open it as the project root. */
export async function openRemoteProject() {
  const { promptDialog } = await import("../components/shell/dialogs");
  const text = await promptDialog({ title: "Open Remote Project (host:/path)", initial: "mc:~", okLabel: "Open" });
  if (!text) return;
  const loc = parseRemote(text);
  if (!loc) return void alert("Use the form host:/absolute/path, e.g. mc:/home/alexw");
  if (loc.path === "~" || loc.path.startsWith("~/")) {
    const home = await invoke<string>("remote_home", { host: loc.host }).catch(() => null);
    if (home) loc.path = loc.path === "~" ? home : home + loc.path.slice(1);
  }
  const st = await fs.stat(loc).catch(() => null);
  if (!st?.exists || !st.isDir) return void alert(`${loc.host}:${loc.path} is not a directory`);
  await openProject(loc);
}

/** Startup: most recent project, else ~/thematic-kyf in dev, else welcome screen. */
let inited = false;
export async function initProject() {
  if (inited) return;
  inited = true;
  const { recent } = projectStore.get();
  for (const r of recent) {
    const st = await Promise.race([
      fs.stat(r).catch(() => null),
      r.host === "local" ? new Promise<null>(() => {}) : new Promise<null>((res) => setTimeout(() => res(null), 4000)),
    ]);
    if (st?.exists && st.isDir) {
      await openProject(r);
      projectStore.set({ ready: true });
      return;
    }
  }
  if (import.meta.env.DEV) {
    const def = local(`${await fs.home()}/thematic-kyf`);
    const st = await fs.stat(def).catch(() => null);
    if (st?.exists && st.isDir) await openProject(def);
  }
  projectStore.set({ ready: true });
}
