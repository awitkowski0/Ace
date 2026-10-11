/** Problems found in run output (Godot ERROR:/WARNING: blocks...), grouped by run. Shown by the Problems tool window's "Run" tab. */
import { createStore } from "../../lib/store";

export interface RunProblem {
  sev: 1 | 2;
  message: string;
  /** absolute path of the file (null when the block has no location) */
  path: string | null;
  host: string;
  line: number;
  col: number;
  /** "at: _ready" etc. */
  detail?: string;
}
export interface RunProblems { id: string; name: string; startedAt: number; items: RunProblem[] }

const MAX_RUNS = 12;
const MAX_ITEMS = 500;
export const runProblems = createStore<{ runs: RunProblems[] }>({ runs: [] });

/** Start (or restart) the group of a run: previous items of the same id are dropped. */
export function beginRunProblems(id: string, name: string) {
  runProblems.set((s) => {
    const runs = [...s.runs.filter((r) => r.id !== id), { id, name, startedAt: Date.now(), items: [] }];
    return { runs: runs.slice(-MAX_RUNS) };
  });
}
export function addRunProblem(id: string, p: RunProblem) {
  runProblems.set((s) => ({
    runs: s.runs.map((r) => {
      if (r.id !== id || r.items.length >= MAX_ITEMS) return r;
      // identical repeated errors (a script error in _process) are collapsed
      if (r.items.some((x) => x.message === p.message && x.path === p.path && x.line === p.line && x.sev === p.sev)) return r;
      return { ...r, items: [...r.items, p] };
    }),
  }));
}
export function renameRunProblems(id: string, name: string) {
  runProblems.set((s) => ({ runs: s.runs.map((r) => (r.id === id ? { ...r, name } : r)) }));
}
export function clearRunProblems(id?: string) {
  runProblems.set((s) => ({ runs: id ? s.runs.filter((r) => r.id !== id) : [] }));
}
export const countRunProblems = () => runProblems.get().runs.reduce((n, r) => n + r.items.length, 0);
