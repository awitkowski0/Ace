import { createStore } from "./store";
/** Shared shell state other modules may write: e.g. git agent calls setBranch("main"). */
export const shellStore = createStore<{ branch: string | null }>({ branch: null });
export const setBranch = (branch: string | null) => shellStore.set({ branch });
