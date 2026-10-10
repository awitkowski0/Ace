/** Project/window actions (IntelliJ ids): switching between project windows (native tabs), Recent Projects, Close Project. */
import { registerAction } from "./registry";
import { openPopup } from "../components/shell/popups";
import { openRemoteProject, pickAndOpenFolder } from "../lib/project";
import { windows } from "../lib/windows";

registerAction({ id: "OpenFolder", title: "Open Folder…", run: pickAndOpenFolder });
registerAction({ id: "OpenRemoteProject", title: "Open Remote Project…", run: openRemoteProject });
registerAction({ id: "RecentProjects", intellijId: "ManageRecentProjects", title: "Recent Projects…", run: () => openPopup("RecentProjects") });
registerAction({
  id: "CloseProject", intellijId: "CloseProject", title: "Close Project",
  // Rust asks this window's webview first (unsaved-changes prompt), then destroys it; the last one leaves the Welcome window.
  run: async () => {
    const { confirmWindowClose } = await import("../lib/windowLifecycle");
    if (await confirmWindowClose("close")) await windows.closeConfirmed();
  },
});

// ⌘⌥` / ⌘⇧⌥` (and ⌘` / ⌘⇧`) cycle the project windows; with native tabs this walks the tab bar.
registerAction({ id: "NextProjectWindow", intellijId: "NextProjectWindow", title: "Next Project Window", run: () => windows.cycle(1) });
registerAction({ id: "PreviousProjectWindow", intellijId: "PreviousProjectWindow", title: "Previous Project Window", run: () => windows.cycle(-1) });
registerAction({ id: "NextWindow", intellijId: "NextWindow", title: "Next Window", run: () => windows.cycle(1) });
registerAction({ id: "PreviousWindow", intellijId: "PreviousWindow", title: "Previous Window", run: () => windows.cycle(-1) });
