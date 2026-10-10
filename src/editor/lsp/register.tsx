// Owned by the LSP agent: language intelligence (see manager.ts) + Problems / Usages tool windows.
import "./lsp.css";
import { registerToolWindow, registerStatusWidget } from "../../toolwindows/registry";
import { ProblemsIcon, SearchIcon } from "../../components/shell/icons";
import { registerAction } from "../../actions/registry";
import { registerPopup, openPopup } from "../../components/shell/popups";
import { activeEditor, triggerEditor } from "../editorRegistry";
import { activeServerReady, bootWhenNeeded, lsp, prewarmGodotWhenIdle, trackGodotFocus } from "./api";
import { FileStructurePopup, IntentionsPopup, InspectionWidget, ProblemsPanel, UsagesPanel, gotoProblem } from "./ui";

registerToolWindow({
  id: "problems", title: "Problems", icon: <ProblemsIcon />, side: "bottom",
  shortcut: "meta 6", actionId: "ActivateProblemsViewToolWindow", order: 11, component: ProblemsPanel,
});
registerToolWindow({
  id: "usages", title: "Usages", icon: <SearchIcon />, side: "bottom", order: 10, component: UsagesPanel,
});
registerStatusWidget({ id: "lsp-inspections", side: "right", order: 5, component: InspectionWidget });
registerPopup("FileStructure", FileStructurePopup);
registerPopup("Intentions", IntentionsPopup);

const hasEditor = () => !!activeEditor();
registerAction({ context: "editor", id: "GotoDeclaration", intellijId: "GotoDeclaration", title: "Go to Declaration or Usages", defaultKeys: ["meta B"], isEnabled: activeServerReady, run: () => lsp.gotoDeclaration() });
registerAction({ context: "editor", id: "FindUsages", intellijId: "FindUsages", title: "Find Usages", defaultKeys: ["alt F7"], isEnabled: activeServerReady, run: () => lsp.findUsages() });
registerAction({ context: "editor", id: "RenameElement", intellijId: "RenameElement", title: "Rename…", defaultKeys: ["shift F6"], isEnabled: activeServerReady, run: () => lsp.rename() });
registerAction({
  context: "editor", id: "ShowIntentionActions", intellijId: "ShowIntentionActions", title: "Show Context Actions", defaultKeys: ["alt ENTER"], isEnabled: activeServerReady,
  run: async () => { const items = await lsp.codeActions(); if (items.length) openPopup("Intentions", items); },
});
registerAction({
  context: "editor", id: "FileStructurePopup", intellijId: "FileStructurePopup", title: "File Structure", defaultKeys: ["meta F12"], isEnabled: hasEditor,
  run: async () => {
    const rows = activeServerReady() ? await lsp.symbols() : null;
    if (rows?.length) openPopup("FileStructure", rows);
    else triggerEditor("editor.action.quickOutline");
  },
});
registerAction({ context: "editor", id: "GotoNextError", intellijId: "GotoNextError", title: "Next Highlighted Error", defaultKeys: ["F2"], isEnabled: hasEditor, run: () => gotoProblem(1) });
registerAction({ context: "editor", id: "GotoPreviousError", intellijId: "GotoPreviousError", title: "Previous Highlighted Error", defaultKeys: ["shift F2"], isEnabled: hasEditor, run: () => gotoProblem(-1) });
const mon = (id: string, title: string, keys: string[], cmd: string) =>
  registerAction({ context: "editor", id, intellijId: id, title, defaultKeys: keys, isEnabled: hasEditor, run: () => void triggerEditor(cmd) });
mon("QuickJavaDoc", "Quick Documentation", ["F1"], "editor.action.showHover");
mon("ParameterInfo", "Parameter Info", ["meta P"], "editor.action.triggerParameterHints");
mon("CodeCompletion", "Basic Completion", ["control SPACE"], "editor.action.triggerSuggest");

bootWhenNeeded();
prewarmGodotWhenIdle();
trackGodotFocus();
