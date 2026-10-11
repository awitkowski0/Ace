/** Test hooks (`(await __qa.gradle()).java`) for scripts/qa/hotswap.mjs. */
import { editorStore } from "../../../editor/store";
import { dumpClasspath, javaApi } from "./api";
import { activeJavaFile, reloadJavaFile } from "./actions";
import { javaSessions, liveJavaSession, type JavaDebugSession } from "./session";
import { hotswapOnSave, setHotswapOnSave } from "./settings";
import { getJavaJbrs } from "./jbr";

const summary = (s: JavaDebugSession) => ({
  id: s.id, jdwpId: s.jdwpId, status: s.status, attach: s.attachState, attaches: s.attachCount, port: s.java.port, title: s.java.title, stopText: s.state.stopText,
  vm: s.vm ? { name: s.vm.vmName, version: s.vm.vmVersion, redefine: s.vm.canRedefine, addMethod: s.vm.canAddMethod } : null,
  runId: s.run.runId, runStatus: s.run.status, last: s.lastResult, events: s.events.length, n: s.results.length, exitCode: s.state.exitCode, enhanced: s.java.enhanced,
});
const cur = () => { const s = liveJavaSession() ?? javaSessions().slice(-1)[0]; if (!s) throw new Error("no java debug session"); return s; };

export const javaQa = {
  sessions: () => javaSessions().map(summary),
  state: () => summary(cur()),
  console: () => cur().outputText(),
  /** what the Debug window shows while paused */
  paused: () => {
    const s = cur();
    const st = s.state;
    const locals = st.scopes[0] ? st.vars[String(st.scopes[0].ref)] : undefined;
    return { status: st.status, reason: st.stopReason, threadId: st.threadId, threads: st.threads.length, frameIdx: st.frameIdx, frames: st.frames.map((f) => ({ name: f.name, line: f.line, path: f.path })), locals: Array.isArray(locals) ? locals.map((v) => ({ name: v.name, value: v.value, type: v.type, ref: v.ref })) : locals ?? null, bpStatus: st.bpStatus };
  },
  waitPaused: async (ms = 60000) => { const s = cur(); const ok = await s.waitFor((x: { status: string; frames: unknown[]; scopes: unknown[] }) => x.status === "paused" && x.frames.length > 0 && x.scopes.length > 0, ms); return { ok }; },
  waitRunning: async (ms = 30000) => { const s = cur(); const ok = await s.waitFor((x: { status: string }) => x.status === "running", ms); return { ok }; },
  resume: () => cur().resume(),
  pause: () => cur().pause(),
  stepOver: () => cur().stepOver(),
  stepInto: () => cur().stepInto(),
  stepOut: () => cur().stepOut(),
  selectFrame: (i: number) => cur().selectFrame(i),
  expand: async (name: string) => { const s = cur(); const sc = s.state.scopes[0]; await s.ensureVars(sc.ref); const slot = s.state.vars[String(sc.ref)]; const v = Array.isArray(slot) ? slot.find((x) => x.name === name) : undefined; if (!v) throw new Error("no local " + name); return (await s.children(v)).map((c) => ({ name: c.name, value: c.value, type: c.type, ref: c.ref })); },
  evaluate: (expr: string) => cur().evaluate(expr),
  waitAttached: async (ms = 120000) => { const s = cur(); const ok = await s.waitFor(() => s.attachState === "attached", ms); return { ok, ...summary(s) }; },
  waitEnded: async (ms = 30000) => { const s = cur(); const ok = await s.waitFor((x: { status: string }) => x.status === "ended", ms); return { ok, ...summary(s) }; },
  waitWaiting: async (ms = 30000) => { const s = cur(); const ok = await s.waitFor(() => s.attachState === "detached" || s.attachState === "waiting", ms); return { ok, ...summary(s) }; },
  /** the action path: Compile and Reload File on the active editor tab */
  reloadActive: () => reloadJavaFile(),
  reload: (file: string) => cur().reloadFile(file),
  activeFile: () => activeJavaFile(),
  stop: () => cur().stop(),
  watchClasses: (pattern: string) => javaApi.watchClasses(cur().jdwpId, pattern),
  vmEvents: () => cur().events,
  killGame: (port: number) => javaApi.killGame(port),
  onSave: () => hotswapOnSave(),
  setOnSave: (on: boolean) => setHotswapOnSave(on),
  /** read-only `aceDumpClasspath` for a file of any Gradle build (no debug session) */
  dump: (root: string, file: string) => dumpClasspath(root, file),
  /** resolve + compile with the build's settings, no VM, nothing redefined (QA on real repos) */
  dryRun: (root: string, file: string) => javaApi.hotswap("dry", file, root, { dryRun: true }),
  jdks: () => javaApi.jdks(),
  jbrs: () => getJavaJbrs(),
  buttons: () => [...document.querySelectorAll<HTMLElement>("[data-hotswap]")].map((e) => ({ kind: e.dataset.hotswap, on: e.classList.contains("on"), title: e.title })),
  docs: () => Object.values(editorStore.get().docs).map((d) => ({ key: d.key, dirty: d.dirty })),
};
