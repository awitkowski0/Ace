/** The console's input line: a small Monaco editor (Python highlighting). Enter runs a complete statement, Shift+Enter always inserts a newline. */
import { useEffect, useRef } from "react";
import type { editor as MonacoEditor } from "monaco-editor";
import { addHistory, checkComplete, execute, getHistory, interrupt, loadHistory } from "./session";

export interface InputHandle {
  focus(): void;
  getValue(): string;
  setValue(v: string): void;
  submit(): Promise<void>;
}
export let activeInput: InputHandle | null = null;

export function InputEditor({ onHeight, autoFocus }: { onHeight?: (h: number) => void; autoFocus?: boolean }) {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let disposed = false;
    let ed: MonacoEditor.IStandaloneCodeEditor | null = null;
    let model: MonacoEditor.ITextModel | null = null;
    void (async () => {
      const { monaco } = await import("../../../editor/monacoSetup");
      if (disposed || !host.current) return;
      model = monaco.editor.createModel("", "python", monaco.Uri.parse(`pyconsole://input/${Math.random().toString(36).slice(2)}`));
      ed = monaco.editor.create(host.current, {
        model,
        minimap: { enabled: false },
        lineNumbers: "off",
        glyphMargin: false,
        folding: false,
        lineDecorationsWidth: 0,
        lineNumbersMinChars: 0,
        scrollBeyondLastLine: false,
        overviewRulerLanes: 0,
        hideCursorInOverviewRuler: true,
        renderLineHighlight: "none",
        scrollbar: { vertical: "hidden", horizontal: "hidden", alwaysConsumeMouseWheel: false },
        fontFamily: "JetBrains Mono, Menlo, monospace",
        fontSize: 12,
        lineHeight: 18,
        padding: { top: 3, bottom: 3 },
        automaticLayout: true,
        contextmenu: false,
        wordWrap: "on",
        quickSuggestions: { other: true, comments: false, strings: false },
        suggestOnTriggerCharacters: false,
        occurrencesHighlight: "off",
        selectionHighlight: false,
        stickyScroll: { enabled: false },
        guides: { indentation: false },
        theme: "nord",
        ariaLabel: "Python Console input",
      });
      const e = ed;
      const hist = { idx: -1, draft: "" };
      const fit = () => {
        const h = Math.min(Math.max(e.getContentHeight(), 24), 180);
        host.current && (host.current.style.height = h + "px");
        onHeight?.(h);
        e.layout();
      };
      e.onDidContentSizeChange(fit);
      fit();

      /** newline + indentation of the current line (+4 after a trailing colon); Monaco's own enter handling is not used for a standalone model */
      const newline = () => {
        const sel = e.getSelection();
        const m = e.getModel();
        if (!sel || !m) return;
        const before = m.getValueInRange({ startLineNumber: sel.startLineNumber, startColumn: 1, endLineNumber: sel.startLineNumber, endColumn: sel.startColumn });
        const indent = /^[ \t]*/.exec(before)![0];
        const code = before.replace(/#.*$/, "").trimEnd();
        e.executeEdits("pyconsole", [{ range: sel, text: "\n" + indent + (code.endsWith(":") ? "    " : ""), forceMoveMarkers: true }]);
        e.revealPosition(e.getPosition()!);
      };
      const submit = async () => {
        const code = e.getValue();
        if (!code.trim()) return;
        const c = await checkComplete(code);
        if (c.status === "incomplete") { newline(); return; }
        await addHistory(code);
        hist.idx = -1;
        e.setValue("");
        void execute(code);
      };
      const handle: InputHandle = { focus: () => e.focus(), getValue: () => e.getValue(), setValue: (v) => { e.setValue(v); e.setPosition(e.getModel()!.getFullModelRange().getEndPosition()); }, submit };
      activeInput = handle;
      void loadHistory();

      const suggestVisible = () => !!(e as unknown as { _contextKeyService?: { getContextKeyValue(k: string): unknown } })._contextKeyService?.getContextKeyValue("suggestWidgetVisible");
      const browse = (dir: -1 | 1) => {
        const h = getHistory();
        if (!h.length) return;
        if (hist.idx === -1) { if (dir === 1) return; hist.draft = e.getValue(); hist.idx = h.length; }
        const next = hist.idx + dir;
        if (next < 0) return;
        if (next >= h.length) { hist.idx = -1; handle.setValue(hist.draft); return; }
        hist.idx = next;
        handle.setValue(h[next]);
      };
      e.onKeyDown((ev) => {
        const k = ev.browserEvent;
        if (k.key === "Enter" && !k.metaKey && !k.ctrlKey && !k.altKey) {
          if (suggestVisible()) return;
          ev.preventDefault();
          ev.stopPropagation();
          if (k.shiftKey) newline(); else void submit();
        } else if ((k.key === "ArrowUp" || k.key === "ArrowDown") && !k.metaKey && !k.ctrlKey && !k.altKey && !k.shiftKey) {
          if (suggestVisible()) return;
          const p = e.getPosition()!;
          const last = e.getModel()!.getLineCount();
          if (k.key === "ArrowUp" && p.lineNumber === 1) { ev.preventDefault(); ev.stopPropagation(); browse(-1); }
          else if (k.key === "ArrowDown" && p.lineNumber === last) { ev.preventDefault(); ev.stopPropagation(); browse(1); }
        } else if (k.ctrlKey && !k.metaKey && !k.altKey && !k.shiftKey && k.key.toLowerCase() === "c" && e.getSelection()?.isEmpty()) {
          ev.preventDefault();
          ev.stopPropagation();
          interrupt();
        }
      });
      if (autoFocus || document.activeElement === host.current) e.focus();
    })();
    return () => {
      disposed = true;
      activeInput = null;
      ed?.dispose();
      model?.dispose();
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return <div className="pyc-editor" ref={host} data-autofocus tabIndex={-1} onFocus={(e) => { if (e.target === e.currentTarget) activeInput?.focus(); }} />;
}
