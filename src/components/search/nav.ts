import { editorStore, openFile } from "../../editor/store";
import { local, type Location } from "../../lib/ipc";
import { projectStore } from "../../lib/project";

export const currentRoot = (): Location | null => projectStore.get().root;
export const absLoc = (root: Location, path: string): Location => ({ host: root.host, path });

/** Open a file and put the caret at line/col (1-based). Uses the editor's first-class openFile API (no polling). */
export async function openAt(loc: Location, line?: number | null, col?: number | null, select?: number) {
  await openFile(loc, line ? { line, col: col ?? 1, select } : undefined);
}

export const recentPaths = (): string[] => {
  const { docs, recent } = editorStore.get();
  return recent.map((k) => docs[k]?.loc.path).filter(Boolean) as string[];
};
export { local };
