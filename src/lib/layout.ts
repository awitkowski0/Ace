import { createStore } from "./store";
import { projectKey, projectStore } from "./project";
import { getToolWindow, listToolWindows, type Side } from "../toolwindows/registry";
import { focusEditor } from "../editor/editorRegistry";

type Active = Record<Side, string | null>;
export const layoutStore = createStore<{ active: Active }>({ active: { left: "project", right: null, bottom: null } });

const key = () => {
  const r = projectStore.get().root;
  return r ? `atelier.layout.${projectKey(r)}` : null;
};

function load() {
  const k = key();
  let active: Active = { left: "project", right: null, bottom: null };
  try {
    if (k) active = { ...active, ...JSON.parse(localStorage.getItem(k) ?? "{}") };
  } catch {}
  // A tool window that moved to another side (e.g. Claude: right -> left, grouped with Project) must not render on the old side.
  for (const side of ["left", "right", "bottom"] as Side[]) {
    const id = active[side];
    const tw = id ? getToolWindow(id) : undefined;
    if (id && tw && tw.side !== side) active[side] = side === "left" ? "project" : null; // sanitize
  }
  layoutStore.set({ active });
}
function persist() {
  const k = key();
  try {
    if (k) localStorage.setItem(k, JSON.stringify(layoutStore.get().active));
  } catch {}
}
let lastKey: string | null = null;
projectStore.subscribe(() => {
  if (key() !== lastKey) {
    lastKey = key();
    load();
  }
});

export function setActive(side: Side, id: string | null) {
  layoutStore.set((s) => ({ active: { ...s.active, [side]: id } }));
  persist();
}

const el = (id: string) => document.querySelector<HTMLElement>(`[data-toolwindow="${id}"]`);
// querySelectorAll: a tool window may have an overlay twin (the terminal's quick terminal carries data-toolwindow="terminal" too)
export const isToolWindowFocused = (id: string) => [...document.querySelectorAll<HTMLElement>(`[data-toolwindow="${id}"]`)].some((e) => e.contains(document.activeElement));
export const focusedToolWindowId = () =>
  listToolWindows().find((t) => isToolWindowFocused(t.id))?.id ?? null;

export function focusToolWindow(id: string) {
  // rAF waits for the tool window to mount; it never fires while the page is hidden (background tab / occluded window),
  // so a short timer is the fallback: focus() still sets document.activeElement there.
  let done = false;
  const run = () => {
    if (done) return;
    const e = el(id);
    if (!e) return;
    done = true;
    (e.querySelector<HTMLElement>("[data-autofocus]") ?? e).focus();
  };
  requestAnimationFrame(run);
  setTimeout(run, 60);
  setTimeout(run, 250);
}

/** IntelliJ semantics: hidden -> show+focus; visible but unfocused -> focus; focused -> hide + focus editor. */
export function toggleToolWindow(id: string) {
  const tw = getToolWindow(id);
  if (!tw) return;
  const isActive = layoutStore.get().active[tw.side] === id;
  if (!isActive) {
    setActive(tw.side, id);
    focusToolWindow(id);
  } else if (!isToolWindowFocused(id)) {
    focusToolWindow(id);
  } else {
    setActive(tw.side, null);
    focusEditor();
  }
}
/** Stripe-button click (IntelliJ mouse semantics): visible -> hide; hidden -> show + focus. Focus state is ignored because
 *  pressing the button has already taken focus away from the tool window. */
export function clickToolWindow(id: string) {
  const tw = getToolWindow(id);
  if (!tw) return;
  if (layoutStore.get().active[tw.side] === id) {
    setActive(tw.side, null);
    focusEditor();
  } else {
    setActive(tw.side, id);
    focusToolWindow(id);
  }
}
export function showToolWindow(id: string) {
  const tw = getToolWindow(id);
  if (!tw) return;
  setActive(tw.side, id);
  focusToolWindow(id);
}
export function hideToolWindow(id: string) {
  const tw = getToolWindow(id);
  if (!tw) return;
  if (layoutStore.get().active[tw.side] === id) setActive(tw.side, null);
  focusEditor();
}
