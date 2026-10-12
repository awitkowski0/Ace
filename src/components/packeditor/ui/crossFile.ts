/**
 * Edits to a file other than the one the view is showing (an ability view changing the preview suit's JSON, or a csv). There is
 * no editor-wide undoable cross-file edit, so this does the best available thing:
 *   - the file is open in the editor (it has a Monaco model): the edit goes into that buffer as an ordinary edit, one undo
 *     stop, unsaved, visible in its tab (undo it there);
 *   - otherwise it is read and written with fs, and the caller gets an `undo` that puts the old text back (while the file still
 *     reads what was written).
 * Either way the result says which, so the UI can tell the person.
 */
import { monaco } from "../../../editor/monacoSetup";
import { editorStore, reloadIfChanged } from "../../../editor/store";
import { dirname, fs, locKey } from "../../../lib/ipc";
import { minimalEdit } from "../../animstudio/core";
import { modelUri } from "../../animstudio/ui/api";
import { clearCatalogCache } from "./data";

export interface CrossEdit {
  via: "buffer" | "disk";
  path: string;
  before: string;
  after: string;
  /** disk only: restore the old text (false when the file changed since) */
  undo?: () => Promise<boolean>;
}

const LF = () => monaco.editor.EndOfLinePreference.LF;

function posOf(text: string, off: number): { line: number; col: number } {
  let line = 1;
  let last = -1;
  for (let i = text.indexOf("\n"); i >= 0 && i < off; i = text.indexOf("\n", i + 1)) { line++; last = i; }
  return { line, col: off - last };
}

/** The file's current text: the open buffer's, else the disk's (null when it can't be read). */
export async function currentText(host: string, path: string): Promise<string | null> {
  const m = monaco.editor.getModel(modelUri(locKey({ host, path })));
  if (m) return m.getValue(LF());
  try { return await fs.readFile({ host, path }); } catch { return null; }
}

/** Apply `fn` to the file's text. `fn` returns null (or the same text) for "nothing to do". Resolves null then. */
export async function editFile(host: string, path: string, fn: (cur: string) => string | null): Promise<CrossEdit | null> {
  const key = locKey({ host, path });
  const m = monaco.editor.getModel(modelUri(key));
  if (m) {
    const before = m.getValue(LF());
    const after = fn(before);
    if (after === null || after === before) return null;
    const e = minimalEdit(before, after);
    const a = posOf(before, e.start), b = posOf(before, e.end);
    m.pushStackElement();
    m.pushEditOperations([], [{ range: new monaco.Range(a.line, a.col, b.line, b.col), text: e.text }], () => null);
    m.pushStackElement();
    clearCatalogCache();
    return { via: "buffer", path, before, after };
  }
  let before: string;
  let isNew = false;
  try { before = await fs.readFile({ host, path }); } catch { before = ""; isNew = true; }
  const after = fn(before);
  if (after === null || after === before) return null;
  if (isNew) await fs.createDir({ host, path: dirname(path) }).catch(() => undefined); // a new file may need its folder
  await fs.writeFile({ host, path }, after);
  clearCatalogCache();
  if (editorStore.get().docs[key]) await reloadIfChanged(key);
  return {
    via: "disk", path, before, after,
    undo: async () => {
      const now = await fs.readFile({ host, path }).catch(() => null);
      if (now !== after) return false;
      await fs.writeFile({ host, path }, before);
      if (editorStore.get().docs[key]) await reloadIfChanged(key);
      return true;
    },
  };
}
