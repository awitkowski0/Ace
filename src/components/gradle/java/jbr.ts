/** Detected JetBrains Runtimes (for the "Enhanced HotSwap" option's hint in the run configuration dialog). */
import { createStore } from "../../../lib/store";
import { javaApi, type Jdk } from "./api";
import { enhancedHintText } from "./pure";

const store = createStore<{ jbrs: Jdk[] | null }>({ jbrs: null });
let loading: Promise<void> | null = null;
export function refreshJbrs(): Promise<void> {
  if (store.get().jbrs !== null) return Promise.resolve();
  return (loading ??= javaApi.jdks().then((all) => { store.set({ jbrs: all.filter((j) => j.jbr) }); }).catch(() => { store.set({ jbrs: [] }); }).finally(() => { loading = null; }));
}
export const getJavaJbrs = () => store.get().jbrs;

/** hint text of the checkbox: what was found, and what happens when the task's Java version has no JBR */
export function enhancedHint(): string {
  const j = store.get().jbrs;
  if (j === null) void refreshJbrs();
  return enhancedHintText(j === null ? null : j.map((x) => x.version));
}
