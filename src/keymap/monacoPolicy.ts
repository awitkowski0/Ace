/**
 * IntelliJ-vs-Monaco keybinding policy. Pure (no monaco / DOM imports) so it is unit-testable and shared by:
 *  - editor/monacoKeymap.ts  (applies the removals to the live Monaco keybinding service)
 *  - monacoAudit.test.ts     (fails when a Monaco default stays active on a key IntelliJ binds to something else;
 *                             regenerates docs/KEYMAP-AUDIT.md when WRITE_AUDIT=1)
 *
 * Decision per Monaco default binding (command, key[s], when):
 *  keep-widget   `when` names a Monaco widget (suggest, find input, snippet, hover, rename input...) - the widget needs its keys
 *  keep-same     same meaning as the IntelliJ action(s) bound to that key (EQUIV)
 *  remove-routed key is bound to a different IntelliJ action that Ace implements; Ace's dispatcher runs it
 *  remove-swallow key is bound to a different IntelliJ action Ace does not implement; swallowed (no-op) in the editor
 *  remove-unbound Monaco-only binding; IntelliJ binds nothing there
 */
import { parseKeystroke } from "../actions/keystroke";

export interface RawChord { ctrl: boolean; alt: boolean; shift: boolean; meta: boolean; keyCode: number; key: string }
export interface MonacoBinding { command: string; when: string | null; chords: RawChord[]; seq: string }
export type DecisionKind = "keep-widget" | "keep-same" | "remove-routed" | "remove-swallow" | "remove-unbound";
export interface Decision { binding: MonacoBinding; kind: DecisionKind; ij: string[]; routedTo: string[] }

/** Monaco KeyCodeUtils.toString name -> IntelliJ key name. */
const KEY_NAMES: Record<string, string> = {
  Backspace: "BACK_SPACE", Del: "DELETE", UpArrow: "UP", DownArrow: "DOWN", LeftArrow: "LEFT", RightArrow: "RIGHT",
  Escape: "ESCAPE", Enter: "ENTER", Tab: "TAB", Space: "SPACE", PageUp: "PAGE_UP", PageDown: "PAGE_DOWN", Home: "HOME", End: "END",
  "[": "OPEN_BRACKET", "]": "CLOSE_BRACKET", "/": "SLASH", ",": "COMMA", ".": "PERIOD", "-": "MINUS", "=": "EQUALS",
  "\\": "BACK_SLASH", ";": "SEMICOLON", "'": "QUOTE", "`": "BACK_QUOTE", Insert: "INSERT",
};
export const ourKeyName = (monacoName: string) => KEY_NAMES[monacoName] ?? monacoName.toUpperCase();

export function strokeOf(c: Pick<RawChord, "ctrl" | "alt" | "shift" | "meta" | "key">): string {
  return [c.ctrl && "control", c.alt && "alt", c.shift && "shift", c.meta && "meta", c.key].filter(Boolean).join(" ");
}
export const seqOf = (chords: RawChord[]) => chords.map(strokeOf).join(" , ");

/** Context keys that are "always on" inside a focused editor; anything else means a transient Monaco widget. */
const AMBIENT = new Set([
  "textInputFocus", "editorTextFocus", "editorFocus", "editorReadonly", "editorHasSelection", "editorHasMultipleSelections",
  "editorColumnSelection", "editorIsOpen", "foldingEnabled", "supportedCodeAction", "isWeb", "inCompositeEditor", "isInEmbeddedEditor",
  "editorTabMovesFocus", "hasWordHighlights", "selectionAnchorSet", "None",
]);
export function isWidgetScoped(when: string | null): boolean {
  if (!when) return false;
  const ids = when.replace(/\/(?:\\.|[^/\\])+\//g, " ").match(/[A-Za-z_][\w.]*/g) ?? [];
  return ids.some((id) => !(AMBIENT.has(id) || /^editorHas\w+Provider$/.test(id) || id.startsWith("config.")));
}

/**
 * Monaco command -> IntelliJ actions with the SAME meaning. Commands Ace re-implements itself (find bar, line ops
 * routed to a different key, ...) are deliberately NOT listed so their Monaco bindings get removed.
 */
const EQUIV: Record<string, string[]> = {
  cursorDown: ["EditorDown"], cursorUp: ["EditorUp"], cursorLeft: ["EditorLeft"], cursorRight: ["EditorRight"],
  cursorDownSelect: ["EditorDownWithSelection"], cursorUpSelect: ["EditorUpWithSelection"],
  cursorLeftSelect: ["EditorLeftWithSelection"], cursorRightSelect: ["EditorRightWithSelection"],
  cursorHome: ["EditorLineStart"], cursorEnd: ["EditorLineEnd"], cursorLineStart: ["EditorLineStart"], cursorLineEnd: ["EditorLineEnd"],
  cursorHomeSelect: ["EditorLineStartWithSelection"], cursorEndSelect: ["EditorLineEndWithSelection"],
  cursorPageDown: ["EditorPageDown"], cursorPageUp: ["EditorPageUp"],
  cursorPageDownSelect: ["EditorPageDownWithSelection"], cursorPageUpSelect: ["EditorPageUpWithSelection"],
  // column (block) selection mode reuses the plain shift+arrow keys, same meaning as the IntelliJ with-selection actions
  cursorColumnSelectDown: ["EditorDownWithSelection"], cursorColumnSelectUp: ["EditorUpWithSelection"],
  cursorColumnSelectLeft: ["EditorLeftWithSelection"], cursorColumnSelectRight: ["EditorRightWithSelection"],
  cursorColumnSelectPageDown: ["EditorPageDownWithSelection"], cursorColumnSelectPageUp: ["EditorPageUpWithSelection"],
  cursorWordLeft: ["EditorPreviousWord"], cursorWordEndRight: ["EditorNextWord"],
  cursorWordLeftSelect: ["EditorPreviousWordWithSelection"], cursorWordEndRightSelect: ["EditorNextWordWithSelection"],
  deleteLeft: ["EditorBackSpace", "$Delete"], deleteRight: ["EditorDelete", "$Delete"],
  deleteWordLeft: ["EditorDeleteToWordStart"], deleteWordRight: ["EditorDeleteToWordEnd"],
  tab: ["EditorTab", "EditorIndentSelection"], outdent: ["EditorUnindentSelection"],
  "editor.action.selectAll": ["$SelectAll"], undo: ["$Undo"], redo: ["$Redo"],
  "editor.action.clipboardCopyAction": ["$Copy"], "editor.action.clipboardCutAction": ["$Cut"],
  "editor.action.commentLine": ["CommentByLineComment"],
  "editor.action.triggerSuggest": ["CodeCompletion"],
  cancelSelection: ["EditorEscape"], removeSecondaryCursors: ["EditorEscape"], "editor.action.cancelSelectionAnchor": ["EditorEscape"],
  "editor.action.showContextMenu": ["ShowPopupMenu"],
  "editor.action.triggerParameterHints": ["ParameterInfo"],
};

/** IntelliJ actions Ace runs on a key (registered by this module's defs or by other modules). */
export const EXTERNAL_IMPLEMENTED = [
  "GotoDeclaration", "FindUsages", "RenameElement", "ShowIntentionActions", "FileStructurePopup", "GotoNextError", "GotoPreviousError",
  "QuickJavaDoc", "ParameterInfo", "CodeCompletion", "SearchEverywhere", "GotoFile", "GotoClass", "GotoSymbol", "GotoAction",
  "FindInPath", "ReplaceInPath", "RecentFiles", "Switcher", "SaveAll", "CloseContent", "CheckinProject", "Vcs.UpdateProject",
  "Vcs.Push", "Diff.ShowDiff", "FocusEditor", "HideActiveWindow", "ReformatCode",
];

export function classify(b: MonacoBinding, ijByStroke: (seq: string) => string[], implemented: Set<string>): Decision {
  const ij = ijByStroke(b.seq);
  if (isWidgetScoped(b.when)) return { binding: b, kind: "keep-widget", ij, routedTo: [] };
  const eq = EQUIV[b.command] ?? [];
  if (eq.some((id) => ij.includes(id))) return { binding: b, kind: "keep-same", ij, routedTo: [] };
  const routedTo = ij.filter((id) => implemented.has(id));
  if (routedTo.length) return { binding: b, kind: "remove-routed", ij, routedTo };
  if (ij.length) return { binding: b, kind: "remove-swallow", ij, routedTo: [] };
  return { binding: b, kind: "remove-unbound", ij, routedTo: [] };
}

export const isRemoved = (d: Decision) => d.kind.startsWith("remove");

/** Builds the IntelliJ stroke index {canonical sequence -> action ids} from the keymap JSON. */
export function indexKeymap(km: Record<string, unknown>): (seq: string) => string[] {
  const idx = new Map<string, string[]>();
  for (const [id, keys] of Object.entries(km)) {
    if (id === "$meta" || !Array.isArray(keys)) continue;
    for (const k of keys as string[]) {
      const seq = parseKeystroke(k);
      if (seq) idx.set(seq, [...(idx.get(seq) ?? []), id]);
    }
  }
  return (seq) => idx.get(seq) ?? [];
}

export function audit(bindings: MonacoBinding[], km: Record<string, unknown>, implemented: Set<string>): Decision[] {
  const ij = indexKeymap(km);
  return bindings.map((b) => classify(b, ij, implemented));
}

/** Keys that stay owned by Monaco (used by the dispatcher to avoid swallowing e.g. native copy/paste). */
export function keptStrokes(ds: Decision[]): Set<string> {
  const s = new Set<string>();
  for (const d of ds) if (!isRemoved(d)) s.add(d.binding.seq);
  return s;
}

/** True when a binding that is still active would reinterpret a key IntelliJ binds to a different action. */
export function conflictsWithIntellij(b: MonacoBinding, ijByStroke: (seq: string) => string[]): boolean {
  if (isWidgetScoped(b.when)) return false;
  const ij = ijByStroke(b.seq);
  if (!ij.length) return true; // Monaco-only key (c)
  return !(EQUIV[b.command] ?? []).some((id) => ij.includes(id));
}
