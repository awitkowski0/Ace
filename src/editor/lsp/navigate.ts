/** Open a file and reveal a range (no monaco namespace import). */
import { local, locKey } from "../../lib/ipc";
import { editorStore, openFile } from "../store";
import { activeEditor } from "../editorRegistry";
import type { Rng } from "./client";

export async function openAt(path: string, range?: Rng) {
  await openFile(local(path));
  if (!range) return;
  const key = locKey(local(path));
  for (let i = 0; i < 50; i++) {
    const ed = activeEditor();
    const m = ed?.getModel();
    if (ed && m && m.uri.path === path && editorStore.get().docs[key]) {
      const line = range.start.line + 1, col = range.start.character + 1;
      ed.setSelection({ startLineNumber: line, startColumn: col, endLineNumber: range.end.line + 1, endColumn: range.end.character + 1 });
      ed.revealPositionInCenterIfOutsideViewport({ lineNumber: line, column: col });
      ed.focus();
      return;
    }
    await new Promise((r) => setTimeout(r, 30));
  }
}
