/** While paused: execution-line highlight + arrow, inline variable values (grey italic after the code) and hover evaluation. */
import type { editor, IDisposable } from "monaco-editor";
import { watchEditors } from "../glyph";
import { acceptModel, modelLoc } from "./gutter";
import { hoverExpression, inlineValues } from "./pure";
import { debugStore, execStore, pausedSession, type ExecPoint } from "./session";

const GLYPH_RIGHT = 3;

interface ExecView { ed: editor.IStandaloneCodeEditor; model: editor.ITextModel; exec: editor.IEditorDecorationsCollection; inline: editor.IEditorDecorationsCollection }
const views = new Set<ExecView>();

function apply(v: ExecView, p: ExecPoint | null) {
  const loc = modelLoc(v.model);
  if (!p || p.path !== loc.path || p.host !== loc.host) { v.exec.clear(); v.inline.clear(); return; }
  const max = v.model.getLineCount();
  const line = Math.min(Math.max(1, p.line), max);
  v.exec.set([{
    range: { startLineNumber: line, startColumn: 1, endLineNumber: line, endColumn: 1 },
    options: {
      isWholeLine: true,
      className: p.top ? "dbg-exec-line" : "dbg-exec-line dbg-exec-frame",
      glyphMargin: { position: GLYPH_RIGHT },
      zIndex: 5,
      glyphMarginClassName: p.top ? "dbg-exec-arrow" : "dbg-exec-arrow dbg-exec-arrow-frame",
      stickiness: 1,
    },
  }]);
  const lines = v.model.getLinesContent();
  const vals = inlineValues(lines, line, p.locals);
  v.inline.set(vals.map((x) => ({
    range: { startLineNumber: x.line, startColumn: v.model.getLineMaxColumn(x.line), endLineNumber: x.line, endColumn: v.model.getLineMaxColumn(x.line) },
    options: { after: { content: "  " + x.text, inlineClassName: "dbg-inline-value" }, showIfCollapsed: true },
  })));
}

export function installExecution(): () => void {
  const off = watchEditors((ed, model) => {
    const v: ExecView = { ed, model, exec: ed.createDecorationsCollection(), inline: ed.createDecorationsCollection() };
    views.add(v);
    const redraw = () => apply(v, execStore.get().point);
    redraw();
    const un = execStore.subscribe(redraw);
    // inline values are text-position based: recompute (cheap, debounced) when the code is edited while paused
    let t: ReturnType<typeof setTimeout> | undefined;
    const sub = model.onDidChangeContent(() => { clearTimeout(t); t = setTimeout(redraw, 250); });
    return () => { clearTimeout(t); sub.dispose(); un(); v.exec.clear(); v.inline.clear(); views.delete(v); };
  }, acceptModel);
  let hover: IDisposable | null = null;
  let disposed = false;
  let hoverRequested = false;
  // the hover provider needs the Monaco runtime: register it when the first debug session appears, not at project open
  const wantHover = () => {
    if (hoverRequested || !debugStore.get().sessions.length) return;
    hoverRequested = true;
    unDebug();
    void import("../../../editor/monacoSetup").then(({ monaco }) => {
      if (disposed) return;
      hover = registerHover(monaco);
    });
  };
  const unDebug = debugStore.subscribe(wantHover);
  wantHover();
  return () => { disposed = true; unDebug(); off(); hover?.dispose(); };
}

function registerHover(monaco: typeof import("monaco-editor")): IDisposable {
  {
    return monaco.languages.registerHoverProvider("python", {
      async provideHover(model, pos) {
        const s = pausedSession();
        if (!s || !acceptModel(model)) return null;
        const h = hoverExpression(model.getLineContent(pos.lineNumber), pos.column);
        if (!h) return null;
        const r = await s.evaluate(h.expr, "hover");
        if (r.error || r.value == null) return null;
        const body = `\`${h.expr}\` = ${r.type ? `*{${r.type}}* ` : ""}\`${r.value.length > 600 ? r.value.slice(0, 600) + "…" : r.value}\``;
        return {
          range: new monaco.Range(pos.lineNumber, h.startCol, pos.lineNumber, h.endCol),
          contents: [{ value: body }],
        };
      },
    });
  }
}

/** Test hook: what the editors currently show for the execution point. */
export function executionInfo() {
  return [...views].map((v) => {
    const line = v.exec.getRanges()[0]?.startLineNumber ?? null;
    return {
      path: modelLoc(v.model).path,
      execLine: line,
      arrow: line ? v.model.getLineDecorations(line).some((d) => d.options.glyphMarginClassName?.includes("dbg-exec-arrow")) : false,
      inline: v.inline.getRanges().map((r) => ({ line: r.startLineNumber, text: v.model.getLineDecorations(r.startLineNumber).map((d) => d.options.after?.content).find(Boolean)?.trim() ?? "" })),
    };
  });
}
