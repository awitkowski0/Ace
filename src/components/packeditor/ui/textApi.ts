/**
 * The file's Monaco model is the single source of truth, as in the Studio: a designer edit computes the new text, applies the
 * minimal change with `pushEditOperations` (one undo stop; a drag between begin/end coalesces into one), and the preview
 * re-reads the live text. Anything else that changes the file (typing in the code pane, a save from outside) shows up the
 * same way.
 */
import { useMemo, useRef } from "react";
import { monaco } from "../../../editor/monacoSetup";
import { minimalEdit } from "../../animstudio/core";
import { modelUri } from "../../animstudio/ui/api";

const LF = () => monaco.editor.EndOfLinePreference.LF;

function posOf(text: string, off: number): { line: number; col: number } {
  let line = 1;
  let last = -1;
  for (let i = text.indexOf("\n"); i >= 0 && i < off; i = text.indexOf("\n", i + 1)) { line++; last = i; }
  return { line, col: off - last };
}

export interface TextApi {
  /** live text (the model's, or `fallback` before the model exists) */
  read(): string;
  /** replace the file's text with `next` as one undo step (or part of the open gesture) */
  commit(next: string | ((cur: string) => string)): void;
  begin(): void;
  end(): void;
  undo(): void;
  redo(): void;
}

export function useTextApi(docKey: string, fallback: string): TextApi {
  const fb = useRef(fallback);
  fb.current = fallback;
  return useMemo(() => {
    let gesture = false;
    const model = () => monaco.editor.getModel(modelUri(docKey));
    const read = () => model()?.getValue(LF()) ?? fb.current;
    return {
      read,
      commit(next) {
        const m = model();
        const cur = read();
        const text = typeof next === "function" ? next(cur) : next;
        if (!m || text === cur) return;
        const e = minimalEdit(cur, text);
        const a = posOf(cur, e.start);
        const b = posOf(cur, e.end);
        if (!gesture) m.pushStackElement();
        m.pushEditOperations([], [{ range: new monaco.Range(a.line, a.col, b.line, b.col), text: e.text }], () => null);
        if (!gesture) m.pushStackElement();
      },
      begin() {
        if (gesture) return;
        gesture = true;
        model()?.pushStackElement();
      },
      end() {
        if (!gesture) return;
        gesture = false;
        model()?.pushStackElement();
      },
      undo() { model()?.undo(); },
      redo() { model()?.redo(); },
    };
  }, [docKey]);
}
