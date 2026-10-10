import { useEffect, useMemo, useRef, useState } from "react";
import { PopupShell, type PopupProps } from "../components/shell/popups";
import { basename } from "../lib/ipc";
import { navigationHistory, currentPosition, openFile } from "./store";

/** Recent Locations (⌘⇧E): navigation history, newest first. Enter jumps without recording a new history entry. */
export function RecentLocationsPopup({ onClose }: PopupProps) {
  const rows = useMemo(() => {
    const h = navigationHistory();
    const cur = currentPosition();
    return [...(cur ? [cur] : []), ...[...h.back].reverse(), ...h.forward]
      .filter((e, i, a) => a.findIndex((x) => x.key === e.key && x.line === e.line) === i);
  }, []);
  const [sel, setSel] = useState(rows.length > 1 ? 1 : 0);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => box.current?.focus(), []);
  const go = (i: number) => {
    const e = rows[i];
    if (!e) return;
    onClose();
    void openFile(e.loc, { line: e.line, col: e.col });
  };
  return (
    <PopupShell onClose={onClose} width={560}>
      <div style={{ padding: "10px 12px 4px", fontWeight: 600 }}>Recent Locations</div>
      <div
        ref={box}
        tabIndex={0}
        className="popup-list"
        style={{ outline: 0, maxHeight: 360 }}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") { e.preventDefault(); setSel((s) => Math.min(rows.length - 1, s + 1)); }
          else if (e.key === "ArrowUp") { e.preventDefault(); setSel((s) => Math.max(0, s - 1)); }
          else if (e.key === "Enter") { e.preventDefault(); go(sel); }
        }}
      >
        {rows.length === 0 && <div className="popup-section">No recent locations</div>}
        {rows.map((r, i) => (
          <div key={r.key + ":" + r.line} className={"popup-row" + (i === sel ? " selected" : "")} onClick={() => go(i)} onMouseMove={() => setSel(i)}>
            {basename(r.loc.path)}:{r.line}
            <span className="dim" style={{ marginLeft: 8 }}>{r.loc.path}</span>
          </div>
        ))}
      </div>
    </PopupShell>
  );
}
