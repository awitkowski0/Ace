/**
 * IntelliJ editor actions implemented on Monaco commands. Context "editor": they are only live while focus is in an
 * editor group, so ⌘D in the Commit window stays "Show Diff". Keys come from the IntelliJ keymap JSON (by action id).
 * The ids listed in editorActionDefs.ts are what the Monaco keybinding policy treats as "implemented".
 */
import type { editor } from "monaco-editor";
import { registerAction } from "../actions/registry";
import { openPopup, registerPopup } from "../components/shell/popups";
import { activeEditor, focusEditor, triggerEditor } from "./editorRegistry";
import { EDITOR_ACTION_DEFS } from "./editorActionDefs";
import { canGoBack, canGoForward, cycleTab, navigateBack, navigateForward } from "./store";
import { findAgain, openFind } from "./find";
import { GotoLinePopup } from "./GotoLine";
import { toggleHideAllWindows } from "./hideAll";
import { RecentLocationsPopup } from "./RecentLocations";

registerPopup("GotoLine", GotoLinePopup);
registerPopup("RecentLocations", RecentLocationsPopup);

const hasEditor = () => !!activeEditor();
const swapCase = (s: string) => [...s].map((c) => (c === c.toUpperCase() ? c.toLowerCase() : c.toUpperCase())).join("");

const CUSTOM: Record<string, () => void> = {
  EditorToggleCase() {
    const ed = activeEditor();
    const model = ed?.getModel();
    if (!ed || !model) return;
    const edits: editor.IIdentifiedSingleEditOperation[] = [];
    for (const sel of ed.getSelections() ?? []) {
      let range = sel;
      if (sel.isEmpty()) {
        const w = model.getWordAtPosition(sel.getPosition());
        if (!w) continue;
        range = { ...sel, startLineNumber: sel.positionLineNumber, endLineNumber: sel.positionLineNumber, startColumn: w.startColumn, endColumn: w.endColumn } as never;
      }
      edits.push({ range: range as never, text: swapCase(model.getValueInRange(range as never)) });
    }
    ed.pushUndoStop();
    ed.executeEdits("toggle-case", edits);
    ed.pushUndoStop();
  },
  UnselectPreviousOccurrence() {
    const ed = activeEditor();
    const sels = ed?.getSelections();
    if (ed && sels && sels.length > 1) ed.setSelections(sels.slice(0, -1));
  },
  EditorCutLineEnd() {
    const ed = activeEditor();
    const model = ed?.getModel();
    if (!ed || !model || ed.getRawOptions().readOnly) return;
    const edits: editor.IIdentifiedSingleEditOperation[] = [];
    const parts: string[] = [];
    for (const sel of ed.getSelections() ?? []) {
      let r: { startLineNumber: number; startColumn: number; endLineNumber: number; endColumn: number };
      if (!sel.isEmpty()) r = sel;
      else {
        const p = sel.getPosition();
        const max = model.getLineMaxColumn(p.lineNumber);
        // at end of line: swallow the line break (IntelliJ joins with the next line)
        r = p.column === max && p.lineNumber < model.getLineCount()
          ? { startLineNumber: p.lineNumber, startColumn: p.column, endLineNumber: p.lineNumber + 1, endColumn: 1 }
          : { startLineNumber: p.lineNumber, startColumn: p.column, endLineNumber: p.lineNumber, endColumn: max };
      }
      parts.push(model.getValueInRange(r as never));
      edits.push({ range: r as never, text: "" });
    }
    void navigator.clipboard?.writeText(parts.join("\n")).catch(() => {});
    ed.pushUndoStop();
    ed.executeEdits("cut-line-end", edits);
    ed.pushUndoStop();
  },
  EditorScrollToCenter() {
    const ed = activeEditor();
    const p = ed?.getPosition();
    if (ed && p) ed.revealPositionInCenter(p);
  },
  GotoLine: () => openPopup("GotoLine"),
  Find: () => openFind(false),
  Replace: () => openFind(true),
  FindNext: () => findAgain(1),
  FindPrevious: () => findAgain(-1),
};

for (const d of EDITOR_ACTION_DEFS) {
  const run = d.monaco ? () => void triggerEditor(d.monaco!) : CUSTOM[d.id];
  if (!run) throw new Error(`editor action ${d.id} has neither a Monaco command nor a custom handler`);
  registerAction({ id: d.id, intellijId: d.id, title: d.title, defaultKeys: d.keys, context: "editor", isEnabled: hasEditor, run });
}

// ---- navigation: tabs, history, layout ----
const notInTerminal = () => !document.activeElement?.closest(".term-host");
const nav = (id: string, title: string, run: () => void, enabled: () => boolean = () => true) =>
  registerAction({ id, intellijId: id, title, isEnabled: () => notInTerminal() && enabled(), run });
nav("Back", "Back", () => void navigateBack(), canGoBack);
nav("Forward", "Forward", () => void navigateForward(), canGoForward);
nav("NextTab", "Next Tab", () => cycleTab(1));
nav("PreviousTab", "Previous Tab", () => cycleTab(-1));
nav("NextEditorTab", "Select Next Tab", () => cycleTab(1));
nav("PreviousEditorTab", "Select Previous Tab", () => cycleTab(-1));
registerAction({ id: "HideAllWindows", intellijId: "HideAllWindows", title: "Hide All Windows", run: toggleHideAllWindows });
registerAction({ id: "RecentLocations", intellijId: "RecentLocations", title: "Recent Locations", run: () => openPopup("RecentLocations") });
registerAction({ id: "FocusEditorGroup", title: "Focus Editor", run: focusEditor });
