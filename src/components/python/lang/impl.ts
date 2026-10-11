/**
 * Monaco-dependent Python language features (lazy: loaded when the first .py model exists in a Python project):
 * ruff diagnostics (own marker owner, merged with the LSP's in diagStore), ruff/black/LSP Reformat Code, Optimize Imports,
 * ruff quick fixes in Show Context Actions. The type checker itself (basedpyright) lives in editor/lsp/manager.ts.
 */
import { monaco } from "../../../editor/monacoSetup";
import { activeEditor } from "../../../editor/editorRegistry";
import { editorStore } from "../../../editor/store";
import { applyMarkers, formatViaLsp } from "../../../editor/lsp/manager";
import { addIntentionProvider } from "../../../editor/lsp/servers";
import { getSourceDiags, setSourceDiags, type Diag } from "../../../editor/lsp/state";
import { local, type Location } from "../../../lib/ipc";
import { projectStore } from "../../../lib/project";
import { pyApi } from "../api";
import { pyStore } from "../interpreter";
import { textEdits, type OffsetEdit } from "./diff";
import { formatArgv, optimizeArgv, parseRuff, pickFormatter, ruffCheckArgv, type FmtRange } from "./tools";
import { notify } from "./note";

type Model = monaco.editor.ITextModel;
type Editor = monaco.editor.IStandaloneCodeEditor;

const DEBOUNCE_MS = 500;
export const isPyModel = (m: Model) => m.getLanguageId() === "python" && (m.uri.scheme === "file" || m.uri.scheme === "ssh");
const locOf = (m: Model): Location => (m.uri.scheme === "ssh" ? { host: m.uri.authority, path: m.uri.path } : local(m.uri.path));
/** cwd for the tools: the project root when the file lives on its host (config discovery), else the file's directory */
function cwdFor(m: Model): Location {
  const l = locOf(m);
  const r = projectStore.get().root;
  return r && r.host === l.host ? r : { host: l.host, path: l.path.slice(0, l.path.lastIndexOf("/")) || "/" };
}
/** Library files (go to definition into site-packages / venvs) are not linted. */
const lintable = (m: Model) => {
  const r = projectStore.get().root;
  const p = m.uri.path;
  return !!r && p.startsWith(r.path.replace(/\/+$/, "") + "/") && !/\/(site-packages|\.venv|venv|node_modules|__pycache__)\//.test(p);
};

// ---------------------------------------------------------------------------------------------------- ruff diagnostics
interface S { sub: monaco.IDisposable; timer?: ReturnType<typeof setTimeout>; busy: boolean; again: boolean }
const states = new Map<Model, S>();
const hiddenDirty = new Set<Model>();
export const ruffStats = { runs: 0, last: 0 };

function schedule(m: Model, delay = DEBOUNCE_MS) {
  const s = states.get(m);
  if (!s) return;
  clearTimeout(s.timer);
  if (document.hidden) { hiddenDirty.add(m); return; }
  s.timer = setTimeout(() => void runRuff(m), delay);
}

async function runRuff(m: Model): Promise<void> {
  const s = states.get(m);
  if (!s || m.isDisposed()) return;
  const st = pyStore.get();
  const path = m.uri.path;
  const ruff = st.tools.ruff;
  if (!ruff || !st.active || !lintable(m)) {
    if (getSourceDiags("ruff", path).length) { setSourceDiags("ruff", { [path]: [] }); applyMarkers(m); }
    return;
  }
  if (s.busy) { s.again = true; return; }
  s.busy = true;
  const v = m.getVersionId();
  try {
    const r = await pyApi.filter(cwdFor(m), ruffCheckArgv(ruff, path), m.getValue());
    ruffStats.runs++;
    ruffStats.last = Date.now();
    if (m.isDisposed()) return;
    if (m.getVersionId() !== v) s.again = true; // a newer edit superseded this result
    else {
      const diags = r.timedOut ? null : parseRuff(r.stdout, path);
      if (diags) { setSourceDiags("ruff", { [path]: diags }); applyMarkers(m); }
    }
  } catch { /* tool vanished / app closing */ }
  finally {
    s.busy = false;
    if (s.again) { s.again = false; schedule(m, 30); }
  }
}

function track(m: Model) {
  if (states.has(m) || !isPyModel(m)) return;
  const s: S = { busy: false, again: false, sub: m.onDidChangeContent(() => schedule(m)) };
  states.set(m, s);
  schedule(m, 0);
}
function untrack(m: Model) {
  const s = states.get(m);
  if (!s) return;
  clearTimeout(s.timer);
  s.sub.dispose();
  states.delete(m);
  hiddenDirty.delete(m);
  const path = m.uri.path;
  if (getSourceDiags("ruff", path).length) setSourceDiags("ruff", { [path]: [] });
}

// ---------------------------------------------------------------------------------------------------- applying text results
function applyOffsets(model: Model, ed: Editor | null, edits: OffsetEdit[]): boolean {
  if (!edits.length) return false;
  const ops = edits.map((e) => {
    const a = model.getPositionAt(e.start), b = model.getPositionAt(e.end);
    return { range: new monaco.Range(a.lineNumber, a.column, b.lineNumber, b.column), text: e.text, forceMoveMarkers: false };
  });
  if (ed && ed.getModel() === model) { ed.pushUndoStop(); ed.executeEdits("ace-python", ops); ed.pushUndoStop(); }
  else { model.pushStackElement(); model.pushEditOperations([], ops, () => null); model.pushStackElement(); }
  return true;
}

export interface ToolResult { ok: boolean; tool?: string; changed?: boolean; error?: string }
async function pipe(m: Model, argv: string[], text: string): Promise<{ ok: true; out: string } | { ok: false; error: string }> {
  const r = await pyApi.filter(cwdFor(m), argv, text);
  if (r.timedOut) return { ok: false, error: "timed out" };
  if (r.code !== 0) return { ok: false, error: (r.stderr || r.stdout || `exit code ${r.code}`).trim().split("\n")[0].slice(0, 200) };
  if (!r.stdout && text.trim()) return { ok: false, error: (r.stderr || "empty output").trim().split("\n")[0].slice(0, 200) };
  return { ok: true, out: r.stdout };
}

const selectionRange = (ed: Editor | null): FmtRange | undefined => {
  const sel = ed?.getSelection();
  return sel && !sel.isEmpty() ? { l1: sel.startLineNumber, c1: sel.startColumn, l2: sel.endLineNumber, c2: sel.endColumn } : undefined;
};

/** The formatted text for `m` (null + error when no tool / the tool failed). Range = selection. */
async function formatted(m: Model, range?: FmtRange): Promise<{ out: string | null; tool?: string; error?: string }> {
  const text = m.getValue();
  const f = pickFormatter(pyStore.get().tools);
  if (f) {
    const r = await pipe(m, formatArgv(f, m.uri.path, range), text);
    return r.ok ? { out: r.out, tool: f.kind } : { out: null, tool: f.kind, error: r.error };
  }
  const edits = await formatViaLsp(m).catch(() => undefined);
  if (edits?.length) {
    // apply the server's edits on a scratch copy of the text
    const off = (p: { lineNumber: number; column: number }) => m.getOffsetAt(p);
    const out = [...edits].sort((a, b) => off({ lineNumber: b.range.startLineNumber, column: b.range.startColumn }) - off({ lineNumber: a.range.startLineNumber, column: a.range.startColumn }))
      .reduce((acc, e) => acc.slice(0, off({ lineNumber: e.range.startLineNumber, column: e.range.startColumn })) + e.text + acc.slice(off({ lineNumber: e.range.endLineNumber, column: e.range.endColumn })), text);
    return { out, tool: "lsp" };
  }
  return { out: null, error: "No formatter found: install ruff or black in the project interpreter" };
}

/** Reformat Code (⌥⌘L) for the active Python editor: ruff format, else black, else LSP; a selection formats only the selection. */
export async function reformat(): Promise<ToolResult> {
  const ed = activeEditor() ?? null;
  const m = ed?.getModel();
  if (!ed || !m) return { ok: false, error: "no editor" };
  const text = m.getValue(), v = m.getVersionId();
  const r = await formatted(m, selectionRange(ed));
  if (r.out === null) { notify(`Reformat Code: ${r.error}`); return { ok: false, tool: r.tool, error: r.error }; }
  if (m.getVersionId() !== v) return { ok: false, tool: r.tool, error: "the file changed while formatting" };
  return { ok: true, tool: r.tool, changed: applyOffsets(m, ed, textEdits(text, r.out)) };
}

/** Optimize Imports (⌃⌥O): ruff (isort rules + unused imports removed) else isort. */
export async function optimizeImports(): Promise<ToolResult> {
  const ed = activeEditor() ?? null;
  const m = ed?.getModel();
  if (!ed || !m) return { ok: false, error: "no editor" };
  const plan = optimizeArgv(pyStore.get().tools, m.uri.path);
  if (!plan) { const error = "Optimize Imports needs ruff or isort in the project interpreter"; notify(error); return { ok: false, error }; }
  const text = m.getValue(), v = m.getVersionId();
  const r = await pipe(m, plan.argv, text);
  if (!r.ok) { notify(`Optimize Imports: ${r.error}`); return { ok: false, tool: plan.tool, error: r.error }; }
  if (m.getVersionId() !== v) return { ok: false, tool: plan.tool, error: "the file changed while optimizing" };
  return { ok: true, tool: plan.tool, changed: applyOffsets(m, ed, textEdits(text, r.out)) };
}

// ---------------------------------------------------------------------------------------------------- quick fixes (⌥↵)
const NOQA = /#\s*noqa(?::\s*([A-Za-z0-9, ]+))?\s*$/;
function noqaEdit(m: Model, line: number, code: string): OffsetEdit {
  const text = m.getLineContent(line);
  const base = m.getOffsetAt({ lineNumber: line, column: 1 });
  const hit = NOQA.exec(text);
  if (hit && hit[1]) return { start: base + text.length, end: base + text.length, text: `, ${code}` };
  if (hit) return { start: base + hit.index, end: base + text.length, text: `# noqa: ${code}` };
  return { start: base + text.length, end: base + text.length, text: `  # noqa: ${code}` };
}

function intentions(ctx: { path: string; range: { start: { line: number; character: number }; end: { line: number; character: number } }; language: string }) {
  if (ctx.language !== "python") return [];
  const m = monaco.editor.getModel(monaco.Uri.file(ctx.path));
  if (!m) return [];
  const ds = getSourceDiags("ruff", ctx.path).filter((d) => d.range.start.line <= ctx.range.end.line && d.range.end.line >= ctx.range.start.line);
  const out: { title: string; run: () => void }[] = [];
  const seen = new Set<string>();
  for (const d of ds) {
    if (d.fix) {
      const fix = d.fix;
      out.push({ title: `${fix.title}${d.code ? ` (${d.code})` : ""}`, run: () => applyFix(m, d) });
    }
  }
  for (const d of ds) {
    if (!d.code || seen.has(`${d.code}${d.range.start.line}`)) continue;
    seen.add(`${d.code}${d.range.start.line}`);
    out.push({ title: `Ignore ${d.code} for this line (# noqa)`, run: () => void applyOffsets(m, activeEditor() ?? null, [noqaEdit(m, d.range.start.line + 1, String(d.code))]) });
  }
  return out;
}
function applyFix(m: Model, d: Diag) {
  const ed = activeEditor() ?? null;
  const ops = d.fix!.edits.map((e) => ({
    range: new monaco.Range(e.range.start.line + 1, e.range.start.character + 1, e.range.end.line + 1, e.range.end.character + 1), text: e.newText, forceMoveMarkers: false,
  }));
  if (ed && ed.getModel() === m) { ed.pushUndoStop(); ed.executeEdits("ruff-fix", ops); ed.pushUndoStop(); }
  else m.pushEditOperations([], ops, () => null);
}

// ---------------------------------------------------------------------------------------------------- start
let started = false;
export function startLang() {
  if (started) return;
  started = true;
  const L = monaco.languages;
  // Monaco's own "Format Document" (and anything calling it) goes through the same tools, as minimal edits.
  L.registerDocumentFormattingEditProvider("python", {
    displayName: "ruff / black",
    async provideDocumentFormattingEdits(model) {
      const text = model.getValue();
      const r = await formatted(model);
      return r.out === null ? undefined : textEdits(text, r.out).map((e) => {
        const a = model.getPositionAt(e.start), b = model.getPositionAt(e.end);
        return { range: new monaco.Range(a.lineNumber, a.column, b.lineNumber, b.column), text: e.text };
      });
    },
  });
  L.registerDocumentRangeFormattingEditProvider("python", {
    displayName: "ruff / black",
    async provideDocumentRangeFormattingEdits(model, range) {
      const text = model.getValue();
      const r = await formatted(model, { l1: range.startLineNumber, c1: range.startColumn, l2: range.endLineNumber, c2: range.endColumn });
      return r.out === null ? undefined : textEdits(text, r.out).map((e) => {
        const a = model.getPositionAt(e.start), b = model.getPositionAt(e.end);
        return { range: new monaco.Range(a.lineNumber, a.column, b.lineNumber, b.column), text: e.text };
      });
    },
  });
  addIntentionProvider(intentions);

  monaco.editor.getModels().forEach(track);
  monaco.editor.onDidCreateModel(track);
  monaco.editor.onWillDisposeModel(untrack);
  monaco.editor.onDidChangeModelLanguage((e) => { untrack(e.model); track(e.model); });

  // save: lint right away
  const wasDirty = new Set<string>();
  editorStore.subscribe(() => {
    for (const d of Object.values(editorStore.get().docs)) {
      if (d.dirty) { wasDirty.add(d.key); continue; }
      if (!wasDirty.delete(d.key)) continue;
      const m = monaco.editor.getModels().find((x) => states.has(x) && x.uri.path === d.loc.path);
      if (m) schedule(m, 0);
    }
  });
  // window visible again: catch up on the edits made while hidden
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) return;
    for (const m of hiddenDirty) schedule(m, 0);
    hiddenDirty.clear();
  });
  // ruff became (un)available / interpreter switched: re-lint everything once
  let lastRuff = pyStore.get().tools.ruff;
  pyStore.subscribe(() => {
    const r = pyStore.get().tools.ruff;
    if (r === lastRuff) return;
    lastRuff = r;
    for (const m of states.keys()) schedule(m, 100);
  });
}

export const modelByPath = (path: string) => monaco.editor.getModel(monaco.Uri.file(path));
export const trackedPaths = () => [...states.keys()].map((m) => m.uri.path);

// ---- test hooks (python/lang/register.tsx -> __qa.py().lang) ----
export const qaTools = {
  text: (path: string) => modelByPath(path)?.getValue() ?? null,
  setText: (path: string, text: string) => { const m = modelByPath(path); if (!m) throw new Error("not open: " + path); m.setValue(text); return true; },
  markers: (path: string) => {
    const m = modelByPath(path);
    return m ? monaco.editor.getModelMarkers({ resource: m.uri }).map((k) => ({ owner: k.owner, code: typeof k.code === "string" ? k.code : (k.code as { value?: string } | undefined)?.value ?? null, line: k.startLineNumber, severity: k.severity, message: k.message, source: k.source ?? null })) : [];
  },
  setCaret: (path: string, line: number, col: number) => {
    const ed = activeEditor();
    if (!ed || ed.getModel()?.uri.path !== path) throw new Error("not the active editor: " + path);
    ed.setPosition({ lineNumber: line, column: col });
    ed.focus();
    return true;
  },
  select: (path: string, l1: number, c1: number, l2: number, c2: number) => {
    const ed = activeEditor();
    if (!ed || ed.getModel()?.uri.path !== path) throw new Error("not the active editor: " + path);
    ed.setSelection({ startLineNumber: l1, startColumn: c1, endLineNumber: l2, endColumn: c2 });
    ed.focus();
    return true;
  },
  caret: () => { const p = activeEditor()?.getPosition(); const m = activeEditor()?.getModel(); return p && m ? { line: p.lineNumber, col: p.column, text: m.getLineContent(p.lineNumber) } : null; },
  /** N quick edits at the end of the file, spread over `gapMs`: to count how many ruff runs they cause */
  async burst(path: string, n: number, gapMs: number) {
    const m = modelByPath(path);
    if (!m) throw new Error("not open: " + path);
    for (let i = 0; i < n; i++) {
      m.applyEdits([{ range: new monaco.Range(m.getLineCount(), m.getLineMaxColumn(m.getLineCount()), m.getLineCount(), m.getLineMaxColumn(m.getLineCount())), text: "\n# edit " + i }]);
      await new Promise((r) => setTimeout(r, gapMs));
    }
    return true;
  },
};
