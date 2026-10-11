import { openFile } from "../../editor/store";
import { activeEditor } from "../../editor/editorRegistry";
import type { Location } from "../../lib/ipc";

/** openFile + line, with a short re-assert: when the tab was visited before, Monaco restores its saved view state right after the
 * reveal request was applied and would put the caret back where it was. */
export async function openAt(loc: Location, line: number, col = 1) {
  await openFile(loc, { line, col });
  let stable = 0;
  for (let i = 0; i < 10 && stable < 3; i++) {
    await new Promise((r) => setTimeout(r, 60));
    const ed = activeEditor();
    const m = ed?.getModel();
    if (!ed || !m || m.uri.path !== loc.path) continue;
    if (ed.getPosition()?.lineNumber !== line) {
      stable = 0;
      ed.setPosition({ lineNumber: line, column: col });
      ed.revealLineInCenterIfOutsideViewport(line);
    } else stable++;
  }
}
