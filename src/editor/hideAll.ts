import { layoutStore, setActive } from "../lib/layout";
import { focusEditor } from "./editorRegistry";
import type { Side } from "../toolwindows/registry";

let saved: Record<Side, string | null> | null = null;

/** IntelliJ HideAllWindows (⌘⇧F12 / double-click an editor tab): maximise the editor, press again to restore. */
export function toggleHideAllWindows() {
  const active = layoutStore.get().active;
  const anyVisible = Object.values(active).some(Boolean);
  if (anyVisible) {
    saved = { ...active };
    (Object.keys(active) as Side[]).forEach((s) => setActive(s, null));
    focusEditor();
  } else if (saved) {
    (Object.keys(saved) as Side[]).forEach((s) => setActive(s, saved![s]));
    saved = null;
  }
}
export const editorMaximised = () => !Object.values(layoutStore.get().active).some(Boolean) && saved !== null;
