/**
 * IntelliJ-style in-file Find / Replace (⌘F, ⌘R, ⌘G, ⌘⇧G) on top of Monaco's text model API.
 * Monaco's own find widget bindings are removed by the keymap policy; this module + FindBar.tsx replace it.
 */
import type { editor } from "monaco-editor";
import { createStore } from "../lib/store";
import { activeEditor } from "./editorRegistry";

export interface FindState {
  open: boolean;
  replace: boolean; // show the replace row
  query: string;
  replaceText: string;
  matchCase: boolean;
  wholeWord: boolean;
  regex: boolean;
  total: number;
  index: number; // 1-based index of the match the selection is on, 0 if none
  focusNonce: number; // bumped to (re)focus + select the query field
  invalid: boolean; // bad regex
}
export const findStore = createStore<FindState>({
  open: false, replace: false, query: "", replaceText: "", matchCase: false, wholeWord: false, regex: false,
  total: 0, index: 0, focusNonce: 0, invalid: false,
});

const MAX_MATCHES = 20000;
const WORD_SEPARATORS = "`~!@#$%^&*()-=+[{]}\\|;:'\",.<>/?";
const decos = new WeakMap<editor.IStandaloneCodeEditor, string[]>();

function matchesOf(ed: editor.IStandaloneCodeEditor): editor.FindMatch[] {
  const f = findStore.get();
  const model = ed.getModel();
  if (!model || !f.query) return [];
  try {
    const m = model.findMatches(f.query, false, f.regex, f.matchCase, f.wholeWord ? WORD_SEPARATORS : null, false, MAX_MATCHES);
    if (f.invalid) findStore.set({ invalid: false });
    return m.filter((x) => !x.range.isEmpty());
  } catch {
    if (!f.invalid) findStore.set({ invalid: true });
    return [];
  }
}

const sameRange = (a: { startLineNumber: number; startColumn: number; endLineNumber: number; endColumn: number }, b: typeof a) =>
  a.startLineNumber === b.startLineNumber && a.startColumn === b.startColumn && a.endLineNumber === b.endLineNumber && a.endColumn === b.endColumn;

/** Recompute counts + highlight decorations for `ed` (call on query/option/content/selection change). */
export function refreshFind(ed: editor.IStandaloneCodeEditor | undefined = activeEditor()) {
  if (!ed) return;
  const f = findStore.get();
  const ms = f.open || f.query ? matchesOf(ed) : [];
  const sel = ed.getSelection();
  const cur = sel ? ms.findIndex((m) => sameRange(m.range, sel)) : -1;
  findStore.set({ total: ms.length, index: cur + 1 });
  const next = f.open
    ? ms.map((m, i) => ({
        range: m.range,
        options: { className: i === cur ? "find-match-current" : "find-match", overviewRuler: { color: "#ebcb8b99", position: 4 /* Center */ } },
      }))
    : [];
  decos.set(ed, ed.deltaDecorations(decos.get(ed) ?? [], next));
}

export function clearFindHighlights(ed: editor.IStandaloneCodeEditor | undefined = activeEditor()) {
  if (ed) decos.set(ed, ed.deltaDecorations(decos.get(ed) ?? [], []));
}

/** Select the next (dir 1) / previous (dir -1) match relative to the caret, wrapping. */
export function findNext(dir: 1 | -1 = 1, ed: editor.IStandaloneCodeEditor | undefined = activeEditor(), keepFocus = false) {
  if (!ed) return false;
  if (!findStore.get().query) seedFromEditor(ed);
  const ms = matchesOf(ed);
  if (!ms.length) { refreshFind(ed); return false; }
  const sel = ed.getSelection()!;
  const pos = dir === 1 ? sel.getEndPosition() : sel.getStartPosition();
  let pick: editor.FindMatch | undefined;
  if (dir === 1) pick = ms.find((m) => m.range.getStartPosition().isBeforeOrEqual(pos) ? false : true) ?? ms[0];
  else pick = [...ms].reverse().find((m) => m.range.getEndPosition().isBefore(pos)) ?? ms[ms.length - 1];
  // when the caret is exactly at a match start (e.g. just-opened bar) prefer that match for "next"
  if (dir === 1 && sel.isEmpty()) {
    const at = ms.find((m) => m.range.getStartPosition().equals(pos));
    if (at) pick = at;
  }
  ed.setSelection(pick.range);
  ed.revealRangeInCenterIfOutsideViewport(pick.range);
  if (!keepFocus) ed.focus();
  refreshFind(ed);
  return true;
}

function seedFromEditor(ed: editor.IStandaloneCodeEditor) {
  const sel = ed.getSelection();
  const model = ed.getModel();
  if (!sel || !model) return;
  let text = sel.isEmpty() ? model.getWordAtPosition(sel.getPosition())?.word ?? "" : model.getValueInRange(sel);
  if (text.includes("\n")) text = "";
  if (text) findStore.set({ query: text });
}

/** ⌘F / ⌘R: open the bar, seeded from a single-line selection (or the word at the caret when no query yet). */
export function openFind(replace: boolean) {
  const ed = activeEditor();
  const sel = ed?.getSelection();
  if (ed && sel && !sel.isEmpty() && sel.startLineNumber === sel.endLineNumber) seedFromEditor(ed);
  findStore.set((s) => ({ open: true, replace: replace || (s.replace && s.open), focusNonce: s.focusNonce + 1 }));
  refreshFind(ed);
}
export function closeFind() {
  findStore.set({ open: false });
  const ed = activeEditor();
  clearFindHighlights(ed);
  ed?.focus();
}

function expand(ed: editor.IStandaloneCodeEditor, m: editor.FindMatch): string {
  const f = findStore.get();
  if (!f.regex) return f.replaceText;
  try {
    const re = new RegExp(f.query, f.matchCase ? "" : "i");
    return (m.matches?.[0] ?? "").replace(re, f.replaceText.replace(/\\n/g, "\n").replace(/\\t/g, "\t"));
  } catch {
    return f.replaceText;
  }
}

export function replaceCurrent(ed: editor.IStandaloneCodeEditor | undefined = activeEditor()) {
  if (!ed || ed.getRawOptions().readOnly) return;
  const ms = matchesOf(ed);
  const sel = ed.getSelection();
  const cur = sel ? ms.find((m) => sameRange(m.range, sel)) : undefined;
  if (!cur) { findNext(1, ed, true); return; }
  ed.executeEdits("find-replace", [{ range: cur.range, text: expand(ed, cur) }]);
  findNext(1, ed, true);
}
export function replaceAll(ed: editor.IStandaloneCodeEditor | undefined = activeEditor()) {
  if (!ed) return;
  const ms = matchesOf(ed);
  if (!ms.length) return;
  ed.executeEdits("find-replace", ms.map((m) => ({ range: m.range, text: expand(ed, m) })));
  refreshFind(ed);
}

/** ⌘G / ⌘⇧G: works with or without the bar (uses the last query, or the word at the caret). */
export function findAgain(dir: 1 | -1) {
  const ed = activeEditor();
  if (!ed) return;
  findNext(dir, ed, false);
}
