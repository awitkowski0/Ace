/**
 * IntelliJ-style "speed search" core: pure matcher + navigation state machine (no React, no DOM).
 * The React side is `components/shell/speedSearch.tsx` (hook, popup, <Highlight>).
 *
 * Matcher = IntelliJ NameUtil with a leading '*' (what SpeedSearchComparator builds):
 *  - case-insensitive;
 *  - each pattern char continues the previous one (contiguous fragment) OR starts at a "word start"
 *    (camel hump, char after `_ - . / space`, letter after digit, digit after letter) further right;
 *  - the first char may match anywhere (the implicit leading `*`), word starts are preferred;
 *  - `*` (and space) in the pattern lets the next char match anywhere to the right;
 *  - an uppercase pattern char must land on a word start.
 */

export type Range = [start: number, end: number]; // [start, end)

const isUpper = (c: string) => c !== c.toLowerCase() && c === c.toUpperCase();
const isLower = (c: string) => c !== c.toUpperCase();
const isDigit = (c: string) => c >= "0" && c <= "9";
const isAlnum = (c: string) => isDigit(c) || isUpper(c) || isLower(c) || c.toLowerCase() !== c.toUpperCase();

/** True when `i` begins a word/hump in `s`. */
export function isWordStart(s: string, i: number): boolean {
  if (i === 0) return true;
  const c = s[i], p = s[i - 1];
  if (!isAlnum(c)) return false;
  if (!isAlnum(p)) return true;
  if (isUpper(c) && !isUpper(p)) return true; // fooBar, foo1Bar
  if (isUpper(c) && isUpper(p) && i + 1 < s.length && isLower(s[i + 1])) return true; // XMLParser -> P
  if (isDigit(c) !== isDigit(p)) return true; // foo2bar
  return false;
}

type Tok = { c: string; any: boolean; upper: boolean }; // any = may match anywhere right of the previous char

function tokenize(pattern: string): Tok[] {
  const toks: Tok[] = [];
  let any = false;
  for (const ch of pattern) {
    if (ch === "*" || ch === " ") { any = true; continue; }
    toks.push({ c: ch.toLowerCase(), any, upper: isUpper(ch) });
    any = false;
  }
  return toks;
}

/** Match ranges of `pattern` in `text`, or null. Empty pattern matches with no ranges. */
export function matchName(pattern: string, text: string): Range[] | null {
  const toks = tokenize(pattern);
  if (!toks.length) return [];
  const n = text.length;
  if (toks.length > n) return null;
  const low = text.toLowerCase();
  // cheap reject: pattern must be a case-insensitive subsequence
  { let k = 0; for (let i = 0; i < n && k < toks.length; i++) if (low[i] === toks[k].c) k++; if (k < toks.length) return null; }

  const starts: boolean[] = new Array(n);
  for (let i = 0; i < n; i++) starts[i] = isWordStart(text, i);
  const failed = new Set<number>();
  const picked: number[] = new Array(toks.length);

  // pi = token to place, from = lowest allowed text index, prev = index of previous matched char (-1 = none)
  const go = (pi: number, from: number, prev: number, firstPass: boolean): boolean => {
    if (pi === toks.length) return true;
    const key = pi * (n + 1) * 2 + from * 2 + (firstPass ? 1 : 0);
    if (failed.has(key)) return false;
    const t = toks[pi];
    const free = pi === 0 || t.any || !isAlnum(t.c);
    // contiguous continuation first
    if (prev >= 0 && !t.any && from === prev + 1 && low[from] === t.c && (!t.upper || starts[from])) {
      picked[pi] = from;
      if (go(pi + 1, from + 1, from, firstPass)) return true;
    }
    for (let j = from; j < n; j++) {
      if (low[j] !== t.c) continue;
      if (prev >= 0 && j === prev + 1 && !t.any) continue; // tried above
      const ok = free ? (pi === 0 && firstPass ? starts[j] || !isAlnum(t.c) : true) : starts[j];
      if (!ok) continue;
      if (t.upper && !starts[j]) continue;
      picked[pi] = j;
      if (go(pi + 1, j + 1, j, firstPass)) return true;
    }
    failed.add(key);
    return false;
  };

  if (!go(0, 0, -1, true)) { failed.clear(); if (!go(0, 0, -1, false)) return null; }
  const out: Range[] = [];
  for (const i of picked) {
    const last = out[out.length - 1];
    if (last && last[1] === i) last[1] = i + 1;
    else out.push([i, i + 1]);
  }
  return out;
}

/** Row indices of `texts` matching `pattern` (optionally only among `candidates`) with their ranges. */
export function matchAll(pattern: string, texts: ArrayLike<string>, candidates?: Iterable<number>): Map<number, Range[]> {
  const out = new Map<number, Range[]>();
  if (!pattern) return out;
  if (candidates) { for (const i of candidates) { const r = matchName(pattern, texts[i]); if (r) out.set(i, r); } }
  else for (let i = 0; i < texts.length; i++) { const r = matchName(pattern, texts[i]); if (r) out.set(i, r); }
  return out;
}

// ---- navigation state machine -------------------------------------------------------------------------------------

export interface SSState { active: boolean; query: string }
export const SS_IDLE: SSState = { active: false, query: "" };

export interface SSKey { key: string; metaKey?: boolean; ctrlKey?: boolean; altKey?: boolean; shiftKey?: boolean }

/** A key that starts or extends a search: one printable char, no ⌘/⌃/⌥. Space only extends (never starts). */
export function isPrintable(e: SSKey): boolean {
  return e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey && e.key >= " " && e.key !== "\x7f";
}
export function startsSearch(e: SSKey): boolean { return isPrintable(e) && e.key !== " "; }

/** Keys speed search consumes while active (the dispatcher yields bare-key actions for these). */
export function speedSearchWants(s: SSState, e: SSKey): boolean {
  if (e.metaKey || e.ctrlKey || e.altKey) return false;
  if (!s.active) return startsSearch(e);
  return isPrintable(e) || ["Backspace", "Enter", "Escape", "ArrowUp", "ArrowDown", "Home", "End"].includes(e.key);
}

export interface SSEnv {
  /** sorted row indices that match `state.query` (after the key is applied: use `matchesFor`) */
  matchesFor: (query: string) => number[];
  /** current selected row index (-1 none) */
  sel: number;
}
export interface SSResult {
  state: SSState;
  select: number | null; // row to select + scroll to
  activate: boolean; // Enter: open the selection (state is closed)
  handled: boolean; // preventDefault + stopPropagation
}

/** First match at/after `sel` (wrapping); `sel < 0` -> first. Null when none. */
export function firstFrom(ms: number[], sel: number): number | null {
  if (!ms.length) return null;
  for (const m of ms) if (m >= sel) return m;
  return ms[0];
}
function nextAfter(ms: number[], sel: number): number | null {
  if (!ms.length) return null;
  for (const m of ms) if (m > sel) return m;
  return ms[0];
}
function prevBefore(ms: number[], sel: number): number | null {
  if (!ms.length) return null;
  for (let i = ms.length - 1; i >= 0; i--) if (ms[i] < sel) return ms[i];
  return ms[ms.length - 1];
}

/** One key through the speed-search state machine (IntelliJ semantics). */
export function stepSpeedSearch(s: SSState, e: SSKey, env: SSEnv): SSResult {
  const none = (state: SSState, handled = false): SSResult => ({ state, select: null, activate: false, handled });
  if (!s.active) {
    if (!startsSearch(e)) return none(s);
    const q = e.key;
    return { state: { active: true, query: q }, select: firstFrom(env.matchesFor(q), env.sel), activate: false, handled: true };
  }
  if (isPrintable(e)) {
    const q = s.query + e.key;
    return { state: { active: true, query: q }, select: firstFrom(env.matchesFor(q), env.sel), activate: false, handled: true };
  }
  if (e.metaKey || e.ctrlKey || e.altKey) return none(SS_IDLE); // some other shortcut: search ends, key passes through
  switch (e.key) {
    case "Escape": return none(SS_IDLE, true);
    case "Enter": return { state: SS_IDLE, select: null, activate: true, handled: true };
    case "Backspace": {
      const q = s.query.slice(0, -1);
      if (!q) return none(SS_IDLE, true);
      return { state: { active: true, query: q }, select: firstFrom(env.matchesFor(q), env.sel), activate: false, handled: true };
    }
    case "ArrowDown": return { state: s, select: nextAfter(env.matchesFor(s.query), env.sel), activate: false, handled: true };
    case "ArrowUp": return { state: s, select: prevBefore(env.matchesFor(s.query), env.sel), activate: false, handled: true };
    case "Home": { const m = env.matchesFor(s.query); return { state: s, select: m.length ? m[0] : null, activate: false, handled: true }; }
    case "End": { const m = env.matchesFor(s.query); return { state: s, select: m.length ? m[m.length - 1] : null, activate: false, handled: true }; }
    default: return none(SS_IDLE); // arrows left/right, Tab, F-keys...: close and let the tree handle it
  }
}

// ---- global "is a speed search live" flag (the key dispatcher consults it) ------------------------------------------

let liveCount = 0;
export const setSpeedSearchLive = (on: boolean) => { liveCount = Math.max(0, liveCount + (on ? 1 : -1)); };
/** True while some tree has an active speed search: bare-key tool-window actions must yield to it. */
export const isSpeedSearchLive = () => liveCount > 0;
