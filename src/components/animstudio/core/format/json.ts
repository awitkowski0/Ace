/**
 * Format-preserving JSON.
 *
 * `parseJson(text)` builds a tree whose containers remember the exact source span they came from
 * (`src`). `emitJson` re-emits a tree: a container that still has its `src` (and sits at the same nesting
 * depth) is copied verbatim from the original text, so an untouched subtree is byte-identical. A container
 * that was edited (a fresh node made by `jobj`/`jarr`/`derive`) is re-laid-out using the formatting of the
 * container it derives from (`like`): multi-line vs inline, the `", "` / `","` separator, `": "` colon and
 * bracket padding, so a changed keyframe re-emits as one inline line in a file that writes them inline.
 * File-wide things (indent unit, newline, minified, trailing text) come from `detectStyle`.
 *
 * Leaves keep their `raw` source text; a leaf made by `jnum`/`jstr` has none and is formatted minimally.
 */

export interface Src {
  text: string;
  start: number;
  end: number;
  /** Nesting depth (root container = 0). Verbatim reuse is only valid at the same depth. */
  depth: number;
  /** End offset of the first child (-1 when empty); used to learn separators lazily. */
  a: number;
}

export interface JEntry {
  key: string;
  /** Raw key text including quotes, when it came from source. */
  keyRaw?: string;
  value: JNode;
}
export interface JObj {
  t: "o";
  entries: JEntry[];
  src?: Src;
  like?: Src;
}
export interface JArr {
  t: "a";
  items: JNode[];
  src?: Src;
  like?: Src;
}
export interface JStr {
  t: "s";
  value: string;
  raw?: string;
}
export interface JNum {
  t: "n";
  value: number;
  raw?: string;
}
export interface JLit {
  t: "l";
  value: boolean | null;
}
export type JNode = JObj | JArr | JStr | JNum | JLit;
export type JContainer = JObj | JArr;

export class JsonParseError extends Error {
  constructor(message: string, public offset: number) {
    super(`${message} at offset ${offset}`);
  }
}

export interface ParsedJson {
  root: JNode;
  /** Offset where the root value starts (after BOM/whitespace) and ends. */
  start: number;
  end: number;
  text: string;
}

const WS = (c: number) => c === 32 || c === 10 || c === 13 || c === 9;

export function parseJson(text: string): ParsedJson {
  let i = 0;
  const n = text.length;
  const skip = () => {
    while (i < n) {
      const c = text.charCodeAt(i);
      if (c === 32 || c === 10 || c === 13 || c === 9 || c === 0xfeff) i++;
      else break;
    }
  };
  const fail = (m: string): never => {
    throw new JsonParseError(m, i);
  };
  const str = (): { value: string; raw: string } => {
    const s = i;
    i++; // opening quote
    let esc = false;
    for (;;) {
      if (i >= n) fail("unterminated string");
      const c = text.charCodeAt(i);
      if (c === 34) break;
      if (c === 92) {
        esc = true;
        i += 2;
      } else i++;
    }
    i++;
    const raw = text.slice(s, i);
    return { value: esc ? (JSON.parse(raw) as string) : raw.slice(1, -1), raw };
  };
  const value = (depth: number): JNode => {
    skip();
    const c = text.charCodeAt(i);
    if (c === 123) {
      const start = i;
      i++;
      const entries: JEntry[] = [];
      let a = -1;
      skip();
      if (text.charCodeAt(i) === 125) {
        i++;
      } else {
        for (;;) {
          skip();
          if (text.charCodeAt(i) !== 34) fail("expected key");
          const k = str();
          skip();
          if (text.charCodeAt(i) !== 58) fail("expected ':'");
          i++;
          const v = value(depth + 1);
          entries.push({ key: k.value, keyRaw: k.raw, value: v });
          if (a < 0) a = i;
          skip();
          const d = text.charCodeAt(i);
          i++;
          if (d === 125) break;
          if (d !== 44) {
            i--;
            fail("expected ',' or '}'");
          }
        }
      }
      return { t: "o", entries, src: { text, start, end: i, depth, a } };
    }
    if (c === 91) {
      const start = i;
      i++;
      const items: JNode[] = [];
      let a = -1;
      skip();
      if (text.charCodeAt(i) === 93) {
        i++;
      } else {
        for (;;) {
          items.push(value(depth + 1));
          if (a < 0) a = i;
          skip();
          const d = text.charCodeAt(i);
          i++;
          if (d === 93) break;
          if (d !== 44) {
            i--;
            fail("expected ',' or ']'");
          }
        }
      }
      return { t: "a", items, src: { text, start, end: i, depth, a } };
    }
    if (c === 34) {
      const s = str();
      return { t: "s", value: s.value, raw: s.raw };
    }
    if (c === 116 && text.startsWith("true", i)) {
      i += 4;
      return { t: "l", value: true };
    }
    if (c === 102 && text.startsWith("false", i)) {
      i += 5;
      return { t: "l", value: false };
    }
    if (c === 110 && text.startsWith("null", i)) {
      i += 4;
      return { t: "l", value: null };
    }
    const s = i;
    while (i < n) {
      const d = text.charCodeAt(i);
      if ((d >= 48 && d <= 57) || d === 45 || d === 43 || d === 46 || d === 101 || d === 69) i++;
      else break;
    }
    if (s === i) fail("unexpected character");
    const raw = text.slice(s, i);
    const num = Number(raw);
    if (Number.isNaN(num)) fail("bad number");
    return { t: "n", value: num, raw };
  };
  skip();
  const start = i;
  const root = value(0);
  const end = i;
  skip();
  if (i < n) fail("trailing content");
  return { root, start, end, text };
}

// ---------------------------------------------------------------- styles

export interface FileStyle {
  /** Newline sequence. */
  nl: string;
  /** One indent level ("\t", "  ", "    "). */
  indent: string;
  minified: boolean;
  /** `": "` / `":"`. */
  colon: string;
  /** Separator between inline items after the comma, e.g. `" "` or `""`. */
  inlineSep: string;
  /** Numeric arrays are written one element per line (Gson pretty printing). */
  numArrayMl: boolean;
  /** Text after the root value (usually "\n" or ""). */
  tail: string;
  /** Text before the root value (BOM etc). */
  head: string;
}

export function detectStyle(text: string, rootStart = 0, rootEnd = text.length): FileStyle {
  const body = text.slice(rootStart, rootEnd);
  const crlf = body.includes("\r\n");
  const nl = crlf ? "\r\n" : "\n";
  const minified = !body.includes("\n");
  let indent = "  ";
  const m = /\n([ \t]+)\S/.exec(body);
  if (m) indent = m[1].startsWith("\t") ? "\t" : m[1];
  const sample = body.slice(0, 120000);
  const cm = /"(?:[^"\\]|\\.)*"([ \t]*:[ \t]*)/.exec(sample);
  const colon = cm ? cm[1] : minified ? ":" : ": ";
  const sm = /[\d"](,[ ]?)[-\d"]/.exec(sample);
  const inlineSep = sm ? sm[1].slice(1) : minified ? "" : " ";
  let ml = 0;
  let inl = 0;
  const re = /\[\s*-?\d[^[\]{}"]*\]/g;
  let mm: RegExpExecArray | null;
  while ((mm = re.exec(sample)) && ml + inl < 60) {
    if (!mm[0].includes(",")) continue;
    if (mm[0].includes("\n")) ml++;
    else inl++;
  }
  return {
    nl,
    indent,
    minified,
    colon,
    inlineSep,
    numArrayMl: ml > inl,
    tail: text.slice(rootEnd),
    head: text.slice(0, rootStart),
  };
}

interface CStyle {
  ml: boolean;
  sep: string; // after comma when inline
  colon: string | null;
  padOpen: string;
  padClose: string;
}
const styleCache = new WeakMap<Src, CStyle>();

function containerStyle(src: Src, isObj: boolean): CStyle {
  const hit = styleCache.get(src);
  if (hit) return hit;
  const t = src.text;
  const skipWs = (p: number) => {
    while (p < src.end && WS(t.charCodeAt(p))) p++;
    return p;
  };
  const first = skipWs(src.start + 1);
  const gapOpen = t.slice(src.start + 1, first);
  const ml = gapOpen.includes("\n");
  let close = src.end - 1;
  while (close > first && WS(t.charCodeAt(close - 1))) close--;
  const padClose = t.slice(close, src.end - 1);
  let sep: string | null = null;
  if (src.a >= 0) {
    let p = skipWs(src.a);
    if (t.charCodeAt(p) === 44) {
      const q = skipWs(p + 1);
      sep = t.slice(p + 1, q);
    }
  }
  let colon: string | null = null;
  if (isObj && first < src.end - 1 && t.charCodeAt(first) === 34) {
    let p = first + 1;
    while (t.charCodeAt(p) !== 34) p += t.charCodeAt(p) === 92 ? 2 : 1;
    p++;
    const q = p;
    p = skipWs(p);
    if (t.charCodeAt(p) === 58) {
      p = skipWs(p + 1);
      colon = t.slice(q, p);
    }
  }
  const st: CStyle = {
    ml,
    sep: sep ?? " ",
    colon,
    padOpen: ml ? "" : gapOpen,
    padClose: ml ? "" : padClose,
  };
  styleCache.set(src, st);
  return st;
}

// ---------------------------------------------------------------- constructors

export function jnum(v: number, dp = 4): JNum {
  return { t: "n", value: v, raw: fmtNum(v, dp) };
}
export function jstr(v: string): JStr {
  return { t: "s", value: v };
}
export function jbool(v: boolean): JLit {
  return { t: "l", value: v };
}
export function jnull(): JLit {
  return { t: "l", value: null };
}
export function jarr(items: JNode[], like?: JNode | Src): JArr {
  return { t: "a", items, like: srcOf(like) };
}
export function jobj(entries: JEntry[] | Array<[string, JNode]>, like?: JNode | Src): JObj {
  return {
    t: "o",
    entries: entries.map((e) => (Array.isArray(e) ? { key: e[0], value: e[1] } : e)),
    like: srcOf(like),
  };
}
function srcOf(like?: JNode | Src): Src | undefined {
  if (!like) return undefined;
  if ("text" in like) return like;
  return like.t === "o" || like.t === "a" ? like.src ?? like.like : undefined;
}
/** New container node with new children but the formatting of `node`. */
export function derive<T extends JContainer>(node: T, children: T extends JObj ? JEntry[] : JNode[]): T {
  const like = node.src ?? node.like;
  return (node.t === "o" ? { t: "o", entries: children, like } : { t: "a", items: children, like }) as T;
}

/** Minimal number text: rounded to `dp` places, integers bare, no exponent, no "-0". */
export function fmtNum(v: number, dp = 4): string {
  if (!Number.isFinite(v)) return "0";
  const f = 10 ** dp;
  let r = Math.round(v * f) / f;
  if (Object.is(r, -0) || Math.abs(r) < 0.5 / f) r = 0;
  let s = String(r);
  if (s.includes("e")) s = r.toFixed(dp).replace(/\.?0+$/, "");
  return s;
}
/** Keyframe time key: whole seconds "0.0", otherwise minimal decimals ("0.0833", "4.5833"). */
export function fmtTime(t: number): string {
  const r = Math.round(t * 10000) / 10000;
  if (Number.isInteger(r)) return r.toFixed(1);
  return fmtNum(r, 4);
}

// ---------------------------------------------------------------- accessors

export const isObj = (n: JNode | undefined): n is JObj => !!n && n.t === "o";
export const isArr = (n: JNode | undefined): n is JArr => !!n && n.t === "a";
export const isNum = (n: JNode | undefined): n is JNum => !!n && n.t === "n";
export const isStr = (n: JNode | undefined): n is JStr => !!n && n.t === "s";

export function getKey(o: JObj | undefined, key: string): JNode | undefined {
  if (!o) return undefined;
  const es = o.entries;
  for (let i = 0; i < es.length; i++) if (es[i].key === key) return es[i].value;
  return undefined;
}
export function numOf(n: JNode | undefined, d: number): number;
export function numOf(n: JNode | undefined): number | undefined;
export function numOf(n: JNode | undefined, d?: number): number | undefined {
  return n && n.t === "n" ? n.value : d;
}
export function strOf(n: JNode | undefined): string | undefined {
  return n && n.t === "s" ? n.value : undefined;
}
export function numsOf(n: JNode | undefined): number[] | undefined {
  if (!n || n.t !== "a") return undefined;
  const out: number[] = [];
  for (const it of n.items) {
    if (it.t !== "n") return undefined;
    out.push(it.value);
  }
  return out;
}

/** Plain JS value of a node (loses formatting). Integer-like keys keep insertion order only in `entries`. */
export function toValue(n: JNode): unknown {
  switch (n.t) {
    case "o": {
      const o: Record<string, unknown> = {};
      for (const e of n.entries) o[e.key] = toValue(e.value);
      return o;
    }
    case "a":
      return n.items.map(toValue);
    default:
      return n.value;
  }
}
export function fromValue(v: unknown, like?: JNode | Src, dp = 4): JNode {
  if (v === null) return jnull();
  if (typeof v === "number") return jnum(v, dp);
  if (typeof v === "string") return jstr(v);
  if (typeof v === "boolean") return jbool(v);
  if (Array.isArray(v)) return jarr(v.map((x) => fromValue(x, undefined, dp)), like);
  if (typeof v === "object") {
    return jobj(
      Object.entries(v as object)
        .filter(([, x]) => x !== undefined)
        .map(([k, x]) => ({ key: k, value: fromValue(x, undefined, dp) })),
      like,
    );
  }
  throw new Error("unsupported value");
}

// ---------------------------------------------------------------- immutable edits

export type Path = Array<string | number>;

export function getIn(root: JNode | undefined, path: Path): JNode | undefined {
  let cur = root;
  for (const p of path) {
    if (!cur) return undefined;
    if (cur.t === "o") cur = getKey(cur, String(p));
    else if (cur.t === "a") cur = cur.items[Number(p)];
    else return undefined;
  }
  return cur;
}

/** Replace/insert/delete (`value === undefined`) a direct entry. Position kept on replace; appended on insert. */
export function setEntry(o: JObj, key: string, value: JNode | undefined, before?: (k: string) => boolean): JObj {
  const es = o.entries;
  const idx = es.findIndex((e) => e.key === key);
  if (idx >= 0) {
    if (value === undefined) return derive(o, [...es.slice(0, idx), ...es.slice(idx + 1)]);
    if (es[idx].value === value) return o;
    const copy = es.slice();
    copy[idx] = { key, keyRaw: es[idx].keyRaw, value };
    return derive(o, copy);
  }
  if (value === undefined) return o;
  const ne: JEntry = { key, value };
  if (before) {
    const at = es.findIndex((e) => before(e.key));
    if (at >= 0) return derive(o, [...es.slice(0, at), ne, ...es.slice(at)]);
  }
  return derive(o, [...es, ne]);
}

/** Immutable set along a path; missing intermediate objects are created (like the parent's formatting). */
export function setIn(root: JNode, path: Path, value: JNode | undefined): JNode {
  if (path.length === 0) return value ?? root;
  const [h, ...rest] = path;
  if (root.t === "o") {
    const key = String(h);
    const child = getKey(root, key);
    if (rest.length === 0) return setEntry(root, key, value);
    if (!child) {
      if (value === undefined) return root;
      return setEntry(root, key, setIn(jobj([], root), rest, value));
    }
    const nc = setIn(child, rest, value);
    return nc === child ? root : setEntry(root, key, nc);
  }
  if (root.t === "a") {
    const idx = Number(h);
    const items = root.items.slice();
    if (rest.length === 0) {
      if (value === undefined) items.splice(idx, 1);
      else items[idx] = value;
    } else {
      const nc = setIn(items[idx], rest, value);
      if (nc === items[idx]) return root;
      items[idx] = nc;
    }
    return derive(root, items);
  }
  throw new Error("setIn: cannot descend into a leaf");
}

// ---------------------------------------------------------------- emitter

export function emitJson(root: JNode, style: FileStyle): string {
  const out: string[] = [];
  emit(root, 0, false, style, out);
  return out.join("");
}

/** Whole-file serialization: head + emitted root + tail, where an untouched root returns the original text. */
export function serializeParsed(root: JNode, style: FileStyle, original: string, start: number, end: number): string {
  if ((root.t === "o" || root.t === "a") && root.src && root.src.depth === 0 && root.src.start === start && root.src.end === end) {
    return original;
  }
  return style.head + emitJson(root, style) + style.tail;
}

const isLeaf = (n: JNode) => n.t !== "o" && n.t !== "a";

function emit(node: JNode, depth: number, inline: boolean, fs: FileStyle, out: string[]): void {
  switch (node.t) {
    case "s":
      out.push(node.raw ?? JSON.stringify(node.value));
      return;
    case "n":
      out.push(node.raw ?? fmtNum(node.value, 5));
      return;
    case "l":
      out.push(String(node.value));
      return;
  }
  if (node.src && node.src.depth === depth) {
    out.push(node.src.text.slice(node.src.start, node.src.end));
    return;
  }
  const isO = node.t === "o";
  const count = isO ? node.entries.length : node.items.length;
  if (count === 0) {
    out.push(isO ? "{}" : "[]");
    return;
  }
  const like = node.src ?? node.like;
  let ml: boolean;
  let sep = fs.inlineSep;
  let colon = fs.colon;
  let padOpen = "";
  let padClose = "";
  if (like) {
    const st = containerStyle(like, isO);
    ml = st.ml;
    sep = st.sep;
    if (st.colon !== null) colon = st.colon;
    padOpen = st.padOpen;
    padClose = st.padClose;
    if (fs.minified) ml = false;
  } else if (fs.minified || inline) {
    ml = false;
  } else if (isO) {
    ml = true;
  } else {
    ml = !(node as JArr).items.every(isLeaf) || ((node as JArr).items.some((x) => x.t === "n") && fs.numArrayMl);
  }
  const open = isO ? "{" : "[";
  const close = isO ? "}" : "]";
  out.push(open);
  const ind1 = ml ? fs.nl + fs.indent.repeat(depth + 1) : "";
  if (ml) out.push(ind1);
  else out.push(padOpen);
  const join = ml ? "," + ind1 : "," + sep;
  if (isO) {
    const es = (node as JObj).entries;
    for (let i = 0; i < es.length; i++) {
      if (i) out.push(join);
      out.push(es[i].keyRaw ?? JSON.stringify(es[i].key), colon);
      emit(es[i].value, depth + 1, !ml, fs, out);
    }
  } else {
    const its = (node as JArr).items;
    for (let i = 0; i < its.length; i++) {
      if (i) out.push(join);
      emit(its[i], depth + 1, !ml, fs, out);
    }
  }
  if (ml) out.push(fs.nl + fs.indent.repeat(depth));
  else out.push(padClose);
  out.push(close);
}
