/** Godot project state for this window: detection (project.godot at the root), lazy scan (scenes, SceneTree scripts, README presets), settings. */
import { createStore } from "../../lib/store";
import { fs, joinPath } from "../../lib/ipc";
import { projectStore } from "../../lib/project";
import { pstore } from "../python/api";
import { godotApi, type GodotBin, type ScanScript } from "./api";
import { parseDevTools, type Preset } from "./presets";

export interface GodotSettings { godotPath: string; recent: string[] }
export interface GodotModel {
  detected: boolean;
  projectDir: string;
  name: string;
  mainScene: string;
  scenes: string[];
  scripts: ScanScript[];
  presets: Preset[];
  scanned: boolean;
  scanning: boolean;
  /** a project file changed since the last scan */
  stale: boolean;
  scans: number;
  bin: GodotBin | null;
  settings: GodotSettings;
}
const EMPTY: GodotModel = {
  detected: false, projectDir: "", name: "", mainScene: "", scenes: [], scripts: [], presets: [], scanned: false, scanning: false, stale: false, scans: 0, bin: null,
  settings: { godotPath: "", recent: [] },
};
export const godotStore = createStore<GodotModel>({ ...EMPTY });

let detectionHook: ((yes: boolean) => void) | null = null;
export const setDetectionHook = (f: (yes: boolean) => void) => { detectionHook = f; };

let key = "";
let seq = 0;

/** One stat of project.godot (local projects only). Everything else waits for the first use. */
export async function detectGodot() {
  const root = projectStore.get().root;
  const k = root ? `${root.host}:${root.path}` : "";
  if (k === key) return;
  key = k;
  const n = ++seq;
  const was = godotStore.get().detected;
  if (!root || root.host !== "local") {
    godotStore.set({ ...EMPTY });
    if (was) detectionHook?.(false);
    return;
  }
  const st = await fs.stat({ host: "local", path: joinPath(root.path, "project.godot") }).catch(() => null);
  if (n !== seq) return;
  const yes = !!st?.exists && st.isFile;
  godotStore.set({ ...EMPTY, detected: yes, projectDir: yes ? root.path : "" });
  if (yes) void loadSettings();
  if (yes !== was) detectionHook?.(yes);
}

async function loadSettings() {
  const root = projectStore.get().root;
  if (!root) return;
  const s = await pstore.get<Partial<GodotSettings>>(root, "godot");
  godotStore.set({ settings: { godotPath: s?.godotPath ?? "", recent: Array.isArray(s?.recent) ? s!.recent!.filter((x) => typeof x === "string") : [] } });
}
export async function saveSettings(patch: Partial<GodotSettings>) {
  const root = projectStore.get().root;
  const settings = { ...godotStore.get().settings, ...patch };
  godotStore.set({ settings });
  if (root) await pstore.set(root, "godot", settings).catch(() => {});
}
export function addRecentScene(res: string) {
  const cur = godotStore.get().settings.recent.filter((x) => x !== res);
  void saveSettings({ recent: [res, ...cur].slice(0, 8) });
}

let scanning: Promise<void> | null = null;
/** Scan the project (Rust, one walk): scenes, tool scripts, README. Cached; `force` rescans. */
export function ensureScan(force = false): Promise<void> {
  const m = godotStore.get();
  if (!m.detected) return Promise.resolve();
  if (m.scanned && !m.stale && !force) return Promise.resolve();
  if (scanning) return scanning;
  const n = seq;
  godotStore.set({ scanning: true });
  scanning = godotApi.scan(m.projectDir).then((s) => {
    if (n !== seq) return;
    godotStore.set((st) => ({
      name: s.name, mainScene: s.mainScene, scenes: s.scenes, scripts: s.scripts, presets: parseDevTools(s.readme), scanned: true, scanning: false, stale: false, scans: st.scans + 1,
    }));
  }).catch(() => godotStore.set({ scanning: false })).finally(() => { scanning = null; });
  return scanning;
}

/** The executable: the configuration's own path, else the project setting, else PATH / Homebrew / Godot.app. */
export async function godotBinary(cfgPath?: string): Promise<GodotBin> {
  const want = (cfgPath || godotStore.get().settings.godotPath || "").trim();
  const bin = await godotApi.find(want);
  if (!bin) {
    throw new Error(want ? `Godot executable not found or not executable: ${want}` : "Godot executable not found. Install Godot (brew install godot) or set the path in Godot > Set Godot Executable… or in the run configuration.");
  }
  godotStore.set({ bin });
  return bin;
}

// project files changed on disk: the next scan picks them up (rescan right away only if one has happened)
let timer: ReturnType<typeof setTimeout> | undefined;
let watching = false;
export function watchGodot() {
  if (watching) return;
  watching = true;
  void fs.onChanged((e) => {
    const m = godotStore.get();
    const root = projectStore.get().root;
    if (!m.detected || !root || e.root !== root.path) return;
    if (!e.paths.some((p) => /\.(tscn|gd)$/.test(p) || p.endsWith("/README.md") || p.endsWith("/project.godot"))) return;
    godotStore.set({ stale: true });
    clearTimeout(timer);
    if (m.scanned) timer = setTimeout(() => void ensureScan(true), 600);
  });
}

projectStore.subscribe(() => void detectGodot());
