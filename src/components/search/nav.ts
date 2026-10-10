import { editorStore, openFile } from "../../editor/store";
import { activeEditor } from "../../editor/editorRegistry";
import { locKey, local, type Location } from "../../lib/ipc";
import { projectStore } from "../../lib/project";

export const currentRoot = (): Location | null => projectStore.get().root;
export const absLoc = (root: Location, path: string): Location => ({ host: root.host, path });

/** Open a file and put the caret at line/col (1-based) once the editor has loaded it. */
export async function openAt(loc: Location, line?: number | null, col?: number | null) {
  await openFile(loc);
  if (!line) return;
  const key = locKey(loc);
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, i < 2 ? 25 : 50));
    const st = editorStore.get();
    if (st.groups[st.activeGroup]?.active !== key) continue;
    const ed = activeEditor();
    const model = ed?.getModel();
    const doc = st.docs[key];
    if (!ed || !model || !doc) continue;
    if (!doc.dirty && model.getValue().length !== doc.initial.length && !doc.error) continue;
    const ln = Math.min(Math.max(1, line), model.getLineCount());
    const c = Math.min(Math.max(1, col ?? 1), model.getLineMaxColumn(ln));
    ed.setPosition({ lineNumber: ln, column: c });
    ed.revealLineInCenter(ln);
    ed.focus();
    return;
  }
}

export const recentPaths = (): string[] => {
  const { docs, recent } = editorStore.get();
  return recent.map((k) => docs[k]?.loc.path).filter(Boolean) as string[];
};
export { local };
