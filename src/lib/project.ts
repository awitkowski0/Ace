import { open } from "@tauri-apps/plugin-dialog";
import { createStore } from "./store";
import { basename, fs, local, locKey, type Location } from "./ipc";

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
  if (loc.host === "local") fs.watch(loc).catch((e) => console.warn("watch failed", e));
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

/** Startup: most recent project, else ~/thematic-kyf in dev, else welcome screen. */
let inited = false;
export async function initProject() {
  if (inited) return;
  inited = true;
  const { recent } = projectStore.get();
  for (const r of recent) {
    if (r.host !== "local") continue; // remote reopen is handled once remote fs exists
    const st = await fs.stat(r).catch(() => null);
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
