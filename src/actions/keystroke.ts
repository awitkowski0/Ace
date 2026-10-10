/** IntelliJ keystroke syntax: "meta shift O", "alt F12", "shift shift", "meta K meta C" (chord). */
const MOD_ALIASES: Record<string, string> = {
  shift: "shift", control: "control", ctrl: "control", alt: "alt", option: "alt", meta: "meta", cmd: "meta", command: "meta",
};
const MOD_ORDER = ["control", "alt", "shift", "meta"];

const canon = (mods: Set<string>, key: string) => [...MOD_ORDER.filter((m) => mods.has(m)), key].join(" ");

/** Returns canonical sequence ("meta shift O" or "meta K , meta C" or "double shift"), or null if unparseable/ignored. */
export function parseKeystroke(s: string): string | null {
  const toks = s.trim().split(/\s+/).filter(Boolean);
  if (!toks.length || toks.some((t) => /click|button\d|wheel/i.test(t))) return null;
  const low = toks.map((t) => t.toLowerCase());
  if (low.length === 2 && low[0] === low[1] && MOD_ALIASES[low[0]]) return `double ${MOD_ALIASES[low[0]]}`;
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
  return strokes.join(" , ");
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
  PageUp: "PAGE_UP", PageDown: "PAGE_DOWN", Insert: "INSERT",
};

export function isModifierCode(code: string) {
  return /^(Shift|Control|Alt|Meta)(Left|Right)$/.test(code);
}
export function modifierName(code: string): string | null {
  const m = /^(Shift|Control|Alt|Meta)(Left|Right)$/.exec(code);
  return m ? m[1].toLowerCase() : null;
}

/** Layout-independent (uses event.code so ⌥ combos don't produce special chars). */
export function strokeFromEvent(e: KeyboardEvent): string | null {
  if (isModifierCode(e.code)) return null;
  let key: string | undefined = CODE_MAP[e.code];
  if (!key) {
    if (/^Key[A-Z]$/.test(e.code)) key = e.code.slice(3);
    else if (/^Digit\d$/.test(e.code)) key = e.code.slice(5);
    else if (/^Numpad\d$/.test(e.code)) key = e.code.slice(6);
    else if (/^F\d{1,2}$/.test(e.code)) key = e.code;
  }
  if (!key) return null;
  const mods = new Set<string>();
  if (e.ctrlKey) mods.add("control");
  if (e.altKey) mods.add("alt");
  if (e.shiftKey) mods.add("shift");
  if (e.metaKey) mods.add("meta");
  return canon(mods, key);
}

const GLYPH: Record<string, string> = {
  control: "⌃", alt: "⌥", shift: "⇧", meta: "⌘", ESCAPE: "⎋", ENTER: "↩", BACK_SPACE: "⌫", DELETE: "⌦", TAB: "⇥",
  LEFT: "←", RIGHT: "→", UP: "↑", DOWN: "↓", SPACE: "Space", OPEN_BRACKET: "[", CLOSE_BRACKET: "]", SLASH: "/",
  COMMA: ",", PERIOD: ".", MINUS: "-", EQUALS: "=", PAGE_UP: "⇞", PAGE_DOWN: "⇟",
};
/** "meta shift O" -> "⇧⌘O" (mac display order) */
export function formatKeystroke(s: string): string {
  const seq = parseKeystroke(s);
  if (!seq) return s;
  return seq
    .split(" , ")
    .map((st) => {
      if (st.startsWith("double ")) return GLYPH[st.slice(7)] + GLYPH[st.slice(7)];
      return st.split(" ").map((t) => GLYPH[t] ?? t).join("");
    })
    .join(" ");
}
