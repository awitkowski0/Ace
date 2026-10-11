/** Which code does "Execute Selection in Python Console" send when nothing is selected? Pure, indentation/bracket based. */
export interface Logical { start: number; end: number; indent: number; head: string; colon: boolean }

/** Split source lines into logical lines (0-based inclusive physical ranges). Blank / comment-only lines outside brackets are skipped. */
export function logicalLines(lines: string[]): Logical[] {
  const out: Logical[] = [];
  let depth = 0;
  let triple: string | null = null;
  let cont = false;
  let cur: Logical | null = null;
  let lastSig = "";
  for (let n = 0; n < lines.length; n++) {
    const line = lines[n];
    const startsFresh = depth === 0 && !triple && !cont;
    if (startsFresh) {
      const t = line.trim();
      if (!t || t.startsWith("#")) continue;
      cur = { start: n, end: n, indent: line.length - line.trimStart().length, head: t, colon: false };
      lastSig = "";
    }
    cont = false;
    let i = 0;
    while (i < line.length) {
      const c = line[i];
      if (triple) {
        if (c === "\\") { i += 2; continue; }
        if (line.startsWith(triple, i)) { i += 3; triple = null; lastSig = '"'; continue; }
        i++;
        continue;
      }
      if (c === "#") break;
      if (c === '"' || c === "'") {
        if (line.startsWith(c.repeat(3), i)) { triple = c.repeat(3); i += 3; continue; }
        i++;
        while (i < line.length && line[i] !== c) i += line[i] === "\\" ? 2 : 1;
        i++;
        lastSig = '"';
        continue;
      }
      if (c === "(" || c === "[" || c === "{") depth++;
      else if (c === ")" || c === "]" || c === "}") depth = Math.max(0, depth - 1);
      if (c === "\\" && line.slice(i + 1).trim() === "") { cont = true; break; }
      if (c !== " " && c !== "\t") lastSig = c;
      i++;
    }
    if (cur) cur.end = n;
    if (depth === 0 && !triple && !cont && cur) {
      cur.colon = lastSig === ":";
      out.push(cur);
      cur = null;
    }
  }
  if (cur) out.push(cur);
  return out;
}

const word = (s: string) => /^[A-Za-z_]+/.exec(s)?.[0] ?? "";
const FOLLOW: Record<string, string[]> = {
  if: ["elif", "else"], elif: ["elif", "else"], for: ["else"], while: ["else"], try: ["except", "else", "finally"], except: ["except", "else", "finally"], else: ["finally"],
  with: [], def: [], class: [], async: [],
};

/** Physical line range (0-based, inclusive) of the statement containing `line0`; compound statements include their whole block. */
export function statementAt(lines: string[], line0: number): { start: number; end: number } | null {
  const ll = logicalLines(lines);
  let k = ll.findIndex((l) => l.start <= line0 && line0 <= l.end);
  if (k < 0) return null;
  const first = ll[k];
  let start = first.start;
  // decorators: run through the decorated def/class
  while (ll[k].head.startsWith("@") && k + 1 < ll.length) k++;
  let head = ll[k];
  let end = Math.max(first.end, head.end);
  if (!head.colon) return { start, end };
  for (;;) {
    let j = k + 1;
    while (j < ll.length && ll[j].indent > head.indent) { end = ll[j].end; j++; }
    const next = ll[j];
    const w = word(head.head === "async" ? head.head : head.head.replace(/^async\s+/, ""));
    if (next && next.indent === head.indent && next.colon && (FOLLOW[w] ?? []).includes(word(next.head))) {
      head = next;
      k = j;
      end = next.end;
      continue;
    }
    break;
  }
  return { start, end };
}

/** Remove the common leading indentation of the non-blank lines. */
export function dedent(text: string): string {
  const lines = text.split("\n");
  let min = Infinity;
  for (const l of lines) {
    if (!l.trim()) continue;
    min = Math.min(min, l.length - l.trimStart().length);
  }
  if (!isFinite(min) || min === 0) return text;
  return lines.map((l) => (l.trim() ? l.slice(min) : l.trimEnd())).join("\n");
}

/** The code to send for a selection / caret: selected text, else the statement at the caret line (null when the line is blank). */
export function codeToExecute(lines: string[], selectedText: string, caretLine0: number): string | null {
  if (selectedText.trim()) return dedentSelection(selectedText);
  const r = statementAt(lines, caretLine0);
  if (!r) return null;
  return dedent(lines.slice(r.start, r.end + 1).join("\n"));
}

/** A selection often starts mid-indent on the first line: pad it back so dedent sees the real indentation. */
function dedentSelection(sel: string): string {
  const t = sel.replace(/^\n+/, "").replace(/\s+$/, "");
  return dedent(t);
}
