// Python debugger (debugpy over DAP): tool window, actions, launcher + stop handler, editor gutter, QA hooks. docs/PYTHON.md
// Everything here is cheap at startup: the Debug window and dialogs are lazy chunks, the gutter/execution decorations are only
// installed once a Python project is active, and no process starts before a debug session is requested.
import { Component, lazy, Suspense, type ReactNode } from "react";
import { registerAction } from "../../../actions/registry";
import { registerToolWindow } from "../../../toolwindows/registry";
import { focusedToolWindowId } from "../../../lib/layout";
import { activeEditor } from "../../../editor/editorRegistry";
import { projectStore } from "../../../lib/project";
import { basename } from "../../../lib/ipc";
import { registerStopHandler, setDebugLauncher, type PythonDebugTarget } from "../../run/hooks";
import { ensurePython, envFor, interpreterFromPath, pyStore } from "../interpreter";
import { registerQa } from "../qa";
import { chooseAdapter } from "./adapter";
import { addWatch, bpStore, clearBreakpoints, flushBreakpoints, loadBreakpoints, removeBreakpoint, removeWatch, setExceptionBreakpoints, setMuted, toggleBreakpoint, updateBreakpoint, watchStore, addBreakpoint } from "./bps";
import { acceptModel, gutterInfo, installGutter, qaGutterClick, qaSetRunMarkers, toggleAtCaret } from "./gutter";
import { installExecution, executionInfo } from "./execution";
import { startDebugSession, stopAllSessions } from "./launch";
import { balloons } from "./notify";
import { hasLive, isPaused, ops } from "./ops";
import { activeSession, debugStore, execStore, liveSessions, pausedSession } from "./session";

const DebugWindow = lazy(() => import("./DebugWindow"));
/** A render error in the Debug window must never take the whole IDE down. */
class Boundary extends Component<{ children: ReactNode }, { err: string | null }> {
  state = { err: null as string | null };
  static getDerivedStateFromError(e: unknown) { return { err: String((e as Error)?.message ?? e) }; }
  render() { return this.state.err ? <div className="dbg-empty" data-autofocus tabIndex={0}>Debug window error: {this.state.err}</div> : this.props.children; }
}
const Win = () => <Boundary><Suspense fallback={null}><DebugWindow /></Suspense></Boundary>;

const BugIcon = () => (
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
    <ellipse cx="8" cy="9.2" rx="3.2" ry="4" /><path d="M5.2 7.6H2.5M10.8 7.6h2.7M5.2 10.8H2.8M10.8 10.8h2.4M6 3.4L5 2M10 3.4L11 2M8 5.2v8" /><path d="M5.6 5.3a2.4 2.1 0 0 1 4.8 0" />
  </svg>
);

registerToolWindow({ id: "debug", title: "Debug", icon: <BugIcon />, side: "bottom", shortcut: "meta 5", actionId: "ActivateDebugToolWindow", order: 6, component: Win });

// ---------------------------------------------------------------- launcher + stop
setDebugLauncher(async (target, ctx) => { await startDebugSession(target, ctx); });
registerStopHandler({ id: "debug", priority: 10, canStop: () => liveSessions().length > 0, stop: () => ops.stop() });

// ---------------------------------------------------------------- actions
const pyEditor = () => { const m = activeEditor()?.getModel(); return !!m && acceptModel(m); };
const stepping = () => isPaused();

registerAction({ id: "ToggleLineBreakpoint", title: "Toggle Line Breakpoint", intellijId: "ToggleLineBreakpoint", defaultKeys: ["meta F8"], context: "editor", isEnabled: pyEditor, run: () => void toggleAtCaret() });
registerAction({ id: "ViewBreakpoints", title: "View Breakpoints…", intellijId: "ViewBreakpoints", defaultKeys: ["meta shift F8"], run: () => ops.viewBreakpoints() });
registerAction({ id: "MuteBreakpoints", title: "Mute Breakpoints", run: () => ops.toggleMute() });
registerAction({ id: "StepOver", title: "Step Over", intellijId: "StepOver", defaultKeys: ["F8"], isEnabled: stepping, run: () => void ops.stepOver() });
registerAction({ id: "StepInto", title: "Step Into", intellijId: "StepInto", defaultKeys: ["F7"], isEnabled: stepping, run: () => void ops.stepInto() });
registerAction({ id: "ForceStepInto", title: "Force Step Into", intellijId: "ForceStepInto", defaultKeys: ["alt shift F7"], isEnabled: stepping, run: () => void ops.forceStepInto() });
registerAction({ id: "SmartStepInto", title: "Smart Step Into", intellijId: "SmartStepInto", defaultKeys: ["shift F7"], isEnabled: stepping, run: () => void ops.smartStepInto() });
registerAction({ id: "StepOut", title: "Step Out", intellijId: "StepOut", defaultKeys: ["shift F8"], isEnabled: stepping, run: () => void ops.stepOut() });
registerAction({ id: "Resume", title: "Resume Program", intellijId: "Resume", defaultKeys: ["F9"], isEnabled: stepping, run: () => void ops.resume() });
registerAction({ id: "Pause", title: "Pause Program", isEnabled: () => liveSessions().some((s) => s.status === "running"), run: () => void ops.pause() });
registerAction({ id: "RunToCursor", title: "Run to Cursor", intellijId: "RunToCursor", defaultKeys: ["alt F9"], context: "editor", isEnabled: () => stepping() && pyEditor(), run: () => void ops.runToCursor(false) });
registerAction({ id: "ForceRunToCursor", title: "Force Run to Cursor", intellijId: "ForceRunToCursor", defaultKeys: ["meta alt F9"], context: "editor", isEnabled: () => stepping() && pyEditor(), run: () => void ops.runToCursor(true) });
registerAction({ id: "EvaluateExpression", title: "Evaluate Expression…", intellijId: "EvaluateExpression", defaultKeys: ["alt F8"], isEnabled: stepping, run: () => ops.evaluateExpression() });
registerAction({ id: "ShowExecutionPoint", title: "Show Execution Point", intellijId: "ShowExecutionPoint", defaultKeys: ["alt F10"], isEnabled: stepping, run: () => ops.showExecutionPoint() });
registerAction({ id: "AddToWatch", title: "Add to Watches", isEnabled: () => hasLive() && pyEditor(), run: () => ops.addToWatch() });
// ⌘R is Replace in the editor: Rerun only while the Debug window has focus (the Run window registers its own)
registerAction({ id: "RerunDebug", title: "Rerun", intellijId: "Rerun", defaultKeys: ["meta R"], context: { toolWindow: "debug" }, isEnabled: () => !!activeSession() && focusedToolWindowId() !== "terminal", run: () => void ops.rerun() });

// ---------------------------------------------------------------- editor integration (only for Python projects)
let installed = false;
function install() {
  if (installed || !pyStore.get().active) return;
  installed = true;
  installGutter();
  installExecution();
}
pyStore.subscribe(install);
install();

// ---------------------------------------------------------------- QA hooks (__qa.py().debug)
interface QaStart { program?: string; module?: string; args?: string[]; python?: string; cwd?: string; env?: Record<string, string>; title?: string; extra?: Record<string, unknown> }
async function qaTarget(o: QaStart): Promise<PythonDebugTarget> {
  await ensurePython();
  const root = projectStore.get().root!;
  const py = o.python ?? pyStore.get().current?.path ?? "python3";
  const interp = pyStore.get().interpreters.find((i) => i.path === py) ?? (await interpreterFromPath(root.host, py));
  const e = envFor(interp);
  return {
    kind: "python", host: root.host, cwd: o.cwd ?? root.path, python: py, program: o.program, module: o.module, args: o.args ?? [],
    env: { ...e.env, ...(o.env ?? {}) }, pathPrepend: e.pathPrepend, title: o.title ?? (o.program ? basename(o.program) : o.module ?? "debug"), extra: o.extra,
  };
}
const fakeClicks: string[] = [];
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const cur = () => activeSession();
const need = () => { const s = cur(); if (!s) throw new Error("no debug session"); return s; };

registerQa("debug", {
  /** start a session (like the Debug button) and return its summary once launched */
  async start(o: QaStart) { await loadBreakpoints(); const s = await startDebugSession(await qaTarget(o)); return s ? s.summary() : { adapterMissing: true }; },
  target: qaTarget,
  state: () => cur()?.summary() ?? null,
  sessions: () => debugStore.get().sessions.map((s) => ({ id: s.id, title: s.state.title, status: s.status })),
  async waitStatus(status: string, ms = 20000) { const s = need(); const ok = await s.waitFor((x) => x.status === status, ms); return { ok, ...s.summary() }; },
  async waitPaused(ms = 20000) { const s = need(); const ok = await s.waitFor((x) => x.status === "paused" && x.frames.length > 0, ms); return { ok, ...s.summary() }; },
  async waitEnded(ms = 20000) { const s = need(); const ok = await s.waitFor((x) => x.status === "ended", ms); return { ok, ...s.summary() }; },
  stepOver: () => ops.stepOver(), stepInto: () => ops.stepInto(), stepOut: () => ops.stepOut(), resume: () => ops.resume(), pause: () => ops.pause(),
  stop: () => ops.stop(), stopAll: () => stopAllSessions(),
  runToCursor: (path: string, line: number, force = false) => pausedSession()?.runToCursor(path, line, force),
  /** run to cursor through the editor action path (caret in the active editor) */
  runToCursorAction: () => ops.runToCursor(false),
  evaluate: (expr: string, ctx: "watch" | "repl" | "hover" = "watch") => need().evaluate(expr, ctx),
  repl: (expr: string) => need().repl(expr),
  selectFrame: (i: number) => need().selectFrame(i),
  /** children of a top-level local (lazy expansion) */
  async expand(name: string) {
    const s = need();
    const slot = s.state.vars[String(s.state.scopes[0]?.ref)];
    const v = Array.isArray(slot) ? slot.find((x) => x.name === name) : undefined;
    if (!v) throw new Error(`no local ${name}`);
    return (await s.children(v)).map((c) => ({ name: c.name, value: c.value, type: c.type, ref: c.ref }));
  },
  setVariable: (name: string, value: string) => { const s = need(); return s.setVariable(s.state.scopes[0].ref, name, value); },
  watches: { add: (e: string) => { addWatch(e); return pausedSession()?.refreshWatches(); }, remove: removeWatch, list: () => watchStore.get().list, refresh: () => pausedSession()?.refreshWatches() },
  bps: {
    load: loadBreakpoints,
    list: () => bpStore.get().list.map(({ id, ...b }) => ({ id, ...b })),
    toggle: (path: string, line: number) => toggleBreakpoint(path, line),
    add: (b: { path: string; line: number; enabled?: boolean; condition?: string; logMessage?: string; hitCount?: string }) => addBreakpoint({ enabled: true, ...b }),
    set: (path: string, line: number, patch: Record<string, unknown>) => { const b = bpStore.get().list.find((x) => x.path === path && x.line === line); if (!b) throw new Error("no breakpoint there"); updateBreakpoint(b.id, patch); },
    remove: (path: string, line: number) => { const b = bpStore.get().list.find((x) => x.path === path && x.line === line); if (b) removeBreakpoint(b.id); },
    clear: clearBreakpoints,
    exceptions: (patch?: Record<string, boolean>) => { if (patch) setExceptionBreakpoints(patch); return bpStore.get().exceptions; },
    mute: (m: boolean) => setMuted(m),
    flush: flushBreakpoints,
    status: () => cur()?.state.bpStatus ?? {},
  },
  /** what the editors draw: breakpoint lines + classes, run markers, execution line, inline values */
  gutter: gutterInfo,
  execution: executionInfo,
  execPoint: () => execStore.get().point,
  gutterClick: (line: number, where: "glyph" | "lineNumber" = "glyph", lane?: "left" | "right", path?: string) => qaGutterClick(line, where, lane, path),
  async chooseAdapter(python: string) { await ensurePython(); const c = await chooseAdapter(projectStore.get().root!.host, python); return c ? { python: c.python, own: c.own } : null; },
  balloons: () => balloons().map((b) => ({ title: b.title, text: b.text, actions: b.actions.map((a) => a.label) })),
  trace: () => cur()?.client.trace ?? [],
  adapterLog: () => cur()?.client.log ?? [],
  /** replace (array of {line, kind, label}) or restore (null) the gutter's run markers; click handlers record into `fakeClicks` */
  fakeRunMarkers(lines: { line: number; kind?: "main" | "test"; label?: string }[] | null) {
    qaSetRunMarkers(lines && ((m) => lines.map((l) => ({
      line: l.line, kind: l.kind ?? "main", label: l.label ?? "Run 'main'",
      run: () => { fakeClicks.push(`run:${m.uri.path.split("/").pop()}:${l.line}`); }, debug: () => { fakeClicks.push(`debug:${m.uri.path.split("/").pop()}:${l.line}`); },
    }))));
    return true;
  },
  fakeClicks: () => fakeClicks.splice(0),
  /** run `start` while no discovered interpreter has debugpy (only `python` is known): the install balloon must show, nothing is installed */
  async withOnlyInterpreter(python: string, o: QaStart) {
    await ensurePython();
    const saved = pyStore.get();
    const interp = await interpreterFromPath(projectStore.get().root!.host, python);
    pyStore.set({ interpreters: [interp], current: interp, probe: null });
    try {
      const s = await startDebugSession(await qaTarget({ ...o, python }));
      return { started: !!s, balloons: balloons().map((b) => ({ title: b.title, actions: b.actions.map((a) => a.label) })) };
    } finally {
      pyStore.set({ interpreters: saved.interpreters, current: saved.current, probe: saved.probe });
    }
  },
  write: (text: string) => need().write(text),
  /** stop and remove every session tab */
  async closeAll() { for (const s of [...debugStore.get().sessions]) await ops.closeSession(s); return true; },
  closeSession: (id: string) => { const s = debugStore.get().sessions.find((x) => x.id === id); return s ? ops.closeSession(s) : undefined; },
  rerun: () => ops.rerun(),
  selectSession: (id: string) => ops.select(id),
  openBreakpointsDialog: () => ops.viewBreakpoints(),
  openEvaluate: (e = "") => import("./dialogs").then((d) => d.openEvaluateDialog(e)),
  sleep,
});
