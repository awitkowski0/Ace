/**
 * Console output model: ANSI SGR colours, \r handling, bounded line storage, and the `\x1e##ace:{json}` control-line filter
 * (the pytest / unittest plugins write test events on stdout; they never reach the console text).
 */
export type Kind = "out" | "err" | "in" | "sys";
export interface Span {
  t: string;
  fg?: string;
  bg?: string;
  b?: boolean;
  d?: boolean;
  i?: boolean;
  u?: boolean;
  k?: Kind;
}
export interface Line { spans: Span[]; len: number }

export const MAX_LINES = 20000;
const TRIM_BATCH = 2000;
const MAX_LINE_LEN = 20000;

const BASIC = ["#4c566a", "#bf616a", "#a3be8c", "#ebcb8b", "#81a1c1", "#b48ead", "#88c0d0", "#e5e9f0"];
const BRIGHT = ["#7b88a1", "#d57780", "#b4d09e", "#f0d399", "#97b4d0", "#c895bf", "#8fbcbb", "#eceff4"];
function color256(n: number): string {
  if (n < 8) return BASIC[n];
  if (n < 16) return BRIGHT[n - 8];
  if (n < 232) {
    const c = n - 16;
    const v = (x: number) => (x === 0 ? 0 : 55 + x * 40);
    return `rgb(${v(Math.floor(c / 36))},${v(Math.floor(c / 6) % 6)},${v(c % 6)})`;
  }
  const g = 8 + (n - 232) * 10;
  return `rgb(${g},${g},${g})`;
}

interface Style { fg?: string; bg?: string; b?: boolean; d?: boolean; i?: boolean; u?: boolean; inv?: boolean }

function applySgr(st: Style, params: number[]): Style {
  let s = { ...st };
  if (!params.length) params = [0];
  for (let i = 0; i < params.length; i++) {
    const p = params[i];
    if (p === 0) s = {};
    else if (p === 1) s.b = true;
    else if (p === 2) s.d = true;
    else if (p === 3) s.i = true;
    else if (p === 4) s.u = true;
    else if (p === 7) s.inv = true;
    else if (p === 22) { s.b = false; s.d = false; }
    else if (p === 23) s.i = false;
    else if (p === 24) s.u = false;
    else if (p === 27) s.inv = false;
    else if (p >= 30 && p <= 37) s.fg = BASIC[p - 30];
    else if (p === 39) s.fg = undefined;
    else if (p >= 40 && p <= 47) s.bg = BASIC[p - 40];
    else if (p === 49) s.bg = undefined;
    else if (p >= 90 && p <= 97) s.fg = BRIGHT[p - 90];
    else if (p >= 100 && p <= 107) s.bg = BRIGHT[p - 100];
    else if (p === 38 || p === 48) {
      const key = p === 38 ? "fg" : "bg";
      if (params[i + 1] === 5 && params[i + 2] !== undefined) { s[key] = color256(params[i + 2]); i += 2; }
      else if (params[i + 1] === 2 && params[i + 4] !== undefined) { s[key] = `rgb(${params[i + 2]},${params[i + 3]},${params[i + 4]})`; i += 4; }
    }
  }
  return s;
}

const MARK = "\x1e##ace:";

export class OutBuffer {
  lines: Line[] = [{ spans: [], len: 0 }];
  /** lines dropped from the front (so absolute line numbers stay meaningful) */
  dropped = 0;
  private style: Style = {};
  private esc = ""; // incomplete escape sequence carried between chunks
  private ctl: string | null = null; // control line being collected
  onControl: (ev: Record<string, unknown>) => void = () => {};

  get cur(): Line { return this.lines[this.lines.length - 1]; }

  clear() {
    this.lines = [{ spans: [], len: 0 }];
    this.dropped = 0;
    this.style = {};
    this.esc = "";
    this.ctl = null;
    this.pendingMark = "";
    this.cr = false;
  }

  /** Raw process output from the runner. Only stdout carries control lines. */
  push(kind: "out" | "err", data: string) {
    if (kind === "out") data = this.filterControl(data);
    if (data) this.text(data, kind);
  }

  /** Text produced by Ace itself (command line, exit status) or typed by the user. */
  sys(data: string, kind: "sys" | "in" = "sys") { this.text(data, kind); }

  private filterControl(data: string): string {
    if (this.pendingMark) { data = this.pendingMark + data; this.pendingMark = ""; }
    let out = "";
    let i = 0;
    while (i < data.length) {
      if (this.ctl !== null) {
        const nl = data.indexOf("\n", i);
        if (nl < 0) { this.ctl += data.slice(i); return out; }
        this.ctl += data.slice(i, nl);
        this.emitControl(this.ctl);
        this.ctl = null;
        i = nl + 1;
        continue;
      }
      const m = data.indexOf(MARK, i);
      if (m < 0) {
        // a marker may begin at the very end of this chunk
        const keep = partialMarkLen(data.slice(i));
        out += data.slice(i, data.length - keep);
        if (keep) this.pendingMark = data.slice(data.length - keep);
        return out;
      }
      out += data.slice(i, m);
      this.ctl = "";
      i = m + MARK.length;
    }
    return out;
  }
  private pendingMark = "";
  private cr = false;
  private emitControl(s: string) {
    try { this.onControl(JSON.parse(s)); } catch { /* malformed control line: drop */ }
  }

  private text(data: string, kind: Kind) {
    if (this.esc) { data = this.esc + data; this.esc = ""; }
    if (this.cr) {
      this.cr = false;
      if (data[0] !== "\n") { this.cur.spans = []; this.cur.len = 0; }
    }
    if (data.endsWith("\r")) { data = data.slice(0, -1); this.cr = true; }
    let buf = "";
    const flush = () => { if (buf) { this.add(buf, kind); buf = ""; } };
    for (let i = 0; i < data.length; i++) {
      const c = data[i];
      if (c === "\n") { flush(); this.newline(); }
      else if (c === "\r") {
        flush();
        if (data[i + 1] === "\n") continue;
        this.cur.spans = [];
        this.cur.len = 0;
      } else if (c === "\x1b") {
        const rest = data.slice(i);
        const m = /^\x1b\[([0-9;:?]*)([ -/]*)([@-~])/.exec(rest);
        if (m) {
          flush();
          if (m[3] === "m" && !m[1].startsWith("?")) this.style = applySgr(this.style, m[1] === "" ? [] : m[1].split(/[;:]/).map((x) => parseInt(x || "0", 10)));
          else if (m[3] === "K" && (m[1] === "" || m[1] === "0")) { /* erase to end of line: nothing after the cursor */ }
          else if (m[3] === "K" && m[1] === "2") { this.cur.spans = []; this.cur.len = 0; }
          i += m[0].length - 1;
        } else if (/^\x1b\]/.test(rest)) {
          const end = /\x07|\x1b\\/.exec(rest);
          if (end) { flush(); i += end.index + end[0].length - 1; }
          else { this.esc = rest; return flush(); }
        } else if (rest.length < 24 && /^\x1b(\[[0-9;:?]*[ -/]*)?$/.test(rest)) { flush(); this.esc = rest; return; }
        else buf += c; // lone ESC: keep
      } else if (c === "\x07") flush();
      else buf += c;
    }
    flush();
  }

  private add(text: string, kind: Kind) {
    while (text) {
      const line = this.cur;
      const room = MAX_LINE_LEN - line.len;
      if (room <= 0) { this.newline(); continue; }
      const part = text.length > room ? text.slice(0, room) : text;
      text = text.slice(part.length);
      const st = this.style;
      const sp: Span = { t: part };
      if (kind !== "out") sp.k = kind;
      let fg = st.fg, bg = st.bg;
      if (st.inv) { const f = fg ?? "#d8dee9", b = bg ?? "#2e3440"; fg = b; bg = f; }
      if (fg) sp.fg = fg;
      if (bg) sp.bg = bg;
      if (st.b) sp.b = true;
      if (st.d) sp.d = true;
      if (st.i) sp.i = true;
      if (st.u) sp.u = true;
      const last = line.spans[line.spans.length - 1];
      if (last && last.k === sp.k && last.fg === sp.fg && last.bg === sp.bg && last.b === sp.b && last.d === sp.d && last.i === sp.i && last.u === sp.u) last.t += part;
      else line.spans.push(sp);
      line.len += part.length;
      if (text) this.newline();
    }
  }

  private newline() {
    this.lines.push({ spans: [], len: 0 });
    if (this.lines.length > MAX_LINES + TRIM_BATCH) {
      this.lines.splice(0, TRIM_BATCH);
      this.dropped += TRIM_BATCH;
    }
  }

  /** Make sure the next text starts on a fresh line. */
  breakLine() { if (this.cur.len) this.newline(); }

  lineText(l: Line) { return l.spans.map((s) => s.t).join(""); }
  fullText() { return this.lines.map((l) => this.lineText(l)).join("\n"); }
}

/** length of a suffix of `s` that is a proper prefix of the control marker */
function partialMarkLen(s: string): number {
  for (let n = Math.min(MARK.length - 1, s.length); n > 0; n--) if (MARK.startsWith(s.slice(s.length - n))) return n;
  return 0;
}
