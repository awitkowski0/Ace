/**
 * LSP manager: owns server sessions, document sync and Monaco providers. Lazy-loaded (imports monaco);
 * loaded by api.ts once an LSP-capable file is open.
 */
import { monaco } from "../monacoSetup";
import { invoke, dirname, fs, local } from "../../lib/ipc";
import { projectStore } from "../../lib/project";
import { editorStore } from "../store";
import { activeEditor } from "../editorRegistry";
import { promptDialog } from "../../components/shell/dialogs";
import { showToolWindow } from "../../lib/layout";
import { LspClient, type Json, type Pos, type Rng } from "./client";
import { LANGUAGE_ID_FOR, ROOT_MARKERS, SERVER_FOR_LANGUAGE, intentionProviderList, launchResolver, type Launch } from "./servers";
import { DIAG_OWNERS, diagStore, getSourceDiags, lspSettings, pathToUri, setServerStatus, setSourceDiags, uriToPath, usagesStore, type Diag } from "./state";
import { openAt } from "./navigate";
import { applyWorkspaceEdit } from "./edits";

type Model = monaco.editor.ITextModel;
const IDLE_MS = 10 * 60 * 1000;
const RETRY_MIN = 3000, RETRY_MAX = 60000;

interface Ctx {
  key: string;
  /** Rust SPEC id of the server actually running (python: basedpyright | pyright) */
  serverId: string;
  /** key of the status entry / widget (SERVER_FOR_LANGUAGE[language]) */
  statusId: string;
  lang: string;
  launch?: Launch;
  rootPath: string;
  client?: LspClient;
  starting?: boolean;
  models: Set<Model>;
  idle?: ReturnType<typeof setTimeout>;
  retry?: ReturnType<typeof setTimeout>;
  retryDelay: number;
  diagPaths: Set<string>;
  tokens: Map<string | number, string>;
}
interface Tracked { ctx: Ctx; sub: monaco.IDisposable; sent: boolean; path: string }

const ctxs = new Map<string, Ctx>();
const tracked = new Map<Model, Tracked>();
const rootCache = new Map<string, string>();
let detect: Promise<Record<string, boolean>> | undefined;

const detectServers = () =>
  (detect ??= invoke<{ id: string; available: boolean }[]>("lsp_detect").then(
    (l) => Object.fromEntries(l.map((s) => [s.id, s.available])),
    () => ({} as Record<string, boolean>),
  ));

// ---------- conversions ----------
const toPos = (p: monaco.IPosition): Pos => ({ line: p.lineNumber - 1, character: p.column - 1 });
const toRange = (r: Rng): monaco.IRange => ({
  startLineNumber: r.start.line + 1, startColumn: r.start.character + 1, endLineNumber: r.end.line + 1, endColumn: r.end.character + 1,
});
const fromRange = (r: monaco.IRange): Rng => ({
  start: { line: r.startLineNumber - 1, character: r.startColumn - 1 }, end: { line: r.endLineNumber - 1, character: r.endColumn - 1 },
});
const tdoc = (m: Model) => ({ uri: pathToUri(m.uri.path) });

/** Godot hovers arrive indented (leading \t), which markdown renders as a code block: dedent + trim. */
export function cleanHover(v: string): string {
  if (!/^[ \t]/.test(v)) return v;
  const lines = v.replace(/\r\n/g, "\n").split("\n");
  const ind = lines.filter((l) => l.trim()).map((l) => /^[ \t]*/.exec(l)![0].length);
  const cut = ind.length ? Math.min(...ind) : 0;
  return lines.map((l) => l.slice(Math.min(cut, /^[ \t]*/.exec(l)![0].length))).join("\n").replace(/^\s+/, "");
}
function md(c: Json): monaco.IMarkdownString[] {
  if (!c) return [];
  if (Array.isArray(c)) return c.flatMap(md);
  if (typeof c === "string") return c ? [{ value: cleanHover(c) }] : [];
  if (c.language) return [{ value: "```" + c.language + "\n" + c.value + "\n```" }];
  return c.value ? [{ value: cleanHover(c.value) }] : [];
}
const docToMonaco = (d: Json): string | monaco.IMarkdownString | undefined => {
  if (!d) return undefined;
  if (typeof d === "string") return d;
  return d.kind === "markdown" ? { value: d.value } : d.value;
};

// ---------- sessions ----------
async function resolveRoot(serverId: string, path: string): Promise<string> {
  const proj = projectStore.get().root!.path;
  const markers = ROOT_MARKERS[serverId] ?? [];
  let dir = dirname(path);
  const visited: string[] = [];
  while (dir.startsWith(proj)) {
    const ck = serverId + "|" + dir;
    const cached = rootCache.get(ck);
    if (cached) { visited.forEach((v) => rootCache.set(serverId + "|" + v, cached)); return cached; }
    visited.push(dir);
    for (const mk of markers) {
      const st = await fs.stat(local(`${dir}/${mk}`)).catch(() => null);
      if (st?.exists) { visited.forEach((v) => rootCache.set(serverId + "|" + v, dir)); return dir; }
    }
    if (dir === proj) break;
    dir = dirname(dir);
  }
  visited.forEach((v) => rootCache.set(serverId + "|" + v, proj));
  return proj;
}

async function track(model: Model) {
  if (tracked.has(model) || model.uri.scheme !== "file") return;
  const lang = model.getLanguageId();
  const serverId = SERVER_FOR_LANGUAGE[lang];
  const proj = projectStore.get().root;
  if (!serverId || !proj || proj.host !== "local") return; // remote roots: LSP disabled for v1
  if (!launchResolver(lang)) {
    const avail = await detectServers();
    if (avail[serverId] === false) { setServerStatus(serverId, { state: "unavailable" }); return; }
  }
  const rootPath = await resolveRoot(serverId, model.uri.path);
  if (tracked.has(model) || model.isDisposed()) return;
  const key = serverId + "|" + rootPath;
  let ctx = ctxs.get(key);
  if (!ctx) ctxs.set(key, (ctx = { key, serverId, statusId: serverId, lang, rootPath, models: new Set(), retryDelay: RETRY_MIN, diagPaths: new Set(), tokens: new Map() }));
  const t: Tracked = { ctx, sent: false, path: model.uri.path, sub: model.onDidChangeContent((e) => onChange(model, t, e)) };
  tracked.set(model, t);
  ctx.models.add(model);
  clearTimeout(ctx.idle);
  applyMarkers(model);
  if (ctx.client) sendOpen(ctx, model, t);
  else startServer(ctx);
}

function untrack(model: Model) {
  const t = tracked.get(model);
  if (!t) return;
  t.sub.dispose();
  tracked.delete(model);
  t.ctx.models.delete(model);
  if (getSourceDiags("lsp", t.path).length) setSourceDiags("lsp", { [t.path]: [] }); // closed file: the server stops reporting it
  if (t.sent && t.ctx.client) t.ctx.client.notifyServer("textDocument/didClose", { textDocument: { uri: pathToUri(t.path) } });
  if (t.ctx.models.size === 0) {
    clearTimeout(t.ctx.retry);
    clearTimeout(t.ctx.idle);
    t.ctx.idle = setTimeout(() => stopCtx(t.ctx), IDLE_MS);
  }
}

function stopCtx(ctx: Ctx) {
  clearTimeout(ctx.retry);
  const c = ctx.client;
  ctx.client = undefined;
  c?.shutdown();
  clearDiagnostics(ctx);
  ctxs.delete(ctx.key);
  setServerStatus(ctx.statusId, { state: "idle" });
}

/** Stop and start again every session of `lang` (the Python interpreter changed, a server was installed ...). */
export function restartLanguage(lang: string) {
  const models: Model[] = [];
  for (const ctx of [...ctxs.values()]) {
    if (ctx.lang !== lang) continue;
    models.push(...ctx.models);
    for (const m of ctx.models) { const t = tracked.get(m); if (t) { t.sub.dispose(); tracked.delete(m); } }
    ctx.models.clear();
    stopCtx(ctx);
  }
  for (const m of models) if (!m.isDisposed()) void track(m);
}

function sendOpen(ctx: Ctx, model: Model, t: Tracked) {
  t.sent = true;
  ctx.client!.notifyServer("textDocument/didOpen", {
    textDocument: { uri: pathToUri(t.path), languageId: LANGUAGE_ID_FOR[model.getLanguageId()] ?? model.getLanguageId(), version: model.getVersionId(), text: model.getValue() },
  });
}

function syncKind(c: LspClient): number {
  const s = c.caps.textDocumentSync;
  return typeof s === "number" ? s : (s?.change ?? 1);
}
function onChange(model: Model, t: Tracked, e: monaco.editor.IModelContentChangedEvent) {
  const c = t.ctx.client;
  if (!c || !t.sent) return;
  const kind = syncKind(c);
  if (kind === 0) return;
  const contentChanges = kind === 1
    ? [{ text: model.getValue() }]
    : e.changes.map((ch) => ({ range: fromRange(ch.range), rangeLength: ch.rangeLength, text: ch.text }));
  c.notifyServer("textDocument/didChange", { textDocument: { uri: pathToUri(t.path), version: model.getVersionId() }, contentChanges });
}

async function startServer(ctx: Ctx) {
  if (ctx.starting || ctx.client) return;
  ctx.starting = true;
  setServerStatus(ctx.statusId, { state: "starting" });
  let client: LspClient | undefined;
  try {
    const resolver = launchResolver(ctx.lang);
    if (resolver) {
      const l = await resolver(ctx.rootPath);
      if (!l) { ctx.starting = false; return; } // no server: the resolver published the status (hint / action)
      ctx.launch = l;
      ctx.serverId = l.serverId;
    }
    const sessionId = await invoke<string>("lsp_start", {
      serverId: ctx.serverId, root: ctx.rootPath, autoGodot: lspSettings.get().autoGodot,
      bin: ctx.launch?.bin ?? null, pathPrepend: ctx.launch?.pathPrepend ?? null,
    });
    client = new LspClient(sessionId);
    await client.attach();
    wire(ctx, client);
    client.onClose = () => {
      if (ctx.client !== client) return;
      ctx.client = undefined;
      for (const m of ctx.models) { const t = tracked.get(m); if (t) t.sent = false; }
      clearDiagnostics(ctx);
      setServerStatus(ctx.statusId, { state: "idle" });
      if (ctx.models.size) scheduleRetry(ctx);
    };
    await client.initialize(ctx.rootPath, pathToUri(ctx.rootPath), ctx.rootPath.split("/").pop() ?? "root");
    if (ctx.models.size === 0 && !ctxs.has(ctx.key)) { client.stop(); return; }
    ctx.client = client;
    ctx.retryDelay = RETRY_MIN;
    setServerStatus(ctx.statusId, { state: "ready" });
    if (ctx.serverId === "typescript") disableBuiltinTs();
    for (const m of ctx.models) { const t = tracked.get(m); if (t && !t.sent) sendOpen(ctx, m, t); }
  } catch (e) {
    client?.stop();
    ctx.client = undefined;
    if (ctx.serverId === "godot") {
      setServerStatus("godot", { state: "waiting", hint: "Start Godot editor for GDScript intelligence" });
    } else {
      setServerStatus(ctx.statusId, { state: "error", hint: String(e) });
    }
    if (ctx.models.size) scheduleRetry(ctx);
  } finally {
    ctx.starting = false;
  }
}

/** Backoff retry (godot, or crashed servers). Only runs while files of that language stay open. */
function scheduleRetry(ctx: Ctx) {
  clearTimeout(ctx.retry);
  const d = ctx.retryDelay;
  ctx.retryDelay = Math.min(d * 2, RETRY_MAX);
  ctx.retry = setTimeout(() => { if (ctx.models.size && !ctx.client) startServer(ctx); }, d);
}
export function retryNow() {
  for (const ctx of ctxs.values()) if (!ctx.client && !ctx.starting && ctx.models.size) { ctx.retryDelay = RETRY_MIN; clearTimeout(ctx.retry); startServer(ctx); }
}

function wire(ctx: Ctx, c: LspClient) {
  c.onNotification("textDocument/publishDiagnostics", (p) => publish(ctx, p));
  c.onRequest("workspace/configuration", (p) => (p.items ?? []).map((it: Json) => (ctx.launch?.settings ? (ctx.launch.settings(it.section, it.scopeUri) ?? null) : null)));
  c.onRequest("client/registerCapability", () => null);
  c.onRequest("client/unregisterCapability", () => null);
  c.onRequest("window/workDoneProgress/create", () => null);
  c.onRequest("workspace/workspaceFolders", () => [{ uri: pathToUri(ctx.rootPath), name: ctx.rootPath.split("/").pop() }]);
  c.onRequest("workspace/applyEdit", async (p) => {
    try { await applyWorkspaceEdit(p.edit); return { applied: true }; } catch (e) { return { applied: false, failureReason: String(e) }; }
  });
  let last = 0;
  c.onNotification("$/progress", (p) => {
    const v = p.value;
    if (v?.kind === "begin") ctx.tokens.set(p.token, v.title ?? "");
    if (v?.kind === "end") ctx.tokens.delete(p.token);
    const now = Date.now();
    if (v?.kind !== "report" || now - last > 250) {
      last = now;
      const title = [...ctx.tokens.values()].pop();
      setServerStatus(ctx.statusId, { state: "ready", progress: title ? `${title}${v?.message ? " " + v.message : ""}` : undefined });
    }
  });
}

function disableBuiltinTs() {
  try {
    const ts = monaco.typescript;
    for (const d of [ts.typescriptDefaults, ts.javascriptDefaults]) {
      d.setDiagnosticsOptions({ noSemanticValidation: true, noSyntaxValidation: true, noSuggestionDiagnostics: true });
      d.setModeConfiguration({
        completionItems: false, hovers: false, documentSymbols: false, definitions: false, references: false, documentHighlights: false,
        rename: false, diagnostics: false, documentRangeFormattingEdits: false, signatureHelp: false, onTypeFormattingEdits: false,
        codeActions: false, inlayHints: false,
      });
    }
  } catch { /* best effort */ }
}

// ---------- diagnostics ----------
let pending: Record<string, Diag[]> = {};
let flushT: ReturnType<typeof setTimeout> | undefined;
function publish(ctx: Ctx, p: Json) {
  const path = uriToPath(p.uri);
  const diags: Diag[] = (p.diagnostics ?? []).map((d: Json) => ({
    uri: path, range: d.range, severity: d.severity ?? 1, message: d.message, source: d.source, code: typeof d.code === "object" ? d.code?.value : d.code,
    tags: d.tags, owner: "lsp",
  }));
  ctx.diagPaths.add(path);
  pending[path] = diags;
  flushT ??= setTimeout(flush, 80);
}
function flush() {
  flushT = undefined;
  const batch = pending;
  pending = {};
  setSourceDiags("lsp", batch);
  for (const k of Object.keys(batch)) {
    const m = monaco.editor.getModel(monaco.Uri.file(k));
    if (m) applyMarkers(m);
  }
}
function clearDiagnostics(ctx: Ctx) {
  const batch: Record<string, Diag[]> = {};
  for (const p of ctx.diagPaths) { batch[p] = []; const m = monaco.editor.getModel(monaco.Uri.file(p)); if (m) monaco.editor.setModelMarkers(m, "lsp", []); }
  if (ctx.diagPaths.size) setSourceDiags("lsp", batch);
  ctx.diagPaths.clear();
}
const SEV = { 1: monaco.MarkerSeverity.Error, 2: monaco.MarkerSeverity.Warning, 3: monaco.MarkerSeverity.Info, 4: monaco.MarkerSeverity.Hint } as const;
/** Each producer (lsp, ruff) has its own marker owner so one never clobbers the other. The merged list (diagStore) feeds Problems. */
export function applyMarkers(model: Model) {
  const merged = diagStore.get().byUri[model.uri.path] ?? [];
  for (const owner of DIAG_OWNERS) {
    const ds = merged.filter((d) => (d.owner ?? "lsp") === owner);
    monaco.editor.setModelMarkers(model, owner, ds.map((d) => ({
      ...toRange(d.range), severity: SEV[d.severity] ?? 8, message: d.message, source: d.source, code: d.code !== undefined ? String(d.code) : undefined,
      tags: d.tags?.map((t) => (t === 1 ? monaco.MarkerTag.Unnecessary : monaco.MarkerTag.Deprecated)),
    })));
  }
}

// ---------- request helpers ----------
function clientFor(model: Model): LspClient | undefined {
  const t = tracked.get(model);
  return t?.sent ? t.ctx.client : undefined;
}
const caps = (c: LspClient, k: string) => !!c.caps[k];

async function req<T>(model: Model, method: string, params: Json): Promise<T | undefined> {
  const c = clientFor(model);
  if (!c) return undefined;
  try { return await c.request<T>(method, params); } catch { return undefined; }
}

const KIND = monaco.languages.CompletionItemKind;
const CK = [KIND.Text, KIND.Text, KIND.Method, KIND.Function, KIND.Constructor, KIND.Field, KIND.Variable, KIND.Class, KIND.Interface, KIND.Module,
  KIND.Property, KIND.Unit, KIND.Value, KIND.Enum, KIND.Keyword, KIND.Snippet, KIND.Color, KIND.File, KIND.Reference, KIND.Folder,
  KIND.EnumMember, KIND.Constant, KIND.Struct, KIND.Event, KIND.Operator, KIND.TypeParameter];

type Item = monaco.languages.CompletionItem & { _raw?: Json; _model?: Model };

async function hoverAt(model: Model, pos: monaco.IPosition): Promise<monaco.languages.Hover | null> {
  const r = await req<Json>(model, "textDocument/hover", { textDocument: tdoc(model), position: toPos(pos) });
  const contents = md(r?.contents);
  return contents.length ? { contents, range: r.range ? toRange(r.range) : undefined } : null;
}
async function completionAt(model: Model, position: monaco.IPosition, context: { triggerKind: number; triggerCharacter?: string }): Promise<monaco.languages.CompletionList> {
  const L = monaco.languages;
  const w = model.getWordUntilPosition(position);
  const def = { startLineNumber: position.lineNumber, endLineNumber: position.lineNumber, startColumn: w.startColumn, endColumn: w.endColumn };
  const r = await req<Json>(model, "textDocument/completion", {
    textDocument: tdoc(model), position: toPos(position),
    context: { triggerKind: context.triggerKind + 1, triggerCharacter: context.triggerCharacter },
  });
  if (!r) return { suggestions: [] };
  const list: Json[] = Array.isArray(r) ? r : (r.items ?? []);
  const suggestions: Item[] = list.map((it) => {
    const te = it.textEdit;
    let range: monaco.IRange | { insert: monaco.IRange; replace: monaco.IRange } = def;
    if (te) {
      if (te.range && te.range.start.line === te.range.end.line) range = toRange(te.range);
      else if (te.insert && te.replace && te.replace.start.line === te.replace.end.line) range = { insert: toRange(te.insert), replace: toRange(te.replace) };
    }
    return {
      label: it.label, kind: CK[it.kind ?? 1] ?? KIND.Text, detail: it.detail, documentation: docToMonaco(it.documentation),
      sortText: it.sortText, filterText: it.filterText, insertText: te?.newText ?? it.insertText ?? it.label, range,
      insertTextRules: it.insertTextFormat === 2 ? L.CompletionItemInsertTextRule.InsertAsSnippet : undefined,
      additionalTextEdits: it.additionalTextEdits?.map((e: Json) => ({ range: toRange(e.range), text: e.newText })),
      commitCharacters: it.commitCharacters, tags: it.deprecated || it.tags?.includes(1) ? [1] : undefined, preselect: it.preselect,
      _raw: it, _model: model,
    };
  });
  return { suggestions, incomplete: !Array.isArray(r) && !!r.isIncomplete };
}
async function resolveItem(item: Item): Promise<Item> {
  const c = item._model && clientFor(item._model);
  if (!c || !c.caps.completionProvider?.resolveProvider || !item._raw) return item;
  try {
    const r = await c.request<Json>("completionItem/resolve", item._raw, 3000);
    if (r?.documentation) item.documentation = docToMonaco(r.documentation);
    if (r?.detail) item.detail = r.detail;
    if (r?.additionalTextEdits) item.additionalTextEdits = r.additionalTextEdits.map((e: Json) => ({ range: toRange(e.range), text: e.newText }));
  } catch { /* keep */ }
  return item;
}

function registerProviders(lang: string) {
  const L = monaco.languages;
  L.registerHoverProvider(lang, { provideHover: (model, pos) => hoverAt(model, pos) });
  L.registerCompletionItemProvider(lang, {
    triggerCharacters: [".", ":", "$", "@", '"', "'", "/", "<", "#", ">"],
    provideCompletionItems: (model, position, context) => completionAt(model, position, context),
    resolveCompletionItem: (item: Item) => resolveItem(item),
  });
  L.registerSignatureHelpProvider(lang, {
    signatureHelpTriggerCharacters: ["(", ","],
    signatureHelpRetriggerCharacters: [")"],
    async provideSignatureHelp(model, pos) {
      const r = await req<Json>(model, "textDocument/signatureHelp", { textDocument: tdoc(model), position: toPos(pos) });
      if (!r?.signatures?.length) return null;
      return {
        value: {
          activeSignature: r.activeSignature ?? 0, activeParameter: r.activeParameter ?? 0,
          signatures: r.signatures.map((s: Json) => ({
            label: s.label, documentation: docToMonaco(s.documentation), activeParameter: s.activeParameter,
            parameters: (s.parameters ?? []).map((p: Json) => ({ label: p.label, documentation: docToMonaco(p.documentation) })),
          })),
        },
        dispose() {},
      };
    },
  });
  L.registerDefinitionProvider(lang, {
    async provideDefinition(model, pos) {
      const locs = await definitionAt(model, pos);
      return locs.map((l) => ({
        uri: monaco.Uri.file(l.path), range: toRange(l.sel), originSelectionRange: l.origin ? toRange(l.origin) : undefined,
      })) as monaco.languages.LocationLink[];
    },
  });
  const fmtOpts = (m: Model) => ({ tabSize: m.getOptions().tabSize, insertSpaces: m.getOptions().insertSpaces });
  const toEdits = (r: Json): monaco.languages.TextEdit[] | undefined =>
    Array.isArray(r) ? r.map((e: Json) => ({ range: toRange(e.range), text: e.newText })) : undefined;
  if (lang === "python") return; // formatting for Python is ruff / black (python/lang), not the type checker
  L.registerDocumentFormattingEditProvider(lang, {
    async provideDocumentFormattingEdits(model) {
      const c = clientFor(model);
      if (!c || !caps(c, "documentFormattingProvider")) return undefined;
      return toEdits(await req(model, "textDocument/formatting", { textDocument: tdoc(model), options: fmtOpts(model) }));
    },
  });
  L.registerDocumentRangeFormattingEditProvider(lang, {
    async provideDocumentRangeFormattingEdits(model, range) {
      const c = clientFor(model);
      if (!c || !caps(c, "documentRangeFormattingProvider")) return undefined;
      return toEdits(await req(model, "textDocument/rangeFormatting", { textDocument: tdoc(model), range: fromRange(range), options: fmtOpts(model) }));
    },
  });
}

// ---------- navigation ----------
interface Target { path: string; sel: Rng; origin?: Rng }
function normLocs(r: Json): Target[] {
  if (!r) return [];
  return (Array.isArray(r) ? r : [r]).map((l: Json) =>
    l.targetUri
      ? { path: uriToPath(l.targetUri), sel: l.targetSelectionRange ?? l.targetRange, origin: l.originSelectionRange }
      : { path: uriToPath(l.uri), sel: l.range },
  );
}
async function definitionAt(model: Model, pos: monaco.IPosition): Promise<Target[]> {
  const r = await req<Json>(model, "textDocument/definition", { textDocument: tdoc(model), position: toPos(pos) });
  return normLocs(r);
}

function cursor() {
  const ed = activeEditor();
  const model = ed?.getModel();
  const pos = ed?.getPosition();
  return ed && model && pos ? { ed, model, pos } : null;
}
export const hasSession = () => { const c = cursor(); return !!c && !!clientFor(c.model); };

async function lineText(path: string, line: number, cache: Map<string, string[]>): Promise<string> {
  let lines = cache.get(path);
  if (!lines) {
    const m = monaco.editor.getModel(monaco.Uri.file(path));
    const text = m ? m.getValue() : await fs.readFile(local(path)).catch(() => "");
    cache.set(path, (lines = text.split("\n")));
  }
  return (lines[line] ?? "").trim();
}
async function toUsages(targets: Target[]) {
  const cache = new Map<string, string[]>();
  return Promise.all(targets.map(async (t) => ({
    loc: { uri: t.path, range: t.sel }, line: await lineText(t.path, t.sel.start.line, cache),
  })));
}

export async function gotoDeclaration() {
  const c = cursor();
  if (!c) return;
  const targets = await definitionAt(c.model, c.pos);
  if (targets.length === 1) return openAt(targets[0].path, targets[0].sel);
  if (targets.length > 1) {
    const word = c.model.getWordAtPosition(c.pos)?.word ?? "";
    usagesStore.set({ title: `Declarations of ${word}`, items: await toUsages(targets), busy: false });
    showToolWindow("usages");
  }
}

export async function findUsages() {
  const c = cursor();
  if (!c || !clientFor(c.model)) return;
  const word = c.model.getWordAtPosition(c.pos)?.word ?? "";
  usagesStore.set({ title: `Usages of ${word}`, items: [], busy: true });
  showToolWindow("usages");
  const r = await req<Json>(c.model, "textDocument/references", { textDocument: tdoc(c.model), position: toPos(c.pos), context: { includeDeclaration: true } });
  const targets = normLocs(r).sort((a, b) => a.path.localeCompare(b.path) || a.sel.start.line - b.sel.start.line);
  usagesStore.set({ title: `Usages of ${word}`, items: await toUsages(targets), busy: false });
}

export async function renameSymbol() {
  const c = cursor();
  if (!c) return;
  const client = clientFor(c.model);
  if (!client || !caps(client, "renameProvider")) return;
  const word = c.model.getWordAtPosition(c.pos);
  let initial = word?.word ?? "";
  if (client.caps.renameProvider?.prepareProvider) {
    const p = await req<Json>(c.model, "textDocument/prepareRename", { textDocument: tdoc(c.model), position: toPos(c.pos) });
    if (!p) return;
    if (p.placeholder) initial = p.placeholder;
    else if (p.range) initial = c.model.getValueInRange(toRange(p.range));
    else if (p.start) initial = c.model.getValueInRange(toRange(p));
  }
  const name = await promptDialog({ title: "Rename", initial, okLabel: "Refactor" });
  if (!name || name === initial) return;
  await renameTo(c.model, c.pos, name);
}
async function renameTo(model: Model, pos: monaco.IPosition, name: string): Promise<boolean> {
  const client = clientFor(model);
  if (!client) return false;
  const edit = await req<Json>(model, "textDocument/rename", { textDocument: tdoc(model), position: toPos(pos), newName: name });
  if (!edit) return false;
  const written = await applyWorkspaceEdit(edit);
  // files edited on disk (not open in Monaco): tell the server so its view of them is not stale
  if (written.length) client.notifyServer("workspace/didChangeWatchedFiles", { changes: written.map((p) => ({ uri: pathToUri(p), type: 2 })) });
  return true;
}

export interface SymbolRow { name: string; kind: number; detail?: string; line: number; col: number; depth: number }
export async function documentSymbols(): Promise<SymbolRow[] | null> {
  const c = cursor();
  if (!c) return null;
  const client = clientFor(c.model);
  if (!client || !caps(client, "documentSymbolProvider")) return null;
  const r = await req<Json[]>(c.model, "textDocument/documentSymbol", { textDocument: tdoc(c.model) });
  if (!Array.isArray(r)) return null;
  const out: SymbolRow[] = [];
  const walk = (s: Json, depth: number) => {
    const rng: Rng = s.selectionRange ?? s.location?.range ?? s.range;
    out.push({ name: s.name, kind: s.kind, detail: s.detail ?? s.containerName, line: rng.start.line + 1, col: rng.start.character + 1, depth });
    (s.children ?? []).forEach((ch: Json) => walk(ch, depth + 1));
  };
  r.forEach((s) => walk(s, 0));
  return out;
}

export interface Intention { title: string; run: () => Promise<void> }
export async function codeActions(): Promise<Intention[]> {
  const c = cursor();
  if (!c) return [];
  const client = clientFor(c.model);
  const sel = c.ed.getSelection();
  const range = sel ? fromRange(sel) : { start: toPos(c.pos), end: toPos(c.pos) };
  const extras: Intention[] = intentionProviderList().flatMap((p) => p({ path: c.model.uri.path, range, language: c.model.getLanguageId() })).map((e) => ({ title: e.title, run: async () => { await e.run(); } }));
  if (!client || !caps(client, "codeActionProvider")) return extras;
  const ds = (diagStore.get().byUri[c.model.uri.path] ?? []).filter(
    (d) => d.range.start.line <= range.end.line && d.range.end.line >= range.start.line &&
      (d.range.start.line !== range.end.line || d.range.start.character <= range.end.character) &&
      (d.range.end.line !== range.start.line || d.range.end.character >= range.start.character),
  );
  const r = await req<Json[]>(c.model, "textDocument/codeAction", {
    textDocument: tdoc(c.model), range,
    context: { diagnostics: ds.map((d) => ({ range: d.range, severity: d.severity, message: d.message, source: d.source, code: d.code })) },
  });
  const lspActions = (r ?? []).filter((a) => !a.disabled).map((a) => ({
    title: a.title,
    run: async () => {
      let act = a;
      if (!act.edit && !act.command?.command && act.data && client.caps.codeActionProvider?.resolveProvider) act = (await client.request<Json>("codeAction/resolve", a)) ?? a;
      if (act.edit) await applyWorkspaceEdit(act.edit);
      const cmd = typeof act.command === "string" ? act : act.command;
      if (cmd?.command) await client.request("workspace/executeCommand", { command: cmd.command, arguments: cmd.arguments });
    },
  }));
  return [...extras, ...lspActions];
}

// ---------- boot ----------
let booted = false;
export function boot() {
  if (booted) return;
  booted = true;
  for (const lang of Object.keys(SERVER_FOR_LANGUAGE)) registerProviders(lang);
  monaco.editor.registerEditorOpener({
    openCodeEditor(_src, resource, sel) {
      if (resource.scheme !== "file") return false;
      const r = sel && "startLineNumber" in sel
        ? fromRange(sel)
        : sel ? { start: toPos(sel as monaco.IPosition), end: toPos(sel as monaco.IPosition) } : undefined;
      openAt(resource.path, r);
      return true;
    },
  });
  monaco.editor.getModels().forEach(track);
  monaco.editor.onDidCreateModel(track);
  monaco.editor.onWillDisposeModel(untrack);
  monaco.editor.onDidChangeModelLanguage((e) => { untrack(e.model); track(e.model); });

  // didSave: dirty true -> false on a tracked doc.
  const wasDirty = new Set<string>();
  editorStore.subscribe(() => {
    for (const d of Object.values(editorStore.get().docs)) {
      if (d.dirty) { wasDirty.add(d.key); continue; }
      if (!wasDirty.delete(d.key)) continue;
      const m = monaco.editor.getModel(monaco.Uri.file(d.loc.path));
      const t = m && tracked.get(m);
      const c = t && t.sent ? t.ctx.client : undefined;
      if (!c || !m) continue;
      const save = c.caps.textDocumentSync?.save;
      if (save === false || save === undefined && typeof c.caps.textDocumentSync === "number") continue;
      c.notifyServer("textDocument/didSave", { textDocument: { uri: pathToUri(m.uri.path) }, ...(save?.includeText ? { text: m.getValue() } : {}) });
    }
  });
}

/** LSP formatting of a whole document (used when neither ruff nor black exists). */
export async function formatViaLsp(model: Model): Promise<{ range: monaco.IRange; text: string }[] | undefined> {
  const c = clientFor(model);
  if (!c || !caps(c, "documentFormattingProvider")) return undefined;
  const r = await req<Json>(model, "textDocument/formatting", { textDocument: tdoc(model), options: { tabSize: model.getOptions().tabSize, insertSpaces: model.getOptions().insertSpaces } });
  return Array.isArray(r) ? r.map((e: Json) => ({ range: toRange(e.range), text: e.newText })) : undefined;
}

/** Test hooks (python/lang/qa): the same code paths the Monaco providers use. */
const modelAt = (path: string) => { const m = monaco.editor.getModel(monaco.Uri.file(path)); if (!m) throw new Error("model not open: " + path); return m; };
export const qaHooks = {
  sessions: () => [...ctxs.values()].map((c) => ({ key: c.key, serverId: c.serverId, bin: c.launch?.bin ?? null, ready: !!c.client, models: c.models.size })),
  async completion(path: string, line: number, col: number, trigger?: string) {
    const r = await completionAt(modelAt(path), { lineNumber: line, column: col }, { triggerKind: trigger ? 1 : 0, triggerCharacter: trigger });
    return r.suggestions.map((s) => ({ label: typeof s.label === "string" ? s.label : s.label.label, detail: s.detail ?? null, insert: s.insertText }));
  },
  async hover(path: string, line: number, col: number) {
    const h = await hoverAt(modelAt(path), { lineNumber: line, column: col });
    return h ? h.contents.map((c) => ("value" in c ? c.value : "")).join("\n---\n") : null;
  },
  async definition(path: string, line: number, col: number) {
    return (await definitionAt(modelAt(path), { lineNumber: line, column: col })).map((t) => ({ path: t.path, line: t.sel.start.line + 1, col: t.sel.start.character + 1 }));
  },
  async references(path: string, line: number, col: number) {
    const r = await req<Json>(modelAt(path), "textDocument/references", { textDocument: tdoc(modelAt(path)), position: { line: line - 1, character: col - 1 }, context: { includeDeclaration: true } });
    return normLocs(r).map((t) => ({ path: t.path, line: t.sel.start.line + 1 }));
  },
  async signature(path: string, line: number, col: number) {
    const r = await req<Json>(modelAt(path), "textDocument/signatureHelp", { textDocument: tdoc(modelAt(path)), position: { line: line - 1, character: col - 1 } });
    return r?.signatures?.map((s: Json) => ({ label: s.label, active: r.activeParameter ?? s.activeParameter ?? 0 })) ?? null;
  },
  async rename(path: string, line: number, col: number, name: string) { return renameTo(modelAt(path), { lineNumber: line, column: col }, name); },
  async symbols(path: string) {
    const m = modelAt(path);
    const r = await req<Json[]>(m, "textDocument/documentSymbol", { textDocument: tdoc(m) });
    const out: { name: string; kind: number; line: number; depth: number }[] = [];
    const walk = (s: Json, depth: number) => { out.push({ name: s.name, kind: s.kind, line: (s.selectionRange ?? s.location?.range ?? s.range).start.line + 1, depth }); (s.children ?? []).forEach((ch: Json) => walk(ch, depth + 1)); };
    (r ?? []).forEach((s) => walk(s, 0));
    return out;
  },
};
