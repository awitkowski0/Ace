/**
 * Window lifecycle on the webview side: Rust asks (`window://close-requested`) before it destroys a project window;
 * unsaved editors get IntelliJ's Save / Don't Save / Cancel prompt. Also routes native-menu File items to actions.
 */
import { editorStore, saveAll } from "../editor/store";
import { runAction } from "../actions/registry";
import { myLabel, windows } from "./windows";

/** true = the window may go away (no dirty editors, or the user saved / discarded). */
export async function confirmWindowClose(reason: "close" | "quit" | "switch" = "close"): Promise<boolean> {
  const dirty = Object.values(editorStore.get().docs).filter((d) => d.dirty);
  if (!dirty.length) return true;
  await windows.focus(myLabel()).catch(() => {}); // the prompt must be visible (this may be a background tab)
  const { choiceDialog } = await import("../components/shell/dialogs");
  const names = dirty.slice(0, 8).map((d) => d.name).join("\n") + (dirty.length > 8 ? `\n… and ${dirty.length - 8} more` : "");
  const what = reason === "quit" ? "Quit Ace" : reason === "switch" ? "Switch project" : "Close project";
  const r = await choiceDialog({
    title: `${what}: unsaved changes`,
    message: `${dirty.length} file${dirty.length > 1 ? "s have" : " has"} unsaved changes:\n${names}`,
    buttons: [
      { label: "Save", value: "save", primary: true },
      { label: "Don't Save", value: "discard" },
      { label: "Cancel", value: null },
    ],
  });
  if (r.value === "save") {
    await saveAll();
    return Object.values(editorStore.get().docs).every((d) => !d.dirty);
  }
  return r.value === "discard";
}

let installed = false;
export function installWindowLifecycle() {
  if (installed) return;
  installed = true;
  void windows.onCloseRequested(async (reason) => {
    const ok = await confirmWindowClose(reason === "quit" ? "quit" : "close");
    await (ok ? windows.closeConfirmed() : windows.closeCancelled());
  });
  // The native tab bar overlays the (full-size) webview: reserve its height under the toolbar while this window is tabbed.
  const sync = () => windows.tabbed().then((t) => document.documentElement.style.setProperty("--tabbar-h", t ? "26px" : "0px")).catch(() => {});
  void sync();
  void windows.onChanged(sync);
  void windows.onTabs(sync);
  window.addEventListener("focus", sync);
  void windows.onMenuAction((id) => runAction(id));
}
