import { useEffect, useMemo, useRef, useState } from "react";
import { PopupShell, type PopupProps } from "../shell/popups";
import { runAction } from "../../actions/registry";
import { runStore, typeOf } from "./configs";
import { useStore } from "../../lib/store";
import { startRun } from "./sessions";
import { selectConfig } from "./configs";

export interface ChooseProps { mode: "run" | "debug" }

/** ⌃⌥R / ⌃⌥D: list of configurations (type to filter); Enter runs / debugs, "Edit Configurations…" opens the dialog. */
export function ChoosePopup({ onClose, props }: PopupProps) {
  const mode = ((props ?? {}) as ChooseProps).mode ?? "run";
  const { configs, selectedId } = useStore(runStore);
  const [q, setQ] = useState("");
  const list = useMemo(() => configs.filter((c) => (mode === "run" || typeOf(c)?.debuggable !== false) && c.name.toLowerCase().includes(q.toLowerCase())), [configs, q, mode]);
  const total = list.length + 1;
  const [hi, setHi] = useState(() => Math.max(0, list.findIndex((c) => c.id === selectedId)));
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { input.current?.focus(); }, []);
  useEffect(() => { setHi((h) => Math.min(h, total - 1)); }, [total]);
  const choose = (i: number) => {
    onClose();
    if (i >= list.length) return void runAction("EditRunConfigurations");
    const c = list[i];
    selectConfig(c.id);
    void startRun(c.id, mode);
  };
  return (
    <PopupShell onClose={onClose} width={440}>
      <div className="popup-tabs"><span className="popup-title">{mode === "run" ? "Run" : "Debug"}</span></div>
      <input ref={input} className="popup-input" data-testid="choose-input" value={q} placeholder="Type to filter" spellCheck={false}
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") { e.preventDefault(); setHi((h) => (h + 1) % total); }
          else if (e.key === "ArrowUp") { e.preventDefault(); setHi((h) => (h - 1 + total) % total); }
          else if (e.key === "Enter") { e.preventDefault(); choose(hi); }
        }} />
      <div className="popup-list" data-testid="choose-list">
        {list.map((c, i) => (
          <div key={c.id} className={"popup-row choose-row" + (i === hi ? " selected" : "")} data-cfg={c.id} onMouseEnter={() => setHi(i)} onClick={() => choose(i)}>
            <span className="se-icon">{typeOf(c)?.icon}</span>
            <span className={c.temporary ? "temp" : undefined}>{c.name}</span>
            <span className="grow" />
            {c.id === selectedId && <span className="gdim">selected</span>}
          </div>
        ))}
        {list.length > 0 && <div className="menu-sep" />}
        <div className={"popup-row choose-row" + (hi === list.length ? " selected" : "")} data-act="edit" onMouseEnter={() => setHi(list.length)} onClick={() => choose(list.length)}>
          <span>Edit Configurations…</span>
        </div>
      </div>
    </PopupShell>
  );
}
