import { useEffect, useMemo, useRef } from "react";
import { useStore } from "../../lib/store";
import { runAction } from "../../actions/registry";
import { keysFor } from "../../actions/keymap";
import { formatKeystroke } from "../../actions/keystroke";
import { showContextMenu } from "../shell/contextMenu";
import { openPopup } from "../shell/popups";
import { ChevronDown, ChevronRight, PinIcon } from "../shell/icons";
import { addConfig, ctxFor, newConfig } from "../run/configs";
import type { ToolWindowProps } from "../../toolwindows/registry";
import { repoConfigStore } from "../../lib/repoConfig";
import { specFields } from "./cmdline";
import { ensureScan, godotStore } from "./model";
import { isPinned, movePin, openInGodotEditor, pinSpec, runSpec, unpinAt, unpinSpec, usePins } from "./ops";
import { specLabel, type GodotSpec } from "./presets";
import { buildRows, type Row } from "./tree";
import { EditorIcon, GodotIcon, HotIcon, ImportIcon, PresetIcon, ReloadIcon, SceneIcon, ScriptIcon } from "./icons";
import { godotUi, toggleRow } from "./ui";
import "./godot.css";

const kb = (a: string) => { const k = keysFor(a)[0]; return k ? formatKeystroke(k) : undefined; };

function createConfiguration(s: GodotSpec) {
  const ctx = ctxFor();
  if (!ctx) return;
  const f = specFields(s);
  addConfig(newConfig(f.type as string, ctx, { ...f, name: specLabel(s), temporary: false }), true);
  openPopup("EditRunConfigurations");
}

export function openMenu(x: number, y: number, row: Row) {
  godotUi.set({ selected: row });
  const s = row.spec;
  if (!s) {
    if (row.kind === "section" || row.kind === "more") showContextMenu(x, y, [{ label: "Refresh", run: () => void ensureScan(true) }]);
    return;
  }
  const pinned = row.kind === "pinned" || isPinned(s);
  showContextMenu(x, y, [
    { label: `Run '${specLabel(s)}'`, shortcut: kb("Godot.RunSelected"), run: () => void runSpec(s, "run") },
    { label: `Debug '${specLabel(s)}'`, run: () => void runSpec(s, "debug") },
    { label: "Create Run Configuration…", run: () => createConfiguration(s) },
    { separator: true, label: "" },
    pinned ? { label: "Unpin", shortcut: kb("Godot.Unpin"), run: () => void (row.kind === "pinned" ? unpinAt(row.pinIndex!) : unpinSpec(s)) } : { label: "Pin", run: () => void pinSpec(s) },
    ...(s.type === "scene" ? [{ label: "Open in Godot Editor", run: () => void openInGodotEditor(s.scene) }] : []),
    ...(s.scene || s.script ? [{ label: "Copy res:// Path", run: () => void navigator.clipboard?.writeText((s.scene ?? s.script)!).catch(() => {}) }] : []),
  ]);
}

const RowIcon = ({ r }: { r: Row }) => {
  switch (r.kind) {
    case "pinned": return <PinIcon />;
    case "run": return <GodotIcon size={14} />;
    case "scene": return <SceneIcon />;
    case "preset": return <PresetIcon />;
    case "script": return <ScriptIcon />;
    default: return null;
  }
};

export function useRows(): Row[] {
  const g = useStore(godotStore);
  const ui = useStore(godotUi);
  const pins = usePins();
  return useMemo(() => buildRows({ name: g.name, mainScene: g.mainScene, recent: g.settings.recent, scenes: g.scenes, presets: g.presets, scripts: g.scripts }, pins, ui.open), [g.name, g.mainScene, g.settings.recent, g.scenes, g.presets, g.scripts, pins, ui.open]);
}

export function GodotWindow(_: ToolWindowProps) {
  const g = useStore(godotStore);
  const ui = useStore(godotUi);
  const rows = useRows();
  const cfgErr = useStore(repoConfigStore).error;
  const body = useRef<HTMLDivElement>(null);
  const sel = ui.selected ? rows.find((r) => r.id === ui.selected!.id) ?? null : null;
  useEffect(() => { void ensureScan(); }, []);
  useEffect(() => { body.current?.querySelector(".gd-row.selected")?.scrollIntoView({ block: "nearest" }); }, [sel?.id]);
  const select = (r: Row) => godotUi.set({ selected: r });
  const key = (e: React.KeyboardEvent) => {
    const i = sel ? rows.findIndex((r) => r.id === sel.id) : -1;
    if (e.key === "ArrowDown") { e.preventDefault(); select(rows[Math.min(rows.length - 1, i + 1)] ?? rows[0]); }
    else if (e.key === "ArrowUp") { e.preventDefault(); if (rows.length) select(rows[Math.max(0, i - 1)]); }
    else if (e.key === "ArrowRight" && sel?.hasChildren) { e.preventDefault(); if (!ui.open.has(sel.id)) toggleRow(sel.id, true); else select(rows[i + 1]); }
    else if (e.key === "ArrowLeft" && sel) {
      e.preventDefault();
      if (sel.hasChildren && ui.open.has(sel.id)) toggleRow(sel.id, false);
      else for (let j = i - 1; j >= 0; j--) if (rows[j].depth < sel.depth) { select(rows[j]); break; }
    }
  };
  return (
    <div className="gd" data-testid="godot-window">
      <div className="gd-body" ref={body} tabIndex={0} data-autofocus onKeyDown={key} data-testid="godot-tree">
        {cfgErr && <div className="gd-empty">{cfgErr}</div>}
        {rows.map((r) => {
          const open = ui.open.has(r.id);
          return (
            <div key={r.id} className={"gd-row" + (r.kind === "section" ? " section" : "") + (sel?.id === r.id ? " selected" : "")} data-row={r.id} data-kind={r.kind} title={r.title}
              style={{ paddingLeft: r.depth * 16 }} draggable={r.kind === "pinned"}
              onDragStart={(e) => { e.dataTransfer.setData("text/godot-pin", String(r.pinIndex)); e.dataTransfer.effectAllowed = "move"; }}
              onDragOver={(e) => { if (r.kind === "pinned") e.preventDefault(); }}
              onDrop={(e) => { const from = Number(e.dataTransfer.getData("text/godot-pin")); if (r.kind === "pinned" && Number.isInteger(from)) void movePin(from, r.pinIndex!); }}
              onMouseDown={() => select(r)}
              onDoubleClick={() => (r.spec ? void runSpec(r.spec, "run") : r.hasChildren && toggleRow(r.id))}
              onContextMenu={(e) => { e.preventDefault(); openMenu(e.clientX, e.clientY, r); }}>
              <span className="gd-chev" onMouseDown={(e) => { if (r.hasChildren) { e.stopPropagation(); select(r); toggleRow(r.id); } }}>
                {r.hasChildren ? open ? <ChevronDown /> : <ChevronRight /> : null}
              </span>
              <span className={"gd-ico " + (r.kind === "pinned" ? "pin" : r.kind)}><RowIcon r={r} /></span>
              <span className="gd-label">{r.label}{r.kind === "section" && r.sub ? <span className="gd-hint">{r.sub}</span> : null}</span>
              {r.kind !== "section" && r.sub && <span className="gd-hint">{r.main ? "main scene" : r.sub}</span>}
            </div>
          );
        })}
        {g.scanning && !g.scanned && <div className="gd-empty">Scanning project…</div>}
      </div>
      <div className="gd-status" data-testid="godot-status">
        <span>{g.bin ? `Godot: ${g.bin.path}` : "Godot executable resolved on first run"}</span>
        {g.scanned && <span>· {g.scenes.length} scenes · {g.scripts.length} scripts · {g.presets.length} presets</span>}
      </div>
    </div>
  );
}

export function GodotHeaderActions(_: ToolWindowProps) {
  const ui = useStore(godotUi);
  const pins = usePins();
  const s = ui.selected?.spec;
  const pinned = !!s && (ui.selected!.kind === "pinned" || pins.length > 0 && isPinned(s));
  return (
    <>
      <button className="icon-btn sm" data-act="refresh" title="Refresh" onClick={() => void ensureScan(true)}><ReloadIcon /></button>
      <button className="icon-btn sm" data-act="editor" title="Open in Godot Editor" onClick={() => runAction("Godot.OpenEditor")}><EditorIcon /></button>
      <button className="icon-btn sm" data-act="import" title="Reimport Assets" onClick={() => runAction("Godot.Reimport")}><ImportIcon /></button>
      <button className="icon-btn sm" data-act="reload-scripts" title={`Reload Scripts in Running Game${kb("Godot.ReloadScripts") ? "  " + kb("Godot.ReloadScripts") : ""}`} onClick={() => runAction("Godot.ReloadScripts")}><HotIcon /></button>
      <button className="icon-btn sm" data-act="pin" title={pinned ? "Unpin" : "Pin"} disabled={!s} onClick={() => runAction(pinned ? "Godot.Unpin" : "Godot.Pin")}><PinIcon /></button>
    </>
  );
}
