import { useStore } from "../../lib/store";
import { openProject, openRemoteProject, pickAndOpenFolder, projectName, projectStore } from "../../lib/project";
import { shellStore } from "../../lib/shell";
import { showContextMenu } from "./contextMenu";
import { runAction } from "../../actions/registry";
import { BranchIcon, ChevronDown, FolderIcon, GearIcon, PlayIcon, SearchIcon } from "./icons";
import { keysFor } from "../../actions/keymap";
import { formatKeystroke } from "../../actions/keystroke";

export function Toolbar() {
  const { root, recent } = useStore(projectStore);
  const { branch } = useStore(shellStore);
  const key = keysFor("SearchEverywhere")[0];
  return (
    <div className="toolbar" data-tauri-drag-region>
      <div className="traffic-spacer" data-tauri-drag-region />
      <button
        className="widget"
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          showContextMenu(r.left, r.bottom + 2, [
            { label: "Open Folder…", run: pickAndOpenFolder },
            { label: "Open Remote Project…", run: openRemoteProject },
            { separator: true, label: "" },
            ...recent.map((l) => ({ label: `${projectName(l)}  —  ${l.host === "local" ? l.path.replace(/^\/Users\/[^/]+/, "~") : `${l.host}:${l.path}`}`, run: () => openProject(l) })),
          ]);
        }}
      >
        <span className="proj-badge">{root ? projectName(root).slice(0, 2).toUpperCase() : "A"}</span>
        <span>{root ? projectName(root) : "Atelier"}</span>
        <ChevronDown />
      </button>
      <button className="widget" title="Git branch" onClick={() => runAction("Git.Branches")}>
        <BranchIcon />
        <span>{branch ?? "No VCS"}</span>
        <ChevronDown />
      </button>
      <div className="grow" data-tauri-drag-region />
      <div id="run-widget-slot" className="widget-slot">
        <button className="widget dim" disabled><PlayIcon /><span>Add Configuration…</span></button>
      </div>
      <button className="icon-btn" title={`Search Everywhere${key ? " " + formatKeystroke(key) : ""}`} onClick={() => runAction("SearchEverywhere")}><SearchIcon /></button>
      <button className="icon-btn" title="Settings"><GearIcon /></button>
    </div>
  );
}
