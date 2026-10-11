import { layoutStore, setActive, toggleToolWindow, clickToolWindow, focusToolWindow } from "../../lib/layout";
import { getToolWindow } from "../../toolwindows/registry";

/**
 * Tool windows that share ONE stripe button and header tab strip (IntelliJ shows Usages inside the "Find" window).
 * The first id is the stripe button; the others are tabs of the same window.
 */
export const TOOL_GROUPS: string[][] = [["find", "usages"], ["project", "claude"]];

export const groupOf = (id: string): string[] | undefined => TOOL_GROUPS.find((g) => g.includes(id));
/** Group members that are registered (a module may be absent). */
export const liveGroup = (id: string): string[] => (groupOf(id) ?? [id]).filter((m) => !!getToolWindow(m));
/** Ids that must not get their own stripe button. */
export const isGroupedFollower = (id: string) => { const g = groupOf(id); return !!g && g[0] !== id && !!getToolWindow(g[0]); };

/** Which member of the group is currently shown on `side`, if any. */
export const activeMemberOf = (id: string): string | null => {
  const tw = getToolWindow(id);
  if (!tw) return null;
  const cur = layoutStore.get().active[tw.side];
  return cur && liveGroup(id).includes(cur) ? cur : null;
};

/** Activate<X>ToolWindow (keyboard): toggle the group as one window, remembering which tab was showing. */
export function toggleGroup(id: string) {
  const cur = activeMemberOf(id);
  // Project / AI Sessions behave like IntelliJ's Project view switcher: asking for the other member (⌘1 vs ⌃⌥C) switches to it.
  if (cur && cur !== id && TAB_SWITCH.has(groupOf(id)![0])) return selectGroupTab(id);
  toggleToolWindow(cur ?? id);
}
const TAB_SWITCH = new Set(["project"]);
/** Stripe-button click: re-clicking the button of a visible tool window (or group) closes it. */
export function clickGroup(id: string) {
  clickToolWindow(activeMemberOf(id) ?? id);
}
export function selectGroupTab(id: string) {
  const tw = getToolWindow(id);
  if (!tw) return;
  setActive(tw.side, id);
  focusToolWindow(id);
}
