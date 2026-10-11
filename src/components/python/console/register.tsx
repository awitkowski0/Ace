// Python Console (docs/PYTHON.md): tool window "pyconsole" + Execute Selection in Python Console (⌥⇧E).
// Nothing is spawned or loaded until the window is first shown or Execute Selection runs.
import { lazy, Suspense } from "react";
import { registerToolWindow } from "../../../toolwindows/registry";
import { getAction, registerAction } from "../../../actions/registry";
import { layoutStore, setActive, showToolWindow, isToolWindowFocused } from "../../../lib/layout";
import { activeEditor } from "../../../editor/editorRegistry";
import { registerStopHandler } from "../../run/hooks";
import { registerQa } from "../qa";
import { codeToExecute } from "./selection";
import { pstore } from "../api";
import { projectStore } from "../../../lib/project";
import { addSystem, clear, interpreterChanged, setConsoleOverride, consoleStore, execute, interrupt, isAlive, refreshVars, restart, setShowVars, start, stop, transcriptText, getHistory, loadHistory } from "./session";

const Panel = lazy(() => import("./ConsolePanel").then((m) => ({ default: m.ConsolePanel })));

const ConsoleIcon = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
    <rect x="1.5" y="2.5" width="13" height="11" rx="1.5" />
    <path d="M4.500 6l2 2-2 2M8.500 10.500h3" />
    <circle cx="11.500" cy="5.500" r=".6" fill="currentColor" />
  </svg>
);

registerToolWindow({
  id: "pyconsole",
  title: "Python Console",
  icon: <ConsoleIcon />,
  side: "bottom",
  actionId: "ActivatePythonConsoleToolWindow",
  order: 11,
  component: () => <Suspense fallback={null}><Panel /></Suspense>,
});

/** Make the console visible WITHOUT moving focus (the editor keeps it). */
function revealConsole() {
  if (layoutStore.get().active.bottom !== "pyconsole") setActive("bottom", "pyconsole");
}

function currentCode(): string | null {
  const ed = activeEditor();
  const model = ed?.getModel();
  if (!ed || !model) return null;
  const sels = ed.getSelections() ?? [];
  const selected = sels.filter((s) => !s.isEmpty()).map((s) => model.getValueInRange(s)).join("\n");
  const lines = model.getValue().split("\n");
  return codeToExecute(lines, selected, (ed.getPosition()?.lineNumber ?? 1) - 1);
}

export async function executeSelectionInConsole(): Promise<boolean> {
  const code = currentCode();
  if (!code) return false;
  revealConsole();
  await execute(code);
  return true;
}

registerAction({
  id: "ExecuteInPyConsoleAction",
  title: "Execute Selection in Python Console",
  defaultKeys: ["alt shift E"],
  context: "editor",
  isEnabled: () => activeEditor()?.getModel()?.getLanguageId() === "python",
  run: async () => { await executeSelectionInConsole(); },
});

registerAction({
  id: "PythonConsole.Restart",
  title: "Restart Python Console",
  run: async () => { revealConsole(); await restart(); },
});

// ⌘F2 (Stop) while the console has focus stops the console process.
registerStopHandler({
  id: "pyconsole",
  priority: 20,
  canStop: () => isAlive() && isToolWindowFocused("pyconsole"),
  stop: () => void stop(),
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
registerQa("console", {
  /** show the tool window (starts the console via the panel) and wait until the process is ready */
  open: async () => { showToolWindow("pyconsole"); await start(); return consoleStore.get().status; },
  start: async () => { await start(); return consoleStore.get().status; },
  /** run code as one cell and wait for it to finish; returns the transcript text produced by that cell (output only) */
  execute: async (code: string) => {
    const before = consoleStore.get().entries.length;
    const r = await execute(code);
    await sleep(60);
    const { entries } = consoleStore.get();
    // eslint-disable-next-line no-control-regex
    const strip = (s: string) => s.replace(/\x1b\[[0-9;:?]*[ -/]*[@-~]/g, "");
    return { exited: r.exited, out: entries.slice(before).filter((e) => e.kind === "out").map((e) => strip((e as { text: string }).text)).join("") };
  },
  transcript: () => transcriptText(),
  entries: () => consoleStore.get().entries.map((e) => (e.kind === "in" ? { kind: "in", n: e.n, code: e.code } : { kind: e.kind, text: (e as { text: string }).text })),
  vars: async () => { await refreshVars(); return consoleStore.get().vars; },
  showVars: (on: boolean) => setShowVars(on),
  history: async () => { await loadHistory(); return getHistory(); },
  restart: async () => { await restart(); return consoleStore.get().status; },
  stop: async () => { await stop(); return consoleStore.get().status; },
  interrupt: () => interrupt(),
  clear: () => clear(),
  note: (t: string) => addSystem(t),
  /** the real action, driven from the active editor's selection / caret; resolves when the cell finished */
  executeSelection: async () => { const a = getAction("ExecuteInPyConsoleAction"); if (!a) throw new Error("action missing"); await a.run(); return consoleStore.get().n; },
  /** type into the input editor (the harness `type` targets the main editor, so go through the handle) */
  setInput: async (text: string) => {
    showToolWindow("pyconsole");
    const m = await import("./InputEditor");
    for (let i = 0; i < 200 && !m.activeInput; i++) await sleep(25);
    m.activeInput?.focus();
    m.activeInput?.setValue(text);
    return !!m.activeInput;
  },
  getInput: async () => (await import("./InputEditor")).activeInput?.getValue() ?? null,
  historyDisk: async () => { const r = projectStore.get().root; return r ? (await pstore.get<{ items: string[] }>(r, "console-history"))?.items ?? [] : []; },
  /** select a range / put the caret in the ACTIVE main editor (the harness has no selection helper) */
  select: (l1: number, c1: number, l2: number, c2: number) => { const ed = activeEditor(); if (!ed) throw new Error("no editor"); ed.focus(); ed.setSelection({ startLineNumber: l1, startColumn: c1, endLineNumber: l2, endColumn: c2 }); return true; },
  caret: (line: number, col = 1) => { const ed = activeEditor(); if (!ed) throw new Error("no editor"); ed.focus(); ed.setPosition({ lineNumber: line, column: col }); return true; },
  /** the interpreter-changed prompt (dialog -> restart), as if the project interpreter was switched */
  interpreterChanged: (path: string) => interpreterChanged(path),
  /** run the console on another host (ssh alias) with that host's interpreter, for the remote check */
  useOverride: (o: { host: string; cwd: string; python: string } | null) => setConsoleOverride(o),
  state: () => { const s = consoleStore.get(); return { status: s.status, ipython: s.ipython, interp: s.interp, n: s.n, entries: s.entries.length, showVars: s.showVars, vars: s.vars.length, visible: layoutStore.get().active.bottom === "pyconsole" }; },
});
