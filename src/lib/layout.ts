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
export const isToolWindowFocused = (id: string) => !!el(id)?.contains(document.activeElement);
export const focusedToolWindowId = () =>
  listToolWindows().find((t) => isToolWindowFocused(t.id))?.id ?? null;

export function focusToolWindow(id: string) {
  requestAnimationFrame(() => {
    const e = el(id);
    if (!e) return;
    (e.querySelector<HTMLElement>("[data-autofocus]") ?? e).focus();
  });
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
