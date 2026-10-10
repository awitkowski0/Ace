/** Pure precedence logic for the dispatcher (unit-tested). popup > focused tool window > editor > global. */
import type { Action } from "./registry";

export interface FocusState {
  popupOpen: boolean;
  toolWindow: string | null; // id of the tool window that has focus
  editor: boolean; // focus is inside an editor group (Monaco, tab strip, find bar) or nowhere
}

/** Lower number = higher priority; null = the action is not live in this state. */
export function tierOf(a: Pick<Action, "context">, st: FocusState): number | null {
  const c = a.context ?? "global";
  if (c === "popup") return st.popupOpen ? 0 : null;
  if (c === "global") return 3;
  if (st.popupOpen) return null; // popups swallow tool-window / editor scoped keys
  if (typeof c === "object") return st.toolWindow === c.toolWindow ? 1 : null;
  if (c === "editor") return st.editor && !st.toolWindow ? 2 : null;
  return null;
}

/** Ordered candidates (best tier first, registration order within a tier), filtered by `isEnabled`. */
export function candidates(ids: string[], get: (id: string) => Action | undefined, st: FocusState): Action[] {
  const out: { a: Action; tier: number; i: number }[] = [];
  ids.forEach((id, i) => {
    const a = get(id);
    if (!a) return;
    const tier = tierOf(a, st);
    if (tier === null) return;
    if (a.isEnabled && !a.isEnabled()) return;
    out.push({ a, tier, i });
  });
  out.sort((x, y) => x.tier - y.tier || x.i - y.i);
  return out.map((o) => o.a);
}
