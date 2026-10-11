/**
 * Run sessions (one per Run window tab). A session owns the console buffer, the test tree and the lifecycle of one process.
 * Output is rendered through a rAF-coalesced revision counter, so a chatty process costs at most one render per frame.
 */
import { createStore } from "../../lib/store";
import { projectStore } from "../../lib/project";
import { setActive } from "../../lib/layout";
import { runner, newId, type OutSeg } from "../python/api";
import { confirmDialog } from "../shell/dialogs";
import { ctxFor, getConfig, typeOf } from "./configs";
import { getDebugLauncher, getJavaDebugLauncher, notifyStopChanged, registerStopHandler, type JavaDebugTarget } from "./hooks";
import { OutBuffer } from "./outbuf";
import { TestModel } from "./testModel";
import { SIGNALS } from "./util";
import type { Mode, OutputFilter, ResolvedRun, RunConfig } from "./types";

export interface Session {
  id: string;
  configId: string;
  /** configuration as it was when the tab was created / last explicitly run (used by Rerun) */
  cfg: RunConfig;
  name: string;
  typeId: string;
  status: "starting" | "running" | "finished";
  runId: string | null;
  exit: { code: number | null; signal: number | null; display: number } | null;
  stopRequested: boolean;
  buf: OutBuffer;
  /** output revision, bumped at most once per frame */
  out: number;
  host: string;
  cwd: string;
  commandLine: string;
  tests: TestModel | null;
  resolved: ResolvedRun | null;
  startedAt: number;
  endedAt: number | null;
  token: number;
  finished: Promise<void>;
  resolveFinished: () => void;
  subs: Set<() => void>;
  renderQueued: boolean;
  /** the plugin / interpreter lacks pytest: the console shows an install hint */
  missing: ResolvedRun["missingPackage"] | null;
  stdinOpen: boolean;
  /** set when this tab is the Gradle process of a Debug run (the debugger session attaches to its JVM) */
  debugTarget?: JavaDebugTarget;
  /** time limit timer (ResolvedRun.timeLimitSec) and the output filter of the current run */
  limitTimer?: ReturnType<typeof setTimeout>;
  filter?: OutputFilter | null;
  /** the time limit ended this run */
  timedOut?: boolean;
}

export const sessionStore = createStore<{ list: Session[]; activeId: string | null; rev: number }>({ list: [], activeId: null, rev: 0 });
export const sessions = () => sessionStore.get().list;
export const getSession = (id: string | null | undefined) => (id ? sessions().find((s) => s.id === id) ?? null : null);
export const activeSession = () => getSession(sessionStore.get().activeId);
const bumpStore = () => { sessionStore.set((s) => ({ rev: s.rev + 1 })); notifyStopChanged(); };

function makeSession(cfg: RunConfig, name: string): Session {
  let resolveFinished = () => {};
  const finished = new Promise<void>((r) => (resolveFinished = r));
  return {
    id: newId("sess"), configId: cfg.id, cfg, name, typeId: cfg.type, status: "finished", runId: null, exit: null, stopRequested: false,
    buf: new OutBuffer(), out: 0, host: "local", cwd: "", commandLine: "", tests: null, resolved: null, startedAt: Date.now(), endedAt: null, token: 0,
    finished, resolveFinished, subs: new Set(), renderQueued: false, missing: null, stdinOpen: true,
  };
}

export function scheduleRender(s: Session) {
  if (s.renderQueued) return;
  s.renderQueued = true;
  const f = () => {
    if (!s.renderQueued) return;
    s.renderQueued = false;
    s.out++;
    s.subs.forEach((x) => x());
  };
  requestAnimationFrame(f);
  setTimeout(f, 120); // rAF does not fire while the window is hidden / occluded
}
export const subscribeOut = (s: Session) => (f: () => void) => { s.subs.add(f); return () => { s.subs.delete(f); }; };

export function showRunWindow() {
  setActive("bottom", "run");
}

const tabName = (cfg: RunConfig) => {
  const taken = new Set(sessions().map((s) => s.name));
  if (!taken.has(cfg.name)) return cfg.name;
  for (let i = 2; ; i++) if (!taken.has(`${cfg.name} (${i})`)) return `${cfg.name} (${i})`;
};

let lastDebugConfigId: string | null = null;
export const lastDebugConfig = () => getConfig(lastDebugConfigId);

/**
 * Start a configuration. `target` is a stored config id or a config object (one-off variants such as "rerun failed").
 * Run mode reuses the tab of a finished session of the same configuration (a running one gets a new tab: parallel runs).
 */
export async function startRun(target: string | RunConfig, mode: Mode = "run", opts: { reuse?: Session; show?: boolean; resolved?: ResolvedRun } = {}): Promise<Session | null> {
  const cfg = typeof target === "string" ? getConfig(target) : target;
  const ctx = ctxFor();
  if (!cfg || !ctx) return null;
  const type = typeOf(cfg);
  if (!type) return null;
  if (mode === "debug") return startDebug(cfg, ctx, opts.reuse);
  // one configuration, several processes (Godot "multiple instances"): each gets its own tab, all share a group
  const parts = type.expand?.(cfg);
  if (parts && parts.length > 1) {
    let first: Session | null = null;
    for (const part of parts) {
      const sess = await startRun(part, "run", { show: opts.show });
      first = first ?? sess;
    }
    if (first) sessionStore.set({ activeId: first.id });
    return first;
  }
  let s = opts.reuse ?? sessions().find((x) => x.configId === cfg.id && x.status === "finished" && !x.resolved?.panel) ?? null;
  if (s && s.status !== "finished") await stopAndWait(s);
  if (!s) {
    const stored = getConfig(cfg.id) ?? cfg;
    s = makeSession(stored, tabName(stored));
    sessionStore.set((st) => ({ list: [...st.list, s!] }));
  } else if (opts.reuse === undefined) {
    s.cfg = getConfig(cfg.id) ?? cfg;
    s.name = s.cfg.name;
  }
  sessionStore.set({ activeId: s.id });
  if (opts.show !== false) showRunWindow();
  s.debugTarget = undefined;
  await execute(s, cfg, opts.resolved);
  return s;
}

async function execute(s: Session, cfg: RunConfig, pre?: ResolvedRun) {
  const type = typeOf(cfg);
  const ctx = ctxFor();
  const tok = ++s.token;
  s.buf.clear();
  s.tests = null;
  s.exit = null;
  s.stopRequested = false;
  s.stdinOpen = true;
  s.missing = null;
  s.status = "starting";
  s.startedAt = Date.now();
  s.endedAt = null;
  s.runId = null;
  s.finished = new Promise<void>((r) => (s.resolveFinished = r));
  clearTimeout(s.limitTimer);
  s.filter = null;
  s.timedOut = false;
  scheduleRender(s);
  bumpStore();
  const fail = (msg: string) => {
    if (s.token !== tok) return;
    s.buf.breakLine();
    s.buf.push("err", msg + "\n");
    finish(s, { code: 1, signal: null });
  };
  if (!type || !ctx) return fail("Run configuration type is not available");
  const bad = type.validate?.(cfg);
  if (bad) return fail(bad);
  let resolved: ResolvedRun;
  try {
    resolved = pre ?? (await type.resolve(cfg, "run", ctx));
  } catch (e) {
    return fail(String((e as Error)?.message ?? e));
  }
  if (s.token !== tok) return;
  s.resolved = resolved;
  s.host = resolved.spec.host;
  s.cwd = resolved.spec.cwd;
  s.commandLine = resolved.commandLine;
  if (resolved.tests) {
    const model = new TestModel();
    s.tests = model;
    s.buf.onControl = (ev) => {
      model.apply(ev);
      resolved.onControl?.(ev, s);
    };
  } else {
    s.buf.onControl = (ev) => resolved.onControl?.(ev, s);
  }
  if (resolved.missingPackage) s.missing = resolved.missingPackage;
  s.filter = resolved.output?.(s) ?? null;
  s.buf.sys(resolved.commandLine + "\n");
  for (const w of resolved.warnings ?? []) s.buf.push("err", w + "\n");
  scheduleRender(s);
  try {
    const h = await runner.start(resolved.spec, {
      label: cfg.name,
      kind: "run",
      onOut: (segs: OutSeg[]) => {
        if (s.token !== tok) return;
        const emit = (k: "out" | "err", t: string) => { if (s.token !== tok) return; s.buf.push(k, t); scheduleRender(s); };
        for (const g of segs) { if (s.filter) s.filter.push(g.s, g.d, emit); else s.buf.push(g.s, g.d); }
        scheduleRender(s);
      },
      onExit: (r) => {
        if (s.token !== tok) return;
        finish(s, r);
      },
    });
    if (s.token !== tok) { void runner.stop(h.id); return; }
    s.runId = h.id;
    if (resolved.timeLimitSec && resolved.timeLimitSec > 0) {
      const secs = resolved.timeLimitSec;
      // kills only this process (runner.stop = its process group), like `perl -e 'alarm shift; exec @ARGV'` in run_godot.sh
      s.limitTimer = setTimeout(() => {
        if (s.token !== tok || s.status === "finished" || !s.runId) return;
        s.timedOut = true;
        s.buf.breakLine();
        s.buf.sys(`Time limit of ${secs} s reached: stopping this process\n`);
        scheduleRender(s);
        void runner.stop(s.runId);
      }, secs * 1000);
    }
    if (s.status === "starting") s.status = "running";
    bumpStore();
  } catch (e) {
    fail(String(e));
  }
}

function finish(s: Session, r: { code: number | null; signal: number | null }) {
  if (s.status === "finished") return;
  clearTimeout(s.limitTimer);
  try { s.filter?.end((k, t) => s.buf.push(k, t)); } catch { /* a broken filter must not block the exit */ }
  s.filter = null;
  const display = r.code ?? (r.signal ? 128 + r.signal : -1);
  s.exit = { code: r.code, signal: r.signal, display };
  s.status = "finished";
  s.endedAt = Date.now();
  s.tests?.finish();
  s.buf.breakLine();
  s.buf.sys("\n");
  let note = "";
  const sig = r.signal ?? (display > 128 && display < 160 && s.stopRequested ? display - 128 : 0);
  if (sig) note = ` (interrupted by signal ${sig}: ${SIGNALS[sig] ?? "SIG" + sig})`;
  s.buf.sys(`Process finished with exit code ${display}${note}`);
  s.runId = null;
  scheduleRender(s);
  s.resolveFinished();
  bumpStore();
}

async function startDebug(cfg: RunConfig, ctx: NonNullable<ReturnType<typeof ctxFor>>, reuse?: Session): Promise<Session | null> {
  const type = typeOf(cfg);
  if (!type) return null;
  const bad = type.validate?.(cfg);
  let msg: string | null = bad ?? null;
  let resolved: ResolvedRun | null = null;
  if (!msg) {
    try { resolved = await type.resolve(cfg, "debug", ctx); } catch (e) { msg = String((e as Error)?.message ?? e); }
  }
  const javaLauncher = getJavaDebugLauncher();
  if (resolved?.javaDebug && javaLauncher) {
    // a Gradle run: the process lives in the Run window, the debugger session (Debug window) attaches to its JVM over JDWP
    lastDebugConfigId = cfg.id;
    const rs = await startRun(cfg, "run", { reuse, show: false, resolved });
    if (!rs) return null;
    rs.debugTarget = resolved.javaDebug;
    await javaLauncher(resolved.javaDebug, rs, cfg);
    return rs;
  }
  const launcher = getDebugLauncher();
  if (resolved?.debug && launcher) {
    lastDebugConfigId = cfg.id;
    await launcher(resolved.debug, { title: resolved.title || cfg.name });
    return null;
  }
  if (!msg) msg = resolved?.debug || resolved?.javaDebug ? "The debugger is not available." : `Debugging is not supported for ${type.label} configurations.`;
  const s = makeSession(cfg, tabName(cfg));
  s.status = "running";
  sessionStore.set((st) => ({ list: [...st.list, s], activeId: s.id }));
  s.buf.push("err", msg + "\n");
  finish(s, { code: 1, signal: null });
  showRunWindow();
  return s;
}

export async function stopAndWait(s: Session, ms = 5000) {
  if (s.status === "finished") return;
  stopSession(s);
  await Promise.race([s.finished, new Promise((r) => setTimeout(r, ms))]);
}

/** Sessions started together from one configuration (`groupId` on their config). */
const groupOf = (s: Session) => { const g = s.cfg.groupId; return typeof g === "string" ? sessions().filter((x) => x.cfg.groupId === g) : [s]; };

export function stopSession(s: Session) {
  if (s.status === "finished") return;
  const wasRequested = s.stopRequested;
  s.stopRequested = true;
  // Stop on one tab of a group stops the whole group
  if (!wasRequested) for (const o of groupOf(s)) if (o !== s && o.status !== "finished" && !o.stopRequested) stopSession(o);
  if (s.runId) { if (s.resolved?.softStop) s.resolved.softStop(s.runId); else void runner.stop(s.runId); }
  else { s.token++; finish(s, { code: null, signal: 15 }); }
}

export async function rerunSession(s: Session) {
  const base = s.cfg.groupOf as RunConfig | undefined;
  if (base) {
    // Rerun on one tab of a group reruns the whole group (stop all, then start the configuration again)
    const all = groupOf(s);
    await Promise.all(all.filter((x) => x.status !== "finished").map((x) => stopAndWait(x)));
    await startRun(getConfig(base.id) ?? base, "run");
    return;
  }
  const cfg = getConfig(s.configId) ?? s.cfg;
  s.cfg = cfg;
  s.name = cfg.name;
  sessionStore.set({ activeId: s.id });
  if (s.status !== "finished") await stopAndWait(s);
  await startRun(cfg, s.debugTarget ? "debug" : "run", { reuse: s });
}

/** Rerun only the failed / errored tests of a test session, in the same tab. */
export async function rerunFailed(s: Session) {
  const ids = s.tests?.failedIds() ?? [];
  const type = typeOf(s.cfg);
  if (!ids.length || !type?.forTestNodes) return false;
  if (s.status !== "finished") await stopAndWait(s);
  await startRun(type.forTestNodes(s.cfg, ids), "run", { reuse: s });
  return true;
}

export async function closeSession(s: Session, ask = true) {
  if (s.status !== "finished") {
    if (ask && !(await confirmDialog({ title: "Terminate Process", message: `Process '${s.name}' is running.\nDo you want to terminate it?`, okLabel: "Terminate" }))) return false;
    stopSession(s);
  }
  s.token++;
  sessionStore.set((st) => {
    const list = st.list.filter((x) => x !== s);
    const i = st.list.indexOf(s);
    return { list, activeId: st.activeId === s.id ? list[Math.min(i, list.length - 1)]?.id ?? null : st.activeId };
  });
  notifyStopChanged();
  return true;
}

export async function writeStdin(s: Session, text: string) {
  if (s.status !== "running" || !s.runId || !s.stdinOpen) return false;
  s.buf.sys(text + "\n", "in");
  scheduleRender(s);
  try { await runner.write(s.runId, text + "\n"); return true; } catch { return false; }
}
export async function closeStdinOf(s: Session) {
  if (s.status !== "running" || !s.runId || !s.stdinOpen) return false;
  s.stdinOpen = false;
  await runner.closeStdin(s.runId);
  bumpStore();
  return true;
}

export function clearSession(s: Session) {
  s.buf.clear();
  scheduleRender(s);
}

// The Stop action (⌘F2, toolbar) goes through the shared stop registry (hooks.ts).
const stoppable = () => { const a = activeSession(); return a && a.status !== "finished" ? a : [...sessions()].reverse().find((s) => s.status !== "finished") ?? null; };
registerStopHandler({ id: "run", priority: 10, canStop: () => !!stoppable(), stop: () => { const s = stoppable(); if (s) stopSession(s); } });

// A different project in this window: sessions of the old one are gone (Rust kills the children when the window closes; a
// switch within a window keeps them, so stop them explicitly).
let lastRoot = "";
projectStore.subscribe(() => {
  const r = projectStore.get().root;
  const k = r ? `${r.host}:${r.path}` : "";
  if (lastRoot && k !== lastRoot) {
    for (const s of sessions()) { stopSession(s); s.token++; }
    sessionStore.set({ list: [], activeId: null });
  }
  lastRoot = k;
});
