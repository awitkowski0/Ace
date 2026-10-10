import { useEffect, useRef } from "react";
import { useStore } from "../../lib/store";
import { getSettings } from "./settings";
import { hideQuick, quickStore } from "./sessions";
import { usePaneMount } from "./TerminalPanel";
import { SearchBar } from "./SearchBar";

/** Ghostty's quick terminal: a drop-down shell over the window, toggled by an action (no global OS hotkey). */
export function QuickTerminal() {
  const { open, pane } = useStore(quickStore);
  const mount = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLDivElement>(null);
  usePaneMount(pane, mount);
  useEffect(() => {
    if (!pane) return;
    if (open) {
      pane.setVisible(true);
      pane.refit();
      setTimeout(() => pane.focus(), 30);
    } else pane.setVisible(false);
  }, [open, pane]);
  if (!pane) return null;
  return (
    <div
      ref={box}
      className={"quick-term" + (open ? " open" : "")}
      data-toolwindow="terminal"
      data-quick="1"
      style={{ height: `${getSettings().quickTerminalHeight * 100}%` }}
      onBlur={() => {
        if (!open || !getSettings().quickTerminalAutohide) return;
        setTimeout(() => {
          const a = document.activeElement;
          if (box.current?.contains(a) || document.querySelector(".dialog-backdrop, .menu-backdrop, .popup-backdrop")) return;
          if (!document.hasFocus()) return;
          hideQuick(false);
        }, 80);
      }}
    >
      <div className="term-slot quick-slot" style={{ left: 0, top: 0, width: "100%", height: "100%" }}>
        <div className="term-mount" ref={mount} />
        {pane.search.open && <SearchBar pane={pane} />}
      </div>
    </div>
  );
}
