/** Data only: IntelliJ editor actions Ace implements on top of Monaco commands (keys come from the keymap JSON). */
export interface EditorActionDef {
  id: string; // IntelliJ action id
  title: string;
  monaco?: string; // Monaco command to run
  custom?: boolean; // implemented in editorActions.ts
  keys?: string[]; // fallback keys when the keymap JSON has none
}

export const EDITOR_ACTION_DEFS: EditorActionDef[] = [
  { id: "EditorDuplicate", title: "Duplicate Line or Selection", monaco: "editor.action.copyLinesDownAction" },
  { id: "EditorDeleteLine", title: "Delete Line", monaco: "editor.action.deleteLines" },
  { id: "CommentByLineComment", title: "Comment with Line Comment", monaco: "editor.action.commentLine" },
  { id: "CommentByBlockComment", title: "Comment with Block Comment", monaco: "editor.action.blockComment" },
  { id: "EditorSelectWord", title: "Extend Selection", monaco: "editor.action.smartSelect.expand" },
  { id: "EditorUnSelectWord", title: "Shrink Selection", monaco: "editor.action.smartSelect.shrink" },
  { id: "MoveLineUp", title: "Move Line Up", monaco: "editor.action.moveLinesUpAction" },
  { id: "MoveLineDown", title: "Move Line Down", monaco: "editor.action.moveLinesDownAction" },
  { id: "MoveStatementUp", title: "Move Statement Up", monaco: "editor.action.moveLinesUpAction" },
  { id: "MoveStatementDown", title: "Move Statement Down", monaco: "editor.action.moveLinesDownAction" },
  { id: "EditorJoinLines", title: "Join Lines", monaco: "editor.action.joinLines" },
  { id: "EditorStartNewLine", title: "Start New Line", monaco: "editor.action.insertLineAfter" },
  { id: "EditorStartNewLineBefore", title: "Start New Line Before Current", monaco: "editor.action.insertLineBefore" },
  { id: "EditorSplitLine", title: "Split Line", monaco: "lineBreakInsert" },
  { id: "EditorToggleCase", title: "Toggle Case", custom: true },
  { id: "SelectNextOccurrence", title: "Add Selection for Next Occurrence", monaco: "editor.action.addSelectionToNextFindMatch" },
  { id: "SelectAllOccurrences", title: "Select All Occurrences", monaco: "editor.action.selectHighlights" },
  { id: "UnselectPreviousOccurrence", title: "Unselect Occurrence", custom: true },
  { id: "EditorCloneCaretBelow", title: "Clone Caret Below", monaco: "editor.action.insertCursorBelow", keys: ["alt alt DOWN"] },
  { id: "EditorCloneCaretAbove", title: "Clone Caret Above", monaco: "editor.action.insertCursorAbove", keys: ["alt alt UP"] },
  { id: "CollapseRegion", title: "Collapse Region", monaco: "editor.fold" },
  { id: "ExpandRegion", title: "Expand Region", monaco: "editor.unfold" },
  { id: "CollapseAllRegions", title: "Collapse All Regions", monaco: "editor.foldAll" },
  { id: "ExpandAllRegions", title: "Expand All Regions", monaco: "editor.unfoldAll" },
  { id: "CollapseRegionRecursively", title: "Collapse Region Recursively", monaco: "editor.foldRecursively" },
  { id: "ExpandRegionRecursively", title: "Expand Region Recursively", monaco: "editor.unfoldRecursively" },
  { id: "EditorMatchBrace", title: "Move Caret to Matching Brace", monaco: "editor.action.jumpToBracket" },
  { id: "EditorCutLineEnd", title: "Cut up to Line End", custom: true },
  { id: "EditorTextStart", title: "Move Caret to Text Start", monaco: "cursorTop" },
  { id: "EditorTextEnd", title: "Move Caret to Text End", monaco: "cursorBottom" },
  { id: "EditorTextStartWithSelection", title: "Move Caret to Text Start with Selection", monaco: "cursorTopSelect" },
  { id: "EditorTextEndWithSelection", title: "Move Caret to Text End with Selection", monaco: "cursorBottomSelect" },
  { id: "EditorScrollToCenter", title: "Scroll to Center", custom: true },
  { id: "ReformatCode", title: "Reformat Code", monaco: "editor.action.formatDocument" },
  { id: "GotoLine", title: "Go to Line/Column…", custom: true },
  { id: "Find", title: "Find…", custom: true },
  { id: "Replace", title: "Replace…", custom: true },
  { id: "FindNext", title: "Find Next", custom: true },
  { id: "FindPrevious", title: "Find Previous", custom: true },
];

/** Non-Monaco navigation actions (tabs / history / layout), implemented in editorActions.ts. */
export const NAV_ACTION_IDS = ["Back", "Forward", "NextTab", "PreviousTab", "NextEditorTab", "PreviousEditorTab", "HideAllWindows", "RecentLocations"];

export const IMPLEMENTED_IDS = new Set([...EDITOR_ACTION_DEFS.map((d) => d.id), ...NAV_ACTION_IDS]);
