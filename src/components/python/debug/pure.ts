/** Pure helpers for the debugger (no monaco / ipc / react imports, unit-tested in pure.test.ts). */

// ------------------------------------------------------------------ ANSI (SGR) for the Console tab
export interface AnsiStyle { fg?: string; bg?: string; bold?: boolean; dim?: boolean; italic?: boolean; underline?: boolean }
export interface Span extends AnsiStyle { t: string }

const BASIC = ["#3b4252", "#bf616a", "#a3be8c", "#ebcb8b", "#81a1c1", "#b48ead", "#88c0d0", "#e5e9f0"];
const BRIGHT = ["#4c566a", "#d57780", "#b1d196", "#f0d399", "#8cafd2", "#c895bf", "#93ccdc", "#eceff4"];
function xterm256(n: number): string {
  if (n < 8) return BASIC[n];
  if (n < 16) return BRIGHT[n - 8];
  if (n >= 232) { const v = 8 + (n - 232) * 10; return `rgb(${v},${v},${v})`; }
  const c = n - 16, lv = (x: number) => (x === 0 ? 0 : 55 + x * 40);
  return `rgb(${lv(Math.floor(c / 36))},${lv(Math.floor((c % 36) / 6))},${lv(c % 6)})`;
}

/** Applies SGR parameters to a style. */
export function applySgr(st: AnsiStyle, params: number[]): AnsiStyle {
  const s: AnsiStyle = { ...st };
  for (let i = 0; i < params.length; i++) {
    const p = params[i];
    if (p === 0) { for (const k of Object.keys(s)) delete (s as Record<string, unknown>)[k]; }
    else if (p === 1) s.bold = true;
    else if (p === 2) s.dim = true;
    else if (p === 3) s.italic = true;
    else if (p === 4) s.underline = true;
    else if (p === 22) { delete s.bold; delete s.dim; }
    else if (p === 23) delete s.italic;
    else if (p === 24) delete s.underline;
    else if (p >= 30 && p <= 37) s.fg = BASIC[p - 30];
    else if (p >= 90 && p <= 97) s.fg = BRIGHT[p - 90];
    else if (p >= 40 && p <= 47) s.bg = BASIC[p - 40];
    else if (p >= 100 && p <= 107) s.bg = BRIGHT[p - 100];
    else if (p === 39) delete s.fg;
    else if (p === 49) delete s.bg;
    else if (p === 38 || p === 48) {
      const key = p === 38 ? "fg" : "bg";
      if (params[i + 1] === 5 && params.length > i + 2) { s[key] = xterm256(params[i + 2]); i += 2; }
      else if (params[i + 1] === 2 && params.length > i + 4) { s[key] = `rgb(${params[i + 2]},${params[i + 3]},${params[i + 4]})`; i += 4; }
    }
  }
  return s;
}

/** Splits `text` into styled spans, starting from `st`. Non-SGR escape sequences are dropped. Returns the style to carry on. */
export function parseAnsi(text: string, st: AnsiStyle = {}): { spans: Span[]; st: AnsiStyle } {
  const spans: Span[] = [];
  // eslint-disable-next-line no-control-regex
  const re = /\x1b\[([0-9;:]*)([A-Za-z])|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][A-Za-z0-9]/g;
  let last = 0, m: RegExpExecArray | null;
  const push = (t: string) => { if (t) spans.push({ t, ...st }); };
  while ((m = re.exec(text))) {
    push(text.slice(last, m.index));
    last = m.index + m[0].length;
    if (m[2] === "m") st = applySgr(st, m[1] === "" ? [0] : m[1].split(/[;:]/).map((x) => parseInt(x, 10) || 0));
  }
  push(text.slice(last));
  return { spans, st };
}

// ------------------------------------------------------------------ clickable tracebacks
export type LinkPart = { t: string; path?: string; line?: number };
const LINK_RE = /File "([^"\n]+)", line (\d+)|((?:\/|[A-Za-z]:\\)[^\s:'"()<>|*?]*\.py[a-z]?):(\d+)/g;
/** Splits console text into plain parts and `File "x.py", line N` / `/abs/path.py:N` links. */
export function splitLinks(text: string): LinkPart[] {
  const out: LinkPart[] = [];
  let last = 0, m: RegExpExecArray | null;
  LINK_RE.lastIndex = 0;
  while ((m = LINK_RE.exec(text))) {
    const path = m[1] ?? m[3], line = parseInt(m[2] ?? m[4], 10);
    if (m.index > last) out.push({ t: text.slice(last, m.index) });
    // for File "x", line N only the quoted path + line part is the link, not the leading `File `
    out.push({ t: m[0], path, line });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ t: text.slice(last) });
  return out;
}

// ------------------------------------------------------------------ variable paging
export const PAGE = 100;
export interface VarRange { start: number; len: number }
/** Sub-ranges of an indexed container of `len` items starting at `start` (IntelliJ shows [0..99], [100..199] ...). */
export function subRanges(start: number, len: number): VarRange[] {
  if (len <= PAGE) return [{ start, len }];
  const size = Math.pow(10, Math.ceil(Math.log10(len)) - 1);
  const out: VarRange[] = [];
  for (let s = 0; s < len; s += size) out.push({ start: start + s, len: Math.min(size, len - s) });
  return out;
}
export const rangeLabel = (r: VarRange) => `[${r.start}..${r.start + r.len - 1}]`;

export const SPECIAL_GROUPS = new Set(["special variables", "function variables", "class variables", "protected variables", "private variables"]);
export const isGroupVar = (name: string, value: string) => SPECIAL_GROUPS.has(name) && value === "";

export function shortValue(v: string, n = 200): string {
  const one = v.replace(/\s+/g, " ");
  return one.length > n ? one.slice(0, n - 1) + "…" : one;
}

// ------------------------------------------------------------------ inline values (grey text after code lines)
const SKIP_TYPES = new Set(["function", "type", "module", "builtin_function_or_method", "method", "classmethod", "staticmethod", "property", "method-wrapper"]);
export interface LocalVal { name: string; value: string; type?: string }

/** Code of a line without comments and string contents (so `"x"` / `# x` do not count as uses of x). */
export function codeOnly(line: string): string {
  let out = "", q = "";
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === "\\") { i++; continue; }
      if (c === q) { q = ""; out += c; }
      continue;
    }
    if (c === "#") break;
    if (c === '"' || c === "'") { q = c; out += c; continue; }
    out += c;
  }
  return out;
}
const indentOf = (s: string) => s.length - s.trimStart().length;

/** First line of the function / class the `cur` line (1-based) belongs to; module level gets a bounded window. */
export function scopeStart(lines: string[], cur: number): number {
  let ind = indentOf(lines[cur - 1] ?? "");
  if (!(lines[cur - 1] ?? "").trim()) ind = 1e9;
  if (ind === 0) return Math.max(1, cur - 60);
  for (let i = cur - 2; i >= 0 && i >= cur - 400; i--) {
    const t = lines[i].trim();
    if (!t) continue;
    if (indentOf(lines[i]) < ind && /^(async\s+def|def|class)\s/.test(t)) return i + 1;
  }
  return Math.max(1, cur - 60);
}

export function inlineValues(lines: string[], cur: number, locals: LocalVal[], opts: { maxValue?: number } = {}): { line: number; text: string }[] {
  const max = opts.maxValue ?? 30;
  const byName = new Map<string, LocalVal>();
  for (const v of locals) {
    if (v.name.startsWith("__") || v.name === "self" || v.name === "cls" || isGroupVar(v.name, v.value)) continue;
    if (v.type && SKIP_TYPES.has(v.type)) continue;
    byName.set(v.name, v);
  }
  if (!byName.size) return [];
  const out: { line: number; text: string }[] = [];
  for (let ln = scopeStart(lines, cur); ln <= Math.min(cur, lines.length); ln++) {
    const code = codeOnly(lines[ln - 1]);
    const seen = new Set<string>();
    const parts: string[] = [];
    const re = /(?<![\w.])[A-Za-z_]\w*/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(code))) {
      const v = byName.get(m[0]);
      if (!v || seen.has(v.name)) continue;
      seen.add(v.name);
      parts.push(`${v.name} = ${shortValue(v.value, max)}`);
    }
    if (parts.length) out.push({ line: ln, text: parts.join(", ") });
  }
  return out;
}

// ------------------------------------------------------------------ hover expression
const PY_KEYWORDS = new Set(["and", "as", "assert", "async", "await", "break", "class", "continue", "def", "del", "elif", "else", "except", "finally", "for", "from", "global", "if", "import", "in", "is", "lambda", "nonlocal", "not", "or", "pass", "raise", "return", "try", "while", "with", "yield"]);
/** The attribute chain (`a.b.c`) around 1-based column `col`, up to the identifier under the cursor. */
export function hoverExpression(lineText: string, col: number): { expr: string; startCol: number; endCol: number } | null {
  const idx = col - 1;
  const isId = (c: string | undefined) => !!c && /[A-Za-z0-9_]/.test(c);
  if (!isId(lineText[idx]) && !isId(lineText[idx - 1])) return null;
  let e = idx;
  while (isId(lineText[e])) e++;
  let s = idx;
  while (s > 0 && isId(lineText[s - 1])) s--;
  const word = lineText.slice(s, e);
  if (!word || /^\d/.test(word) || PY_KEYWORDS.has(word)) return null;
  // extend left across `.name` links
  let start = s;
  for (;;) {
    if (lineText[start - 1] !== ".") break;
    let p = start - 1;
    const end = p;
    while (p > 0 && isId(lineText[p - 1])) p--;
    if (p === end || /^\d/.test(lineText.slice(p, end))) break;
    start = p;
  }
  const expr = lineText.slice(start, e);
  return { expr, startCol: start + 1, endCol: e + 1 };
}

// ------------------------------------------------------------------ breakpoints (data)
export interface Bp {
  id: string;
  path: string;
  line: number;
  enabled: boolean;
  condition?: string;
  logMessage?: string;
  hitCount?: string;
}
export interface ExceptionBps { raised: boolean; uncaught: boolean; userUnhandled: boolean }
export const DEFAULT_EXCEPTIONS: ExceptionBps = { raised: false, uncaught: false, userUnhandled: false };

/** What a DAP setBreakpoints request carries for the enabled breakpoints of one file. */
export function dapBreakpoints(list: Bp[], path: string) {
  return list
    .filter((b) => b.path === path && b.enabled)
    .sort((a, b) => a.line - b.line)
    .map((b) => ({
      line: b.line,
      ...(b.condition?.trim() ? { condition: b.condition.trim() } : {}),
      ...(b.logMessage?.trim() ? { logMessage: b.logMessage.trim() } : {}),
      ...(b.hitCount?.trim() ? { hitCondition: b.hitCount.trim() } : {}),
    }));
}
export function dapExceptionFilters(e: ExceptionBps, supported?: string[]): string[] {
  const f: string[] = [];
  if (e.raised) f.push("raised");
  if (e.uncaught) f.push("uncaught");
  if (e.userUnhandled) f.push("userUnhandled");
  return supported ? f.filter((x) => supported.includes(x)) : f;
}

/** Exit code text for the console: `Process finished with exit code N` (signals as -N like PyCharm). */
export const exitText = (code: number | null, signal: number | null) =>
  `Process finished with exit code ${code ?? (signal ? -signal : 0)}`;
