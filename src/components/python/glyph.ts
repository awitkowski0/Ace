/** Shared plumbing for per-editor Python decorations (breakpoints, run markers, execution line). Types only: no monaco import. */
import type { editor } from "monaco-editor";
import { onEditorRegistered } from "../../editor/editorRegistry";
import { pyStore } from "./interpreter";
import { debugLanguages, subscribeDebugLanguages } from "../run/hooks";

export type EditorHook = (ed: editor.IStandaloneCodeEditor, model: editor.ITextModel) => void | (() => void);

/**
 * Calls `hook(editor, model)` for every Monaco editor (current and future) each time its model changes, running the previous
 * cleanup first. Models are filtered with `accept` (default: Python files). Also keeps the glyph margin on while a Python
 * project is active so the gutter does not jump when switching tabs.
 */
export function watchEditors(hook: EditorHook, accept: (m: editor.ITextModel) => boolean = isPythonModel): () => void {
  const subs = new Map<editor.IStandaloneCodeEditor, { dispose(): void }>();
  const cleanups = new Map<editor.IStandaloneCodeEditor, () => void>();
  const attach = (ed: editor.IStandaloneCodeEditor) => {
    cleanups.get(ed)?.();
    cleanups.delete(ed);
    const m = ed.getModel();
    if (m && accept(m)) {
      const c = hook(ed, m);
      if (c) cleanups.set(ed, c);
    }
  };
  const off = onEditorRegistered((ed) => {
    if (subs.has(ed)) return;
    ensureGlyph(ed);
    subs.set(ed, ed.onDidChangeModel(() => attach(ed)));
    attach(ed);
  });
  return () => { off(); subs.forEach((s) => s.dispose()); cleanups.forEach((c) => c()); };
}

export const isPythonModel = (m: editor.ITextModel) => m.getLanguageId() === "python" && m.uri.scheme === "file";

function ensureGlyph(ed: editor.IStandaloneCodeEditor) {
  let on = false;
  const apply = () => { if (!on && (pyStore.get().active || debugLanguages().length)) { on = true; ed.updateOptions({ glyphMargin: true }); } };
  apply();
  pyStore.subscribe(apply);
  subscribeDebugLanguages(apply);
}
