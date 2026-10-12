/**
 * Platform helpers. macOS is the reference platform: `isMac` true keeps every label and key path exactly as before.
 * Everything that is not macOS (Windows, and Linux as a fallback) uses Ctrl as the primary modifier and Explorer
 * wording. Detection runs once at import and is safe under vitest/jsdom (no navigator.platform there => not mac).
 */

/** Pure detection, exported for tests. */
export function detectPlatform(userAgent: string, platform = ""): { mac: boolean; windows: boolean } {
  const s = `${platform} ${userAgent}`;
  return {
    mac: /Mac|iPhone|iPad|iPod/i.test(s),
    windows: /Win/i.test(s),
  };
}

const nav: { userAgent?: string; platform?: string } | undefined = typeof navigator !== "undefined" ? navigator : undefined;
const detected = detectPlatform(nav?.userAgent ?? "", nav?.platform ?? "");

export const isMac: boolean = detected.mac;
export const isWindows: boolean = detected.windows;

/** Label for the primary (command) modifier: "⌘" on mac, "Ctrl" elsewhere. */
export const modKey = isMac ? "⌘" : "Ctrl";
/** The OS file manager: "Finder" on mac, "Explorer" elsewhere. */
export const fileManagerName = isMac ? "Finder" : "Explorer";

/**
 * True when the primary (command) modifier is down: metaKey on mac, ctrlKey elsewhere. Code that checks ⌃ (ctrlKey on
 * mac) must NOT use this helper; see the Windows mapping notes in src/actions/keystroke.ts.
 */
export function isMod(e: { metaKey: boolean; ctrlKey: boolean }, mac: boolean = isMac): boolean {
  return mac ? e.metaKey : e.ctrlKey;
}

const GLYPH_MODS: Record<string, string> = { "⌘": "Ctrl", "⌃": "Ctrl", "⌥": "Alt", "⇧": "Shift" };
const MOD_RANK: Record<string, number> = { Ctrl: 0, Alt: 1, Shift: 2 };
const GLYPH_KEYS: Record<string, string> = {
  "↩": "Enter", "⌫": "Backspace", "⌦": "Delete", "⇥": "Tab", "⎋": "Esc", "←": "Left", "→": "Right", "↑": "Up", "↓": "Down",
  "⇞": "PgUp", "⇟": "PgDn", "⌤": "Enter",
};

/**
 * Converts a mac glyph shortcut ("⇧⌘C", "⌥⇧R", "⌃⌥W", "⌘↩") to Windows text ("Ctrl+Shift+C", "Alt+Shift+R",
 * "Ctrl+Alt+W", "Ctrl+Enter"). Space-separated chord strokes are converted one by one. On mac returns `s` unchanged.
 * Display only: ⌘ and ⌃ both become "Ctrl" here, as in the spec. The key handling uses a stricter mapping (see
 * formatKeystroke in src/actions/keystroke.ts), so use that one for IntelliJ keystroke strings.
 */
export function formatShortcut(s: string, mac: boolean = isMac): string {
  if (mac || !s) return s;
  return s
    .split(" ")
    .map((stroke) => {
      const mods = new Set<string>();
      let i = 0;
      while (i < stroke.length && GLYPH_MODS[stroke[i]]) mods.add(GLYPH_MODS[stroke[i++]]);
      const rest = stroke.slice(i);
      if (!rest && !mods.size) return stroke;
      const key = GLYPH_KEYS[rest] ?? rest;
      return [...mods].sort((a, b) => MOD_RANK[a] - MOD_RANK[b]).concat(key ? [key] : []).join("+");
    })
    .join(" ");
}
