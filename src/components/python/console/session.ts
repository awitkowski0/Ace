/**
 * The Python Console session: one `ace_console.py` process per project window (src-tauri/src/python/scripts/ace_console.py).
 * Module-level state (the tool window component only renders it), so hiding the window keeps the console alive.
 * Nothing starts until `start()` (tool window shown / Execute Selection / QA hook).
 */
import { createStore } from "../../../lib/store";
import { projectStore } from "../../../lib/project";
import { pstore, pyApi, runner, type OutSeg } from "../api";
import { currentInterpreter, ensurePython, onInterpreterChange, pythonSpec, pyStore } from "../interpreter";
import { applyCr } from "./ansi";
import { Splitter, type StreamItem } from "./stream";

export type Entry =
  | { id: number; kind: "in"; n: number; code: string }
  | { id: number; kind: "out"; text: string }
  | { id: number; kind: "sys"; text: string; error?: boolean };

export interface VarRow { name: string; type: string; repr: string }
export type Status = "stopped" | "starting" | "ready" | "busy";

export interface ConsoleState {
  status: Status;
  entries: Entry[];
  vars: VarRow[];
  showVars: boolean;
  ipython: boolean;
  /** interpreter path of the running process */
  interp: string | null;
  /** next execution number (In [n]) */
  n: number;
  /** bumped on every transcript change */
  rev: number;
}
export const consoleStore = createStore<ConsoleState>({ status: "stopped", entries: [], vars: [], showVars: false, ipython: false, interp: null, n: 1, rev: 0 });

const MAX_ENTRIES = 3000;
let eid = 0;
let gen = 0;
let procId: string | null = null;
let disposeProc: (() => void) | null = null;
let splitter = new Splitter();
let startPromise: Promise<void> | null = null;
let readyResolve: (() => void) | null = null;
let seq = 0;
let pending = 0;
const waiters = new Map<number, (ev: Record<string, unknown>) => void>();
let exitWaiters: (() => void)[] = [];
let unsubInterp: (() => void) | null = null;

const root = () => override ? { host: override.host, path: override.cwd } : projectStore.get().root;
/** QA only: run the console somewhere else (e.g. a remote host) without opening a project there. */
let override: { host: string; cwd: string; python: string } | null = null;
export function setConsoleOverride(o: { host: string; cwd: string; python: string } | null) { override = o; }
const patch = (p: Partial<ConsoleState>) => consoleStore.set((s) => ({ ...p, rev: s.rev + 1 }));

type NewEntry = Entry extends infer E ? (E extends Entry ? Omit<E, "id"> : never) : never;
function pushEntry(e: NewEntry) {
  consoleStore.set((s) => {
    const entries = [...s.entries, { ...e, id: ++eid } as Entry];
    if (entries.length > MAX_ENTRIES) entries.splice(0, entries.length - MAX_ENTRIES);
    return { entries, rev: s.rev + 1 };
  });
}
export function addSystem(text: string, error = false) { pushEntry({ kind: "sys", text, error }); }

function appendOut(text: string, err: boolean) {
  if (!text) return;
  const t = err ? `\x1b[31m${text}\x1b[0m` : text;
  consoleStore.set((s) => {
    const last = s.entries[s.entries.length - 1];
    let entries: Entry[];
    if (last && last.kind === "out") {
      entries = [...s.entries.slice(0, -1), { ...last, text: applyCr(last.text, t) }];
    } else {
      entries = [...s.entries, { id: ++eid, kind: "out", text: applyCr("", t) }];
      if (entries.length > MAX_ENTRIES) entries.splice(0, entries.length - MAX_ENTRIES);
    }
    return { entries, rev: s.rev + 1 };
  });
}

function onItems(g: number, items: StreamItem[]) {
  if (g !== gen) return;
  for (const it of items) {
    if (it.t === "text") appendOut(it.d, it.err);
    else handleEvent(it.ev);
  }
}

function handleEvent(ev: { k: string; id?: number; [x: string]: unknown }) {
  if (ev.k === "ready") {
    patch({ status: pending > 0 ? "busy" : "ready", ipython: !!ev.ipython });
    readyResolve?.();
    readyResolve = null;
  } else if (ev.id != null && (ev.k === "check" || ev.k === "vars" || ev.k === "done")) {
    const w = waiters.get(ev.id);
    if (w) { waiters.delete(ev.id); w(ev); }
  }
}

/** Starts the console process (idempotent). Resolves when it is ready, or when it failed to start (status "stopped"). */
export function start(): Promise<void> {
  if (startPromise) return startPromise;
  if (consoleStore.get().status !== "stopped") return Promise.resolve();
  startPromise = (async () => {
    const r = root();
    if (!r) { addSystem("No project is open.", true); return; }
    if (!override && (!pyStore.get().active || !pyStore.get().current)) await ensurePython().catch(() => {});
    const interp = override ? { id: override.python, path: override.python, version: "", kind: "system" as const, name: "override", envRoot: null, project: false, host: override.host } : currentInterpreter();
    if (!interp) { addSystem("No Python interpreter is configured for this project (select one in the status bar widget).", true); return; }
    const g = ++gen;
    splitter = new Splitter();
    const argv = r.host === "local" ? ["-u", `${await pyApi.scriptsDir()}/ace_console.py`] : ["-u", "-c", await pyApi.scriptSource("ace_console")];
    const spec = pythonSpec(argv, { interp, loc: r, env: { PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8" } });
    patch({ status: "starting", interp: interp.path, vars: [], ipython: false });
    const ready = new Promise<void>((res) => { readyResolve = res; });
    try {
      const h = await runner.start(spec, {
        label: "Python Console",
        kind: "pyconsole",
        onOut: (segs: OutSeg[]) => onItems(g, segs.flatMap((s) => splitter.push(s))),
        onExit: (x) => onExit(g, x.code, x.signal),
      });
      if (g !== gen) { h.dispose(); return; }
      procId = h.id;
      disposeProc = h.dispose;
    } catch (e) {
      patch({ status: "stopped", interp: null });
      addSystem(`Cannot start the Python Console: ${String((e as Error)?.message ?? e)}`, true);
      return;
    }
    unsubInterp ??= onInterpreterChange((i) => void interpreterChanged(i?.path ?? null));
    await Promise.race([ready, new Promise<void>((res) => exitWaiters.push(res))]);
  })().finally(() => { startPromise = null; });
  return startPromise;
}

function onExit(g: number, code: number | null, signal: number | null) {
  if (g !== gen) return;
  onItems(g, splitter.flush());
  procId = null;
  disposeProc = null;
  pending = 0;
  const ws = [...waiters.values()];
  waiters.clear();
  ws.forEach((w) => w({ k: "done", exit: true }));
  const sys = signal ? `Process finished (signal ${signal})` : `Process finished with exit code ${code ?? 0}`;
  addSystem(sys, !!signal || (code ?? 0) !== 0);
  patch({ status: "stopped", interp: null });
  const x = exitWaiters;
  exitWaiters = [];
  x.forEach((f) => f());
  readyResolve?.();
  readyResolve = null;
}

function request(req: Record<string, unknown>): Promise<Record<string, unknown>> {
  const id = ++seq;
  return new Promise((resolve) => {
    if (!procId) return resolve({ k: "done", exit: true });
    waiters.set(id, resolve);
    runner.write(procId, JSON.stringify({ id, ...req }) + "\n").catch(() => { waiters.delete(id); resolve({ k: "done", exit: true }); });
  });
}

export const isAlive = () => consoleStore.get().status !== "stopped";

/** Ask the process whether `code` is a complete statement ("complete" | "incomplete" | "invalid"). */
export async function checkComplete(code: string): Promise<{ status: string; indent: number }> {
  await start();
  if (!procId) return { status: "complete", indent: 0 };
  const ev = await request({ check: code });
  return { status: String(ev.status ?? "complete"), indent: Number(ev.indent ?? 0) };
}

/** Run `code` as one cell. Starts the console when needed. Resolves when the cell has finished. */
export async function execute(code: string): Promise<{ exited: boolean }> {
  await start();
  if (!procId) return { exited: true };
  const s = consoleStore.get();
  pushEntry({ kind: "in", n: s.n, code });
  patch({ n: s.n + 1, status: "busy" });
  pending++;
  const ev = await request({ code });
  pending = Math.max(0, pending - 1);
  if (pending === 0 && consoleStore.get().status === "busy") patch({ status: "ready" });
  if (ev.exit) return { exited: true };
  if (consoleStore.get().showVars) await refreshVars();
  return { exited: false };
}

export async function refreshVars() {
  if (!procId) return;
  const ev = await request({ vars: true });
  if (Array.isArray(ev.vars)) patch({ vars: ev.vars as VarRow[] });
}

export function setShowVars(on: boolean) {
  patch({ showVars: on });
  if (on && isAlive()) void refreshVars();
}

/** Ctrl+C: KeyboardInterrupt in the running cell (ignored when idle). */
export function interrupt() {
  if (procId && pending > 0) void runner.interrupt(procId);
}

export function stop(): Promise<void> {
  if (!procId) return Promise.resolve();
  const done = new Promise<void>((res) => exitWaiters.push(res));
  void runner.stop(procId);
  return done;
}

export function clear() { patch({ entries: [] }); }

/** Stop, clear the transcript and start a fresh process. */
export async function restart() {
  await stop();
  patch({ entries: [], vars: [], n: 1 });
  await start();
}

export async function interpreterChanged(path: string | null) {
  const s = consoleStore.get();
  if (!isAlive() || !path || path === s.interp) return;
  const { confirmDialog } = await import("../../shell/dialogs");
  if (await confirmDialog({ title: "Python Console", message: "The project interpreter has changed. Restart the Python Console with the new interpreter?", okLabel: "Restart" })) await restart();
}

// ------------------------------------------------------------------------------------------------ history (per project)
let history: string[] = [];
let historyLoaded: string | null = null;
const HKEY = "console-history";
export async function loadHistory(): Promise<string[]> {
  const r = root();
  if (!r) return history;
  const k = `${r.host}:${r.path}`;
  if (historyLoaded !== k) {
    historyLoaded = k;
    history = (await pstore.get<{ items: string[] }>(r, HKEY))?.items ?? [];
  }
  return history;
}
export const getHistory = () => history;
export async function addHistory(code: string) {
  await loadHistory();
  if (!code.trim() || history[history.length - 1] === code) return;
  history = [...history, code].slice(-500);
  const r = root();
  if (r) void pstore.set(r, HKEY, { items: history }).catch(() => {});
}

/** Plain-text transcript (for QA and copy). */
export function transcriptText(): string {
  // eslint-disable-next-line no-control-regex
  const strip = (s: string) => s.replace(/\x1b\[[0-9;:?]*[ -/]*[@-~]/g, "");
  const ipy = consoleStore.get().ipython;
  return consoleStore
    .get()
    .entries.map((e) => {
      if (e.kind === "in") return code2text(e.code, e.n, ipy) + "\n";
      return e.kind === "sys" ? e.text + "\n" : strip(e.text);
    })
    .join("");
}
export function code2text(code: string, n: number, ipy: boolean) {
  const lines = code.split("\n");
  const p1 = ipy ? `In [${n}]: ` : ">>> ";
  const p2 = ipy ? "   ...: " : "... ";
  return lines.map((l, i) => (i === 0 ? p1 : p2) + l).join("\n");
}
