/** Minimal JSON-RPC LSP client over the Rust bridge. No monaco imports. */
import { invoke, listen, type UnlistenFn } from "../../lib/ipc";

export interface Pos { line: number; character: number }
export interface Rng { start: Pos; end: Pos }
export interface LspLocation { uri: string; range: Rng }
export type Json = any; // eslint-disable-line @typescript-eslint/no-explicit-any

type Handler = (params: Json) => unknown | Promise<unknown>;

export class LspClient {
  caps: Json = {};
  private seq = 1;
  private pending = new Map<number, { res: (v: Json) => void; rej: (e: Error) => void }>();
  private notify = new Map<string, (p: Json) => void>();
  private reqHandlers = new Map<string, Handler>();
  private un: UnlistenFn[] = [];
  closed = false;
  onClose?: () => void;

  constructor(public sessionId: string) {}

  async attach() {
    this.un.push(await listen<string>(`lsp://msg/${this.sessionId}`, (e) => this.onMsg(e.payload)));
    this.un.push(await listen(`lsp://closed/${this.sessionId}`, () => this.dispose(true)));
  }

  onNotification(method: string, h: (p: Json) => void) { this.notify.set(method, h); }
  onRequest(method: string, h: Handler) { this.reqHandlers.set(method, h); }

  private send(o: object) {
    if (this.closed) return Promise.resolve();
    return invoke<void>("lsp_send", { sessionId: this.sessionId, json: JSON.stringify(o) }).catch(() => {});
  }
  request<T = Json>(method: string, params: Json, timeoutMs = 30000): Promise<T> {
    if (this.closed) return Promise.reject(new Error("closed"));
    const id = this.seq++;
    return new Promise<T>((res, rej) => {
      const t = setTimeout(() => { this.pending.delete(id); rej(new Error(`${method} timed out`)); }, timeoutMs);
      this.pending.set(id, { res: (v) => { clearTimeout(t); res(v); }, rej: (e) => { clearTimeout(t); rej(e); } });
      this.send({ jsonrpc: "2.0", id, method, params });
    });
  }
  notifyServer(method: string, params: Json) { this.send({ jsonrpc: "2.0", method, params }); }

  private async onMsg(text: string) {
    let m: Json;
    try { m = JSON.parse(text); } catch { return; }
    if (m.method !== undefined && m.id !== undefined) {
      const h = this.reqHandlers.get(m.method);
      try {
        const result = h ? await h(m.params) : null;
        this.send({ jsonrpc: "2.0", id: m.id, result: result ?? null });
      } catch (e) {
        this.send({ jsonrpc: "2.0", id: m.id, error: { code: -32603, message: String(e) } });
      }
    } else if (m.method !== undefined) {
      this.notify.get(m.method)?.(m.params);
    } else if (m.id !== undefined) {
      const p = this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id);
      if (m.error) p.rej(new Error(m.error.message ?? "LSP error"));
      else p.res(m.result);
    }
  }

  async initialize(rootPath: string, rootUri: string, name: string, initOptions?: Json) {
    const res = await this.request("initialize", {
      processId: null,
      clientInfo: { name: "Atelier" },
      rootUri,
      rootPath,
      workspaceFolders: [{ uri: rootUri, name }],
      initializationOptions: initOptions,
      capabilities: CLIENT_CAPS,
    }, 120000);
    this.caps = res?.capabilities ?? {};
    this.notifyServer("initialized", {});
  }

  async shutdown() {
    if (this.closed) return;
    try { await this.request("shutdown", null, 2000); this.notifyServer("exit", null); } catch { /* ignore */ }
    this.stop();
  }
  /** Hard stop: kill the session. */
  stop() {
    invoke("lsp_stop", { sessionId: this.sessionId }).catch(() => {});
    this.dispose(false);
  }
  private dispose(fromServer: boolean) {
    if (this.closed) return;
    this.closed = true;
    this.un.forEach((u) => u());
    this.pending.forEach((p) => p.rej(new Error("closed")));
    this.pending.clear();
    if (fromServer) this.onClose?.();
  }
}

const MD = ["markdown", "plaintext"];
const CLIENT_CAPS = {
  general: { positionEncodings: ["utf-16"] },
  workspace: { applyEdit: true, workspaceEdit: { documentChanges: true }, configuration: true, workspaceFolders: true, didChangeConfiguration: {} },
  window: { workDoneProgress: true },
  textDocument: {
    synchronization: { didSave: true, dynamicRegistration: false },
    publishDiagnostics: { relatedInformation: false, tagSupport: { valueSet: [1, 2] } },
    hover: { contentFormat: MD },
    completion: {
      contextSupport: true,
      completionItem: {
        snippetSupport: true, documentationFormat: MD, insertReplaceSupport: true, deprecatedSupport: true,
        resolveSupport: { properties: ["documentation", "detail", "additionalTextEdits"] },
      },
    },
    signatureHelp: { signatureInformation: { documentationFormat: MD, parameterInformation: { labelOffsetSupport: true }, activeParameterSupport: true } },
    definition: { linkSupport: true },
    declaration: { linkSupport: true },
    implementation: { linkSupport: true },
    references: {},
    documentSymbol: { hierarchicalDocumentSymbolSupport: true },
    formatting: {},
    rangeFormatting: {},
    rename: { prepareSupport: true },
    codeAction: {
      codeActionLiteralSupport: { codeActionKind: { valueSet: ["quickfix", "refactor", "refactor.extract", "refactor.inline", "refactor.rewrite", "source", "source.organizeImports"] } },
      resolveSupport: { properties: ["edit"] },
    },
  },
};
