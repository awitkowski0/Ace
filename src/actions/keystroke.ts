import { isMac } from "../lib/platform";

/** IntelliJ keystroke syntax: "meta shift O", "alt F12", "shift shift", "meta K meta C" (chord). */
const MOD_ALIASES: Record<string, string> = {
  shift: "shift", control: "control", ctrl: "control", alt: "alt", option: "alt", meta: "meta", cmd: "meta", command: "meta",
};
const MOD_ORDER = ["control", "alt", "shift", "meta"];

const canon = (mods: Set<string>, key: string) => [...MOD_ORDER.filter((m) => mods.has(m)), key].join(" ");

/**
 * Returns canonical sequence ("meta shift O", "meta K , meta C", "double shift", "doublehold alt DOWN"), or null if
 * unparseable/ignored. Chord strokes may be separated by "," (keymap JSON) or just follow each other ("meta K meta C").
 */
export function parseKeystroke(s: string): string | null {
  if (!s.trim() || /click|button\d|wheel/i.test(s)) return null;
  const parts = s.split(",").map((p) => p.trim()).filter(Boolean);
  if (!parts.length) return null;
  const strokes: string[] = [];
  for (const part of parts) {
    const r = parseStrokes(part);
    if (!r) return null;
    strokes.push(...r);
  }
  return strokes.join(" , ");
}

function parseStrokes(s: string): string[] | null {
  const toks = s.trim().split(/\s+/).filter(Boolean);
  if (!toks.length) return null;
  const low = toks.map((t) => t.toLowerCase());
  if (low.length === 2 && low[0] === low[1] && MOD_ALIASES[low[0]]) return [`double ${MOD_ALIASES[low[0]]}`];
  // "alt alt DOWN": double-tap + hold gesture (clone caret)
  if (low.length === 3 && low[0] === low[1] && MOD_ALIASES[low[0]] && !MOD_ALIASES[low[2]])
    return [`doublehold ${MOD_ALIASES[low[0]]} ${normKeyName(toks[2])}`];
  const strokes: string[] = [];
  let mods = new Set<string>();
  for (let i = 0; i < toks.length; i++) {
    const m = MOD_ALIASES[low[i]];
    if (m) mods.add(m);
    else {
      strokes.push(canon(mods, normKeyName(toks[i])));
      mods = new Set();
    }
  }
  if (mods.size || !strokes.length) return null;
  return strokes;
}

function normKeyName(k: string) {
  const u = k.toUpperCase();
  return { ESC: "ESCAPE", RETURN: "ENTER", BACKSPACE: "BACK_SPACE", PAGEUP: "PAGE_UP", PAGEDOWN: "PAGE_DOWN" }[u] ?? u;
}

const CODE_MAP: Record<string, string> = {
  ArrowLeft: "LEFT", ArrowRight: "RIGHT", ArrowUp: "UP", ArrowDown: "DOWN", Backspace: "BACK_SPACE", Enter: "ENTER",
  NumpadEnter: "ENTER", Escape: "ESCAPE", Tab: "TAB", Space: "SPACE", Slash: "SLASH", BracketLeft: "OPEN_BRACKET",
  BracketRight: "CLOSE_BRACKET", Comma: "COMMA", Period: "PERIOD", Minus: "MINUS", Equal: "EQUALS", Semicolon: "SEMICOLON",
  Quote: "QUOTE", Backquote: "BACK_QUOTE", Backslash: "BACK_SLASH", Delete: "DELETE", Home: "HOME", End: "END",
  PageUp: "PAGE_UP", PageDown: "PAGE_DOWN", Insert: "INSERT", NumpadAdd: "ADD", NumpadSubtract: "SUBTRACT",
  NumpadMultiply: "MULTIPLY", NumpadDivide: "DIVIDE",
};

export function isModifierCode(code: string) {
  return /^(Shift|Control|Alt|Meta)(Left|Right)$/.test(code);
}
export function modifierName(code: string): string | null {
  const m = /^(Shift|Control|Alt|Meta)(Left|Right)$/.exec(code);
  return m ? m[1].toLowerCase() : null;
}

/** Layout-independent key name for a keydown (uses event.code so ⌥ combos don't produce special chars). */
function keyName(e: KeyboardEvent): string | null {
  let key: string | undefined = CODE_MAP[e.code];
  if (!key) {
    if (/^Key[A-Z]$/.test(e.code)) key = e.code.slice(3);
    else if (/^Digit\d$/.test(e.code)) key = e.code.slice(5);
    else if (/^Numpad\d$/.test(e.code)) key = e.code.slice(6);
    else if (/^F\d{1,2}$/.test(e.code)) key = e.code;
  }
  return key ?? null;
}

/** Mac stroke for a keydown: metaKey = "meta" (⌘), ctrlKey = "control" (⌃). See strokeCandidates for other platforms. */
export function strokeFromEvent(e: KeyboardEvent): string | null {
  if (isModifierCode(e.code)) return null;
  const key = keyName(e);
  if (!key) return null;
  const mods = new Set<string>();
  if (e.ctrlKey) mods.add("control");
  if (e.altKey) mods.add("alt");
  if (e.shiftKey) mods.add("shift");
  if (e.metaKey) mods.add("meta");
  return canon(mods, key);
}

/*
 * Windows / Linux key mapping. Canonical strokes stay mac-style ("meta" = ⌘, "control" = ⌃, "alt" = ⌥), so the one
 * keymap JSON serves both platforms. Physical keys map to canonical modifiers as follows:
 *
 *   Ctrl                 -> meta      ⌘X   is Ctrl+X         (the primary command key; every ⌘ binding keeps its chord)
 *   Ctrl+Alt             -> control   ⌃X   is Ctrl+Alt+X     (⌃ bindings; ⌃⌥X is Ctrl+Alt+X too, see priority below)
 *   Ctrl+Alt             -> meta alt  ⌘⌥X  is Ctrl+Alt+X     (last resort, after the two ⌃ forms)
 *   Alt, Shift           -> alt, shift (unchanged)
 *   Win (metaKey)        -> ignored (never part of an Ace shortcut; the OS reserves most Win chords anyway)
 *
 * Collision resolution: Ctrl+Alt+X has three possible meanings (⌃⌥X, ⌃X, ⌘⌥X). strokeCandidates returns them in that
 * order and the dispatcher takes the first one that is bound and runs, so ⌃⌥X wins over ⌃X, and ⌃X wins over ⌘⌥X.
 * Ctrl+X without Alt only ever means ⌘X, so ⌘ bindings never lose their chord. Consequence: on Windows a ⌃X binding
 * that shares its key with a ⌃⌥X binding is unreachable. Ctrl+Shift+X is "meta shift X" (⌘⇧X), and Ctrl+Alt+Shift+X
 * tries "control alt shift X", "control shift X", "meta alt shift X".
 * Double-tap: the Control key counts as ⌘ on Windows, so double-Ctrl runs "double meta" bindings; the Win key is ignored.
 */
const WIN_KEY: Record<string, string> = {
  ESCAPE: "Esc", ENTER: "Enter", BACK_SPACE: "Backspace", DELETE: "Delete", TAB: "Tab", LEFT: "Left", RIGHT: "Right",
  UP: "Up", DOWN: "Down", SPACE: "Space", PAGE_UP: "PgUp", PAGE_DOWN: "PgDn", OPEN_BRACKET: "[", CLOSE_BRACKET: "]",
  SLASH: "/", COMMA: ",", PERIOD: ".", MINUS: "-", EQUALS: "=", BACK_QUOTE: "`", BACK_SLASH: "\\", SEMICOLON: ";", QUOTE: "'",
};
const WIN_MOD: Record<string, string> = { meta: "Ctrl", control: "Ctrl+Alt", alt: "Alt", shift: "Shift" };

/**
 * Canonical stroke candidates for a keydown, most specific first. Mac: exactly one (strokeFromEvent). Windows/Linux:
 * see the mapping table above. Empty when the event is not a keystroke (lone modifier, unmapped key).
 */
export function strokeCandidates(e: KeyboardEvent, mac: boolean = isMac): string[] {
  if (mac) {
    const s = strokeFromEvent(e);
    return s ? [s] : [];
  }
  if (isModifierCode(e.code)) return [];
  const key = keyName(e);
  if (!key) return [];
  const mods = (...m: string[]) => new Set(e.shiftKey ? [...m, "shift"] : m);
  if (e.ctrlKey && e.altKey) {
    return [canon(mods("control", "alt"), key), canon(mods("control"), key), canon(mods("meta", "alt"), key)];
  }
  if (e.ctrlKey) return [canon(mods("meta"), key)];
  return [canon(mods(...(e.altKey ? ["alt"] : [])), key)];
}

const GLYPH: Record<string, string> = {
  control: "⌃", alt: "⌥", shift: "⇧", meta: "⌘", ESCAPE: "⎋", ENTER: "↩", BACK_SPACE: "⌫", DELETE: "⌦", TAB: "⇥",
  LEFT: "←", RIGHT: "→", UP: "↑", DOWN: "↓", SPACE: "Space", OPEN_BRACKET: "[", CLOSE_BRACKET: "]", SLASH: "/",
  COMMA: ",", PERIOD: ".", MINUS: "-", EQUALS: "=", PAGE_UP: "⇞", PAGE_DOWN: "⇟",
};
/** Display of one canonical stroke on Windows, using the same mapping as strokeCandidates (⌃ shows as Ctrl+Alt). */
function winStroke(st: string): string {
  const toks = st.split(" ");
  const key = toks[toks.length - 1];
  const mods = new Set(toks.slice(0, -1));
  const parts: string[] = [];
  if (mods.has("meta") || mods.has("control")) parts.push("Ctrl");
  if (mods.has("alt") || mods.has("control")) parts.push("Alt");
  if (mods.has("shift")) parts.push("Shift");
  return [...parts, WIN_KEY[key] ?? key].join("+");
}

/** "meta shift O" -> "⇧⌘O" on mac (mac display order), "Ctrl+Shift+O" elsewhere. */
export function formatKeystroke(s: string, mac: boolean = isMac): string {
  const seq = parseKeystroke(s);
  if (!seq) return s;
  return seq
    .split(" , ")
    .map((st) => {
      if (st.startsWith("double ")) {
        const m = st.slice(7);
        return mac ? GLYPH[m] + GLYPH[m] : `${WIN_MOD[m] ?? m} ${WIN_MOD[m] ?? m}`;
      }
      if (st.startsWith("doublehold ")) {
        const [, m, k] = st.split(" ");
        return mac ? GLYPH[m] + GLYPH[m] + (GLYPH[k] ?? k) : `${WIN_MOD[m] ?? m} ${WIN_MOD[m] ?? m}+${WIN_KEY[k] ?? k}`;
      }
      return mac ? st.split(" ").map((t) => GLYPH[t] ?? t).join("") : winStroke(st);
    })
    .join(" ");
}
