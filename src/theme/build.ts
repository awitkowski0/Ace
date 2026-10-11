/** Pure builders: Scheme -> CSS variables, Monaco theme data, terminal palette. No DOM / monaco runtime imports (unit-testable). */
import type { editor } from "monaco-editor";
import { hex6, mix, withAlpha } from "./color";
import { DECL_COLOR, SEM_ROLES, VARIANT_MODS, semName, type SemRole } from "./semanticRoles";
import type { Scheme, Syn, Tok } from "./types";
import { nordTheme } from "../editor/nordTheme";

const h = (x: string) => "#" + hex6(x);

/** "rrggbb/bi" -> { fg, fontStyle } */
export function parseTok(t: Tok): { fg: string; style: string } {
  const [c, f = ""] = t.split("/");
  const style = [f.includes("i") ? "italic" : "", f.includes("b") ? "bold" : "", f.includes("s") ? "strikethrough" : "", f.includes("u") ? "underline" : ""].filter(Boolean);
  return { fg: hex6(c), style: style.join(" ") };
}

export function cssVars(s: Scheme): Record<string, string> {
  const u = s.ui;
  const v: Record<string, string> = {
    "--bg-editor": h(u.bg), "--bg-chrome": h(u.chrome), "--bg-popup": h(u.popup), "--bg-hover": h(u.hover), "--bg-selected": h(u.selected),
    "--bg-input": h(u.input), "--border": h(u.border), "--border-strong": h(u.borderStrong), "--fg": h(u.fg), "--fg-dim": h(u.fgDim),
    "--fg-faint": h(u.fgFaint), "--accent": h(u.accent), "--accent-bg": h(u.accentBg), "--on-accent": h(u.onAccent ?? "ffffff"),
    "--scroll-thumb": withAlpha(s.dark ? mix(u.fg, u.bg, 0.65) : mix(u.fg, u.bg, 0.55), 0.55),
    "--scroll-thumb-hover": withAlpha(s.dark ? mix(u.fg, u.bg, 0.5) : mix(u.fg, u.bg, 0.4), 0.9),
    "--shadow": s.dark ? "rgba(0,0,0,.5)" : "rgba(24,32,48,.22)",
    "--backdrop": s.dark ? "rgba(0,0,0,.25)" : "rgba(24,32,48,.18)",
  };
  s.slots.forEach((c, i) => { v[`--nord${i}`] = h(c); });
  return v;
}

const CONTROL_WORDS = ["if", "else", "for", "while", "do", "switch", "case", "default", "return", "break", "continue", "try", "catch", "finally", "throw", "yield", "await", "match"];

/** token-name -> Syn role (Monarch grammars append the language id, rules match by dotted prefix) */
const TOKEN_ROLES: [string, keyof Syn][] = [
  ["", "text"], ["comment", "comment"], ["comment.doc", "docComment"], ["comment.doc.tag", "docTag"],
  ["string", "string"], ["string.escape", "escape"], ["string.invalid", "invalid"], ["string.key", "key"], ["string.value", "string"],
  ["number", "number"], ["regexp", "regexp"], ["regexp.escape", "escape"],
  ["keyword", "keyword"], ["keyword.control", "control"], ["keyword.flow", "control"], ["keyword.json", "constant"], ["keyword.operator", "operator"],
  ["operator", "operator"], ["delimiter", "punct"],
  ["type", "type"], ["type.identifier", "type"], ["type.interface", "iface"], ["type.enum", "enumT"], ["type.parameter", "typeParam"], ["support.type", "type"],
  ["variable", "local"], ["variable.predefined", "self"], ["variable.parameter", "param"], ["variable.field", "field"],
  ["identifier", "text"], ["constant", "constant"], ["constant.enum", "enumMember"],
  ["function", "call"], ["function.declaration", "fnDecl"], ["function.macro", "macro"], ["predefined", "call"],
  ["annotation", "annotation"], ["metatag", "annotation"], ["meta", "annotation"], ["namespace", "ns"],
  ["tag", "tag"], ["attribute.name", "attr"], ["attribute.value", "string"], ["key", "key"], ["invalid", "invalid"],
  ["signal", "macro"], ["field", "field"], ["property", "field"], ["parameter", "param"], ["macro", "macro"],
];

export function monacoRules(syn: Syn): editor.ITokenThemeRule[] {
  const rules: editor.ITokenThemeRule[] = [];
  const add = (token: string, tok: Tok, extraStyle = "") => {
    const p = parseTok(tok);
    const fontStyle = [p.style, extraStyle].filter(Boolean).join(" ");
    rules.push(fontStyle ? { token, foreground: p.fg, fontStyle } : { token, foreground: p.fg });
  };
  for (const [t, r] of TOKEN_ROLES) add(t, syn[r]);
  for (const w of CONTROL_WORDS) add("keyword." + w, syn.control);
  // semantic tokens: one rule per role x {declaration, static, deprecated}
  for (const role of Object.keys(SEM_ROLES) as SemRole[]) {
    for (let m = 0; m < 8; m++) {
      const mods = { declaration: !!(m & 1), static: !!(m & 2), deprecated: !!(m & 4) };
      const key = (mods.declaration && DECL_COLOR[role]) || SEM_ROLES[role];
      const extra = [mods.static ? "italic" : "", mods.deprecated ? "strikethrough" : ""].filter(Boolean);
      const p = parseTok(syn[key]);
      const style = [...new Set([...p.style.split(" ").filter(Boolean), ...extra])].join(" ");
      rules.push(style ? { token: semName(role, mods), foreground: p.fg, fontStyle: style } : { token: semName(role, mods), foreground: p.fg });
    }
  }
  void VARIANT_MODS;
  return rules;
}

export function monacoTheme(s: Scheme): editor.IStandaloneThemeData {
  if (s.verbatimMonaco) {
    // The original Nord theme as is, plus the semantic rules (which only exist once an LSP sends tokens).
    const sem = monacoRules(s.syn).filter((r) => r.token.startsWith("sem."));
    return { ...nordTheme, rules: [...nordTheme.rules, ...sem] };
  }
  const u = s.ui, base = s.dark ? "vs-dark" : "vs";
  const fgFade = (a: number) => withAlpha(u.fg, a);
  return {
    base, inherit: true, rules: monacoRules(s.syn),
    colors: {
      "editor.background": h(u.bg), "editor.foreground": h(u.fg), "editorCursor.foreground": h(u.fg),
      "editor.lineHighlightBackground": h(u.lineHl), "editor.lineHighlightBorder": "#00000000",
      "editor.selectionBackground": h(u.selection), "editor.inactiveSelectionBackground": withAlpha(u.selection, 0.6),
      "editor.selectionHighlightBackground": withAlpha(u.selection, 0.6), "editor.wordHighlightBackground": fgFade(0.12),
      "editor.wordHighlightStrongBackground": fgFade(0.18),
      "editor.findMatchBackground": withAlpha(u.accent, 0.35), "editor.findMatchHighlightBackground": withAlpha(u.accent, 0.2),
      "editorLineNumber.foreground": h(s.dark ? mix(u.fgFaint, u.bg, 0.25) : u.fgFaint), "editorLineNumber.activeForeground": h(u.fg),
      "editorIndentGuide.background1": h(mix(u.bg, u.fg, 0.08)), "editorIndentGuide.activeBackground1": h(mix(u.bg, u.fg, 0.25)),
      "editorWhitespace.foreground": h(mix(u.bg, u.fg, 0.15)),
      "editorBracketMatch.background": withAlpha(u.accent, 0.25), "editorBracketMatch.border": h(u.accent),
      "editorGutter.background": h(u.bg),
      "editorWidget.background": h(u.popup), "editorWidget.border": h(u.border),
      "editorSuggestWidget.background": h(u.popup), "editorSuggestWidget.border": h(u.border), "editorSuggestWidget.selectedBackground": h(u.selected),
      "editorHoverWidget.background": h(u.popup), "editorHoverWidget.border": h(u.border),
      "editorStickyScroll.background": h(u.bg), "editorStickyScrollHover.background": h(u.hover),
      "input.background": h(u.input), "scrollbarSlider.background": withAlpha(mix(u.fg, u.bg, 0.7), 0.4),
      "scrollbarSlider.hoverBackground": withAlpha(mix(u.fg, u.bg, 0.6), 0.6), "scrollbarSlider.activeBackground": withAlpha(mix(u.fg, u.bg, 0.5), 0.8),
      "menu.background": h(u.popup), "menu.selectionBackground": h(u.selected),
      "diffEditor.insertedTextBackground": withAlpha(s.syn.string.split("/")[0], 0.16), "diffEditor.removedTextBackground": withAlpha(s.slots[11], 0.18),
      "peekViewEditor.background": h(u.chrome), "peekViewResult.background": h(u.chrome), "peekViewTitle.background": h(u.chrome),
    },
  };
}

type Term = Record<string, string>;
/** xterm theme (hex strings) for the IDE scheme. Used while the terminal's own setting is the default "Nord (Atelier)". */
export function termTheme(s: Scheme): Term {
  const u = s.ui, [red, green, yellow, blue, magenta, cyan] = s.ansi.map(h);
  const toward = s.dark ? "#ffffff" : "#000000";
  const br = (c: string) => (s.verbatimMonaco ? c : mix(c, toward, s.dark ? 0.18 : 0.12));
  const black = h(s.dark ? s.slots[1] : s.slots[6]), white = h(s.dark ? s.slots[5] : u.fgDim); // light schemes: "white" must stay readable on white
  return {
    background: h(u.bg), foreground: h(u.fg), cursor: h(u.fg), cursorAccent: h(u.bg),
    selectionBackground: h(u.selection), selectionInactiveBackground: h(u.hover),
    black, red, green, yellow, blue, magenta, cyan, white,
    brightBlack: h(s.slots[3]), brightRed: br(red), brightGreen: br(green), brightYellow: br(yellow), brightBlue: br(blue), brightMagenta: br(magenta),
    brightCyan: s.verbatimMonaco ? h(s.slots[7]) : br(cyan), brightWhite: h(s.slots[6]),
  };
}
