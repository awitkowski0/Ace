// Run infrastructure: Run tool window, actions (Run / Debug / Stop / Rerun ...), popups and the config store. Config TYPES register themselves
// from their own modules (python/runtypes ...); the toolbar widget lives in Widget.tsx (mounted by shell/Toolbar.tsx in #run-widget-slot).
import { Suspense, lazy } from "react";
import { registerToolWindow, type ToolWindowProps } from "../../toolwindows/registry";
import { registerAction } from "../../actions/registry";
import { registerPopup, openPopup } from "../shell/popups";
import { focusedToolWindowId, isToolWindowFocused } from "../../lib/layout";
import { projectStore } from "../../lib/project";
import { editorStore, activeDocKey } from "../../editor/store";
import { activeEditor } from "../../editor/editorRegistry";
import { RunIcon } from "./icons";
import { ChoosePopup } from "./ChoosePopup";
import { contextConfig, ensureConfig, loadConfigs, selectedConfig } from "./configs";
import { canStopAny, stopCurrent } from "./hooks";
import { activeSession, lastDebugConfig, rerunFailed, rerunSession, sessions, startRun, closeStdinOf, type Session } from "./sessions";
import "./qa";
import "./run.css";

const LazyPanel = lazy(() => import("./RunPanel").then((m) => ({ default: m.RunPanel })));
const LazyEdit = lazy(() => import("./EditDialog").then((m) => ({ default: m.EditDialog })));
const RunPanelHost = (_: ToolWindowProps) => <Suspense fallback={null}><LazyPanel /></Suspense>;

registerToolWindow({ id: "run", title: "Run", icon: <RunIcon size={18} />, side: "bottom", shortcut: "meta 4", actionId: "ActivateRunToolWindow", order: 15, component: RunPanelHost });
registerPopup("EditRunConfigurations", (p) => <Suspense fallback={null}><LazyEdit {...p} /></Suspense>);
registerPopup("ChooseRunConfiguration", ChoosePopup);

// configurations are per project: load when the project is known (one small file read; nothing else)
projectStore.subscribe(() => void loadConfigs());
void loadConfigs();

/** The editor's file as a run context: the caret line is what ⌃⇧R looks at. */
async function runContext(mode: "run" | "debug"): Promise<boolean> {
  const k = activeDocKey();
  const doc = k ? editorStore.get().docs[k] : undefined;
  if (!doc || doc.kind === "diff" || doc.error) return false;
  const ed = activeEditor();
  const model = ed?.getModel();
  const live = model && model.uri.path === doc.loc.path;
  const partial = await contextConfig({ loc: doc.loc, text: live ? model.getValue() : doc.saved, line: live ? ed!.getPosition()?.lineNumber ?? 1 : editorStore.get().cursor.line, language: doc.language });
  if (!partial) return false;
  const cfg = ensureConfig(partial);
  await startRun(cfg.id, mode);
  return true;
}
export { runContext };

async function runSelected(mode: "run" | "debug") {
  const sel = selectedConfig();
  if (sel) return void (await startRun(sel.id, mode));
  if (await runContext(mode)) return;
  openPopup("EditRunConfigurations");
}

const notTerminal = () => focusedToolWindowId() !== "terminal";
const edit = (props?: unknown) => openPopup("EditRunConfigurations", props);

registerAction({ id: "Run", title: "Run", intellijId: "Run", isEnabled: notTerminal, run: () => runSelected("run") });
registerAction({ id: "Debug", title: "Debug", intellijId: "Debug", isEnabled: notTerminal, run: () => runSelected("debug") });
registerAction({ id: "RunClass", title: "Run Context Configuration", intellijId: "RunClass", isEnabled: notTerminal, run: async () => void (await runContext("run")) });
registerAction({ id: "DebugClass", title: "Debug Context Configuration", intellijId: "DebugClass", isEnabled: notTerminal, run: async () => void (await runContext("debug")) });
registerAction({ id: "ChooseRunConfiguration", title: "Choose Run Configuration", intellijId: "ChooseRunConfiguration", isEnabled: notTerminal, run: () => openPopup("ChooseRunConfiguration", { mode: "run" }) });
registerAction({ id: "ChooseDebugConfiguration", title: "Choose Debug Configuration", intellijId: "ChooseDebugConfiguration", isEnabled: notTerminal, run: () => openPopup("ChooseRunConfiguration", { mode: "debug" }) });
registerAction({ id: "Stop", title: "Stop", intellijId: "Stop", isEnabled: canStopAny, run: () => void stopCurrent() });
registerAction({ id: "EditRunConfigurations", title: "Edit Configurations…", run: () => edit() });
registerAction({ id: "NewRunConfiguration", title: "Add Run Configuration…", run: () => edit({ addType: "python" }) });

// ⌘R is Replace in the editor: Rerun only while the Run (or Debug) tool window has focus.
registerAction({
  id: "Rerun", title: "Rerun", intellijId: "Rerun", context: { toolWindow: "run" },
  isEnabled: () => isToolWindowFocused("run") && !!activeSession(),
  run: () => { const s = activeSession(); if (s) void rerunSession(s); },
});
registerAction({
  id: "Rerun.Debug", title: "Rerun (Debug)", intellijId: "Rerun", context: { toolWindow: "debug" },
  isEnabled: () => !!lastDebugConfig(),
  run: async () => {
    const c = lastDebugConfig();
    if (!c) return;
    stopCurrent();
    await new Promise((r) => setTimeout(r, 700));
    await startRun(c.id, "debug");
  },
});
const testSession = (): Session | null => {
  const a = activeSession();
  if (a?.tests) return a;
  return [...sessions()].reverse().find((s) => s.tests) ?? null;
};
registerAction({ id: "RerunTests", title: "Rerun Tests", intellijId: "RerunTests", isEnabled: () => !!testSession(), run: () => { const s = testSession(); if (s) void rerunSession(s); } });
registerAction({ id: "RerunFailedTests", title: "Rerun Failed Tests", isEnabled: () => !!testSession()?.tests?.failedIds().length, run: () => { const s = testSession(); if (s) void rerunFailed(s); } });
// ⌃D = Debug everywhere, except while the stdin field of the Run window is focused: there it is EOF (closes stdin).
registerAction({
  id: "Run.CloseStdin", title: "Close Process Input (EOF)", defaultKeys: ["control D"], context: { toolWindow: "run" },
  isEnabled: () => !!document.activeElement?.closest("[data-stdin]") || document.activeElement?.hasAttribute("data-stdin") === true,
  run: () => { const s = activeSession(); if (s) void closeStdinOf(s); },
});
