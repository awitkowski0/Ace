import { useEffect, useRef, useState } from "react";
import { PopupShell, type PopupProps } from "../components/shell/popups";
import { activeEditor } from "./editorRegistry";
import { markNavigation } from "./store";

/** Parses IntelliJ's "line[:column]" input (also ":col" for the current line). Returns null when unparseable. */
export function parseLineCol(text: string, cur: { line: number; col: number }, lineCount: number): { line: number; col: number } | null {
  const m = /^\s*(-?\d+)?\s*(?:[:,]\s*(-?\d+)?)?\s*$/.exec(text);
  if (!m || (m[1] === undefined && m[2] === undefined)) return null;
  let line = m[1] === undefined ? cur.line : parseInt(m[1], 10);
  if (line < 0) line = lineCount + 1 + line; // negative = from the end
  line = Math.min(Math.max(1, line), lineCount);
  const col = m[2] === undefined ? 1 : Math.max(1, parseInt(m[2], 10));
  return { line, col };
}

/** "Go to Line/Column" (⌘L): small centered popup, Enter jumps, Esc cancels. */
export function GotoLinePopup({ onClose }: PopupProps) {
  const ed = activeEditor();
  const model = ed?.getModel();
  const pos = ed?.getPosition();
  const [text, setText] = useState("");
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.focus(), []);
  const lineCount = model?.getLineCount() ?? 1;
  const cur = { line: pos?.lineNumber ?? 1, col: pos?.column ?? 1 };
  const target = parseLineCol(text, cur, lineCount);
  const go = () => {
    if (!ed || !target) return;
    const maxCol = model!.getLineMaxColumn(target.line);
    const p = { lineNumber: target.line, column: Math.min(target.col, maxCol) };
    onClose();
    markNavigation();
    ed.setPosition(p);
    ed.revealPositionInCenterIfOutsideViewport(p);
    ed.focus();
  };
  return (
    <PopupShell onClose={onClose} width={360}>
      <div style={{ padding: "10px 12px 4px", fontWeight: 600 }}>Go to Line:Column</div>
      <input
        ref={input}
        className="popup-input"
        placeholder="line:column"
        value={text}
        spellCheck={false}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); go(); } }}
      />
      <div style={{ padding: "0 12px 10px", color: "var(--fg-faint)", fontSize: 12 }}>
        Current: {cur.line}:{cur.col} · Last line: {lineCount}
      </div>
    </PopupShell>
  );
}
