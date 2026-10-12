import { open } from "@tauri-apps/plugin-dialog";
import { createStore } from "./store";
import { basename, fs, invoke, local, locKey, sameLoc, type Location } from "./ipc";
import { homeShorten } from "./paths";
import { windows } from "./windows";
import { recentKey as normalizeRecentKey } from "./recentProjects";

const RECENT_KEY = "atelier.recent";
const OPEN_IN_KEY = "atelier.openIn";
const MAX_RECENT = 25; // the Welcome screen declutters (temp/missing/duplicate/worktrees), so keep more than the old 10

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

// The recent list is shared by all project windows (same localStorage): keep this window's copy current.
if (typeof window !== "undefined") {
  window.addEventListener("storage", (e) => {
    if (e.key === RECENT_KEY) projectStore.set({ recent: readRecent() });
  });
}

/** "Remove from Recent Projects": only edits the recent-list storage, never the project on disk. Persists across windows. */
export function removeRecent(...locs: Location[]) {
  const gone = new Set(locs.map((l) => normalizeRecentKey(l)));
  const recent = readRecent().filter((r) => !gone.has(normalizeRecentKey(r)));
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(recent));
  } catch {}
  projectStore.set({ recent });
}

export const projectName = (l: Location) => basename(l.path) || l.path;
export const projectKey = (l: Location) => locKey(l);

/** Open `loc` IN THIS WINDOW without any question (startup, harness, empty Welcome window). Use openProjectFlow for user actions. */
export async function openProject(loc: Location) {
  const prev = projectStore.get().root;
  if (prev) fs.unwatch(prev).catch(() => {});
  // read-modify-write against storage, never against this window's possibly stale copy
  const recent = [loc, ...readRecent().filter((r) => locKey(r) !== locKey(loc))].slice(0, MAX_RECENT);
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(recent));
  } catch {}
  projectStore.set({ root: loc, recent });
  windows.setProject(loc).catch(() => {});
  fs.watch(loc).catch((e) => console.warn("watch failed", e));
}

export function closeProject() {
  const prev = projectStore.get().root;
  if (prev) fs.unwatch(prev).catch(() => {});
  projectStore.set({ root: null });
  windows.setProject(null).catch(() => {});
}

export type OpenIn = "ask" | "this" | "new";
/** IntelliJ "Open project in" preference. Default New Window (which macOS merges into a native tab). */
export function getOpenIn(): OpenIn {
  try {
    const v = localStorage.getItem(OPEN_IN_KEY);
    return v === "this" || v === "new" ? v : "ask";
  } catch {
    return "ask";
  }
}
export function setOpenIn(v: OpenIn) {
  try {
    localStorage.setItem(OPEN_IN_KEY, v);
  } catch {}
}

const displayPath = (l: Location) => (l.host === "local" ? homeShorten(l.path) : `${l.host}:${l.path}`);

/**
 * User-initiated open (Open Folder, recent list, project switcher), IntelliJ semantics:
 *  - the project is already open in some window -> focus that window/tab, never a second copy;
 *  - this window is empty (Welcome) -> open here;
 *  - otherwise ask "This Window / New Window" (remembered when "Do not ask again" is ticked; default New Window,
 *    which becomes a native tab of the current frame).
 */
export async function openProjectFlow(loc: Location, mode?: "this" | "new"): Promise<void> {
  const root = projectStore.get().root;
  if (root && sameLoc(root, loc)) return;
  const wins = await windows.list().catch(() => []);
  const existing = wins.find((w) => w.project && sameLoc(w.project, loc));
  if (existing) {
    await windows.focus(existing.label);
    return;
  }
  if (!root) return openProject(loc);
  let choice: "this" | "new" | null = mode ?? null;
  if (!choice) {
    const pref = getOpenIn();
    if (pref !== "ask") choice = pref;
    else {
      const { choiceDialog } = await import("../components/shell/dialogs");
      const r = await choiceDialog({
        title: "Open Project",
        message: `Open ${projectName(loc)} (${displayPath(loc)}) in:`,
        buttons: [
          { label: "This Window", value: "this" },
          { label: "New Window", value: "new", primary: true },
          { label: "Cancel", value: null },
        ],
        checkbox: "Do not ask again",
      });
      if (!r.value) return;
      choice = r.value as "this" | "new";
      if (r.checked) setOpenIn(choice);
    }
  }
  if (choice === "new") {
    const r = await windows.open(loc, true);
    if (r.action !== "here") return;
    return openProject(loc);
  }
  const { confirmWindowClose } = await import("./windowLifecycle");
  if (!(await confirmWindowClose("switch"))) return;
  await windows.switchHere(loc);
}

export async function pickAndOpenFolder() {
  const dir = await open({ directory: true, multiple: false, title: "Open Folder" });
  if (typeof dir === "string") await openProjectFlow(local(dir));
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
  await openProjectFlow(loc);
}

/** Startup: the project Rust assigned to this window (argv, restored session or an open request); else the Welcome screen. */
let inited = false;
export async function initProject() {
  if (inited) return;
  inited = true;
  const arg = await fs.launchLocation().catch(() => null);
  if (arg) await openProject(arg);
  projectStore.set({ ready: true });
}
