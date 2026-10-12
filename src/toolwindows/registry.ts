/**
 * Tool window registry. Each module registers its tool window from ITS OWN
 * `src/components/<module>/register.tsx` (already imported by src/modules.ts):
 *
 *   registerToolWindow({ id: "terminal", title: "Terminal", icon: <TerminalIcon/>, side: "bottom",
 *                        shortcut: "alt F12", component: TerminalPanel });
 *
 * `shortcut` is an IntelliJ-syntax default keystroke (used when the keymap JSON has no entry). An action
 * `Activate<Id>ToolWindow` (or `actionId`) is auto-registered with toggle-focus semantics.
 */
import type { ComponentType, ReactNode } from "react";
import type { Location } from "../lib/ipc";
import { createRegistry, createStore } from "../lib/store";

export type Side = "left" | "right" | "bottom";

export interface ToolWindowProps {
  root: Location;
}
export interface ToolWindowDef {
  id: string;
  title: string;
  icon: ReactNode;
  side: Side;
  shortcut?: string; // IntelliJ syntax, e.g. "meta 1"
  actionId?: string; // IntelliJ action id; default Activate<Id>ToolWindow (Id = capitalized id)
  order?: number;
  component: ComponentType<ToolWindowProps>;
  /** extra buttons rendered in the tool window header (left of options/hide) */
  headerActions?: ComponentType<ToolWindowProps>;
}

const reg = createRegistry<ToolWindowDef>();
export const registerToolWindow = reg.register;
export const toolWindowRegistry = reg;

// == profiles hook == (src/components/profiles): a view maps each registered tool window to what the active profile shows
// (null = hidden, another def = replaced). No view (Developer) = the registry exactly as registered.
export type ToolWindowView = (tw: ToolWindowDef) => ToolWindowDef | null;
let view: ToolWindowView | null = null;
let viewRev = 0;
const viewSubs = new Set<() => void>();
export function setToolWindowView(v: ToolWindowView | null) {
  view = v;
  viewRev++;
  viewSubs.forEach((f) => f());
}
/** every registered tool window, unfiltered (profiles use this to know what they hide) */
export const rawToolWindows = () => reg.list();
export const getToolWindow = (id: string): ToolWindowDef | undefined => {
  const t = reg.get(id);
  return t && view ? view(t) ?? undefined : t;
};
export const subscribeToolWindows = (fn: () => void) => {
  const off = reg.subscribe(fn);
  viewSubs.add(fn);
  return () => { off(); viewSubs.delete(fn); };
};
let cacheSrc: ToolWindowDef[] = [];
let cacheRev = -1;
let cacheOut: ToolWindowDef[] = [];
/** Sorted by `order`; referentially stable between registrations (safe for useSyncExternalStore). */
export const listToolWindows = () => {
  const src = reg.list();
  if (src !== cacheSrc || cacheRev !== viewRev) {
    cacheSrc = src;
    cacheRev = viewRev;
    const vis = view ? src.map((t) => view!(t)).filter((t): t is ToolWindowDef => !!t) : src;
    cacheOut = [...vis].sort((a, b) => (a.order ?? 100) - (b.order ?? 100));
  }
  return cacheOut;
};

// ---- status bar widgets (same pattern) ----
export interface StatusWidgetDef {
  id: string;
  side: "left" | "right";
  order?: number;
  component: ComponentType;
}
export const statusWidgets = createRegistry<StatusWidgetDef>();
export const registerStatusWidget = statusWidgets.register;

// ---- small badges on stripe buttons / header tabs (e.g. Claude sessions waiting) ----
export interface ToolBadge { text: string; title: string; kind?: string }
export const toolBadges = createStore<{ map: Record<string, ToolBadge | undefined> }>({ map: {} });
export const setToolBadge = (id: string, b: ToolBadge | null) =>
  toolBadges.set((s) => (s.map[id] === (b ?? undefined) ? {} : { map: { ...s.map, [id]: b ?? undefined } }));
