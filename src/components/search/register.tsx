// Owned by the search agent. Replace the placeholders; keep registerPopup ids / action ids.
//   Popups: SearchEverywhere, GotoFile, GotoAction, FindInPath, RecentFiles, Switcher.
import { useEffect, useMemo, useRef, useState } from "react";
import { registerToolWindow } from "../../toolwindows/registry";
import { registerPopup, PopupShell, type PopupProps } from "../shell/popups";
import { Placeholder } from "../shell/Placeholder";
import { SearchIcon } from "../shell/icons";
import { editorStore, openFile } from "../../editor/store";
import { useStore } from "../../lib/store";

registerToolWindow({
  id: "find",
  title: "Find",
  icon: <SearchIcon />,
  side: "bottom",
  shortcut: "meta 3",
  actionId: "ActivateFindToolWindow",
  order: 9,
  component: () => <Placeholder name="Find" />,
});

const TABS = ["All", "Classes", "Files", "Symbols", "Actions", "Text"];

function makeSearchPopup(title: string, initialTab: string) {
  return function SearchPopup({ onClose }: PopupProps) {
    const [tab, setTab] = useState(initialTab);
    const [q, setQ] = useState("");
    const input = useRef<HTMLInputElement>(null);
    const { docs, recent } = useStore(editorStore);
    useEffect(() => input.current?.focus(), []);
    const items = useMemo(() => recent.map((k) => docs[k]).filter(Boolean), [recent, docs]);
    return (
      <PopupShell onClose={onClose} height={460}>
        <div className="popup-tabs">
          <span className="popup-title">{title}</span>
          {TABS.map((t) => (
            <span key={t} className={"popup-tab" + (t === tab ? " active" : "")} onClick={() => setTab(t)}>{t}</span>
          ))}
        </div>
        <input
          ref={input}
          className="popup-input"
          placeholder="Type / to see commands"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Tab") {
              e.preventDefault();
              setTab(TABS[(TABS.indexOf(tab) + (e.shiftKey ? TABS.length - 1 : 1)) % TABS.length]);
            }
          }}
        />
        <div className="popup-list">
          <div className="popup-section">Recent files (placeholder - search agent implements real search)</div>
          {items.map((d) => (
            <div key={d.key} className="popup-row" onClick={() => { openFile(d.loc); onClose(); }}>{d.name}<span className="dim">{d.loc.path}</span></div>
          ))}
        </div>
      </PopupShell>
    );
  };
}
registerPopup("SearchEverywhere", makeSearchPopup("Search Everywhere", "All"));
registerPopup("GotoFile", makeSearchPopup("Go to File", "Files"));
registerPopup("GotoAction", makeSearchPopup("Find Action", "Actions"));
registerPopup("FindInPath", makeSearchPopup("Find in Files", "Text"));

function RecentFiles({ onClose }: PopupProps) {
  const { docs, recent } = useStore(editorStore);
  const items = recent.map((k) => docs[k]).filter(Boolean);
  const [sel, setSel] = useState(Math.min(1, items.length - 1));
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => box.current?.focus(), []);
  return (
    <PopupShell onClose={onClose} width={420}>
      <div
        ref={box}
        tabIndex={0}
        className="popup-list"
        style={{ outline: "none", maxHeight: 400 }}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") setSel((s) => Math.min(items.length - 1, s + 1));
          else if (e.key === "ArrowUp") setSel((s) => Math.max(0, s - 1));
          else if (e.key === "Enter" && items[sel]) { openFile(items[sel].loc); onClose(); }
          else return;
          e.preventDefault();
        }}
      >
        <div className="popup-section">Recent Files</div>
        {items.map((d, i) => (
          <div key={d.key} className={"popup-row" + (i === sel ? " selected" : "")} onClick={() => { openFile(d.loc); onClose(); }}>{d.name}<span className="dim">{d.loc.path}</span></div>
        ))}
      </div>
    </PopupShell>
  );
}
registerPopup("RecentFiles", RecentFiles);
registerPopup("Switcher", RecentFiles);
