/** Action Control (Blockbench `F`): searchable list of every Studio command that applies right now. ↑/↓ navigate, Enter runs, Esc closes. */
import { useEffect, useMemo, useRef, useState } from "react";
import { useStudio } from "../state";
import { allStudios } from "../studios";
import { useToolsUi, toolsStore } from "../toolsUi";
import { runStudioCommand, studioCommands } from "./actions";

export function ActionControl() {
  const api = useStudio();
  const open = useToolsUi(api).actionControl;
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const handle = useMemo(() => (open ? allStudios().find((h) => h.api === api) ?? null : null), [open, api]);
  const items = useMemo(() => {
    if (!handle) return [];
    const needle = q.trim().toLowerCase();
    return studioCommands(handle).filter((c) => !needle || c.title.toLowerCase().includes(needle) || c.id.toLowerCase().includes(needle));
  }, [handle, q]);
  useEffect(() => { if (open) { setQ(""); setSel(0); setTimeout(() => input.current?.focus(), 0); } }, [open]);
  useEffect(() => setSel(0), [q]);
  if (!open || !handle) return null;
  const close = () => { toolsStore(api).set({ actionControl: false }); handle.root.current?.focus({ preventScroll: true }); };
  const run = (id: string) => { close(); setTimeout(() => runStudioCommand(handle, id), 0); };
  return (
    <div className="as-ac-bg" onMouseDown={close} data-testid="as-actioncontrol">
      <div className="as-ac" onMouseDown={(e) => e.stopPropagation()}>
        <input
          ref={input} className="as-ac-in" placeholder="Search actions…" value={q} spellCheck={false}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "ArrowDown") { e.preventDefault(); setSel((s) => Math.min(items.length - 1, s + 1)); }
            else if (e.key === "ArrowUp") { e.preventDefault(); setSel((s) => Math.max(0, s - 1)); }
            else if (e.key === "Enter") { e.preventDefault(); if (items[sel]) run(items[sel].id); }
            else if (e.key === "Escape") { e.preventDefault(); close(); }
          }}
        />
        <div className="as-ac-list">
          {items.map((c, i) => (
            <div key={c.id} className={"as-ac-row" + (i === sel ? " sel" : "")} data-action={c.id} onMouseMove={() => setSel(i)} onClick={() => run(c.id)}>
              <span className="t">{c.title}</span>
              <span className="k">{c.keys.join("  ")}</span>
            </div>
          ))}
          {!items.length && <div className="as-ac-empty">No matching action</div>}
        </div>
      </div>
    </div>
  );
}
