// Godot support entry (docs/GODOT.md). The tool windows exist only for projects with project.godot at the root; nothing spawns until the user runs something.
import { registerToolWindow, toolWindowRegistry } from "../../toolwindows/registry";
import { registerAction } from "../../actions/registry";
import { setActive, layoutStore } from "../../lib/layout";
import { ensureRepoConfig, repoConfigStore } from "../../lib/repoConfig";
import { projectStore } from "../../lib/project";
import { promptDialog } from "../shell/dialogs";
import { registerContextProvider } from "../run/configs";
import { enableDebugLanguage, notifyWidgetItems, registerWidgetItems } from "../run/hooks";
import { installEditorDebug } from "../python/debug/register";
import { showBalloon } from "../python/debug/notify";
import { GodotHeaderActions, GodotWindow } from "./GodotWindow";
import { StructureWindow } from "./StructureWindow";
import { GodotIcon, SceneIcon } from "./icons";
import { detectGodot, ensureScan, godotStore, saveSettings, setDetectionHook, watchGodot } from "./model";
import { currentScene, sceneForPath, getPins, openInGodotEditor, projectSpec, reimportAssets, reloadScripts, resPath, runSpec, selectSpec, specConfig, unpinAt, unpinSpec, pinSpec, isPinned } from "./ops";
import { liveLinks } from "./link";
import { specKey, specLabel, defaultHeadless } from "./presets";
import { sceneSpec } from "./tree";
import { godotUi, ensureOpen } from "./ui";
import "./runtypes";
import "./qa";

const isDetected = () => godotStore.get().detected;

const StructureIcon = () => <SceneIcon size={18} />;

setDetectionHook((yes) => {
  if (yes) {
    ensureOpen();
    ensureRepoConfig();
    enableDebugLanguage("gdscript");
    installEditorDebug(true);
    registerToolWindow({ id: "godot", title: "Godot", icon: <GodotIcon size={18} />, side: "right", actionId: "ActivateGodotToolWindow", order: 41, component: GodotWindow, headerActions: GodotHeaderActions });
    registerToolWindow({ id: "structure", title: "Structure", icon: <StructureIcon />, side: "left", actionId: "ActivateStructureToolWindow", order: 20, component: StructureWindow });
  } else {
    toolWindowRegistry.unregister("godot");
    toolWindowRegistry.unregister("structure");
    if (layoutStore.get().active.right === "godot") setActive("right", null);
    if (layoutStore.get().active.left === "structure") setActive("left", null);
  }
  notifyWidgetItems();
});

const inGodot = { toolWindow: "godot" } as const;
const selSpec = () => godotUi.get().selected?.spec ?? null;

registerAction({
  id: "Godot.RunSelected", title: "Run Godot Item", defaultKeys: ["ENTER"], context: inGodot, isEnabled: () => !!godotUi.get().selected,
  run: () => {
    const r = godotUi.get().selected;
    if (r?.spec) void runSpec(r.spec, "run");
    else if (r?.hasChildren) import("./ui").then((u) => u.toggleRow(r.id));
  },
});
registerAction({ id: "Godot.Pin", title: "Pin Godot Item", isEnabled: () => { const s = selSpec(); return !!s && godotUi.get().selected?.kind !== "pinned" && !isPinned(s); }, run: () => { const s = selSpec(); if (s) void pinSpec(s); } });
registerAction({
  id: "Godot.Unpin", title: "Unpin Godot Item", defaultKeys: ["DELETE", "BACK_SPACE"], context: inGodot,
  isEnabled: () => { const r = godotUi.get().selected; return !!r?.spec && (r.kind === "pinned" || isPinned(r.spec)); },
  run: () => { const r = godotUi.get().selected; if (!r?.spec) return; if (r.kind === "pinned") void unpinAt(r.pinIndex!); else void unpinSpec(r.spec); },
});
registerAction({ id: "Godot.OpenEditor", title: "Open in Godot Editor", isEnabled: isDetected, run: () => void openInGodotEditor().catch((e) => showBalloon({ kind: "error", title: "Could not open Godot", text: String(e?.message ?? e) })) });
registerAction({ id: "Godot.Reimport", title: "Reimport Godot Assets", isEnabled: isDetected, run: () => void reimportAssets() });
registerAction({
  id: "Godot.RunProject", title: "Godot: Run Project", isEnabled: isDetected, run: () => void runSpec(projectSpec(), "run"),
});
registerAction({
  id: "Godot.RunCurrentScene", title: "Godot: Run Current Scene", isEnabled: isDetected,
  run: async () => { const s = await currentScene(); if (s) void runSpec(sceneSpec(s), "run"); else showBalloon({ kind: "warn", title: "No scene to run", text: "Open a .tscn file, or a script that is attached to a scene." }); },
});
registerAction({
  id: "Godot.ReloadScripts", title: "Reload Scripts in Running Game", intellijId: "UpdateRunningApplication", isEnabled: () => isDetected() && liveLinks.size > 0,
  run: async () => {
    const n = await reloadScripts();
    showBalloon(n > 0 ? { kind: "info", title: "Scripts reloaded", text: `${n} changed script${n === 1 ? "" : "s"} sent to the running game.` } : { kind: "warn", title: "Nothing to reload", text: "No script changed since the game connected or last reloaded." });
  },
});
registerAction({ id: "Godot.Refresh", title: "Refresh Godot Project", isEnabled: isDetected, run: () => void ensureScan(true) });
registerAction({
  id: "Godot.SetExecutable", title: "Set Godot Executable…", isEnabled: isDetected,
  run: async () => { const v = await promptDialog({ title: "Godot Executable", initial: godotStore.get().settings.godotPath, okLabel: "OK" }); if (v !== null) await saveSettings({ godotPath: v.trim() }); },
});

// Pinned items in the toolbar Run widget dropdown
registerWidgetItems("godot-pinned", () => (isDetected() ? getPins().map((p, i) => ({
  id: `godot-pin-${i}`, label: `📌 ${specLabel(p)}`, title: `Godot: ${specKey(p)}`,
  run: () => void runSpec(p, "run"),
  select: () => selectSpec(p),
})) : []));
repoConfigStore.subscribe(notifyWidgetItems);

// ⌃⇧R / ⌃⇧D on an open .tscn or .gd: the scene itself, a SceneTree script, or the scene the script is attached to
registerContextProvider(async (ctx) => {
  if (!isDetected() || ctx.loc.host !== "local") return null;
  const res = resPath(ctx.loc.path);
  if (!res) return null;
  if (res.endsWith(".tscn")) return specConfig(sceneSpec(res));
  if (!res.endsWith(".gd")) return null;
  if (/^\s*(?:class_name\s+\w+\s+)?extends\s+(SceneTree|MainLoop)\b/m.test(ctx.text)) return specConfig({ type: "script", script: res, headless: defaultHeadless(res) });
  const scene = await sceneForPath(ctx.loc.path);
  return scene ? specConfig(sceneSpec(scene)) : null;
});

watchGodot();
void detectGodot();
void projectStore;
