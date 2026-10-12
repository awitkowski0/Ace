import { createStore } from "../../lib/store";
import { projectKey, projectStore } from "../../lib/project";
import { DEFAULT_OPEN, type Row } from "./tree";

export const godotUi = createStore<{ selected: Row | null; open: Set<string>; rev: number }>({ selected: null, open: new Set(DEFAULT_OPEN), rev: 0 });

const storeKey = () => { const r = projectStore.get().root; return r ? `ace.godot.open.${projectKey(r)}` : null; };
let loaded = "";
export function ensureOpen() {
  const k = storeKey() ?? "";
  if (loaded === k) return;
  loaded = k;
  let open = new Set(DEFAULT_OPEN);
  try { const v = k && localStorage.getItem(k); if (v) open = new Set(JSON.parse(v) as string[]); } catch { /* ignore */ }
  godotUi.set({ open, selected: null });
}
export function toggleRow(id: string, force?: boolean) {
  const o = new Set(godotUi.get().open);
  const want = force ?? !o.has(id);
  if (want) o.add(id); else o.delete(id);
  godotUi.set((s) => ({ open: o, rev: s.rev + 1 }));
  try { const k = storeKey(); if (k) localStorage.setItem(k, JSON.stringify([...o])); } catch { /* ignore */ }
}
