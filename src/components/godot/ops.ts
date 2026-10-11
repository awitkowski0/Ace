/** Godot operations: running specs through the Run infra, pinning (.ace/config.json -> godot.pinned), editor / reimport / reload scripts. */
import { ensureConfig } from "../run/configs";
import { startRun, sessions, type Session } from "../run/sessions";
import { activeEditor } from "../../editor/editorRegistry";
import { editorStore, activeDocKey, saveAll } from "../../editor/store";
import { projectStore } from "../../lib/project";
import { repoConfigStore, setRepoSection, useRepoSection } from "../../lib/repoConfig";
import { createStore } from "../../lib/store";
import { godotApi } from "./api";
import { specFields } from "./cmdline";
import { addRecentScene, godotBinary, godotStore } from "./model";
import { pinRecord, pinsOf, specKey, specLabel, type GodotPin, type GodotSpec } from "./presets";
import { reloadScriptsEverywhere } from "./link";

// ---------------------------------------------------------------- pins
export const getPins = (): GodotPin[] => pinsOf(repoConfigStore.get().raw.godot);
export const usePins = (): GodotPin[] => pinsOf(useRepoSection("godot"));

export async function setPins(pins: GodotPin[]) {
  const cur = repoConfigStore.get().raw.godot;
  const base = cur && typeof cur === "object" && !Array.isArray(cur) ? (cur as Record<string, unknown>) : {};
  await setRepoSection("godot", { ...base, pinned: pins });
}
export const isPinned = (s: GodotSpec) => getPins().some((p) => specKey(p) === specKey(s));
export async function pinSpec(s: GodotSpec) {
  if (isPinned(s)) return;
  await setPins([...getPins(), pinRecord(s)]);
}
export async function unpinSpec(s: GodotSpec) {
  const k = specKey(s);
  await setPins(getPins().filter((p) => specKey(p) !== k));
}
export async function unpinAt(i: number) {
  await setPins(getPins().filter((_, j) => j !== i));
}
export async function movePin(i: number, to: number) {
  const pins = getPins();
  if (i < 0 || i >= pins.length || to < 0 || to >= pins.length || i === to) return;
  const [p] = pins.splice(i, 1);
  pins.splice(to, 0, p);
  await setPins(pins);
}

// ---------------------------------------------------------------- run
export const specConfig = (s: GodotSpec) => ({ ...specFields(s), name: specLabel(s), temporary: true }) as Omit<import("../run/types").RunConfig, "id">;

/** Run (or debug) a spec as a temporary run configuration (selected in the toolbar widget). */
export async function runSpec(s: GodotSpec, mode: "run" | "debug" = "run"): Promise<Session | null> {
  const cfg = ensureConfig(specConfig(s));
  if (s.type === "scene" && s.scene) addRecentScene(s.scene);
  return startRun(cfg.id, mode);
}
/** Make the spec the selected configuration without running it (Run widget dropdown pick). */
export function selectSpec(s: GodotSpec) {
  ensureConfig(specConfig(s));
}

export const projectSpec = (): GodotSpec => ({ type: "project", name: godotStore.get().name ? `${godotStore.get().name}` : undefined });

/** res:// path of a file inside the Godot project, else null. */
export function resPath(abs: string): string | null {
  const dir = godotStore.get().projectDir.replace(/\/$/, "");
  return dir && abs.startsWith(dir + "/") ? "res://" + abs.slice(dir.length + 1) : null;
}

/** The scene of the editor tab: a .tscn itself, or the scene a .gd is attached to (first one, main scene preferred). */
export async function currentScene(): Promise<string | null> {
  const k = activeDocKey();
  const doc = k ? editorStore.get().docs[k] : undefined;
  const m = activeEditor()?.getModel();
  const path = doc?.loc.path ?? m?.uri.path;
  return path ? sceneForPath(path) : null;
}
/** The scene for a file of the project: the .tscn itself, or the scene a .gd is attached to (main scene preferred). */
export async function sceneForPath(path: string): Promise<string | null> {
  const res = resPath(path);
  if (!res) return null;
  if (res.endsWith(".tscn")) return res;
  if (res.endsWith(".gd")) {
    const scenes = await godotApi.scenesUsing(godotStore.get().projectDir, res);
    const main = godotStore.get().mainScene;
    return scenes.find((s) => s === main) ?? scenes[0] ?? null;
  }
  return null;
}

// ---------------------------------------------------------------- editor / import / reload
export async function openInGodotEditor(scene?: string | null): Promise<string[]> {
  const dir = godotStore.get().projectDir;
  const argv = await godotApi.openEditor(dir, scene ?? (await currentScene()) ?? undefined, godotStore.get().settings.godotPath);
  lastEditorLaunch.set({ argv });
  return argv;
}
export const lastEditorLaunch = createStore<{ argv: string[] | null }>({ argv: null });

/** `godot --headless --path . --import` in the Run window (time limited). */
export function reimportAssets(): Promise<Session | null> {
  const cfg = ensureConfig({ ...specFields({ type: "project", name: "Godot: Reimport Assets", headless: true, args: "--import", timeLimit: 900 }), name: "Godot: Reimport Assets", liveReload: false, temporary: true } as never);
  return startRun(cfg.id, "run");
}

/** Save, then ask every connected game (debug sessions and live-reload runs) to reload the scripts changed on disk since it connected / last reloaded. */
export async function reloadScripts(): Promise<number> {
  await saveAll().catch(() => {});
  return reloadScriptsEverywhere(godotStore.get().projectDir);
}

export const godotSessions = () => sessions().filter((s) => s.typeId.startsWith("godot-"));
export const projectRoot = () => projectStore.get().root;
