/**
 * A DAP-shaped client for a Godot game, so the existing Debug window / breakpoint gutter / stepping code is reused unchanged.
 * It does NOT talk to Godot's editor DAP server: Ace is the debug server of Godot's remote debugger (the protocol the editor itself
 * uses with a running game). `DebugSession` sends DAP requests, this translates them to remote-debugger messages:
 *
 *   setBreakpoints      -> `--breakpoints res://f.gd:12,...` on the command line, `breakpoint [res, line, set]` afterwards
 *   configurationDone   -> start listening, ask the session to launch Godot (reverse request `runInTerminal`) with `--remote-debug`
 *   debug_enter         -> `get_stack_dump` -> `stopped` event
 *   scopes / variables  -> `get_stack_frame_vars [frame]` (locals, members, globals), objects expand through `scene:inspect_objects`
 *   next/stepIn/stepOut -> `next` / `step` / `out`;  continue -> `continue`;  pause -> `break`
 *   evaluate            -> `evaluate [expr, frame]` -> `evaluation_return`
 */
import { newId } from "../python/api";
import type { DapBody, DapLike } from "../python/debug/dap";
import type { GodotDebugTarget } from "../run/hooks";
import { GameLink } from "./link";
import { resToPath } from "./output";
import { describe, inspectProps } from "./vars";

type Json = unknown;
interface BpReq { line: number; condition?: string }
interface Frame { file: string; line: number; func: string }
type Entry = { kind: "kids"; kids: { name: string; v: Json }[] } | { kind: "items"; items: DapBody[] } | { kind: "obj"; id: string };

const MAX_KIDS = 1000;

export class GodotDapClient implements DapLike {
  readonly id = newId("gdap");
  closed = false;
  readonly log: string[] = [];
  readonly trace: string[] = [];
  onEvent: (event: string, body: DapBody) => void = () => {};
  onRequest: (command: string, args: DapBody) => Promise<DapBody | void> = async () => {};
  onClosed: () => void = () => {};

  private link = new GameLink();
  private bps = new Map<string, BpReq[]>(); // absolute path -> breakpoints
  private sent = new Map<string, Set<number>>(); // res path -> lines already known to the game
  private launched: { resolve(): void; reject(e: Error): void } | null = null;
  private frames: Frame[] = [];
  private stepping = false;
  private pausing = false;
  private thread = 1;
  private reason = "";
  private nextRef = 1;
  private refs = new Map<number, Entry>();
  private lastError = "";
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private t: GodotDebugTarget) {
    this.link.onMessage = (m) => this.onGame(m.cmd, m.data, m.thread);
    this.link.onClose = () => this.gameGone();
  }

  /** The link to the running game (reload scripts etc.). */
  get gameLink() { return this.link; }

  async start() { /* nothing runs before configurationDone */ }

  private note(s: string) { this.trace.push(s); if (this.trace.length > 300) this.trace.shift(); }

  private resOf(abs: string): string | null {
    const root = this.t.projectDir.replace(/\/$/, "") + "/";
    return abs.startsWith(root) ? "res://" + abs.slice(root.length) : null;
  }
  private absOf(res: string): string | null {
    return res.startsWith("res://") ? resToPath(res, this.t.projectDir) : null;
  }

  request<T = DapBody>(command: string, args: DapBody = {}, _timeoutMs?: number): Promise<T> {
    if (this.closed) return Promise.reject(new Error("The debug connection is closed"));
    this.note(`-> ${command}`);
    // requests are handled one after another (the game answers one question at a time)
    const run = () => this.handle(command, args) as Promise<T>;
    const p = command === "continue" || command === "next" || command === "stepIn" || command === "stepOut" || command === "pause" || command === "disconnect" || command === "setBreakpoints" || command === "launch" || command === "initialize" || command === "setExceptionBreakpoints" || command === "configurationDone"
      ? run()
      : (this.chain = this.chain.then(run, run)) as Promise<T>;
    return p;
  }

  private async handle(command: string, a: DapBody): Promise<DapBody> {
    switch (command) {
      case "initialize":
        return { supportsConfigurationDoneRequest: true, supportsEvaluateForHovers: true, supportsSetVariable: false, supportsStepInTargetsRequest: false };
      case "launch":
        setTimeout(() => this.onEvent("initialized", {}), 0);
        return new Promise<DapBody>((resolve, reject) => { this.launched = { resolve: () => resolve({}), reject }; });
      case "setBreakpoints": return this.setBreakpoints(a);
      case "setExceptionBreakpoints": return {};
      case "configurationDone": await this.launchGame(); return {};
      case "threads": return { threads: [{ id: this.thread, name: "main" }] };
      case "stackTrace": return this.stackTrace();
      case "scopes": return this.scopes(a.frameId ?? 0);
      case "variables": return this.variables(a.variablesReference);
      case "evaluate": return this.evaluate(String(a.expression ?? ""), a.frameId ?? 0);
      case "continue": this.stepping = false; await this.link.send("continue", [], this.thread); return { allThreadsContinued: true };
      case "next": this.stepping = true; await this.link.send("next", [], this.thread); return {};
      case "stepIn": this.stepping = true; await this.link.send("step", [], this.thread); return {};
      case "stepOut": this.stepping = true; await this.link.send("out", [], this.thread); return {};
      case "pause": this.pausing = true; await this.link.send("break", [], this.thread); return {};
      case "exceptionInfo": return { exceptionId: "Script error", description: this.reason, breakMode: "always", details: { message: this.reason } };
      case "disconnect": this.shutdown(); return {};
      case "setVariable": throw new Error("Changing variables is not supported by Godot's remote debugger");
      default: throw new Error(`${command} is not supported for GDScript`);
    }
  }

  // ------------------------------------------------------------------ breakpoints
  private async setBreakpoints(a: DapBody): Promise<DapBody> {
    const path = String(a.source?.path ?? "");
    const reqs = ((a.breakpoints as DapBody[]) ?? []).map((b): BpReq => ({ line: b.line, condition: b.condition ? String(b.condition) : undefined }));
    const res = this.resOf(path);
    if (reqs.length) this.bps.set(path, reqs); else this.bps.delete(path);
    const out = reqs.map((r) => {
      const ok = !!res;
      const unsupported = (a.breakpoints as DapBody[]).find((b) => b.line === r.line && (b.logMessage || b.hitCondition));
      return { verified: ok && !unsupported, line: r.line, message: !ok ? "Not inside the Godot project" : unsupported ? "Log messages and pass counts are not supported by Godot's debugger" : undefined };
    });
    // before the game runs, breakpoints go on the command line; afterwards as messages
    if (res && this.link.connected) {
      const had = this.sent.get(res) ?? new Set<number>();
      const want = new Set(reqs.map((r) => r.line));
      for (const l of had) if (!want.has(l)) await this.link.send("breakpoint", [res, l, false], this.thread);
      for (const l of want) if (!had.has(l)) await this.link.send("breakpoint", [res, l, true], this.thread);
      this.sent.set(res, want);
    }
    return { breakpoints: out };
  }

  // ------------------------------------------------------------------ launch
  private async launchGame() {
    try {
      const port = await this.link.open();
      const list: string[] = [];
      for (const [p, reqs] of this.bps) {
        const res = this.resOf(p);
        if (!res) continue;
        const lines = new Set<number>();
        for (const r of reqs) { list.push(`${res.replace(/ /g, "%20")}:${r.line}`); lines.add(r.line); }
        this.sent.set(res, lines);
      }
      const [bin, ...rest] = this.t.argv;
      const argv = [bin, "--remote-debug", `tcp://127.0.0.1:${port}`, ...(list.length ? ["--breakpoints", list.join(",")] : []), ...rest];
      await this.onRequest("runInTerminal", { args: argv, cwd: this.t.cwd, env: {} });
      this.launched?.resolve();
    } catch (e) {
      this.launched?.reject(e as Error);
      throw e;
    }
  }

  // ------------------------------------------------------------------ game messages
  private onGame(cmd: string, data: Json[], thread: number) {
    this.note(`<- ${cmd}`);
    switch (cmd) {
      case "debug_enter": void this.entered(data, thread).catch((e) => this.log.push(String(e))); break;
      case "error": this.lastError = String(data[8] || data[7] || ""); break;
      default: break; // output / set_pid / performance...: the process output is read from its pipes
    }
  }

  private async entered(data: Json[], thread: number) {
    this.thread = thread || 1;
    this.reason = String(data[1] ?? "");
    const isBreak = this.reason === "Breakpoint";
    this.link.send("get_stack_dump", [], this.thread);
    const dump = await this.link.expect("stack_dump");
    const frames: Frame[] = [];
    for (let i = 1; i + 2 < dump.length; i += 3) frames.push({ file: String(dump[i]), line: Number(dump[i + 1]), func: String(dump[i + 2]) });
    this.frames = frames;
    this.refs.clear();
    this.nextRef = 1;
    const top = frames[0];
    if (isBreak && !this.stepping && !this.pausing && top) {
      const abs = this.absOf(top.file);
      const bp = abs ? this.bps.get(abs)?.find((b) => b.line === top.line) : undefined;
      if (bp?.condition) {
        // conditional breakpoint: evaluate in the top frame, continue silently when false
        const r = await this.evalRaw(bp.condition, 0).catch(() => null);
        if (r && r.type !== 0 && (r.value === false || r.value === 0 || r.value === null)) { await this.link.send("continue", [], this.thread); return; }
      }
    }
    const reason = !isBreak ? "exception" : this.pausing ? "pause" : this.stepping ? "step" : "breakpoint";
    this.stepping = false;
    this.pausing = false;
    this.onEvent("stopped", { reason, threadId: this.thread, description: isBreak ? (reason === "step" ? "Step" : reason === "pause" ? "Paused" : "Breakpoint") : this.reason, text: isBreak ? undefined : this.reason, allThreadsStopped: true });
  }

  private gameGone() {
    this.onEvent("terminated", {});
  }

  // ------------------------------------------------------------------ stack + variables
  private stackTrace(): DapBody {
    return {
      stackFrames: this.frames.map((f, i) => ({ id: i, name: f.func, line: f.line, column: 1, source: this.absOf(f.file) ? { path: this.absOf(f.file), name: f.file.split("/").pop() } : undefined })),
      totalFrames: this.frames.length,
    };
  }

  private alloc(e: Entry): number {
    const r = this.nextRef++;
    this.refs.set(r, e);
    return r;
  }

  private item(name: string, v: Json, typeId?: number): DapBody {
    const d = describe(v, typeId);
    const ref = d.kids?.length ? this.alloc({ kind: "kids", kids: d.kids.slice(0, MAX_KIDS) }) : d.objId ? this.alloc({ kind: "obj", id: d.objId }) : 0;
    return { name, value: d.value, type: d.type, variablesReference: ref };
  }

  private async scopes(frame: number): Promise<DapBody> {
    this.link.send("get_stack_frame_vars", [frame], this.thread);
    const head = await this.link.expect("stack_frame_vars");
    const count = Number(head[0] ?? 0);
    const groups: DapBody[][] = [[], [], []];
    for (let i = 0; i < count; i++) {
      const d = await this.link.expect("stack_frame_var");
      // [name, scope(0 local, 1 member, 2 global), type id, value, class name]
      const [name, scope, type, value] = d as [string, number, number, Json];
      const it = this.item(String(name), value, Number(type));
      if (type === 24 && d[4]) it.type = String(d[4]);
      groups[Math.min(2, Math.max(0, Number(scope)))].push(it);
    }
    const names = ["Locals", "Members", "Globals"];
    return { scopes: groups.map((items, i) => ({ name: names[i], variablesReference: this.alloc({ kind: "items", items }), expensive: false })) };
  }

  private async variables(ref: number): Promise<DapBody> {
    const e = this.refs.get(ref);
    if (!e) return { variables: [] };
    if (e.kind === "items") return { variables: e.items };
    if (e.kind === "kids") return { variables: e.kids.map((k) => this.item(k.name, k.v)) };
    this.link.send("scene:inspect_objects", [[Number(e.id)], false], this.thread);
    const r = await this.link.expect("scene:inspect_objects");
    const first = Array.isArray(r[0]) ? (r[0] as Json[]) : r;
    return { variables: inspectProps(first).map((p) => this.item(p.name, p.v, p.type)) };
  }

  // ------------------------------------------------------------------ evaluate
  private async evalRaw(expr: string, frame: number): Promise<{ type: number; value: Json }> {
    this.lastError = "";
    this.link.send("evaluate", [expr, frame], this.thread);
    const d = await this.link.expect("evaluation_return", 8000);
    // [name, scope, type id, value, class]
    const type = Number(d[2] ?? 0);
    if (type === 0 && (d[3] === null || d[3] === undefined)) await new Promise((r) => setTimeout(r, 60)); // the engine's own error message follows
    return { type, value: d[3] };
  }

  private async evaluate(expr: string, frame: number): Promise<DapBody> {
    if (!expr.trim()) throw new Error("Empty expression");
    const r = await this.evalRaw(expr, frame);
    if (r.type === 0 && (r.value === null || r.value === undefined) && !/^\s*null\s*$/.test(expr)) throw new Error(this.lastError || `Cannot evaluate '${expr}'`);
    const it = this.item("", r.value, r.type);
    return { result: it.value, type: it.type, variablesReference: it.variablesReference };
  }

  // ------------------------------------------------------------------ teardown
  private shutdown() {
    this.link.close();
  }

  stop() {
    if (this.closed) return;
    this.closed = true;
    this.shutdown();
    this.launched?.reject(new Error("stopped"));
  }
}
