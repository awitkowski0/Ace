/** A Gradle Debug run as a session of the Debug window: attaches to the JavaExec JVM over JDWP (Rust: jdwp.rs), hot swap, no breakpoints. */
import { listen, type UnlistenFn } from "../../../lib/ipc";
import { projectStore } from "../../../lib/project";
import { showToolWindow } from "../../../lib/layout";
import { DebugSession, debugStore, execStore, type EvalResult, type Frame, type Scope, type Var } from "../../python/debug/session";
import { bpStore, loadBreakpoints, watchStore } from "../../python/debug/bps";
import { showBalloon } from "../../python/debug/notify";
import { scheduleRender, startRun, stopSession, type Session } from "../../run/sessions";
import type { JavaDebugTarget } from "../../run/hooks";
import type { RunConfig } from "../../run/types";
import { ranProjects } from "./pure";
import { javaApi, type AttachState, type HotswapResult, type JFrame, type VmEvent, type VmInfo } from "./api";

let extras: DebugSession["sideExtras"];
/** register.tsx hands in the Debug window buttons (keeps this file free of React) */
export const setJavaExtras = (c: DebugSession["sideExtras"]) => { extras = c; };
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
/** how long we wait for the JVM to open its debug port (Loom's first setup can take many minutes) */
export const ATTACH_TIMEOUT_SECS = 30 * 60;

export class JavaDebugSession extends DebugSession {
  readonly jdwpId: string;
  vm: VmInfo | null = null;
  attachState: AttachState["state"] = "waiting";
  attachCount = 0;
  events: VmEvent[] = [];
  lastResult: HotswapResult | null = null;
  results: HotswapResult[] = [];
  private readonly runToken: number;
  private jgen = 0;
  private bpSent = new Map<string, string>();
  private bpSyncing: Promise<void> = Promise.resolve();
  private bpTimer: ReturnType<typeof setTimeout> | undefined;
  private attachedNote = "Running";
  private unl: UnlistenFn[] = [];
  private ended = false;
  private jStop = false;
  private jBusy = false;

  constructor(readonly java: JavaDebugTarget, readonly run: Session, readonly cfg: RunConfig) {
    super(
      { kind: "python", host: java.host, cwd: java.cwd, python: "", args: [], env: {}, pathPrepend: [], title: `${java.title} (debug)` },
      { python: "", interp: null, own: false },
    );
    this.jdwpId = `jdwp-${this.id}`;
    this.sideExtras = extras;
    this.runToken = run.token;
    this.customRerun = async () => {
      await this.stop();
      await startRun(this.cfg, "debug", { reuse: this.run });
    };
  }

  async write(_text: string) {}

  async start() {
    const j = this.java;
    this.set({ status: "starting", stopText: "Waiting for JVM…" });
    this.printLine("sys", `Debugging Gradle run '${j.title}'. Waiting for the game JVM on 127.0.0.1:${j.port} (the first Loom setup can take minutes)…`);
    this.printLine("sys", "Gradle's own output is in the Run window (⌘4). Edit a .java file and press ⌘⇧F9 (Compile and Reload File) to hot swap it.");
    if (j.note) this.printLine("err", j.note);
    this.unl.push(await listen<AttachState>(`jdwp://state/${this.jdwpId}`, (e) => this.onState(e.payload)));
    this.unl.push(await listen<VmEvent>(`jdwp://event/${this.jdwpId}`, (e) => { this.events.push(e.payload); this.onVmEvent(e.payload); }));
    this.unl.push(await listen<string>(`hotswap://progress/${this.jdwpId}`, (e) => this.printLine("sys", e.payload)));
    try {
      await loadBreakpoints();
      this.unl.push(bpStore.subscribe(() => this.scheduleBps()));
      await javaApi.attach(this.jdwpId, j.port, ATTACH_TIMEOUT_SECS, projectStore.get().root?.path ?? "");
    } catch (e) {
      this.printLine("err", `Cannot start the debugger: ${String(e)}`);
      return void this.end(null);
    }
    // the Gradle process ends -> so does the session
    const run = this.run;
    void run.finished.then(() => { if (run.token === this.runToken) void this.onRunFinished(); });
    if (run.status === "finished") void this.onRunFinished();
  }

  private onState(s: AttachState) {
    if (this.ended) return;
    this.attachState = s.state;
    switch (s.state) {
      case "waiting":
        this.set({ status: "starting", stopText: "Waiting for JVM…" });
        break;
      case "attached": {
        this.vm = s.vm;
        this.attachCount++;
        const enhanced = s.vm.canAddMethod;
        const note = `Attached to ${s.vm.vmName} ${s.vm.vmVersion}${enhanced ? " (enhanced class redefinition)" : ""}`;
        this.attachedNote = note;
        this.bpSent.clear();
        execStore.set({ point: null });
        this.set({ status: "running", stopText: note, frames: [], scopes: [], vars: {}, frameIdx: 0 });
        this.scheduleBps(0);
        this.printLine("sys", `${note}; JDWP ${s.vm.jdwp}; redefine=${s.vm.canRedefine} addMethod=${s.vm.canAddMethod}. Ready to hot swap.`);
        break;
      }
      case "detached":
        this.vm = null;
        this.jgen++;
        execStore.set({ point: null });
        this.printLine("sys", "The JVM exited. Waiting for the next JVM of this run…");
        this.set({ status: "starting", stopText: "Waiting for JVM…", frames: [], scopes: [], vars: {}, frameIdx: 0 });
        break;
      case "timeout":
        this.printLine("err", `No JVM opened the debug port within ${ATTACH_TIMEOUT_SECS / 60} minutes. Does the run start a JavaExec task? Debugger session closed.`);
        void this.stop();
        break;
    }
  }

  // ------------------------------------------------------------------ breakpoints
  private scheduleBps(delay = 30) {
    if (this.ended) return;
    clearTimeout(this.bpTimer);
    this.bpTimer = setTimeout(() => { this.bpSyncing = this.bpSyncing.then(() => this.syncBps(), () => this.syncBps()); }, delay);
  }

  private async syncBps() {
    if (this.ended || this.attachState !== "attached") return;
    const { list, muted } = bpStore.get();
    const want = new Map<string, { id: string; line: number }[]>();
    for (const b of list) {
      if (!b.path.endsWith(".java")) continue;
      if (!want.has(b.path)) want.set(b.path, []);
      if (b.enabled && !muted) want.get(b.path)!.push({ id: b.id, line: b.line });
    }
    for (const f of this.bpSent.keys()) if (!want.has(f)) want.set(f, []);
    const st = { ...this.state.bpStatus };
    for (const [file, bps] of want) {
      const lines = [...new Set(bps.map((b) => b.line))].sort((a, b) => a - b);
      const key = JSON.stringify(lines);
      if (this.bpSent.get(file) === key) continue;
      try {
        const res = await javaApi.breakpoints(this.jdwpId, file, lines);
        this.bpSent.set(file, key);
        if (!lines.length) this.bpSent.delete(file);
        for (const b of bps) {
          const r = res.find((x) => x.line === b.line);
          if (r) st[b.id] = { verified: r.verified, message: r.message ?? undefined };
        }
      } catch (e) {
        this.printLine("err", `Could not set breakpoints in ${file.slice(file.lastIndexOf("/") + 1)}: ${String((e as { message?: string })?.message ?? e)}`);
      }
    }
    this.set({ bpStatus: st });
    debugStore.set({}); // gutter dots show verified / invalid state
  }

  // ------------------------------------------------------------------ stops
  private onVmEvent(ev: VmEvent) {
    if (this.ended) return;
    if (ev.kind === "breakpoint" || ev.kind === "step") void this.onJavaStopped(ev.kind, ev.thread);
  }

  private mapJFrames(raw: JFrame[]): Frame[] {
    return raw.map((f) => ({ id: f.id, name: f.name, line: f.line, col: 1, path: f.path, hint: f.path ? undefined : "subtle" }));
  }

  private async loadStack(thread: number, gen: number): Promise<boolean> {
    const frames = this.mapJFrames(await javaApi.stack(this.jdwpId, thread));
    if (gen !== this.jgen) return false;
    this.set({ threadId: thread, frames, frameIdx: 0, scopes: [], vars: {} });
    await this.loadScopes(gen);
    return gen === this.jgen;
  }

  private async loadScopes(gen: number) {
    const f = this.frame;
    if (!f) return;
    const sc = await javaApi.scopes(this.jdwpId, f.id).catch(() => []);
    if (gen !== this.jgen) return;
    const scopes: Scope[] = sc.map((s) => ({ name: s.name, ref: s.ref, expensive: s.expensive }));
    this.set({ scopes });
    if (scopes[0]) await this.ensureVars(scopes[0].ref);
  }

  private async onJavaStopped(reason: string, thread: number) {
    const gen = ++this.jgen;
    this.stopGen = gen;
    try {
      const threads = (await javaApi.threads(this.jdwpId).catch(() => [])).map((t) => ({ id: t.id, name: t.name }));
      if (gen !== this.jgen) return;
      this.set({ threads, watchResults: {}, stopReason: reason, stopText: null, exception: null });
      if (!(await this.loadStack(thread, gen))) return;
      this.set({ status: "paused" });
      showToolWindow("debug"); // like IntelliJ: a stop brings the Debug window up (it may have been hidden behind Run)
      this.publishExec();
      this.showFrame(this.frame, true);
      void this.refreshWatches(gen);
    } catch (e) {
      if (gen === this.jgen) this.printLine("err", `Could not read the stop location: ${String((e as { message?: string })?.message ?? e)}`);
    }
  }

  protected markJavaRunning() {
    this.jgen++;
    this.stopGen = this.jgen;
    execStore.set({ point: null });
    this.set({ status: "running", frames: [], scopes: [], vars: {}, frameIdx: 0, stopReason: null, stopText: this.attachedNote, exception: null });
  }

  // ------------------------------------------------------------------ execution control
  async resume() {
    if (this.status !== "paused") return;
    this.markJavaRunning();
    await javaApi.resume(this.jdwpId).catch((e) => this.printLine("err", String((e as { message?: string })?.message ?? e)));
  }

  async pause() {
    if (this.status !== "running" || this.attachState !== "attached") return;
    try {
      await javaApi.suspend(this.jdwpId);
      const threads = await javaApi.threads(this.jdwpId);
      // the thread a user means: the game's main / render / server thread, else the first one that has a stack
      const prefer = ["main", "Render thread", "Server thread"];
      const order = [...threads.filter((t) => prefer.includes(t.name)), ...threads.filter((t) => !prefer.includes(t.name))];
      for (const t of order) {
        const st = await javaApi.stack(this.jdwpId, t.id).catch(() => []);
        if (st.length) return void (await this.onJavaStopped("pause", t.id));
      }
      await javaApi.resume(this.jdwpId).catch(() => {});
      this.printLine("err", "No thread with a Java stack to show.");
    } catch (e) {
      this.printLine("err", String((e as { message?: string })?.message ?? e));
    }
  }

  private async stepWith(depth: "into" | "over" | "out") {
    const t = this.state.threadId;
    if (this.status !== "paused" || t == null) return;
    this.markJavaRunning();
    await javaApi.step(this.jdwpId, t, depth).catch((e) => this.printLine("err", String((e as { message?: string })?.message ?? e)));
  }
  async stepOver() { await this.stepWith("over"); }
  async stepInto(_target?: number) { await this.stepWith("into"); }
  async stepOut() { await this.stepWith("out"); }
  async stepInTargets() { return []; }
  async runToCursor(_path: string, _line: number, _force = false) { this.printLine("err", "Run to Cursor is not supported for Java yet; set a breakpoint and resume."); }

  async selectFrame(i: number, navigate = true) {
    if (this.status !== "paused" || !this.state.frames[i]) return;
    const gen = this.jgen;
    this.set({ frameIdx: i, scopes: [], vars: {} });
    await this.loadScopes(gen);
    if (gen !== this.jgen) return;
    this.publishExec();
    if (navigate) this.showFrame(this.frame);
    void this.refreshWatches(gen);
  }

  async selectThread(id: number) {
    if (this.status !== "paused") return;
    const gen = this.jgen;
    const frames = await javaApi.stack(this.jdwpId, id).catch(() => null);
    if (!frames || gen !== this.jgen) return;
    this.set({ threadId: id, frames: this.mapJFrames(frames), frameIdx: 0, scopes: [], vars: {} });
    await this.loadScopes(gen);
    if (gen !== this.jgen) return;
    this.publishExec();
    this.showFrame(this.frame);
  }

  // ------------------------------------------------------------------ variables / watches
  async ensureVars(ref: number, _range?: { filter?: "indexed" | "named"; start?: number; count?: number }) {
    const key = String(ref);
    if (this.state.vars[key]) return;
    const gen = this.jgen;
    this.set({ vars: { ...this.state.vars, [key]: "loading" } });
    let slot: Var[] | { error: string };
    try {
      slot = (await javaApi.variables(this.jdwpId, ref)).map((v) => ({ name: v.name, value: v.value, type: v.type || undefined, ref: v.ref || 0, evalName: v.name }));
    } catch (e) {
      slot = { error: String((e as { message?: string })?.message ?? e) };
    }
    if (gen !== this.jgen) return;
    this.set({ vars: { ...this.state.vars, [key]: slot } });
    if (ref === this.state.scopes[0]?.ref) this.publishExec();
  }

  async children(v: Var): Promise<Var[]> {
    if (!v.ref) return [];
    await this.ensureVars(v.ref);
    const slot = this.state.vars[String(v.ref)];
    return Array.isArray(slot) ? slot : [];
  }

  async setVariable(_parentRef: number, _name: string, _value: string): Promise<string | null> {
    return "Changing values is not supported for Java yet.";
  }

  /** Simple expressions only: a local / field path (`a`, `this.pos.x`, `list[2]`) resolved through the frame's variables. */
  async evaluate(expression: string, _context: "watch" | "repl" | "hover" | "clipboard" = "watch"): Promise<EvalResult> {
    if (this.status !== "paused" || !this.frame) return { error: this.live ? "The process is running" : "The session has ended" };
    const parts = expression.trim().match(/[A-Za-z_$][\w$]*|\[\d+\]/g);
    if (!parts || parts.join("") !== expression.trim().replace(/\./g, "")) return { error: "Only local variables and field paths (a.b[0]) can be evaluated for Java yet." };
    const scope = this.state.scopes[0];
    if (!scope) return { error: "No variables available" };
    await this.ensureVars(scope.ref);
    let slot = this.state.vars[String(scope.ref)];
    let cur: Var | undefined;
    for (let i = 0; i < parts.length; i++) {
      const list = Array.isArray(slot) ? slot : [];
      cur = list.find((x) => x.name === parts[i]);
      if (!cur) return { error: `Cannot find local variable '${parts[i]}'` };
      if (i < parts.length - 1) {
        if (!cur.ref) return { error: `'${parts[i]}' has no fields` };
        await this.ensureVars(cur.ref);
        slot = this.state.vars[String(cur.ref)];
      }
    }
    return cur ? { value: cur.value, type: cur.type, ref: cur.ref } : { error: "Cannot evaluate" };
  }

  async refreshWatches(gen = this.stopGen) {
    const exprs = watchStore.get().list;
    if (!exprs.length || this.status !== "paused") { if (gen === this.stopGen) this.set({ watchResults: {} }); return; }
    const results = await Promise.all(exprs.map(async (e) => [e, await this.evaluate(e, "watch")] as const));
    if (gen !== this.stopGen) return;
    this.set({ watchResults: Object.fromEntries(results) });
  }

  async repl(expression: string) {
    this.printLine("sys", `>>> ${expression}`);
    const r = await this.evaluate(expression, "repl");
    this.printLine(r.error ? "err" : "out", r.error ?? r.value ?? "");
  }

  /** Compile only `file` and redefine its classes in the attached JVM. */
  async reloadFile(file: string): Promise<HotswapResult> {
    const root = projectStore.get().root?.path ?? "/";
    const name = file.slice(file.lastIndexOf("/") + 1);
    if (this.jBusy) return this.reloadFail(name, "Another reload is still running.");
    this.jBusy = true;
    this.printLine("sys", `Compile and reload ${name}`);
    try {
      const r = await javaApi.hotswap(this.jdwpId, file, root, { enhanced: this.java.enhanced, ran: ranProjects(this.run.buf.fullText()) });
      this.report(name, r);
      return r;
    } catch (e) {
      return this.reloadFail(name, String(e));
    } finally {
      this.jBusy = false;
    }
  }

  private reloadFail(name: string, message: string): HotswapResult {
    const r: HotswapResult = { ok: false, stage: "resolve", message, redefined: [], skipped: [], warnings: [], output: "", errorCode: null, errorName: null, elapsedMs: 0, compiled: 0, javac: "", release: 0, sourceSet: "", dumped: false };
    this.report(name, r);
    return r;
  }

  private report(name: string, r: HotswapResult) {
    this.lastResult = r;
    this.results.push(r);
    if (r.output) {
      this.printLine("err", r.output);
      // the same errors, clickable, in the Run console of the Gradle run
      this.run.buf.breakLine();
      this.run.buf.push("err", `[Ace hot swap] ${name}\n${r.output}\n`);
      scheduleRender(this.run);
    }
    for (const w of r.warnings) this.printLine("err", `Warning: ${w}`);
    const took = r.elapsedMs ? ` (${(r.elapsedMs / 1000).toFixed(1)} s)` : "";
    if (r.ok) {
      this.printLine("sys", `${r.message}${took}${r.redefined.length ? ": " + r.redefined.join(", ") : ""}`);
      showBalloon({ kind: r.warnings.length && !r.redefined.length ? "warn" : "info", title: r.message, text: r.warnings[0] ?? (r.redefined.length ? `${name}${took}` : undefined) });
    } else {
      this.printLine("err", `${r.message}${took}`);
      showBalloon({ kind: "error", title: r.stage === "compile" ? `Cannot reload ${name}` : r.stage === "redefine" ? `Reload of ${name} failed` : "Cannot reload", text: r.message });
    }
  }

  private async onRunFinished() {
    if (this.ended) return;
    this.printLine("sys", "The Gradle run finished.");
    void javaApi.detach(this.jdwpId, true).catch(() => {}); // leftover game JVM of this run (never a daemon)
    this.end(this.run.exit?.display ?? null);
  }

  /** Stop = stop the Gradle run (client, SIGINT first) and the game JVM; every GradleDaemon survives. */
  async stop() {
    if (this.ended || this.jStop) return;
    this.jStop = true;
    this.printLine("sys", "Stopping…");
    const run = this.run;
    if (run.status !== "finished" && run.token === this.runToken) {
      stopSession(run);
      await Promise.race([run.finished, sleep(1500)]);
    }
    await javaApi.detach(this.jdwpId, true).catch(() => {});
    if (run.status !== "finished" && run.token === this.runToken) await Promise.race([run.finished, sleep(4000)]);
    this.end(run.exit?.display ?? null);
  }

  private end(code: number | null) {
    if (this.ended) return;
    this.ended = true;
    clearTimeout(this.bpTimer);
    execStore.set({ point: null });
    this.unl.splice(0).forEach((u) => u());
    void javaApi.cleanup(this.java.port).catch(() => {});
    void javaApi.forget(this.jdwpId).catch(() => {});
    this.printLine("sys", "Debug session finished");
    this.set({ status: "ended", exitCode: code, stopText: null });
  }
}

/** The launcher the Run infrastructure calls for a Debug run of a Gradle configuration. */
export async function launchJavaDebug(target: JavaDebugTarget, run: Session, cfg: RunConfig): Promise<void> {
  // a previous session of the same Gradle tab (Rerun) is replaced
  const old = debugStore.get().sessions.find((s) => s instanceof JavaDebugSession && s.run === run);
  const s = new JavaDebugSession(target, run, cfg);
  debugStore.set((st) => {
    const i = old ? st.sessions.indexOf(old) : -1;
    return { sessions: i >= 0 ? st.sessions.map((x, j) => (j === i ? s : x)) : [...st.sessions, s], activeId: s.id };
  });
  showToolWindow("debug");
  await s.start();
}

export const javaSessions = (): JavaDebugSession[] => debugStore.get().sessions.filter((s): s is JavaDebugSession => s instanceof JavaDebugSession);
/** The live session a hot swap goes to: the active one if it is a Java session, else the newest live one. */
export function liveJavaSession(): JavaDebugSession | null {
  const live = javaSessions().filter((s) => s.live);
  const a = debugStore.get().activeId;
  return live.find((s) => s.id === a) ?? live[live.length - 1] ?? null;
}
