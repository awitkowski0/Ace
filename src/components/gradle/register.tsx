// Gradle support entry (docs/GRADLE.md). The tool window exists only while the project is a Gradle project; nothing spawns otherwise.
import { registerToolWindow, toolWindowRegistry } from "../../toolwindows/registry";
import { registerAction } from "../../actions/registry";
import { registerPopup, openPopup } from "../shell/popups";
import { setActive, layoutStore } from "../../lib/layout";
import { ensureRepoConfig } from "../../lib/repoConfig";
import { registerWidgetItems, notifyWidgetItems } from "../run/hooks";
import { ensureConfig } from "../run/configs";
import { repoConfigStore } from "../../lib/repoConfig";
import { gradleStore, reloadGradle, setDetectionHook, startGradleWatch } from "./model";
import { GradleHeaderActions, GradleWindow, ensureOpen, toggleRow } from "./GradleWindow";
import { ExecuteGradlePopup } from "./ExecutePopup";
import { GradleIcon } from "./icons";
import { gradleUi, getPins, pinTask, runTask, unpinAt, unpinTask } from "./ops";
import { pinLabel } from "./tree";
import "./runtype";
import "./java/register";
import "./qa";

const isDetected = () => gradleStore.get().detected;

setDetectionHook((yes) => {
  if (yes) {
    ensureOpen();
    ensureRepoConfig();
    registerToolWindow({ id: "gradle", title: "Gradle", icon: <GradleIcon size={18} />, side: "right", actionId: "ActivateGradleToolWindow", order: 40, component: GradleWindow, headerActions: GradleHeaderActions });
  } else {
    toolWindowRegistry.unregister("gradle");
    if (layoutStore.get().active.right === "gradle") setActive("right", null);
  }
  notifyWidgetItems();
});

registerPopup("ExecuteGradleTask", ExecuteGradlePopup);

const inGradle = { toolWindow: "gradle" } as const;
const selTask = () => { const s = gradleUi.get().selected; return s && (s.kind === "task" || s.kind === "pinned") ? s : null; };

registerAction({ id: "Gradle.Refresh", title: "Reload All Gradle Projects", intellijId: "ExternalSystem.ProjectRefreshAction", isEnabled: isDetected, run: () => void reloadGradle() });
registerAction({ id: "Gradle.ExecuteTask", title: "Execute Gradle Task", isEnabled: isDetected, run: () => openPopup("ExecuteGradleTask") });
registerAction({
  id: "Gradle.RunSelected", title: "Run Gradle Task", defaultKeys: ["ENTER"], context: inGradle, isEnabled: () => !!gradleUi.get().selected,
  run: () => {
    const s = gradleUi.get().selected;
    if (!s) return;
    if (s.task) void runTask(s.task, s.args ?? "", s.kind === "pinned" && s.label !== s.task ? s.label : "");
    else if (s.hasChildren) toggleRow(s.id);
  },
});
registerAction({
  id: "Gradle.Pin", title: "Pin Gradle Task", isEnabled: () => selTask()?.kind === "task",
  run: () => { const s = selTask(); if (s) void pinTask(s.task!); },
});
registerAction({
  id: "Gradle.Unpin", title: "Unpin Gradle Task", defaultKeys: ["DELETE", "BACK_SPACE"], context: inGradle,
  isEnabled: () => { const s = selTask(); return !!s && (s.kind === "pinned" || getPins().some((p) => p.task === s.task && !p.args)); },
  run: () => { const s = selTask(); if (!s) return; if (s.kind === "pinned") void unpinAt(s.pinIndex!); else void unpinTask(s.task!); },
});
registerAction({
  id: "Gradle.CopyPath", title: "Copy Gradle Task Path", intellijId: "$Copy", context: inGradle, isEnabled: () => !!selTask(),
  run: () => { const s = selTask(); if (s) void navigator.clipboard?.writeText(s.task!).catch(() => {}); },
});

// Pinned tasks in the toolbar Run widget dropdown
registerWidgetItems("gradle-pinned", () => (isDetected() ? getPins().map((p, i) => ({
  id: `gradle-pin-${i}`, label: `📌 ${pinLabel(p)}${p.args ? "  " + p.args : ""}`, title: `Gradle: ${p.task}${p.args ? " " + p.args : ""}`,
  run: () => void runTask(p.task, p.args ?? "", p.name ?? ""),
  // dropdown pick: select the (temporary) configuration so the toolbar label shows it and ▶ / ⌃R runs it
  select: () => void ensureConfig({ type: "gradle", name: p.name || `${gradleStore.get().model?.name ?? "gradle"} [${p.task}${p.args ? " " + p.args : ""}]`, tasks: p.task, args: p.args ?? "", workingDir: "", env: [], temporary: true }),
})) : []));
repoConfigStore.subscribe(notifyWidgetItems);

startGradleWatch();
