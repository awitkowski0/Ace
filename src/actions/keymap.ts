import { listActions, subscribeActions } from "./registry";
import { parseKeystroke } from "./keystroke";

// Absent file tolerated: glob returns {} when no match.
const files = import.meta.glob("../keymap/intellij-macos.json", { eager: true, import: "default" }) as Record<
  string,
  Record<string, string[]>
>;
const keymap: Record<string, string[]> = Object.values(files)[0] ?? {};

const OVERRIDE_KEY = "ace.keymap.overrides";
function overrides(): Record<string, string[]> {
  try {
    return JSON.parse(localStorage.getItem(OVERRIDE_KEY) ?? "{}");
  } catch {
    return {};
  }
}
/** Settings UI hook: rebind an action (by action id). Empty array unbinds. */
export function setOverride(actionId: string, keys: string[]) {
  try {
    localStorage.setItem(OVERRIDE_KEY, JSON.stringify({ ...overrides(), [actionId]: keys }));
  } catch {}
  rebuild();
}

export interface Bindings {
  exact: Map<string, string[]>; // canonical sequence -> action ids
  prefixes: Set<string>; // canonical strokes that begin a chord
}
let bindings: Bindings = { exact: new Map(), prefixes: new Set() };
export const getBindings = () => bindings;
export const hasKeymapFile = Object.keys(keymap).length > 0;

export function keysFor(actionId: string): string[] {
  const a = listActions().find((x) => x.id === actionId);
  if (!a) return [];
  const o = overrides();
  return o[a.id] ?? (a.intellijId ? keymap[a.intellijId] : undefined) ?? a.defaultKeys ?? [];
}

export function rebuild() {
  const exact = new Map<string, string[]>();
  const prefixes = new Set<string>();
  for (const a of listActions()) {
    for (const k of keysFor(a.id)) {
      const seq = parseKeystroke(k);
      if (!seq) continue;
      exact.set(seq, [...(exact.get(seq) ?? []), a.id]);
      const parts = seq.split(" , ");
      for (let i = 1; i < parts.length; i++) prefixes.add(parts.slice(0, i).join(" , "));
    }
  }
  bindings = { exact, prefixes };
}
subscribeActions(rebuild);
rebuild();

let boundSet: Set<string> | null = null;
/** True when the IntelliJ keymap binds this canonical stroke to any action (implemented or not). */
export function isIntellijBound(stroke: string): boolean {
  if (!boundSet) {
    boundSet = new Set();
    for (const [id, keys] of Object.entries(keymap)) {
      if (id === "$meta" || !Array.isArray(keys)) continue;
      for (const k of keys) {
        const seq = parseKeystroke(k);
        if (seq && !seq.includes(" , ") && !seq.startsWith("double")) boundSet.add(seq);
      }
    }
  }
  return boundSet.has(stroke);
}
/** Full keymap (IntelliJ action id -> keystrokes) for tooling/tests. */
export const intellijKeymap = keymap;

/** Canonical strokes Monaco still handles itself (set by editor/monacoKeymap.ts after the policy is applied). */
export const monacoKept = new Set<string>();
