import { registerAction } from "./registry";
import { closeActiveTab, saveAll, splitActive } from "../editor/store";
import { activeEditor, focusEditor, triggerEditor } from "../editor/editorRegistry";
import { focusedToolWindowId, hideToolWindow, layoutStore, toggleToolWindow } from "../lib/layout";
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
registerAction({
  id: "FocusEditor", intellijId: "FocusEditor", title: "Focus Editor", defaultKeys: ["ESCAPE"],
  isEnabled: () => !isPopupOpen() && focusedToolWindowId() !== null,
  run: () => focusEditor(),
});
registerAction({
  id: "HideActiveWindow", intellijId: "HideActiveWindow", title: "Hide Active Tool Window", defaultKeys: ["shift ESCAPE"],
  run: () => {
    const id = focusedToolWindowId() ?? Object.values(layoutStore.get().active).find(Boolean) ?? null;
    if (id) hideToolWindow(id);
  },
});

// IntelliJ editor actions -> Monaco commands.
const mon = (id: string, intellijId: string, title: string, keys: string[], cmd: string) =>
  registerAction({ id, intellijId, title, defaultKeys: keys, isEnabled: () => !!activeEditor(), run: () => void triggerEditor(cmd) });
mon("EditorDuplicate", "EditorDuplicate", "Duplicate Line or Selection", ["meta D"], "editor.action.copyLinesDownAction");
mon("EditorDeleteLine", "EditorDeleteLine", "Delete Line", ["meta BACK_SPACE"], "editor.action.deleteLines");
mon("CommentByLineComment", "CommentByLineComment", "Comment with Line Comment", ["meta SLASH"], "editor.action.commentLine");
mon("EditorSelectWord", "EditorSelectWord", "Extend Selection", ["alt UP"], "editor.action.smartSelect.expand");
mon("EditorUnSelectWord", "EditorUnSelectWord", "Shrink Selection", ["alt DOWN"], "editor.action.smartSelect.shrink");
mon("ReformatCode", "ReformatCode", "Reformat Code", ["alt meta L"], "editor.action.formatDocument");

// One Activate<X>ToolWindow action per registered tool window.
function syncToolWindowActions() {
  for (const tw of listToolWindows()) {
    const id = tw.actionId ?? `Activate${cap(tw.id)}ToolWindow`;
    registerAction({
      id, intellijId: id, title: `${tw.title} Tool Window`,
      defaultKeys: tw.shortcut ? [tw.shortcut] : [], run: () => toggleToolWindow(tw.id),
    });
  }
}
syncToolWindowActions();
let n = listToolWindows().length;
subscribeToolWindows(() => {
  if (listToolWindows().length !== n) { n = listToolWindows().length; syncToolWindowActions(); }
});
