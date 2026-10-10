/** Multi-project windows (one project per native macOS tab). Thin typed wrappers over the Rust `win_*` commands. */
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { invoke, listen, type Location } from "./ipc";

export interface WinItem {
  label: string;
  project: Location | null;
  title: string;
  current: boolean;
  focused: boolean;
}
export interface OpenResult {
  action: "focused" | "here" | "opened";
  label: string;
}

export const myLabel = () => getCurrentWebviewWindow().label;

export const windows = {
  list: () => invoke<WinItem[]>("win_list"),
  /** already open -> focus it ("focused"); `newWindow` -> new tab ("opened"); otherwise "here" (caller switches itself). */
  open: (loc: Location, newWindow: boolean) => invoke<OpenResult>("win_open_project", { loc, newWindow }),
  /** re-point THIS window at `loc` (kills its children, reloads the webview). */
  switchHere: (loc: Location) => invoke<OpenResult>("win_switch_here", { loc }),
  /** tell Rust which project this window displays (title, dedupe, session file). */
  setProject: (loc: Location | null) => invoke<void>("win_set_project", { loc }),
  focus: (label: string) => invoke<void>("win_focus", { label }),
  cycle: (delta: 1 | -1) => invoke<void>("win_cycle", { delta }),
  closeConfirmed: () => invoke<void>("win_close_confirmed"),
  closeCancelled: () => invoke<void>("win_close_cancelled"),
  quit: () => invoke<void>("win_quit"),
  branch: (loc: Location) => invoke<string | null>("project_branch", { loc }),
  tabbed: () => invoke<boolean>("win_tabbed"),
  onChanged: (cb: () => void) => listen("windows://changed", cb),
  onTabs: (cb: () => void) => listen("windows://tabs", cb),
  onCloseRequested: (cb: (reason: string) => void) => listen<{ reason: string }>("window://close-requested", (e) => cb(e.payload.reason)),
  onMenuAction: (cb: (id: string) => void) => listen<string>("menu://action", (e) => cb(e.payload)),
};
