/** One transient status-bar message for the Python language tools ("Reformat Code: ruff not found ..."). */
import { createStore } from "../../../lib/store";

export const noteStore = createStore<{ text: string; at: number }>({ text: "", at: 0 });
let t: ReturnType<typeof setTimeout> | undefined;
export function notify(text: string, ms = 8000) {
  noteStore.set({ text, at: Date.now() });
  clearTimeout(t);
  t = setTimeout(() => noteStore.set({ text: "" }), ms);
}
export const clearNote = () => { clearTimeout(t); noteStore.set({ text: "" }); };
