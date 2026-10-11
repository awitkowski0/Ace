/** Test hooks (`(await __qa.py()).run`) for scripts/qa/py/run.mjs and tests.mjs. */
import { projectStore } from "../../lib/project";
import { fs } from "../../lib/ipc";
import { registerQa } from "../python/qa";
import { pstore, pyApi } from "../python/api";
import { pyStore } from "../python/interpreter";
import { addConfig, contextConfig, ensureConfig, ctxFor, getConfig, listConfigTypes, loadConfigs, newConfig, removeConfig, runStore, saveNow, selectConfig, updateConfig } from "./configs";
import { getRunMarkers, canStopAny, stopCurrent, getDebugLauncher, setDebugLauncher, type DebugLauncher } from "./hooks";
import { findLinks, resolveLink } from "./links";
import { clearSession, closeSession, closeStdinOf, getSession, rerunFailed, rerunSession, sessionStore, sessions, startRun, stopSession, writeStdin, type Session } from "./sessions";
import { nodeOutcome, type TestNode } from "./testModel";
import { testsUiOf } from "./TestsView";

const summary = (s: Session) => ({
  id: s.id, name: s.name, configId: s.configId, status: s.status, exit: s.exit?.display ?? null, signal: s.exit?.signal ?? null, stopRequested: s.stopRequested,
  lines: s.buf.lines.length, runId: s.runId, commandLine: s.commandLine, cwd: s.cwd, stdinOpen: s.stdinOpen, tests: s.tests ? s.tests.statusText() : null, active: sessionStore.get().activeId === s.id,
  missing: s.missing ? s.missing.name : null,
});
const need = (id: string) => { const s = getSession(id); if (!s) throw new Error(`no session ${id}`); return s; };
const tree = (n: TestNode): unknown => ({
  name: n.name, kind: n.kind, outcome: nodeOutcome(n), duration: n.duration, id: n.id, file: n.file, line: n.line, message: n.message,
  hasTrace: !!n.longrepr, output: n.output, counts: n.counts, children: n.children.map(tree),
});
let savedLauncher: DebugLauncher | null = null;
const debugCalls: unknown[] = [];
const q = (sel: string) => [...document.querySelectorAll<HTMLElement>(sel)];

registerQa("run", {
  ensure: (partial: never) => ensureConfig(partial),
  interpreters: () => pyStore.get().interpreters.map((i) => ({ path: i.path, name: i.name, project: i.project })),
  probe: async (path: string) => (await pyApi.probe(projectStore.get().root!.host, path)).modules,
  /** record debug launches instead of starting a debugger (restores the real launcher with on=false) */
  captureDebug: (on: boolean) => {
    if (on) { savedLauncher = getDebugLauncher(); debugCalls.length = 0; setDebugLauncher(async (t, c) => { debugCalls.push({ target: t, ctx: c }); }); }
    else { setDebugLauncher(savedLauncher); savedLauncher = null; }
  },
  debugCalls: () => debugCalls,
  types: () => listConfigTypes().map((t) => ({ id: t.id, label: t.label, available: !t.available || t.available() })),
  configs: () => runStore.get().configs,
  selected: () => runStore.get().selectedId,
  addConfig: (type: string, patch: Record<string, unknown> = {}) => { const ctx = ctxFor()!; return addConfig(newConfig(type, ctx, patch)); },
  updateConfig: (cfg: never) => updateConfig(cfg),
  removeConfig, select: selectConfig, getConfig,
  flush: () => saveNow(),
  stored: () => pstore.get(projectStore.get().root!, "runconfigs"),
  /** drop the in-memory list and read it back from the per-project store */
  reload: async () => { await saveNow(); runStore.set({ configs: [], selectedId: null }); await loadConfigs(true); return runStore.get(); },
  start: async (target: string | never, mode: "run" | "debug" = "run") => (await startRun(target, mode))?.id ?? null,
  sessions: () => sessions().map(summary),
  session: (id: string) => summary(need(id)),
  text: (id: string) => need(id).buf.fullText(),
  spans: (id: string) => need(id).buf.lines.map((l) => l.spans),
  stop: (id: string) => stopSession(need(id)),
  stopCurrent: () => stopCurrent(),
  canStop: () => canStopAny(),
  rerun: (id: string) => rerunSession(need(id)),
  close: (id: string) => closeSession(need(id), false),
  clear: (id: string) => clearSession(need(id)),
  write: (id: string, t: string) => writeStdin(need(id), t),
  closeStdin: (id: string) => closeStdinOf(need(id)),
  waitDone: async (id: string, ms = 20000) => {
    const s = need(id);
    await Promise.race([s.finished, new Promise((_, rej) => setTimeout(() => rej(new Error(`session ${s.name} still ${s.status} after ${ms} ms\n` + s.buf.fullText().slice(-400))), ms))]);
    await new Promise((r) => setTimeout(r, 60));
    return summary(s);
  },
  /** every file link in the console, resolved like a click would */
  links: async (id: string) => {
    const s = need(id);
    const root = projectStore.get().root!.path;
    const out: unknown[] = [];
    for (const l of s.buf.lines) {
      const t = l.spans.map((x) => x.t).join("");
      for (const k of findLinks(t)) {
        const loc = await resolveLink(k.path, s.host, s.cwd, root);
        out.push({ text: t.slice(k.start, k.end), path: k.path, line: k.line, col: k.col, resolved: loc?.path ?? null });
      }
    }
    return out;
  },
  /** DOM: link elements currently rendered in the console / detail pane */
  domLinks: () => q(".run-link").map((a) => ({ text: a.textContent, path: a.dataset.path, line: +(a.dataset.line ?? 0) })),
  clickDomLink: (i = 0) => { const a = q(".run-link")[i]; if (!a) return false; a.click(); return true; },
  tests: (id: string) => { const s = need(id); return s.tests ? { status: s.tests.statusText(), done: s.tests.done, failed: s.tests.failedIds(), root: tree(s.tests.root) } : null; },
  selectTest: (id: string, key: string) => { testsUiOf(id).sel = key; sessionStore.set((x) => ({ rev: x.rev + 1 })); },
  rerunFailed: (id: string) => rerunFailed(need(id)),
  /** toolbar widget state as the user sees it */
  widget: () => {
    const w = document.querySelector<HTMLElement>('[data-testid="run-widget"]');
    if (!w) return null;
    const btn = (a: string) => w.querySelector<HTMLButtonElement>(`[data-act="${a}"]`);
    const cfg = btn("config");
    return {
      name: cfg?.querySelector(".run-cfg-name")?.textContent ?? "", temp: cfg?.dataset.temp === "1", empty: cfg?.classList.contains("empty") ?? false,
      run: { disabled: btn("run")?.disabled, title: btn("run")?.title }, debug: { disabled: btn("debug")?.disabled }, stop: { disabled: btn("stop")?.disabled },
      italic: !!cfg?.querySelector(".run-cfg-name.temp"),
    };
  },
  menuItems: () => q('[data-testid="run-menu"] .run-menu-item').map((e) => ({ id: e.dataset.cfg, name: e.querySelector(".run-menu-name")?.textContent, temp: !!e.querySelector(".run-menu-name.temp"), checked: !!e.querySelector(".run-menu-check")?.textContent })),
  /** gutter markers for a project file, as the debugger's gutter would ask for them */
  markers: async (path: string) => {
    const text = await fs.readFile({ host: projectStore.get().root!.host, path });
    return getRunMarkers({ getValue: () => text, uri: { path } }).map((m) => ({ line: m.line, kind: m.kind, label: m.label }));
  },
  markerRun: async (path: string, line: number, mode: "run" | "debug" = "run") => {
    const text = await fs.readFile({ host: projectStore.get().root!.host, path });
    const m = getRunMarkers({ getValue: () => text, uri: { path } }).find((x) => x.line === line);
    if (!m) throw new Error(`no marker at ${line}`);
    mode === "run" ? m.run() : m.debug();
  },
  contextConfig: async (path: string, line: number) => contextConfig({ loc: { host: projectStore.get().root!.host, path }, text: await fs.readFile({ host: projectStore.get().root!.host, path }), line, language: "python" }),
  setInline: async (on: boolean) => { (await import("../python/runtypes/pytest")).pluginTransport.inline = on; },
});
