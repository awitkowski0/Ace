import { useEffect, useMemo, useRef, useState } from "react";
import { PopupShell, closePopup, type PopupProps } from "../shell/popups";
import { useStore } from "../../lib/store";
import { DEFAULTS, loadGhosttyConfig, resetSettings, settingsStore, updateSettings, type TermSettings } from "./settings";
import { listThemes } from "./themes";
import { focusedPane, targetPane } from "./sessions";
import { openPopup } from "../shell/popups";

const refocus = (restore?: () => void) => { closePopup(); setTimeout(() => restore ? restore() : focusedPane()?.focus(), 40); };

/** Ghostty theme picker: type to filter, ↑↓ previews live on the focused terminal, ↩ applies, Esc reverts. */
export function ThemePicker({ props }: PopupProps) {
  const { s } = useStore(settingsStore);
  const [names, setNames] = useState<string[]>([]);
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const target = useRef(targetPane());
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => { void listThemes().then(setNames); }, []);
  const shown = useMemo(() => {
    const k = q.toLowerCase();
    return names.filter((n) => n.toLowerCase().includes(k)).slice(0, 300);
  }, [names, q]);
  useEffect(() => setSel(0), [q]);
  const name = shown[sel];
  useEffect(() => {
    if (name) void target.current?.applyTheme(undefined, name);
    list.current?.querySelector(".sel")?.scrollIntoView({ block: "nearest" });
  }, [name]);
  const revert = () => void target.current?.applyTheme();
  const close = () => { revert(); refocus(() => target.current?.focus()); };
  const apply = (mode: "both" | "light" | "dark") => {
    if (!name) return;
    const cur = s.theme;
    const pair = (k: "light" | "dark") => new RegExp(`${k}:([^,]+)`).exec(cur)?.[1]?.trim() ?? (/^(light|dark):/.test(cur) ? name : cur);
    updateSettings({ theme: mode === "both" ? name : mode === "light" ? `light:${name},dark:${pair("dark")}` : `light:${pair("light")},dark:${name}` });
    refocus(() => target.current?.focus());
  };
  void props;
  return (
    <PopupShell onClose={close} width={460} height={440}>
      <div className="tset">
        <div className="tset-title">Terminal Theme <span className="dim">{names.length - 1} Ghostty themes</span></div>
        <input
          className="dialog-input"
          autoFocus
          placeholder="Filter themes"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") { e.preventDefault(); setSel((i) => Math.min(shown.length - 1, i + 1)); }
            else if (e.key === "ArrowUp") { e.preventDefault(); setSel((i) => Math.max(0, i - 1)); }
            else if (e.key === "Enter") { e.preventDefault(); apply("both"); }
          }}
        />
        <div className="tset-list" ref={list}>
          {shown.map((n, i) => (
            <div key={n} className={"popup-row" + (i === sel ? " sel" : "")} onMouseDown={() => { setSel(i); }} onDoubleClick={() => apply("both")}>
              {n}{n === s.theme && <span className="dim">current</span>}
            </div>
          ))}
        </div>
        <div className="tset-foot">
          <button onClick={() => apply("light")}>Use for light</button>
          <button onClick={() => apply("dark")}>Use for dark</button>
          <button className="primary" onClick={() => apply("both")}>Apply</button>
        </div>
      </div>
    </PopupShell>
  );
}

type Field =
  | { k: keyof TermSettings; label: string; kind: "text" }
  | { k: keyof TermSettings; label: string; kind: "number"; step?: number; min?: number }
  | { k: keyof TermSettings; label: string; kind: "bool" }
  | { k: keyof TermSettings; label: string; kind: "select"; options: string[] };

const FIELDS: Field[] = [
  { k: "fontFamily", label: "Font family", kind: "text" },
  { k: "fontSize", label: "Font size", kind: "number", step: 1, min: 6 },
  { k: "lineHeight", label: "Line height", kind: "number", step: 0.05, min: 1 },
  { k: "cursorStyle", label: "Cursor style", kind: "select", options: ["block", "bar", "underline"] },
  { k: "cursorBlink", label: "Cursor blink", kind: "bool" },
  { k: "padding", label: "Padding (px)", kind: "number", step: 1, min: 0 },
  { k: "scrollback", label: "Scrollback (lines)", kind: "number", step: 1000, min: 0 },
  { k: "optionAsAlt", label: "Option key acts as Alt", kind: "bool" },
  { k: "copyOnSelect", label: "Copy on select", kind: "bool" },
  { k: "mouseHideWhileTyping", label: "Hide mouse while typing", kind: "bool" },
  { k: "confirmClose", label: "Confirm closing a running terminal", kind: "bool" },
  { k: "pasteProtection", label: "Paste protection", kind: "bool" },
  { k: "clipboardRead", label: "Clipboard read (OSC 52)", kind: "select", options: ["deny", "ask", "allow"] },
  { k: "clipboardWrite", label: "Clipboard write (OSC 52)", kind: "select", options: ["allow", "ask", "deny"] },
  { k: "shellIntegration", label: "Shell integration (new terminals)", kind: "bool" },
  { k: "notifications", label: "Desktop notifications (OSC 9 / 777)", kind: "bool" },
  { k: "bellVisual", label: "Visual bell + tab badge", kind: "bool" },
  { k: "images", label: "Inline images (sixel, iTerm2)", kind: "bool" },
  { k: "quickTerminalAutohide", label: "Quick terminal hides when focus leaves", kind: "bool" },
  { k: "quickTerminalHeight", label: "Quick terminal height (0.15-0.95)", kind: "number", step: 0.05, min: 0.15 },
];

export function TerminalSettings() {
  const { s } = useStore(settingsStore);
  const restore = useRef(targetPane());
  const done = () => refocus(() => restore.current?.focus());
  return (
    <PopupShell onClose={done} width={560} height={560}>
      <div className="tset">
        <div className="tset-title">Terminal Settings <span className="dim">Ghostty config is read if present; these choices win over it</span></div>
        <div className="tset-list tset-form">
          <div className="tset-row">
            <label>Theme</label>
            <button onClick={() => { closePopup(); setTimeout(() => openPopup("TerminalThemes"), 0); }}>{s.theme}…</button>
          </div>
          {FIELDS.map((f) => (
            <div className="tset-row" key={f.k}>
              <label>{f.label}</label>
              {f.kind === "bool" ? (
                <input type="checkbox" checked={!!s[f.k]} onChange={(e) => updateSettings({ [f.k]: e.target.checked })} />
              ) : f.kind === "select" ? (
                <select value={String(s[f.k])} onChange={(e) => updateSettings({ [f.k]: e.target.value })}>{f.options.map((o) => <option key={o}>{o}</option>)}</select>
              ) : f.kind === "number" ? (
                <input type="number" step={f.step} min={f.min} value={Number(s[f.k])} onChange={(e) => { const n = parseFloat(e.target.value); if (!Number.isNaN(n)) updateSettings({ [f.k]: n }); }} />
              ) : (
                <input type="text" value={String(s[f.k])} onChange={(e) => updateSettings({ [f.k]: e.target.value })} />
              )}
            </div>
          ))}
        </div>
        <div className="tset-foot">
          <button onClick={() => { resetSettings(); void loadGhosttyConfig(); }}>Reset to {DEFAULTS.theme === s.theme ? "defaults" : "Ghostty / defaults"}</button>
          <button className="primary" onClick={done}>Done</button>
        </div>
      </div>
    </PopupShell>
  );
}
