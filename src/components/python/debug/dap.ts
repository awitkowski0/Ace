/** Minimal DAP client over the Rust bridge (dapBridge): request/response matching by seq, events, reverse requests, adapter crash. */
import type { UnlistenFn } from "../../../lib/ipc";
import { dapBridge, newId, type RunSpec } from "../api";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type DapBody = Record<string, any>;

interface Pending { resolve(b: DapBody): void; reject(e: Error): void; command: string; timer?: ReturnType<typeof setTimeout> }

export class DapClient {
  readonly id = newId("dap");
  closed = false;
  /** adapter stderr lines (last 300) */
  readonly log: string[] = [];
  /** compact protocol trace (last 300 messages), for tests / diagnostics */
  readonly trace: string[] = [];
  onEvent: (event: string, body: DapBody) => void = () => {};
  onRequest: (command: string, args: DapBody) => Promise<DapBody | void> = async (c) => { throw new Error(`unsupported request ${c}`); };
  onClosed: () => void = () => {};
  private seq = 1;
  private pending = new Map<number, Pending>();
  private un: UnlistenFn[] = [];

  async start(spec: RunSpec) {
    // subscribe BEFORE starting: the id is ours, so nothing the adapter prints can be missed
    this.un.push(await dapBridge.onMsg(this.id, (j) => this.recv(j)));
    this.un.push(await dapBridge.onLog(this.id, (l) => { this.log.push(l); if (this.log.length > 300) this.log.shift(); }));
    this.un.push(await dapBridge.onClosed(this.id, () => this.handleClosed()));
    try {
      await dapBridge.start(this.id, spec);
    } catch (e) {
      this.closed = true;
      this.dispose();
      throw e;
    }
  }

  private note(s: string) {
    this.trace.push(s);
    if (this.trace.length > 300) this.trace.shift();
  }

  private recv(json: string) {
    let m: DapBody;
    try { m = JSON.parse(json); } catch { return; }
    if (m.type === "response") {
      this.note(`<- ${m.command}${m.success ? "" : " FAILED " + (m.message ?? "")}`);
      const p = this.pending.get(m.request_seq);
      if (!p) return;
      this.pending.delete(m.request_seq);
      if (p.timer) clearTimeout(p.timer);
      if (m.success) p.resolve(m.body ?? {});
      else p.reject(new Error(m.message ?? `${p.command} failed`));
    } else if (m.type === "event") {
      this.note(`<- event ${m.event}`);
      try { this.onEvent(m.event, m.body ?? {}); } catch (e) { console.error("dap event handler", m.event, e); }
    } else if (m.type === "request") {
      this.note(`<- request ${m.command}`);
      Promise.resolve()
        .then(() => this.onRequest(m.command, m.arguments ?? {}))
        .then((body) => this.sendRaw({ type: "response", request_seq: m.seq, command: m.command, success: true, body: body ?? {} }))
        .catch((e) => this.sendRaw({ type: "response", request_seq: m.seq, command: m.command, success: false, message: String(e?.message ?? e) }));
    }
  }

  private sendRaw(msg: DapBody) {
    if (this.closed) return Promise.resolve();
    return dapBridge.send(this.id, JSON.stringify({ seq: this.seq++, ...msg })).catch(() => {});
  }

  /** Sends a request; rejects with the adapter's message on failure, on adapter exit, or after `timeoutMs` (0 = never). */
  request<T = DapBody>(command: string, args: DapBody = {}, timeoutMs = 30000): Promise<T> {
    if (this.closed) return Promise.reject(new Error("Debug adapter is not running"));
    const seq = this.seq++;
    this.note(`-> ${command}`);
    return new Promise<T>((resolve, reject) => {
      const p: Pending = { resolve: resolve as (b: DapBody) => void, reject, command };
      if (timeoutMs > 0) p.timer = setTimeout(() => { this.pending.delete(seq); reject(new Error(`${command} timed out`)); }, timeoutMs);
      this.pending.set(seq, p);
      dapBridge.send(this.id, JSON.stringify({ seq, type: "request", command, arguments: args })).catch((e) => {
        this.pending.delete(seq);
        if (p.timer) clearTimeout(p.timer);
        reject(new Error(String(e)));
      });
    });
  }

  private handleClosed() {
    if (this.closed && !this.un.length) return;
    this.closed = true;
    for (const [, p] of this.pending) { if (p.timer) clearTimeout(p.timer); p.reject(new Error("Debug adapter exited")); }
    this.pending.clear();
    this.dispose();
    try { this.onClosed(); } catch (e) { console.error(e); }
  }

  private dispose() { this.un.splice(0).forEach((u) => u()); }

  /** Kills the adapter process (Rust) and drops listeners. */
  stop() {
    const was = this.closed;
    this.closed = true;
    void dapBridge.stop(this.id).catch(() => {});
    for (const [, p] of this.pending) { if (p.timer) clearTimeout(p.timer); p.reject(new Error("Debug adapter stopped")); }
    this.pending.clear();
    if (!was) setTimeout(() => this.dispose(), 300);
    else this.dispose();
  }
}
