/** Minimal ANSI SGR parser for the Python Console / package logs: text -> styled spans (Nord colours). Other escapes are dropped. */
export interface Span {
  text: string;
  fg?: string;
  bg?: string;
  bold?: boolean;
  dim?: boolean;
  italic?: boolean;
  underline?: boolean;
}

const BASIC = ["#4c566a", "var(--nord11)", "var(--nord14)", "var(--nord13)", "var(--nord9)", "var(--nord15)", "var(--nord8)", "var(--nord4)"];
const BRIGHT = ["#616e88", "#d57780", "#b4cf9f", "#f0d399", "#8fb0cf", "#c69dc0", "#8fbcbb", "var(--nord6)"];

function color256(n: number): string | undefined {
  if (n < 0 || n > 255) return undefined;
  if (n < 8) return BASIC[n];
  if (n < 16) return BRIGHT[n - 8];
  if (n >= 232) {
    const v = 8 + (n - 232) * 10;
    return `rgb(${v},${v},${v})`;
  }
  const i = n - 16;
  const lv = (x: number) => (x === 0 ? 0 : 55 + x * 40);
  return `rgb(${lv(Math.floor(i / 36))},${lv(Math.floor(i / 6) % 6)},${lv(i % 6)})`;
}

type Style = Omit<Span, "text">;

function applySgr(st: Style, params: number[]): Style {
  let s: Style = { ...st };
  if (!params.length) params = [0];
  for (let i = 0; i < params.length; i++) {
    const p = params[i];
    if (p === 0) s = {};
    else if (p === 1) s.bold = true;
    else if (p === 2) s.dim = true;
    else if (p === 3) s.italic = true;
    else if (p === 4) s.underline = true;
    else if (p === 22) { s.bold = false; s.dim = false; }
    else if (p === 23) s.italic = false;
    else if (p === 24) s.underline = false;
    else if (p >= 30 && p <= 37) s.fg = BASIC[p - 30];
    else if (p === 39) s.fg = undefined;
    else if (p >= 40 && p <= 47) s.bg = BASIC[p - 40];
    else if (p === 49) s.bg = undefined;
    else if (p >= 90 && p <= 97) s.fg = BRIGHT[p - 90];
    else if (p >= 100 && p <= 107) s.bg = BRIGHT[p - 100];
    else if (p === 38 || p === 48) {
      const key = p === 38 ? "fg" : "bg";
      if (params[i + 1] === 5) { s[key] = color256(params[i + 2]); i += 2; }
      else if (params[i + 1] === 2) { s[key] = `rgb(${params[i + 2] ?? 0},${params[i + 3] ?? 0},${params[i + 4] ?? 0})`; i += 4; }
    }
  }
  return s;
}

// eslint-disable-next-line no-control-regex
const CSI = /\x1b\[([0-9;:?]*)([ -/]*[@-~])|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][A-Z0-9]|\x1b[=>78]/g;

export function parseAnsi(input: string): Span[] {
  const out: Span[] = [];
  let st: Style = {};
  let last = 0;
  const push = (text: string) => {
    if (!text) return;
    const prev = out[out.length - 1];
    if (prev && prev.fg === st.fg && prev.bg === st.bg && !!prev.bold === !!st.bold && !!prev.dim === !!st.dim && !!prev.italic === !!st.italic && !!prev.underline === !!st.underline) prev.text += text;
    else out.push({ text, ...st });
  };
  for (const m of input.matchAll(CSI)) {
    push(input.slice(last, m.index));
    last = m.index! + m[0].length;
    if (m[2] === "m") st = applySgr(st, m[1].split(/[;:]/).map((x) => (x === "" ? 0 : parseInt(x, 10))));
  }
  push(input.slice(last));
  return out;
}

export const stripAnsi = (s: string) => s.replace(CSI, "");

/** Append `chunk` to `prev` the way a terminal shows plain line output: "\r\n" -> "\n", a lone "\r" rewinds to the line start
 * (a trailing "\r" is kept so the next chunk overwrites). */
export function applyCr(prev: string, chunk: string): string {
  const t = (prev + chunk).replace(/\r\n/g, "\n");
  if (!t.includes("\r")) return t;
  return t
    .split("\n")
    .map((line) => {
      if (!line.includes("\r")) return line;
      const segs = line.split("\r");
      const tail = segs[segs.length - 1] === "" ? "\r" : "";
      let res = "";
      for (const seg of segs) if (seg) res = seg + res.slice(seg.length);
      return res + tail;
    })
    .join("\n");
}
