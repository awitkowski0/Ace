/** One debug session = one debugpy adapter + one debuggee (run through runner.start so it gets stdin and an output stream). */
import { createStore, type Store } from "../../../lib/store";
import { openFile } from "../../../editor/store";
import { runner, type RunSpec } from "../api";
import { envFor } from "../interpreter";
import type { DebugTarget } from "../../run/hooks";
import type { AdapterChoice } from "./adapter";
import { bpStore, watchStore } from "./bps";
import { DapClient, type DapBody, type DapLike } from "./dap";
import { dapBreakpoints, dapExceptionFilters, exitText, PAGE, type LocalVal } from "./pure";

export type Status = "starting" | "running" | "paused" | "ended";
export interface Frame { id: number; name: string; line: number; col: number; path: string | null; hint?: string }
export interface Thread { id: number; name: string }
export interface Scope { name: string; ref: number; expensive: boolean }
export interface Var { name: string; value: string; type?: string; ref: number; evalName?: string; indexed?: number; named?: number }
export type VarSlot = Var[] | "loading" | { error: string };
export interface EvalResult { value?: string; type?: string; ref?: number; error?: string }
export interface OutChunk { s: "out" | "err" | "sys"; d: string }

export interface SessionState {
  id: string;
  title: string;
  status: Status;
  /** exit code of the debuggee once known */
  exitCode: number | null;
  stopReason: string | null;
  stopText: string | null;
  exception: { type: string; message: string } | null;
  threads: Thread[];
  threadId: number | null;
  frames: Frame[];
  frameIdx: number;
  scopes: Scope[];
  /** variables by `ref` or `ref:filter:start:count`; cleared on resume (references die with the stop) */
  vars: Record<string, VarSlot>;
  watchResults: Record<string, EvalResult>;
  bpStatus: Record<string, { verified: boolean; message?: string }>;
  outRev: number;
  /** a one-shot stop request (Run to Cursor) is pending */
  runningTo: boolean;
}

export interface ExecPoint { sessionId: string; host: string; path: string; line: number; col: number; top: boolean; locals: LocalVal[] }
/** What the editor decorations draw (execution line, inline values, hover). null = nothing. */
export const execStore = createStore<{ point: ExecPoint | null }>({ point: null });

export const debugStore = createStore<{ sessions: DebugSession[]; activeId: string | null }>({ sessions: [], activeId: null });
export const activeSession = (): DebugSession | null => {
  const { sessions, activeId } = debugStore.get();
  return sessions.find((s) => s.id === activeId) ?? sessions[sessions.length - 1] ?? null;
};
export const liveSessions = () => debugStore.get().sessions.filter((s) => s.status !== "ended");
export const pausedSession = (): DebugSession | null => {
  const a = activeSession();
  return a && a.status === "paused" ? a : debugStore.get().sessions.find((s) => s.status === "paused") ?? null;
};

const MAX_OUT = 1_500_000;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
let sessionSeq = 1;

const errText = (e: unknown) => {
  const m = String((e as Error)?.message ?? e).trim();
  const lines = m.split("\n").filter(Boolean);
  return lines[lines.length - 1] ?? m;
};

export class DebugSession {
  readonly id = `dbg${sessionSeq++}`;
  readonly store: Store<SessionState>;
  client!: DapLike;
  caps: DapBody = {};
  /** output chunks for the Console tab (state.outRev changes when it grows) */
  readonly out: OutChunk[] = [];
  private outSize = 0;
  private debuggee: { id: string; dispose(): void } | null = null;
  private debuggeeExited = false;
  private exitPrinted = false;
  private terminatedSeen = false;
  private finished = false;
  private stopping = false;
  private configured = false;
  protected stopGen = 0;
  private lastSent = new Map<string, string>();
  private lastExc = "";
  private syncing: Promise<void> = Promise.resolve();
  private temp: { path: string; line: number; force: boolean } | null = null;
  private unsub: Array<() => void> = [];
  private finishTimer: ReturnType<typeof setTimeout> | undefined;
  private waiters = new Set<() => void>();

  constructor(readonly target: DebugTarget, readonly adapter: AdapterChoice) {
    this.store = createStore<SessionState>({
      id: this.id, title: target.title, status: "starting", exitCode: null, stopReason: null, stopText: null, exception: null,
      threads: [], threadId: null, frames: [], frameIdx: 0, scopes: [], vars: {}, watchResults: {}, bpStatus: {}, outRev: 0, runningTo: false,
    });
  }

  /** Sessions of other languages (Gradle/JDWP: gradle/java) plug in here: Rerun and extra buttons in the Debug window's toolbar */
  customRerun?: () => Promise<unknown>;
  sideExtras?: import("react").ComponentType<{ session: DebugSession }>;

  get state() { return this.store.get(); }
  get status() { return this.store.get().status; }
  get live() { return this.status !== "ended"; }
  get frame(): Frame | null { const s = this.state; return s.frames[s.frameIdx] ?? null; }
  protected set(p: Partial<SessionState>) { this.store.set(p); this.waiters.forEach((w) => w()); }

  /** resolves once `pred(state)` holds (or after `ms`, resolving false) */
  waitFor(pred: (s: SessionState) => boolean, ms = 15000): Promise<boolean> {
    if (pred(this.state)) return Promise.resolve(true);
    return new Promise((resolve) => {
      const done = (v: boolean) => { clearTimeout(t); this.waiters.delete(check); resolve(v); };
      const check = () => { if (pred(this.state)) done(true); };
      const t = setTimeout(() => done(false), ms);
      this.waiters.add(check);
    });
  }

  // ------------------------------------------------------------------ output
  print(s: OutChunk["s"], d: string) {
    if (!d) return;
    const last = this.out[this.out.length - 1];
    if (last && last.s === s) last.d += d;
    else this.out.push({ s, d });
    this.outSize += d.length;
    while (this.outSize > MAX_OUT && this.out.length > 1) this.outSize -= this.out.shift()!.d.length;
    this.set({ outRev: this.state.outRev + 1 });
  }
  outputText() { return this.out.map((c) => c.d).join(""); }
  protected printLine(s: OutChunk["s"], d: string) {
    const last = this.out[this.out.length - 1];
    this.print(s, (last && !last.d.endsWith("\n") ? "\n" : "") + d + "\n");
  }

  // ------------------------------------------------------------------ lifecycle
  async start() {
    const t = this.target;
    this.client = t.kind === "godot" ? new (await import("../../godot/dapShim")).GodotDapClient(t) : new DapClient();
    this.client.onEvent = (e, b) => this.onEvent(e, b);
    this.client.onRequest = (c, a) => this.onReverse(c, a);
    this.client.onClosed = () => this.onAdapterClosed();
    this.unsub.push(bpStore.subscribe(() => this.scheduleSync()));
    try {
      if (t.kind === "godot") await this.client.start();
      else {
        const e = envFor(this.adapter.interp);
        await this.client.start({ host: t.host, cwd: "/", argv: [this.adapter.python, "-m", "debugpy.adapter"], env: { PYTHONUNBUFFERED: "1" }, pathPrepend: e.pathPrepend });
      }
      this.caps = await this.client.request("initialize", {
        clientID: "ace", clientName: "Ace", adapterID: "python", locale: "en", linesStartAt1: true, columnsStartAt1: true, pathFormat: "path",
        supportsVariableType: true, supportsVariablePaging: true, supportsRunInTerminalRequest: true, supportsMemoryReferences: false,
        supportsProgressReporting: false, supportsInvalidatedEvent: false,
      });
      const launch: DapBody = t.kind === "godot" ? { type: "godot", request: "launch", name: t.title, cwd: t.cwd } : {
        type: "python", request: "launch", name: t.title, cwd: t.cwd, args: t.args, env: t.env, python: [t.python],
        console: "integratedTerminal", justMyCode: true, stopOnEntry: false, showReturnValue: true, redirectOutput: false, subProcess: true,
        ...(t.program ? { program: t.program } : { module: t.module }),
        ...(t.extra ?? {}),
      };
      // the launch response only arrives after configurationDone, so it must not be awaited here
      this.client.request("launch", launch, 0).catch((err) => this.fail(`Failed to launch: ${errText(err)}`));
    } catch (err) {
      this.fail(`Failed to start the debug adapter: ${errText(err)}${this.client.log.length ? "\n" + this.client.log.slice(-6).join("\n") : ""}`);
    }
  }

  private fail(msg: string) {
    this.printLine("err", msg);
    void this.teardown();
  }

  /** Stop = kill the debuggee and the adapter. Idempotent. */
  async stop() {
    if (this.finished || this.stopping) return;
    this.stopping = true;
    this.set({ runningTo: false });
    await this.teardown();
  }

  private async teardown() {
    if (this.finished) return;
    this.stopping = true;
    if (this.debuggee && !this.debuggeeExited) void runner.stop(this.debuggee.id).catch(() => {});
    if (this.client && !this.client.closed) {
      await Promise.race([this.client.request("disconnect", { terminateDebuggee: true }, 1500).catch(() => {}), sleep(900)]);
    }
    if (this.debuggee && !this.debuggeeExited) {
      // give the SIGTERM/SIGKILL (Rust, ~400 ms) time to land so the exit message is printed before the tab says "ended"
      for (let i = 0; i < 20 && !this.debuggeeExited; i++) await sleep(50);
    }
    this.finish();
  }

  private finish() {
    if (this.finished) return;
    this.finished = true;
    clearTimeout(this.finishTimer);
    this.unsub.splice(0).forEach((u) => u());
    this.stopGen++;
    this.client?.stop();
    this.debuggee?.dispose();
    if (!this.exitPrinted) { this.exitPrinted = true; this.printLine("sys", "Debug session finished"); }
    this.set({ status: "ended", frames: [], scopes: [], vars: {}, frameIdx: 0, threadId: null, stopReason: null, stopText: null, exception: null, runningTo: false });
    this.publishExec();
  }

  private onAdapterClosed() {
    if (this.finished) return;
    if (!this.stopping && !this.terminatedSeen) this.printLine("err", `Debug adapter exited unexpectedly${this.client.log.length ? ":\n" + this.client.log.slice(-6).join("\n") : ""}`);
    if (this.debuggee && !this.debuggeeExited) void runner.stop(this.debuggee.id).catch(() => {});
    this.stopping = true;
    void this.teardown();
  }

  private onDebuggeeExit(r: { code: number | null; signal: number | null }) {
    this.debuggeeExited = true;
    if (!this.exitPrinted) {
      this.exitPrinted = true;
      this.printLine("sys", `\n${exitText(r.code, r.signal)}`);
    }
    this.set({ exitCode: r.code ?? (r.signal ? -r.signal : 0) });
    // normally `terminated` is already here or follows within ms; if the adapter is gone/stuck, end anyway
    clearTimeout(this.finishTimer);
    this.finishTimer = setTimeout(() => void this.teardown(), this.terminatedSeen ? 50 : 2500);
  }

  // ------------------------------------------------------------------ DAP events + reverse requests
  private async onReverse(command: string, args: DapBody): Promise<DapBody | void> {
    if (command !== "runInTerminal") throw new Error(`unsupported request ${command}`);
    const t = this.target;
    const env: Record<string, string> = { ...t.env };
    for (const [k, v] of Object.entries((args.env ?? {}) as Record<string, string | null>)) { if (v === null) delete env[k]; else env[k] = v; }
    // PyCharm puts the project (content) root on PYTHONPATH so `import app.x` works from scripts in sub-folders
    if (t.kind === "python") {
      const pp = (env.PYTHONPATH ?? "").split(":").filter(Boolean);
      if (!pp.includes(t.cwd)) env.PYTHONPATH = [t.cwd, ...pp].join(":");
    }
    const spec: RunSpec = { host: t.host, cwd: (args.cwd as string) || t.cwd, argv: args.args as string[], env, pathPrepend: t.pathPrepend };
    this.debuggee = await runner.start(spec, {
      kind: "debuggee", label: t.title,
      onOut: (segs) => segs.forEach((g) => this.print(g.s, g.d)),
      onExit: (r) => this.onDebuggeeExit(r),
    });
    return {};
  }

  private onEvent(ev: string, b: DapBody) {
    switch (ev) {
      case "initialized": void this.configure(); break;
      case "stopped": void this.onStopped(b); break;
      case "continued": if (this.status === "paused" && (b.allThreadsContinued ?? true)) this.markRunning(); break;
      case "output": {
        const cat = b.category as string | undefined;
        if (cat === "telemetry") break;
        this.print(cat === "stderr" ? "err" : cat === "console" || cat === "important" ? "sys" : "out", String(b.output ?? ""));
        break;
      }
      case "exited": if (typeof b.exitCode === "number" && this.state.exitCode == null) this.set({ exitCode: b.exitCode }); break;
      case "terminated":
        this.terminatedSeen = true;
        clearTimeout(this.finishTimer);
        // the debuggee's exit event (with the output still in flight) normally lands within a few ms
        this.finishTimer = setTimeout(() => void this.teardown(), this.debuggee && !this.debuggeeExited ? 1500 : 50);
        break;
      case "breakpoint": {
        const bp = b.breakpoint as DapBody | undefined;
        if (bp?.id != null) this.dapIds.set(bp.id, bp.verified);
        break;
      }
    }
  }
  private dapIds = new Map<number, boolean>();

  private async configure() {
    try {
      await this.sendBreakpoints(true);
      await this.sendExceptionFilters(true);
      if (this.caps.supportsConfigurationDoneRequest !== false) await this.client.request("configurationDone", {});
      this.configured = true;
      if (this.status === "starting") this.set({ status: "running" });
    } catch (e) {
      this.fail(`Debugger configuration failed: ${errText(e)}`);
    }
  }

  // ------------------------------------------------------------------ breakpoints
  private syncPending = false;
  /** Breakpoint edits go out in the same tick (coalesced), so "remove breakpoint, then Resume" never races the adapter. */
  private scheduleSync() {
    if (!this.configured || this.finished || this.syncPending) return;
    this.syncPending = true;
    queueMicrotask(() => { if (this.syncPending) { this.syncPending = false; this.runSync(); } });
  }
  private runSync() {
    void this.sendBreakpoints(false).catch(() => {});
    void this.sendExceptionFilters(false).catch(() => {});
  }
  /** Sends pending breakpoint changes now and waits until the adapter has them. */
  private async flushSync() {
    if (this.syncPending) { this.syncPending = false; this.runSync(); }
    await Promise.race([this.syncing, sleep(2000)]);
  }

  private desired(): Map<string, ReturnType<typeof dapBreakpoints>> {
    const { list, muted } = bpStore.get();
    const want = new Map<string, ReturnType<typeof dapBreakpoints>>();
    const t = this.temp;
    // .java breakpoints belong to the Gradle/JDWP sessions (gradle/java/session.ts), not to debugpy
    if (!(muted || t?.force)) for (const p of new Set(list.filter((b) => !b.path.endsWith(".java")).map((b) => b.path))) want.set(p, dapBreakpoints(list, p));
    if (t) want.set(t.path, [...(want.get(t.path) ?? []), { line: t.line }]);
    return want;
  }

  private sendBreakpoints(all: boolean): Promise<void> {
    const run = async () => {
      const want = this.desired();
      for (const p of this.lastSent.keys()) if (!want.has(p)) want.set(p, []);
      const ids = new Map(bpStore.get().list.map((b) => [b.path + ":" + b.line, b.id]));
      for (const [path, bps] of want) {
        const j = JSON.stringify(bps);
        if (!all && this.lastSent.get(path) === j) continue;
        if (all && !bps.length && !this.lastSent.has(path)) continue;
        this.lastSent.set(path, j);
        if (!bps.length) this.lastSent.delete(path);
        const r = await this.client.request<DapBody>("setBreakpoints", { source: { path }, breakpoints: bps, sourceModified: false }).catch(() => null);
        const st = { ...this.state.bpStatus };
        (r?.breakpoints as DapBody[] | undefined)?.forEach((rb, i) => {
          const id = ids.get(path + ":" + bps[i]?.line);
          if (id) st[id] = { verified: !!rb.verified, message: rb.message };
        });
        this.set({ bpStatus: st });
        debugStore.set({}); // gutter dots show verified / invalid state
      }
    };
    // serialise so two syncs never interleave their requests
    this.syncing = this.syncing.then(run, run);
    return this.syncing;
  }

  private sendExceptionFilters(force: boolean): Promise<void> {
    const run = async () => {
    const supported = (this.caps.exceptionBreakpointFilters as DapBody[] | undefined)?.map((f) => f.filter as string);
    const e = bpStore.get();
    const filters = e.muted ? [] : dapExceptionFilters(e.exceptions, supported);
    const j = JSON.stringify(filters);
    if (!force && j === this.lastExc) return;
    this.lastExc = j;
    await this.client.request("setExceptionBreakpoints", { filters }).catch(() => {});
    };
    this.syncing = this.syncing.then(run, run);
    return this.syncing;
  }

  // ------------------------------------------------------------------ stopped / running
  private markRunning() {
    this.stopGen++;
    execStore.set({ point: null });
    this.set({ status: "running", frames: [], scopes: [], vars: {}, frameIdx: 0, stopReason: null, stopText: null, exception: null });
  }

  private async onStopped(b: DapBody) {
    const gen = ++this.stopGen;
    const reason = String(b.reason ?? "");
    if (this.temp) {
      const wasForce = this.temp.force;
      this.temp = null;
      this.set({ runningTo: false });
      void this.sendBreakpoints(wasForce).catch(() => {});
    }
    try {
      let threadId: number | null = typeof b.threadId === "number" ? b.threadId : this.state.threadId;
      const th = await this.client.request<DapBody>("threads", {}).catch(() => ({ threads: [] }));
      const threads: Thread[] = ((th.threads as DapBody[]) ?? []).map((t) => ({ id: t.id, name: String(t.name) }));
      if (threadId == null) threadId = threads[0]?.id ?? null;
      if (gen !== this.stopGen) return;
      if (threadId == null) return;
      const st = await this.client.request<DapBody>("stackTrace", { threadId, startFrame: 0, levels: 200 });
      if (gen !== this.stopGen) return;
      const frames = this.mapFrames(st.stackFrames ?? []);
      let exception: SessionState["exception"] = null;
      if (reason === "exception") {
        const ei = await this.client.request<DapBody>("exceptionInfo", { threadId }).catch(() => null);
        if (ei) exception = { type: String(ei.exceptionId ?? ei.details?.typeName ?? "Exception"), message: String(ei.description ?? ei.details?.message ?? "") };
      }
      if (gen !== this.stopGen) return;
      this.set({ threads, threadId, frames, frameIdx: 0, vars: {}, scopes: [], stopReason: reason, stopText: (b.text ?? b.description ?? null) as string | null, exception, watchResults: {} });
      await this.loadFrameVars(gen);
      if (gen !== this.stopGen) return;
      this.set({ status: "paused" });
      this.publishExec();
      this.showFrame(this.frame, true);
      void this.refreshWatches(gen);
    } catch (e) {
      if (gen === this.stopGen) this.printLine("err", `Could not read the stop location: ${errText(e)}`);
    }
  }

  private mapFrames(raw: DapBody[]): Frame[] {
    return raw.map((f) => {
      const p = f.source?.path as string | undefined;
      return { id: f.id, name: String(f.name), line: f.line ?? 0, col: f.column ?? 1, path: p && p.startsWith("/") ? p : null, hint: f.presentationHint ?? f.source?.presentationHint };
    });
  }

  private async loadFrameVars(gen = this.stopGen) {
    const f = this.frame;
    if (!f) return;
    const r = await this.client.request<DapBody>("scopes", { frameId: f.id }).catch(() => ({ scopes: [] }));
    if (gen !== this.stopGen) return;
    const scopes: Scope[] = ((r.scopes as DapBody[]) ?? []).map((s) => ({ name: String(s.name), ref: s.variablesReference, expensive: !!s.expensive }));
    this.set({ scopes });
    if (scopes[0] && !scopes[0].expensive) await this.ensureVars(scopes[0].ref);
  }

  protected publishExec() {
    const s = this.state;
    const f = s.frames[s.frameIdx];
    if (s.status !== "paused" || !f?.path) { execStore.set({ point: null }); return; }
    const slot = s.scopes[0] ? s.vars[String(s.scopes[0].ref)] : undefined;
    const locals: LocalVal[] = Array.isArray(slot) ? slot.map((v) => ({ name: v.name, value: v.value, type: v.type })) : [];
    execStore.set({ point: { sessionId: this.id, host: this.target.host, path: f.path, line: f.line, col: f.col, top: s.frameIdx === 0, locals } });
  }

  /** Open the file at the frame's line (like IntelliJ), keeping focus where it was when it was in the Debug window. */
  showFrame(f: Frame | null, auto = false) {
    if (!f?.path) return;
    const was = document.activeElement as HTMLElement | null;
    const inDebug = !!was?.closest?.("[data-toolwindow=debug]");
    void openFile({ host: this.target.host, path: f.path }, { line: f.line, col: f.col }).then(() => {
      if (inDebug) {
        setTimeout(() => {
          // only undo the editor's focus grab; never steal focus from something the user opened meanwhile (a dialog, an input)
          const now = document.activeElement as HTMLElement | null;
          if (was && was.isConnected && (!now || now === document.body || now.closest(".monaco-editor"))) was.focus();
        }, 120);
      }
    });
  }

  // ------------------------------------------------------------------ frames / threads / variables
  async selectFrame(i: number, navigate = true) {
    if (this.status !== "paused" || !this.state.frames[i]) return;
    const gen = this.stopGen;
    this.set({ frameIdx: i, scopes: [] });
    await this.loadFrameVars(gen);
    if (gen !== this.stopGen) return;
    this.publishExec();
    if (navigate) this.showFrame(this.frame);
    void this.refreshWatches(gen);
  }

  async selectThread(id: number) {
    if (this.status !== "paused") return;
    const gen = this.stopGen;
    const st = await this.client.request<DapBody>("stackTrace", { threadId: id, startFrame: 0, levels: 200 }).catch(() => null);
    if (!st || gen !== this.stopGen) return;
    this.set({ threadId: id, frames: this.mapFrames(st.stackFrames ?? []), frameIdx: 0, scopes: [], vars: {} });
    await this.loadFrameVars(gen);
    if (gen !== this.stopGen) return;
    this.publishExec();
    this.showFrame(this.frame);
    void this.refreshWatches(gen);
  }

  static slotKey(ref: number, range?: { filter?: "indexed" | "named"; start?: number; count?: number }) {
    return range ? `${ref}:${range.filter ?? ""}:${range.start ?? 0}:${range.count ?? 0}` : String(ref);
  }

  /** Loads (once per stop) the children of a variablesReference, optionally a page or only named/indexed ones. */
  async ensureVars(ref: number, range?: { filter?: "indexed" | "named"; start?: number; count?: number }) {
    const key = DebugSession.slotKey(ref, range);
    if (this.state.vars[key]) return;
    const gen = this.stopGen;
    this.set({ vars: { ...this.state.vars, [key]: "loading" } });
    let slot: VarSlot;
    try {
      const r = await this.client.request<DapBody>("variables", { variablesReference: ref, ...(range?.filter ? { filter: range.filter } : {}), ...(range?.count ? { start: range.start ?? 0, count: range.count } : {}) });
      slot = ((r.variables as DapBody[]) ?? []).map((v) => ({
        name: String(v.name), value: String(v.value ?? ""), type: v.type, ref: v.variablesReference || 0, evalName: v.evaluateName, indexed: v.indexedVariables, named: v.namedVariables,
      }));
    } catch (e) {
      slot = { error: errText(e) };
    }
    if (gen !== this.stopGen) return;
    this.set({ vars: { ...this.state.vars, [key]: slot } });
    if (ref === this.state.scopes[0]?.ref && !range) this.publishExec();
  }

  /** Plain list of a variable's direct children (all pages of a small container; named ones of a big one). */
  async children(v: Var): Promise<Var[]> {
    if (!v.ref) return [];
    const big = (v.indexed ?? 0) > PAGE;
    const range = big ? { filter: "named" as const } : undefined;
    await this.ensureVars(v.ref, range);
    const slot = this.state.vars[DebugSession.slotKey(v.ref, range)];
    return Array.isArray(slot) ? slot : [];
  }

  async setVariable(parentRef: number, name: string, value: string): Promise<string | null> {
    if (this.status !== "paused") return "The process is running";
    try {
      await this.client.request("setVariable", { variablesReference: parentRef, name, value });
      this.set({ vars: {}, watchResults: {} });
      await this.loadFrameVars();
      this.publishExec();
      void this.refreshWatches();
      return null;
    } catch (e) { return errText(e); }
  }

  // ------------------------------------------------------------------ evaluate / watches
  async evaluate(expression: string, context: "watch" | "repl" | "hover" | "clipboard" = "watch"): Promise<EvalResult> {
    if (this.status !== "paused" || !this.frame) return { error: this.live ? "The process is running" : "The session has ended" };
    try {
      const r = await this.client.request<DapBody>("evaluate", { expression, frameId: this.frame.id, context }, 20000);
      return { value: String(r.result ?? ""), type: r.type, ref: r.variablesReference || 0 };
    } catch (e) { return { error: errText(e) }; }
  }

  async refreshWatches(gen = this.stopGen) {
    const exprs = watchStore.get().list;
    if (!exprs.length || this.status !== "paused") { if (gen === this.stopGen) this.set({ watchResults: {} }); return; }
    const results = await Promise.all(exprs.map(async (e) => [e, await this.evaluate(e, "watch")] as const));
    if (gen !== this.stopGen) return;
    this.set({ watchResults: Object.fromEntries(results) });
  }

  /** Console REPL line: evaluate in the selected frame and echo like a console. */
  async repl(expression: string) {
    this.printLine("sys", `>>> ${expression}`);
    const r = await this.evaluate(expression, "repl");
    if (r.error) this.printLine("err", r.error);
    else if (r.value) this.printLine("out", r.value);
    if (!r.error) void this.refreshAfterRepl();
  }
  private async refreshAfterRepl() {
    if (this.status !== "paused") return;
    this.set({ vars: {} });
    await this.loadFrameVars();
    this.publishExec();
    void this.refreshWatches();
  }

  async write(text: string) {
    if (!this.debuggee || this.debuggeeExited) return;
    this.print("sys", "");
    await runner.write(this.debuggee.id, text).catch(() => {});
  }

  // ------------------------------------------------------------------ execution control
  private tid(): number | null { return this.state.threadId ?? this.state.threads[0]?.id ?? null; }

  async resume() {
    if (this.status !== "paused") return;
    await this.flushSync();
    if (this.status !== "paused") return;
    const threadId = this.tid();
    this.markRunning();
    await this.client.request("continue", { threadId: threadId ?? 0 }).catch(() => {});
  }

  private async step(cmd: "next" | "stepIn" | "stepOut", extra: DapBody = {}) {
    if (this.status !== "paused") return;
    await this.flushSync();
    if (this.status !== "paused") return;
    const threadId = this.tid();
    if (threadId == null) return;
    this.markRunning();
    await this.client.request(cmd, { threadId, granularity: "statement", ...extra }).catch((e) => this.printLine("err", errText(e)));
  }
  stepOver() { return this.step("next"); }
  stepInto(targetId?: number) { return this.step("stepIn", targetId != null ? { targetId } : {}); }
  stepOut() { return this.step("stepOut"); }

  async stepInTargets(): Promise<{ id: number; label: string }[]> {
    const f = this.frame;
    if (!f || this.status !== "paused") return [];
    const r = await this.client.request<DapBody>("stepInTargets", { frameId: f.id }).catch(() => null);
    return ((r?.targets as DapBody[]) ?? []).map((t) => ({ id: t.id, label: String(t.label) }));
  }

  async pause() {
    if (this.status !== "running") return;
    let threadId = this.tid();
    if (threadId == null) {
      const th = await this.client.request<DapBody>("threads", {}).catch(() => null);
      threadId = (th?.threads as DapBody[] | undefined)?.[0]?.id ?? 1;
    }
    await this.client.request("pause", { threadId }).catch((e) => this.printLine("err", errText(e)));
  }

  /** Run to Cursor via a one-shot breakpoint (debugpy's `goto` moves the instruction pointer; it does not run). */
  async runToCursor(path: string, line: number, force = false) {
    if (this.status !== "paused") return;
    this.temp = { path, line, force };
    this.set({ runningTo: true });
    await this.sendBreakpoints(force).catch(() => {});
    await this.resume();
  }

  // ------------------------------------------------------------------ test/diagnostic summary
  summary() {
    const s = this.state;
    const slot = s.scopes[0] ? s.vars[String(s.scopes[0].ref)] : undefined;
    return {
      id: this.id, title: s.title, status: s.status, exitCode: s.exitCode, stopReason: s.stopReason, exception: s.exception,
      adapter: this.adapter.python, adapterOwn: this.adapter.own,
      thread: s.threadId, frameIdx: s.frameIdx,
      frames: s.frames.map((f) => ({ name: f.name, line: f.line, path: f.path })),
      scopes: s.scopes.map((x) => x.name),
      locals: Array.isArray(slot) ? slot.map((v) => ({ name: v.name, value: v.value, type: v.type, ref: v.ref })) : null,
      watches: s.watchResults,
      output: this.outputText(),
    };
  }
}
