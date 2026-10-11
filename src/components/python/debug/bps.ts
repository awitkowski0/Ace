/** Breakpoint + watch stores, persisted per project (pstore "breakpoints" / "debugwatches"). No monaco, no session code. */
import { createStore } from "../../../lib/store";
import { projectStore } from "../../../lib/project";
import type { Location } from "../../../lib/ipc";
import { newId, pstore } from "../api";
import { DEFAULT_EXCEPTIONS, type Bp, type ExceptionBps } from "./pure";

export type { Bp, ExceptionBps };

interface BpState {
  /** project the breakpoints were loaded for */
  key: string;
  loaded: boolean;
  list: Bp[];
  exceptions: ExceptionBps;
  muted: boolean;
  /** bumped on every change (decorations + sessions re-sync) */
  rev: number;
}
export const bpStore = createStore<BpState>({ key: "", loaded: false, list: [], exceptions: { ...DEFAULT_EXCEPTIONS }, muted: false, rev: 0 });
export const watchStore = createStore<{ key: string; list: string[] }>({ key: "", list: [] });

const root = (): Location | null => projectStore.get().root;
const keyOf = (r: Location) => `${r.host}:${r.path}`;
let loading: Promise<void> | null = null;

interface Saved { breakpoints?: Omit<Bp, "id">[]; exceptions?: Partial<ExceptionBps>; muted?: boolean }

/** Loads (once per project) the persisted breakpoints. Safe to call repeatedly. */
export function loadBreakpoints(): Promise<void> {
  const r = root();
  if (!r) return Promise.resolve();
  const k = keyOf(r);
  if (bpStore.get().loaded && bpStore.get().key === k) return Promise.resolve();
  if (loading) return loading;
  loading = (async () => {
    const raw = await pstore.get<Saved | Omit<Bp, "id">[]>(r, "breakpoints");
    const saved: Saved = Array.isArray(raw) ? { breakpoints: raw } : raw ?? {};
    const watches = await pstore.get<string[]>(r, "debugwatches");
    if (root() && keyOf(root()!) !== k) return; // project switched meanwhile
    // anything toggled before the load finished is merged in
    const early = bpStore.get().key === k ? bpStore.get().list : [];
    const list = [...(saved.breakpoints ?? []).map((b) => ({ ...b, id: newId("bp") })), ...early.filter((e) => !(saved.breakpoints ?? []).some((b) => b.path === e.path && b.line === e.line))];
    bpStore.set((s) => ({ key: k, loaded: true, list, exceptions: { ...DEFAULT_EXCEPTIONS, ...(saved.exceptions ?? {}) }, muted: !!saved.muted, rev: s.rev + 1 }));
    watchStore.set({ key: k, list: Array.isArray(watches) ? watches.filter((x) => typeof x === "string") : [] });
  })().finally(() => { loading = null; });
  return loading;
}

let persistTimer: ReturnType<typeof setTimeout> | undefined;
function persist() {
  clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    const r = root();
    const s = bpStore.get();
    if (!r || !s.loaded || s.key !== keyOf(r)) return;
    void pstore.set(r, "breakpoints", { breakpoints: s.list.map(({ id: _id, ...b }) => b), exceptions: s.exceptions, muted: s.muted }).catch(() => {});
  }, 300);
}
/** Flush right away (tests / window close). */
export async function flushBreakpoints() {
  clearTimeout(persistTimer);
  const r = root();
  const s = bpStore.get();
  if (r && s.loaded) await pstore.set(r, "breakpoints", { breakpoints: s.list.map(({ id: _id, ...b }) => b), exceptions: s.exceptions, muted: s.muted });
}

function commit(list: Bp[], extra: Partial<BpState> = {}) {
  const r = root();
  bpStore.set((s) => ({ list, rev: s.rev + 1, ...(r && !s.loaded ? { key: keyOf(r) } : {}), ...extra }));
  persist();
}

export const bpsAt = (path: string, line: number) => bpStore.get().list.filter((b) => b.path === path && b.line === line);
export const bpsIn = (path: string) => bpStore.get().list.filter((b) => b.path === path);

/** IntelliJ ToggleLineBreakpoint: removes the breakpoints on the line, or adds one. Returns true when one was added. */
export function toggleBreakpoint(path: string, line: number): boolean {
  const here = bpsAt(path, line);
  if (here.length) {
    commit(bpStore.get().list.filter((b) => !here.includes(b)));
    return false;
  }
  commit([...bpStore.get().list, { id: newId("bp"), path, line, enabled: true }]);
  return true;
}
export function addBreakpoint(b: Omit<Bp, "id">): Bp {
  const nb = { ...b, id: newId("bp") };
  const dup = bpStore.get().list.find((x) => x.path === b.path && x.line === b.line);
  if (dup) { updateBreakpoint(dup.id, b); return dup; }
  commit([...bpStore.get().list, nb]);
  return nb;
}
export function removeBreakpoint(id: string) { commit(bpStore.get().list.filter((b) => b.id !== id)); }
export function updateBreakpoint(id: string, patch: Partial<Omit<Bp, "id">>) {
  commit(bpStore.get().list.map((b) => (b.id === id ? { ...b, ...patch } : b)));
}
/** Editor edits moved the breakpoints: write the new line numbers back (duplicates merged, nothing re-persisted if unchanged). */
export function setBreakpointLines(path: string, lines: Map<string, number>) {
  const cur = bpStore.get().list;
  let changed = false;
  let next = cur.map((b) => {
    const l = lines.get(b.id);
    if (b.path !== path || l == null || l === b.line) return b;
    changed = true;
    return { ...b, line: l };
  });
  if (!changed) return;
  const seen = new Set<string>();
  next = next.filter((b) => { const k = `${b.path}:${b.line}`; if (seen.has(k)) return false; seen.add(k); return true; });
  commit(next);
}
export function clearBreakpoints() { commit([]); }
export function setExceptionBreakpoints(e: Partial<ExceptionBps>) { commit(bpStore.get().list, { exceptions: { ...bpStore.get().exceptions, ...e } }); }
export function setMuted(muted: boolean) { commit(bpStore.get().list, { muted }); }

// ------------------------------------------------------------------ watches
function persistWatches() {
  const r = root();
  if (r) void pstore.set(r, "debugwatches", watchStore.get().list).catch(() => {});
}
export function addWatch(expr: string) {
  const e = expr.trim();
  if (!e || watchStore.get().list.includes(e)) return;
  watchStore.set((s) => ({ list: [...s.list, e] }));
  persistWatches();
}
export function removeWatch(expr: string) { watchStore.set((s) => ({ list: s.list.filter((x) => x !== expr) })); persistWatches(); }
export function replaceWatch(oldExpr: string, expr: string) {
  const e = expr.trim();
  if (!e) return removeWatch(oldExpr);
  watchStore.set((s) => ({ list: s.list.map((x) => (x === oldExpr ? e : x)) }));
  persistWatches();
}
