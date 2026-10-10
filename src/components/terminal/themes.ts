/** Ghostty themes: read from the installed Ghostty.app (or the user's theme dirs) at runtime, converted to xterm themes. */
import type { ITheme } from "@xterm/xterm";
import { invoke } from "../../lib/ipc";
import { DEFAULT_THEME, type TermSettings } from "./settings";
import { colorOverridesFrom, parseConfigText, resolveThemeName } from "./ghosttyConfig";

export const NORD: ITheme = {
  background: "#2e3440", foreground: "#d8dee9", cursor: "#d8dee9", cursorAccent: "#2e3440",
  selectionBackground: "#434c5e", selectionInactiveBackground: "#3b4252",
  black: "#3b4252", red: "#bf616a", green: "#a3be8c", yellow: "#ebcb8b",
  blue: "#81a1c1", magenta: "#b48ead", cyan: "#88c0d0", white: "#e5e9f0",
  brightBlack: "#4c566a", brightRed: "#bf616a", brightGreen: "#a3be8c", brightYellow: "#ebcb8b",
  brightBlue: "#81a1c1", brightMagenta: "#b48ead", brightCyan: "#8fbcbb", brightWhite: "#eceff4",
};

const ANSI = ["black", "red", "green", "yellow", "blue", "magenta", "cyan", "white", "brightBlack", "brightRed", "brightGreen", "brightYellow", "brightBlue", "brightMagenta", "brightCyan", "brightWhite"] as const;

/** Theme-style color keys (`background`, `p3`, ...) -> xterm theme (pure). */
export function themeFromColors(c: Record<string, string>, base: ITheme = {}): ITheme {
  const t: Record<string, any> = { ...base };
  ANSI.forEach((n, i) => { if (c[`p${i}`]) t[n] = c[`p${i}`]; });
  if (c.background) t.background = c.background;
  if (c.foreground) t.foreground = c.foreground;
  if (c["cursor-color"]) t.cursor = c["cursor-color"];
  if (c["cursor-text"]) t.cursorAccent = c["cursor-text"];
  if (c["selection-background"]) t.selectionBackground = c["selection-background"];
  if (c["selection-foreground"]) t.selectionForeground = c["selection-foreground"];
  if (!t.selectionBackground && t.foreground) t.selectionBackground = t.foreground + "40";
  if (!t.cursor && t.foreground) t.cursor = t.foreground;
  return t as ITheme;
}

export function parseThemeText(text: string): ITheme {
  return themeFromColors(colorOverridesFrom(parseConfigText(text)));
}

const cache = new Map<string, ITheme>();
export async function loadTheme(name: string): Promise<ITheme | null> {
  if (name === DEFAULT_THEME) return NORD;
  const hit = cache.get(name);
  if (hit) return hit;
  try {
    const text = await invoke<string | null>("ghostty_theme", { name });
    if (!text) return null;
    const t = parseThemeText(text);
    cache.set(name, t);
    return t;
  } catch {
    return null;
  }
}

let names: Promise<string[]> | null = null;
export const listThemes = (): Promise<string[]> =>
  (names ??= invoke<string[]>("ghostty_themes").then((l) => [DEFAULT_THEME, ...l]).catch(() => [DEFAULT_THEME]));

export const prefersDark = () => !window.matchMedia || window.matchMedia("(prefers-color-scheme: dark)").matches;

/** Effective xterm theme for the settings: theme (light/dark pair resolved) + config color overrides. */
export async function resolveTheme(s: Pick<TermSettings, "theme" | "colorOverrides">): Promise<ITheme> {
  const base = (await loadTheme(resolveThemeName(s.theme, prefersDark()))) ?? NORD;
  return Object.keys(s.colorOverrides).length ? themeFromColors(s.colorOverrides, base) : base;
}
