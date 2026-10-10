/** Terminal settings. Layers: defaults < Ghostty config (read-only, if one exists) < Atelier's own choices (localStorage). */
import { createStore } from "../../lib/store";
import { invoke } from "../../lib/ipc";
import { parseConfigText, settingsFromGhostty } from "./ghosttyConfig";

export interface TermSettings {
  /** Ghostty theme name, or `light:Name,dark:Name`. "Nord (Atelier)" = the IDE's own palette. */
  theme: string;
  fontFamily: string;
  fontSize: number;
  lineHeight: number;
  cursorStyle: "block" | "bar" | "underline";
  cursorBlink: boolean;
  scrollback: number;
  padding: number;
  optionAsAlt: boolean;
  copyOnSelect: boolean;
  mouseHideWhileTyping: boolean;
  confirmClose: boolean;
  clipboardRead: "ask" | "deny" | "allow";
  clipboardWrite: "allow" | "ask" | "deny";
  pasteProtection: boolean;
  shellIntegration: boolean;
  notifications: boolean;
  bellVisual: boolean;
  images: boolean;
  quickTerminalHeight: number;
  quickTerminalAutohide: boolean;
  /** theme-style color keys from a Ghostty config (background, foreground, p0..p15, ...) */
  colorOverrides: Record<string, string>;
}

export const DEFAULT_THEME = "Nord (Atelier)";
export const DEFAULTS: TermSettings = {
  theme: DEFAULT_THEME,
  fontFamily: '"JetBrains Mono", Menlo, monospace',
  fontSize: 13,
  lineHeight: 1.15,
  cursorStyle: "block",
  cursorBlink: true,
  scrollback: 10000,
  padding: 6,
  optionAsAlt: true,
  copyOnSelect: true,
  mouseHideWhileTyping: false,
  confirmClose: true,
  clipboardRead: "deny",
  clipboardWrite: "allow",
  pasteProtection: true,
  shellIntegration: true,
  notifications: true,
  bellVisual: true,
  images: true,
  quickTerminalHeight: 0.45,
  quickTerminalAutohide: true,
  colorOverrides: {},
};

const KEY = "atelier.terminal.settings";
function loadStored(): Partial<TermSettings> {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? "{}");
  } catch {
    return {};
  }
}

let ghostty: Partial<TermSettings> = {};
let stored = loadStored();
const merge = (): TermSettings => ({ ...DEFAULTS, ...ghostty, ...stored });
export const settingsStore = createStore<{ s: TermSettings }>({ s: merge() });
export const getSettings = () => settingsStore.get().s;

/** Change settings (persisted as Atelier's own choices, winning over the Ghostty config). */
export function updateSettings(patch: Partial<TermSettings>) {
  stored = { ...stored, ...patch };
  try { localStorage.setItem(KEY, JSON.stringify(stored)); } catch {}
  settingsStore.set({ s: merge() });
}
export function resetSettings() {
  stored = {};
  try { localStorage.removeItem(KEY); } catch {}
  settingsStore.set({ s: merge() });
}

/** Read the user's Ghostty config once at startup (and on "Reload Config"). No config file = nothing changes. */
export async function loadGhosttyConfig(): Promise<boolean> {
  try {
    const text = await invoke<string | null>("ghostty_config");
    ghostty = text ? settingsFromGhostty(parseConfigText(text)) : {};
    settingsStore.set({ s: merge() });
    return !!text;
  } catch {
    return false;
  }
}
