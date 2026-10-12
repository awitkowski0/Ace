/**
 * A tolerant reader for Thematic's builder-style JS files (huds/*.js, abilities/**.js): finds every `recv.method(args)` /
 * `name(args)` call and the object / array / literal arguments it was given, with exact text offsets, so a visual editor can
 * change one value (`x: 0.04` -> `x: 0.1`) without touching anything else in the file. It is not a JS parser: anything it
 * does not understand inside an argument (expressions, constants, template strings) is kept as an opaque span.
 */

export type TokKind = "id" | "num" | "str" | "tpl" | "punc" | "re";
export interface Tok { k: TokKind; v: string; s: number; e: number }

const ID0 = /[A-Za-z_$]/;
const IDN = /[A-Za-z0-9_$]/;
const REGEX_AFTER = new Set(["(", ",", "=", ":", "[", "!", "&", "|", "?", "{", "}", ";", "+", "-", "*", "%", "<", ">", "~", "^", "=>"]);
const REGEX_AFTER_KW = new Set(["return", "typeof", "case", "do", "else", "in", "of", "new", "delete", "void", "throw"]);

export function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  const n = src.length;
  const prevAllowsRegex = () => {
    const p = out[out.length - 1];
    if (!p) return true;
    if (p.k === "punc") return REGEX_AFTER.has(p.v);
    if (p.k === "id") return REGEX_AFTER_KW.has(p.v);
    return false;
  };
  while (i < n) {
    const c = src[i];
    if (c === " " || c === "\t" || c === "\n" || c === "\r") { i++; continue; }
    if (c === "/" && src[i + 1] === "/") { while (i < n && src[i] !== "\n") i++; continue; }
    if (c === "/" && src[i + 1] === "*") { const j = src.indexOf("*/", i + 2); i = j < 0 ? n : j + 2; continue; }
    const s = i;
    if (c === '"' || c === "'") {
      i++;
      while (i < n && src[i] !== c && src[i] !== "\n") i += src[i] === "\\" ? 2 : 1;
      i = Math.min(n, i + 1);
      out.push({ k: "str", v: src.slice(s, i), s, e: i });
      continue;
    }
    if (c === "`") {
      i++;
      let depth = 0;
      while (i < n) {
        if (src[i] === "\\") { i += 2; continue; }
        if (depth === 0 && src[i] === "`") { i++; break; }
        if (src[i] === "$" && src[i + 1] === "{") { depth++; i += 2; continue; }
        if (depth > 0 && src[i] === "}") depth--;
        i++;
      }
      out.push({ k: "tpl", v: src.slice(s, i), s, e: i });
      continue;
    }
    if (/[0-9]/.test(c) || (c === "." && /[0-9]/.test(src[i + 1] ?? ""))) {
      while (i < n && /[0-9a-fA-FxXoObB._eE]/.test(src[i])) {
        if ((src[i] === "e" || src[i] === "E") && (src[i + 1] === "-" || src[i + 1] === "+")) i++;
        i++;
      }
      out.push({ k: "num", v: src.slice(s, i), s, e: i });
      continue;
    }
    if (ID0.test(c)) {
      while (i < n && IDN.test(src[i])) i++;
      out.push({ k: "id", v: src.slice(s, i), s, e: i });
      continue;
    }
    if (c === "/" && prevAllowsRegex()) {
      i++;
      let cls = false;
      while (i < n && src[i] !== "\n") {
        if (src[i] === "\\") { i += 2; continue; }
        if (src[i] === "[") cls = true;
        else if (src[i] === "]") cls = false;
        else if (src[i] === "/" && !cls) { i++; break; }
        i++;
      }
      while (i < n && /[a-z]/.test(src[i])) i++;
      out.push({ k: "re", v: src.slice(s, i), s, e: i });
      continue;
    }
    const three = src.slice(i, i + 3);
    const two = src.slice(i, i + 2);
    if (three === "..." || three === "===" || three === "!==") { out.push({ k: "punc", v: three, s, e: i + 3 }); i += 3; continue; }
    if (["=>", "==", "!=", "<=", ">=", "&&", "||", "??", "?."].includes(two)) { out.push({ k: "punc", v: two, s, e: i + 2 }); i += 2; continue; }
    out.push({ k: "punc", v: c, s, e: i + 1 });
    i++;
  }
  return out;
}

// ---------------------------------------------------------------- values

export interface Span { s: number; e: number }
export type JsValue = JsObj | JsArr | JsLit | JsFn | JsOther;
export interface JsLit extends Span { t: "lit"; value: string | number | boolean | null; raw: string }
export interface JsObj extends Span { t: "obj"; entries: JsEntry[] }
export interface JsArr extends Span { t: "arr"; items: JsValue[] }
export interface JsFn extends Span { t: "fn"; params: string[]; body: Span }
/** Anything else (an identifier, a call, an expression): kept as source. */
export interface JsOther extends Span { t: "other"; raw: string }
export interface JsEntry { key: string; keySpan: Span; value: JsValue; /** span of `key: value` */ s: number; e: number }

const OPEN: Record<string, string> = { "(": ")", "[": "]", "{": "}" };

/** Index after the bracket matching the one at `i` (tokens). */
function skipBalanced(toks: Tok[], i: number): number {
  let depth = 0;
  for (let j = i; j < toks.length; j++) {
    const v = toks[j].k === "punc" ? toks[j].v : "";
    if (v in OPEN) depth++;
    else if (v === ")" || v === "]" || v === "}") { depth--; if (depth === 0) return j + 1; }
  }
  return toks.length;
}

/** Skip one expression up to a `,` or closing bracket at depth 0. */
function skipExpr(toks: Tok[], i: number): number {
  let j = i;
  while (j < toks.length) {
    const t = toks[j];
    if (t.k === "punc") {
      if (t.v === "," || t.v === ")" || t.v === "]" || t.v === "}") return j;
      if (t.v in OPEN) { j = skipBalanced(toks, j); continue; }
    }
    j++;
  }
  return j;
}

function unquote(raw: string): string {
  const q = raw[0];
  const body = raw.slice(1, raw.endsWith(q) && raw.length > 1 ? -1 : undefined);
  return body.replace(/\\(u[0-9a-fA-F]{4}|.)/g, (_, c: string) => (c[0] === "u" ? String.fromCharCode(parseInt(c.slice(1), 16)) : c === "n" ? "\n" : c === "t" ? "\t" : c));
}

class P {
  constructor(readonly src: string, readonly toks: Tok[]) {}

  /** Parse one value starting at token `i`; returns the value and the index after it. */
  value(i: number): [JsValue, number] {
    const { toks, src } = this;
    const t = toks[i];
    if (!t) return [{ t: "other", raw: "", s: src.length, e: src.length }, i];
    // arrow functions: `x => ...`, `(a, b) => ...`, `async (...) =>`
    const fn = this.arrow(i);
    if (fn) return fn;
    if (t.k === "punc" && t.v === "{") return this.obj(i);
    if (t.k === "punc" && t.v === "[") return this.arr(i);
    const end = skipExpr(toks, i);
    if (end === i + 1) {
      if (t.k === "str") return [{ t: "lit", value: unquote(t.v), raw: t.v, s: t.s, e: t.e }, end];
      if (t.k === "num") return [{ t: "lit", value: Number(t.v), raw: t.v, s: t.s, e: t.e }, end];
      if (t.k === "id" && (t.v === "true" || t.v === "false")) return [{ t: "lit", value: t.v === "true", raw: t.v, s: t.s, e: t.e }, end];
      if (t.k === "id" && t.v === "null") return [{ t: "lit", value: null, raw: t.v, s: t.s, e: t.e }, end];
    }
    if (end === i + 2 && t.k === "punc" && t.v === "-" && toks[i + 1].k === "num") {
      const raw = src.slice(t.s, toks[i + 1].e);
      return [{ t: "lit", value: -Number(toks[i + 1].v), raw, s: t.s, e: toks[i + 1].e }, end];
    }
    const e = end > i ? toks[end - 1].e : t.s;
    return [{ t: "other", raw: src.slice(t.s, e), s: t.s, e }, end];
  }

  arrow(i: number): [JsFn, number] | null {
    const { toks } = this;
    let j = i;
    if (toks[j]?.k === "id" && toks[j].v === "async") j++;
    let params: string[] = [];
    let after: number;
    if (toks[j]?.k === "id" && toks[j + 1]?.v === "=>") {
      params = [toks[j].v];
      after = j + 2;
    } else if (toks[j]?.v === "(") {
      const close = skipBalanced(toks, j);
      if (toks[close]?.v !== "=>") return null;
      for (let k = j + 1; k < close - 1; k++) if (toks[k].k === "id" && (toks[k + 1]?.v === "," || toks[k + 1]?.v === ")" || toks[k + 1]?.v === "=")) params.push(toks[k].v);
      after = close + 1;
    } else return null;
    const b = toks[after];
    if (!b) return null;
    const end = b.v === "{" && b.k === "punc" ? skipBalanced(toks, after) : skipExpr(toks, after);
    const last = toks[end - 1] ?? b;
    return [{ t: "fn", params, body: { s: b.s, e: last.e }, s: toks[i].s, e: last.e }, end];
  }

  obj(i: number): [JsObj, number] {
    const { toks, src } = this;
    const open = toks[i];
    const entries: JsEntry[] = [];
    let j = i + 1;
    while (j < toks.length && !(toks[j].k === "punc" && toks[j].v === "}")) {
      const t = toks[j];
      if (t.k === "punc" && t.v === ",") { j++; continue; }
      if (t.k === "punc" && t.v === "...") { j = skipExpr(toks, j + 1); continue; }
      const keyTok = t;
      const key = t.k === "str" ? unquote(t.v) : t.v;
      if (toks[j + 1]?.k === "punc" && toks[j + 1].v === ":") {
        const [v, nj] = this.value(j + 2);
        entries.push({ key, keySpan: { s: keyTok.s, e: keyTok.e }, value: v, s: keyTok.s, e: v.e });
        j = nj;
      } else if (t.k === "id" && (toks[j + 1]?.v === "," || toks[j + 1]?.v === "}")) {
        // shorthand `{ x }`
        entries.push({ key, keySpan: { s: t.s, e: t.e }, value: { t: "other", raw: t.v, s: t.s, e: t.e }, s: t.s, e: t.e });
        j++;
      } else {
        j = skipExpr(toks, j + 1); // method or computed key: not editable
      }
    }
    const close = toks[j] ?? toks[toks.length - 1];
    return [{ t: "obj", entries, s: open.s, e: close ? close.e : src.length }, j + 1];
  }

  arr(i: number): [JsArr, number] {
    const { toks, src } = this;
    const open = toks[i];
    const items: JsValue[] = [];
    let j = i + 1;
    while (j < toks.length && !(toks[j].k === "punc" && toks[j].v === "]")) {
      if (toks[j].k === "punc" && toks[j].v === ",") { j++; continue; }
      const [v, nj] = this.value(j);
      items.push(v);
      j = nj === j ? j + 1 : nj;
    }
    const close = toks[j];
    return [{ t: "arr", items, s: open.s, e: close ? close.e : src.length }, j + 1];
  }
}

// ---------------------------------------------------------------- calls

export interface JsCall extends Span {
  /** `con` in `con.page(...)`; undefined for a bare `hud(...)` */
  recv?: string;
  method: string;
  args: JsValue[];
  /** span of the argument list, parens included */
  parens: Span;
}

/** Every `recv.method(...)` and bare `name(...)` call in the file, in source order. */
export function scanCalls(src: string): JsCall[] {
  const toks = tokenize(src);
  const p = new P(src, toks);
  const out: JsCall[] = [];
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (t.k !== "id" || toks[i + 1]?.v !== "(" || toks[i + 1].k !== "punc") continue;
    const prev = toks[i - 1];
    let recv: string | undefined;
    let start = t.s;
    if (prev?.k === "punc" && (prev.v === "." || prev.v === "?.")) {
      const r = toks[i - 2];
      if (!r || r.k !== "id") continue; // `foo().bar(` / `a[0].b(`: not a builder call we edit
      if (toks[i - 3]?.k === "punc" && (toks[i - 3].v === "." || toks[i - 3].v === "?.")) continue; // a.b.c(): skip
      recv = r.v;
      start = r.s;
    } else if (prev?.k === "id" && (prev.v === "function" || prev.v === "new")) continue;
    else if (["if", "for", "while", "switch", "catch", "return", "typeof", "function"].includes(t.v)) continue;
    const open = i + 1;
    const close = skipBalanced(toks, open);
    const args: JsValue[] = [];
    let j = open + 1;
    while (j < close - 1) {
      if (toks[j].k === "punc" && toks[j].v === ",") { j++; continue; }
      const [v, nj] = p.value(j);
      args.push(v);
      j = nj === j ? j + 1 : nj;
    }
    const closeTok = toks[close - 1];
    out.push({ recv, method: t.v, args, s: start, e: closeTok ? closeTok.e : src.length, parens: { s: toks[open].s, e: closeTok ? closeTok.e : src.length } });
  }
  return out;
}

export const within = (inner: Span, outer: Span) => inner.s >= outer.s && inner.e <= outer.e && (inner.s !== outer.s || inner.e !== outer.e);

/** The calls inside `fn`'s body whose receiver is the function's `param`-th parameter (default the first). */
export function callsOn(calls: JsCall[], fn: JsFn | undefined, param = 0): JsCall[] {
  if (!fn) return [];
  const name = fn.params[param];
  // inclusive: an expression body (`p => p.then("x")`) is exactly one call
  return name ? calls.filter((c) => c.recv === name && c.s >= fn.body.s && c.e <= fn.body.e) : [];
}

export const objArg = (c: JsCall): JsObj | undefined => c.args.find((a): a is JsObj => a.t === "obj");
export const fnArg = (c: JsCall): JsFn | undefined => c.args.find((a): a is JsFn => a.t === "fn");
export const strArg = (c: JsCall, i = 0): string | undefined => {
  const a = c.args[i];
  return a?.t === "lit" && typeof a.value === "string" ? a.value : undefined;
};

export function entry(o: JsObj | undefined, key: string): JsEntry | undefined {
  return o?.entries.find((e) => e.key === key);
}
export function lit(o: JsObj | undefined, key: string): string | number | boolean | null | undefined {
  const v = entry(o, key)?.value;
  return v?.t === "lit" ? v.value : undefined;
}
export function num(o: JsObj | undefined, key: string): number | undefined {
  const v = lit(o, key);
  return typeof v === "number" ? v : undefined;
}
export function str(o: JsObj | undefined, key: string): string | undefined {
  const v = lit(o, key);
  return typeof v === "string" ? v : undefined;
}
/** Plain data of a value (objects/arrays of literals); `undefined` for anything opaque inside. */
export function plain(v: JsValue | undefined): unknown {
  if (!v) return undefined;
  if (v.t === "lit") return v.value;
  if (v.t === "arr") return v.items.map(plain);
  if (v.t === "obj") return Object.fromEntries(v.entries.map((e) => [e.key, plain(e.value)]));
  return undefined;
}

// ---------------------------------------------------------------- edits

export interface TextEdit { s: number; e: number; text: string }

export function applyEdits(src: string, edits: TextEdit[]): string {
  let out = src;
  for (const e of [...edits].sort((a, b) => b.s - a.s)) out = out.slice(0, e.s) + e.text + out.slice(e.e);
  return out;
}

/** Source for a JS value, in the file's own style (double quotes unless the file prefers single). */
export function jsSource(v: unknown, quote: '"' | "'" = '"'): string {
  if (v === null) return "null";
  if (typeof v === "number") return fmtJsNum(v);
  if (typeof v === "boolean") return String(v);
  if (typeof v === "string") return quote + v.replace(/\\/g, "\\\\").replace(new RegExp(quote, "g"), "\\" + quote).replace(/\n/g, "\\n") + quote;
  if (Array.isArray(v)) return "[" + v.map((x) => jsSource(x, quote)).join(", ") + "]";
  if (typeof v === "object") return "{ " + Object.entries(v as Record<string, unknown>).map(([k, x]) => `${/^[A-Za-z_$][\w$]*$/.test(k) ? k : jsSource(k, quote)}: ${jsSource(x, quote)}`).join(", ") + " }";
  return "undefined";
}

export function fmtJsNum(v: number, dp = 4): string {
  if (!Number.isFinite(v)) return "0";
  const r = Math.round(v * 10 ** dp) / 10 ** dp;
  return Object.is(r, -0) ? "0" : String(r);
}

export const preferredQuote = (src: string): '"' | "'" => ((src.match(/"/g)?.length ?? 0) >= (src.match(/'/g)?.length ?? 0) ? '"' : "'");

/**
 * Set `key` of object literal `o` to `value` (plain data): replaces the existing value's span, or inserts `key: value` before
 * the closing brace (after a comma when needed, keeping a trailing comma style). `undefined` removes the entry.
 */
export function setProp(src: string, o: JsObj, key: string, value: unknown): TextEdit {
  const q = preferredQuote(src);
  const e = entry(o, key);
  if (value === undefined) {
    if (!e) return { s: o.s, e: o.s, text: "" };
    // remove `key: value` and one adjacent comma
    let s = e.s;
    let end = e.e;
    const after = src.slice(end).match(/^\s*,[ \t]*/);
    if (after) end += after[0].length;
    else {
      const before = src.slice(o.s + 1, s).match(/,\s*$/);
      if (before) s -= before[0].length;
    }
    return { s, e: end, text: "" };
  }
  const text = jsSource(value, q);
  if (e) return { s: e.value.s, e: e.value.e, text };
  const k = /^[A-Za-z_$][\w$]*$/.test(key) ? key : jsSource(key, q);
  const inner = src.slice(o.s + 1, o.e - 1);
  if (!inner.trim()) return { s: o.s, e: o.e, text: `{ ${k}: ${text} }` };
  // insert after the last entry (or before the closing brace)
  const last = o.entries[o.entries.length - 1];
  const tail = src.slice(last ? last.e : o.s + 1, o.e - 1);
  const anchor = last ? last.e : o.s + 1;
  const multiline = /\n/.test(inner);
  if (/^\s*,/.test(tail)) {
    // trailing comma already there: insert after it
    const m = tail.match(/^\s*,/)!;
    const indent = multiline ? (src.slice(0, last!.s).match(/\n([ \t]*)$/)?.[1] ?? "") : "";
    return { s: anchor + m[0].length, e: anchor + m[0].length, text: multiline ? `\n${indent}${k}: ${text},` : ` ${k}: ${text},` };
  }
  if (multiline && last) {
    const indent = src.slice(0, last.s).match(/\n([ \t]*)$/)?.[1];
    if (indent !== undefined) return { s: anchor, e: anchor, text: `,\n${indent}${k}: ${text}` };
  }
  return { s: anchor, e: anchor, text: `, ${k}: ${text}` };
}

/** Replace a whole value (any kind) with plain data. */
export function setValue(src: string, v: JsValue, value: unknown): TextEdit {
  return { s: v.s, e: v.e, text: jsSource(value, preferredQuote(src)) };
}
