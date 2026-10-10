import { registerAction } from "./registry";
import { closeActiveTab, saveAll, splitActive } from "../editor/store";
import "../editor/editorActions";
import { focusEditor } from "../editor/editorRegistry";
import { focusedToolWindowId, hideToolWindow, layoutStore } from "../lib/layout";
import { toggleGroup } from "../components/shell/toolGroups";
import { listToolWindows, subscribeToolWindows } from "../toolwindows/registry";
import { isPopupOpen, openPopup } from "../components/shell/popups";
import { pickAndOpenFolder } from "../lib/project";

const cap = (s: string) => s.replace(/(^|[-_ ])(\w)/g, (_, __, c: string) => c.toUpperCase());

registerAction({ id: "SaveAll", intellijId: "SaveAll", title: "Save All", defaultKeys: ["meta S"], run: saveAll });
registerAction({ id: "CloseContent", intellijId: "CloseContent", title: "Close Tab", defaultKeys: ["meta W"], run: closeActiveTab });
registerAction({ id: "SplitVertically", intellijId: "SplitVertically", title: "Split Right", run: () => splitActive("right") });
registerAction({ id: "SplitHorizontally", intellijId: "SplitHorizontally", title: "Split Down", run: () => splitActive("down") });

const popup = (id: string, title: string, keys: string[]) =>
  registerAction({ id, intellijId: id, title, defaultKeys: keys, run: () => openPopup(id) });
popup("SearchEverywhere", "Search Everywhere", ["shift shift"]);
popup("GotoFile", "Go to File…", ["meta shift O"]);
popup("FindInPath", "Find in Files…", ["meta shift F"]);
popup("GotoAction", "Find Action…", ["meta shift A"]);
popup("RecentFiles", "Recent Files", ["meta E"]);
popup("Switcher", "Switcher", ["control TAB"]);

registerAction({ id: "OpenFolder", title: "Open Folder…", run: pickAndOpenFolder });

// Esc in a tool window returns focus to editor; ⇧Esc hides the active tool window.
// Not in the terminal: there Esc belongs to the shell / TUI (vim, claude); ⇧Esc still hides the window.
const inTerminal = () => !!document.activeElement?.closest(".term-host");
registerAction({
  id: "FocusEditor", intellijId: "FocusEditor", title: "Focus Editor", defaultKeys: ["ESCAPE"],
  isEnabled: () => !isPopupOpen() && focusedToolWindowId() !== null && !inTerminal(),
  run: () => focusEditor(),
});
registerAction({
  id: "HideActiveWindow", intellijId: "HideActiveWindow", title: "Hide Active Tool Window", defaultKeys: ["shift ESCAPE"],
  run: () => {
    const id = focusedToolWindowId() ?? Object.values(layoutStore.get().active).find(Boolean) ?? null;
    if (id) hideToolWindow(id);
  },
});

// IntelliJ editor actions (duplicate line, find, go to line, ...) live in src/editor/editorActions.ts (context "editor").

// One Activate<X>ToolWindow action per registered tool window.
function syncToolWindowActions() {
  for (const tw of listToolWindows()) {
    const id = tw.actionId ?? `Activate${cap(tw.id)}ToolWindow`;
    registerAction({
      id, intellijId: id, title: `${tw.title} Tool Window`,
      defaultKeys: tw.shortcut ? [tw.shortcut] : [], run: () => toggleGroup(tw.id),
    });
  }
}
syncToolWindowActions();
let n = listToolWindows().length;
subscribeToolWindows(() => {
  if (listToolWindows().length !== n) { n = listToolWindows().length; syncToolWindowActions(); }
});
