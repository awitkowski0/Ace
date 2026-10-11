/**
 * Colour scheme runtime: current scheme (global preference, persisted in the data dir like IntelliJ's look-and-feel),
 * live apply to the DOM (CSS variables), Monaco (monacoSetup registers an applier) and the terminal (subscribers).
 */
import { createStore } from "../lib/store";
import { invoke } from "../lib/ipc";
import { cssVars, monacoTheme, termTheme } from "./build";
import { DEFAULT_SCHEME, SCHEMES, schemeById } from "./schemes";
import type { Scheme } from "./types";

export { SCHEMES, schemeById, DEFAULT_SCHEME };
export type { Scheme };

const PREF = "colorScheme";
/** `saved` = persisted choice, `preview` = Quick Switch Scheme hover (not persisted), `rev` bumps on every effective change. */
export const schemeStore = createStore<{ saved: string; preview: string | null; rev: number }>({ saved: DEFAULT_SCHEME, preview: null, rev: 0 });

export const effectiveScheme = (): Scheme => { const s = schemeStore.get(); return schemeById(s.preview ?? s.saved); };
export const savedScheme = (): Scheme => schemeById(schemeStore.get().saved);

/** Monaco theme name. Always "nord": other modules (diff editor, find preview) hard-code it, so the data behind the name is swapped instead. */
export const MONACO_THEME = "nord";

type Applier = (s: Scheme) => void;
const appliers: Applier[] = [];
/** register a live applier (called now and on every effective scheme change) */
export function registerSchemeApplier(fn: Applier) { appliers.push(fn); fn(effectiveScheme()); }
/** Monaco side: define the theme data under MONACO_THEME and activate it (re-defining the active theme updates all editors). */
export const monacoThemeData = () => monacoTheme(effectiveScheme());
export const terminalTheme = () => termTheme(effectiveScheme());

export function applyDom(s: Scheme) {
  const root = document.documentElement;
  for (const [k, v] of Object.entries(cssVars(s))) root.style.setProperty(k, v);
  root.style.colorScheme = s.dark ? "dark" : "light";
  root.dataset.theme = s.id;
  root.dataset.dark = String(s.dark);
}

let lastApplied = "";
function applyAll() {
  const s = effectiveScheme();
  if (s.id === lastApplied) return;
  lastApplied = s.id;
  applyDom(s);
  appliers.forEach((f) => f(s));
  schemeStore.set((x) => ({ rev: x.rev + 1 }));
}

/** Subscribe to effective scheme changes (terminal re-theme ...). */
export function onSchemeChange(fn: (s: Scheme) => void): () => void {
  let prev = lastApplied;
  return schemeStore.subscribe(() => { if (lastApplied !== prev) { prev = lastApplied; fn(effectiveScheme()); } });
}

/** Switch and persist (OK / Apply). */
export function setScheme(id: string) {
  const sid = schemeById(id).id;
  schemeStore.set({ saved: sid, preview: null });
  applyAll();
  void invoke("ui_pref_set", { name: PREF, value: sid }).catch(() => {});
}
/** Live preview without persisting; `null` restores the saved scheme. */
export function previewScheme(id: string | null) {
  schemeStore.set({ preview: id === null ? null : schemeById(id).id });
  applyAll();
}

async function readPref(): Promise<string> {
  try { return schemeById(await invoke<string | null>("ui_pref_get", { name: PREF })).id; } catch { return DEFAULT_SCHEME; }
}
/** Load the persisted scheme and apply it to the DOM. Called before the first render. */
export async function initScheme() {
  schemeStore.set({ saved: await readPref() });
  applyAll();
  // other project windows: pick up a change made elsewhere when this window regains focus
  window.addEventListener("focus", async () => {
    if (schemeStore.get().preview) return;
    const id = await readPref();
    if (id !== schemeStore.get().saved) { schemeStore.set({ saved: id }); applyAll(); }
  });
}
