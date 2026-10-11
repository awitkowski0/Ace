import { useStore } from "../../lib/store";
import { projectName, projectStore } from "../../lib/project";
import { shellStore } from "../../lib/shell";
import { openPopup } from "./popups";
import { runAction } from "../../actions/registry";
import { BranchIcon, ChevronDown, GearIcon, SearchIcon } from "./icons";
import { RunWidget } from "../run/Widget";
import { keysFor } from "../../actions/keymap";
import { formatKeystroke } from "../../actions/keystroke";

export function Toolbar() {
  const { root } = useStore(projectStore);
  const { branch } = useStore(shellStore);
  const key = keysFor("SearchEverywhere")[0];
  return (
    <div className="toolbar" data-tauri-drag-region>
      <div className="traffic-spacer" data-tauri-drag-region />
      <button className="widget" title="Projects (Recent Projects)" onClick={() => openPopup("RecentProjects")}>
        <span className="proj-badge">{root ? projectName(root).slice(0, 2).toUpperCase() : "A"}</span>
        <span>{root ? projectName(root) : "Ace"}</span>
        <ChevronDown />
      </button>
      <button className="widget" title="Git branch" onClick={() => runAction("Git.Branches")}>
        <BranchIcon />
        <span>{branch ?? "No VCS"}</span>
        <ChevronDown />
      </button>
      <div className="grow" data-tauri-drag-region />
      <div id="run-widget-slot" className="widget-slot">
        <RunWidget />
      </div>
      <button className="icon-btn" title={`Search Everywhere${key ? " " + formatKeystroke(key) : ""}`} onClick={() => runAction("SearchEverywhere")}><SearchIcon /></button>
      <button className="icon-btn" title="Settings"><GearIcon /></button>
    </div>
  );
}
