/** Parser for the subset of Ghostty's config / theme file format that Atelier honours (pure; unit-tested). */
import type { TermSettings } from "./settings";

export type ConfigEntries = Array<[string, string]>;

/** `key = value` lines (comments `#`, optional quotes). Repeated keys are kept (palette, keybind, font-family). */
export function parseConfigText(text: string): ConfigEntries {
  const out: ConfigEntries = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const i = line.indexOf("=");
    if (i < 0) continue;
    const k = line.slice(0, i).trim();
    let v = line.slice(i + 1).trim();
    if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
    out.push([k, v]);
  }
  return out;
}

const bool = (v: string) => v === "true" || v === "1" || v === "yes";
const hex = (v: string) => (/^#?[0-9a-f]{6}$/i.test(v) ? "#" + v.replace(/^#/, "").toLowerCase() : undefined);

/** Color keys shared by theme files and the config (theme-style overrides). */
export function colorOverridesFrom(entries: ConfigEntries): Record<string, string> {
  const o: Record<string, string> = {};
  for (const [k, v] of entries) {
    if (k === "palette") {
      const m = /^(\d{1,3})\s*=\s*(#?[0-9a-f]{6})$/i.exec(v);
      if (m && +m[1] < 16) o[`p${m[1]}`] = hex(m[2])!;
    } else if (["background", "foreground", "cursor-color", "cursor-text", "selection-background", "selection-foreground"].includes(k)) {
      const h = hex(v);
      if (h) o[k] = h;
    }
  }
  return o;
}

/** Map a Ghostty config onto Atelier's terminal settings. Unknown keys are ignored. */
export function settingsFromGhostty(entries: ConfigEntries): Partial<TermSettings> {
  const s: Partial<TermSettings> = {};
  const fonts: string[] = [];
  for (const [k, v] of entries) {
    switch (k) {
      case "theme": if (v) s.theme = v; break;
      case "font-family": if (v) fonts.push(v); else fonts.length = 0; break;
      case "font-size": { const n = parseFloat(v); if (n > 4 && n < 100) s.fontSize = n; break; }
      case "adjust-cell-height": { const m = /^(-?\d+(?:\.\d+)?)%$/.exec(v); if (m) s.lineHeight = Math.min(2, Math.max(1, 1 + parseFloat(m[1]) / 100)); break; }
      case "cursor-style": s.cursorStyle = v === "bar" ? "bar" : v === "underline" ? "underline" : "block"; break;
      case "cursor-style-blink": if (v === "true" || v === "false") s.cursorBlink = v === "true"; break;
      // Ghostty counts bytes (default 10 MB); xterm counts lines. ~1 KB per line is a fair estimate for typical output.
      case "scrollback-limit": { const n = parseInt(v, 10); if (n >= 0) s.scrollback = Math.min(100000, Math.max(1000, Math.round(n / 1000))); break; }
      case "window-padding-x": case "window-padding-y": { const n = parseInt(v, 10); if (n >= 0) s.padding = n; break; }
      case "macos-option-as-alt": s.optionAsAlt = v === "true" || v === "left" || v === "right"; break;
      case "copy-on-select": s.copyOnSelect = v !== "false"; break;
      case "mouse-hide-while-typing": s.mouseHideWhileTyping = bool(v); break;
      case "confirm-close-surface": s.confirmClose = v !== "false"; break;
      case "clipboard-read": if (v === "allow" || v === "deny" || v === "ask") s.clipboardRead = v; break;
      case "clipboard-write": if (v === "allow" || v === "deny" || v === "ask") s.clipboardWrite = v; break;
      case "clipboard-paste-protection": s.pasteProtection = v !== "false"; break;
      case "shell-integration": s.shellIntegration = v !== "none"; break;
      case "desktop-notifications": s.notifications = v !== "false"; break;
      case "bell-features": s.bellVisual = /(^|,)\s*attention|(^|,)\s*title/.test(v) || /^(true|system|audio)/.test(v); break;
      case "quick-terminal-size": { const m = /^(\d+(?:\.\d+)?)%$/.exec(v); if (m) s.quickTerminalHeight = Math.min(0.95, Math.max(0.15, parseFloat(m[1]) / 100)); break; }
      case "quick-terminal-autohide": s.quickTerminalAutohide = bool(v); break;
    }
  }
  if (fonts.length) s.fontFamily = fonts.map((f) => (/[\s,]/.test(f) ? `"${f}"` : f)).join(", ") + ", Menlo, monospace";
  const co = colorOverridesFrom(entries);
  if (Object.keys(co).length) s.colorOverrides = co;
  return s;
}

/** Ghostty theme setting: `Name` or `light:Name,dark:Name`. */
export function resolveThemeName(theme: string, dark: boolean): string {
  if (!/(^|,)\s*(light|dark):/.test(theme)) return theme.trim();
  let light: string | undefined, drk: string | undefined;
  for (const part of theme.split(",")) {
    const m = /^\s*(light|dark):(.*)$/.exec(part);
    if (m) (m[1] === "light" ? (light = m[2].trim()) : (drk = m[2].trim()));
  }
  return (dark ? drk ?? light : light ?? drk) ?? theme;
}
