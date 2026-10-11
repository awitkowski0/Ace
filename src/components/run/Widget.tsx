import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useStore } from "../../lib/store";
import { editorStore, activeDocKey } from "../../editor/store";
import { keysFor } from "../../actions/keymap";
import { formatKeystroke } from "../../actions/keystroke";
import { runAction } from "../../actions/registry";
import { ChevronDown } from "../shell/icons";
import { DebugIcon, KebabIcon, RerunIcon, RunIcon, StopIcon } from "./icons";
import { promoteConfig, runStore, selectConfig, typeOf } from "./configs";
import { canStopAny, subscribeStop } from "./hooks";
import { rerunSession, sessionStore, sessions, startRun } from "./sessions";
import type { RunConfig } from "./types";

const key = (a: string) => { const k = keysFor(a)[0]; return k ? ` ${formatKeystroke(k)}` : ""; };

/** The editor has a file the context run (⌃⇧R) can run. */
function useHasContext() {
  const st = useStore(editorStore);
  const k = activeDocKey();
  const d = k ? st.docs[k] : undefined;
  return !!d && d.kind !== "diff" && !d.error && d.language === "python";
}

export function RunWidget() {
  const { configs, selectedId } = useStore(runStore);
  useStore(sessionStore);
  const stoppable = useSyncExternalStore(subscribeStop, canStopAny);
  const hasCtx = useHasContext();
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const sel = configs.find((c) => c.id === selectedId) ?? null;
  const running = sel ? sessions().find((s) => s.configId === sel.id && s.status !== "finished") : undefined;
  const canRun = !!sel || hasCtx;
  const name = sel?.name ?? "Add Configuration…";
  return (
    <div className="run-widget" data-testid="run-widget">
      <button
        className={"widget run-cfg" + (sel ? "" : " empty")} data-act="config" data-name={sel?.name ?? ""} data-temp={sel?.temporary ? "1" : "0"}
        title={sel ? `Select run/debug configuration (⌃⌥R)` : "Add Configuration…"}
        onClick={(e) => {
          if (!sel) return void runAction("EditRunConfigurations");
          const r = e.currentTarget.getBoundingClientRect();
          setMenu(menu ? null : { x: r.left, y: r.bottom + 2 });
        }}
      >
        <span className="run-cfg-icon">{sel ? typeOf(sel)?.icon : <RunIcon />}</span>
        <span className={"run-cfg-name" + (sel?.temporary ? " temp" : "")}>{name}</span>
        {sel && <ChevronDown />}
      </button>
      <button className="icon-btn run-btn" data-act="run" disabled={!canRun}
        title={running ? `Rerun '${sel!.name}'${key("Rerun")}` : sel ? `Run '${sel.name}'${key("Run")}` : `Run${key("Run")}`}
        onClick={() => { if (running) void rerunSession(running); else runAction("Run"); }}>
        {running ? <RerunIcon /> : <RunIcon />}
      </button>
      <button className="icon-btn run-btn" data-act="debug" disabled={!canRun || (!!sel && typeOf(sel)?.debuggable === false)}
        title={sel ? `Debug '${sel.name}'${key("Debug")}` : `Debug${key("Debug")}`} onClick={() => runAction("Debug")}>
        <DebugIcon />
      </button>
      <button className="icon-btn run-btn" data-act="stop" disabled={!stoppable} title={`Stop${key("Stop")}`} onClick={() => runAction("Stop")}>
        <StopIcon />
      </button>
      <button className="icon-btn run-btn" data-act="more" title="More Actions"
        onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); setMenu({ x: r.left - 160, y: r.bottom + 2 }); }}>
        <KebabIcon />
      </button>
      {menu && <ConfigMenu x={menu.x} y={menu.y} configs={configs} sel={sel} onClose={() => setMenu(null)} />}
    </div>
  );
}

function ConfigMenu({ x, y, configs, sel, onClose }: { x: number; y: number; configs: RunConfig[]; sel: RunConfig | null; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [hi, setHi] = useState(Math.max(0, configs.findIndex((c) => c.id === sel?.id)));
  const count = configs.length;
  const items: { label: string; run: () => void }[] = [];
  if (sel?.temporary) items.push({ label: `Save '${sel.name}' Configuration`, run: () => promoteConfig(sel.id) });
  items.push({ label: "Edit Configurations…", run: () => runAction("EditRunConfigurations") });
  useEffect(() => {
    const down = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) onClose(); };
    const keyh = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.stopPropagation(); onClose(); }
      else if (e.key === "ArrowDown") { e.preventDefault(); setHi((h) => Math.min(count + items.length - 1, h + 1)); }
      else if (e.key === "ArrowUp") { e.preventDefault(); setHi((h) => Math.max(0, h - 1)); }
      else if (e.key === "Enter") {
        e.preventDefault();
        if (hi < count) selectConfig(configs[hi].id); else items[hi - count]?.run();
        onClose();
      }
    };
    window.addEventListener("mousedown", down, true);
    window.addEventListener("keydown", keyh, true);
    return () => { window.removeEventListener("mousedown", down, true); window.removeEventListener("keydown", keyh, true); };
  });
  const left = Math.max(8, Math.min(x, window.innerWidth - 300));
  return (
    <div ref={ref} className="menu run-menu" style={{ left, top: y }} data-testid="run-menu">
      {configs.map((c, i) => (
        <div key={c.id} className={"menu-item run-menu-item" + (i === hi ? " hi" : "")} data-cfg={c.id} onMouseEnter={() => setHi(i)} onClick={() => { selectConfig(c.id); onClose(); }}>
          <span className="run-menu-check">{c.id === sel?.id ? "✓" : ""}</span>
          <span className="run-cfg-icon">{typeOf(c)?.icon}</span>
          <span className={"run-menu-name" + (c.temporary ? " temp" : "")}>{c.name}</span>
          <span className="grow" />
          <span className="run-menu-acts">
            <button className="icon-btn sm" title="Run" onClick={(e) => { e.stopPropagation(); onClose(); void startRun(c.id, "run"); }}><RunIcon /></button>
            {typeOf(c)?.debuggable !== false && <button className="icon-btn sm" title="Debug" onClick={(e) => { e.stopPropagation(); onClose(); void startRun(c.id, "debug"); }}><DebugIcon /></button>}
          </span>
        </div>
      ))}
      {count > 0 && <div className="menu-sep" />}
      {items.map((it, i) => (
        <div key={it.label} className={"menu-item" + (count + i === hi ? " hi" : "")} onMouseEnter={() => setHi(count + i)} onClick={() => { onClose(); it.run(); }}>
          <span>{it.label}</span>
        </div>
      ))}
    </div>
  );
}

