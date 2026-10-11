/** Minimal text edits between two versions of a file (line diff, then trimmed to the changed characters). Pure. */

export interface OffsetEdit { start: number; end: number; text: string }

const lines = (t: string) => t.match(/[^\n]*\n|[^\n]+$/g) ?? [];

interface Hunk { a0: number; a1: number; b0: number; b1: number }

/** Myers O(ND) diff of two line arrays; returns the changed hunks (old [a0,a1) -> new [b0,b1)) or null when too different. */
function myers<T>(a: T[], b: T[], maxD = 1500): Hunk[] | null {
  const n = a.length, m = b.length;
  const max = Math.min(n + m, maxD);
  const off = max + 1;
  let v = new Int32Array(2 * max + 3);
  const trace: Int32Array[] = [];
  let found = -1;
  for (let d = 0; d <= max && found < 0; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[off + k - 1] < v[off + k + 1]) ? v[off + k + 1] : v[off + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) { x++; y++; }
      v[off + k] = x;
      if (x >= n && y >= m) { found = d; break; }
    }
  }
  if (found < 0) return null;
  // backtrack
  const edits: { px: number; py: number; ins: boolean }[] = [];
  let x = n, y = m;
  for (let d = found; d > 0; d--) {
    const vv = trace[d];
    const k = x - y;
    const prevK = k === -d || (k !== d && vv[off + k - 1] < vv[off + k + 1]) ? k + 1 : k - 1;
    const px = vv[off + prevK];
    const py = px - prevK;
    edits.push({ px, py, ins: prevK === k + 1 });
    x = px; y = py;
  }
  edits.reverse();
  // each edit step is one insertion or deletion after a diagonal run; coalesce into hunks
  const hunks: Hunk[] = [];
  for (const e of edits) {
    const a0 = e.px, b0 = e.py;
    const a1 = e.ins ? e.px : e.px + 1, b1 = e.ins ? e.py + 1 : e.py;
    const last = hunks[hunks.length - 1];
    if (last && last.a1 === a0 && last.b1 === b0) { last.a1 = a1; last.b1 = b1; }
    else hunks.push({ a0, a1, b0, b1 });
  }
  return hunks;
}

const TOKEN = /\w+|\s+|[^\w\s]/g;
const tokens = (t: string) => t.match(TOKEN) ?? [];

/** Refine one replaced region (old text -> new text) into token-level edits so unchanged words inside a changed line keep their identity (carets). */
function refine(old: string, text: string, base: number): OffsetEdit[] {
  if (old.length + text.length > 40000) return [trim(old, text, base)].filter((e) => e.start !== e.end || e.text);
  const a = tokens(old), b = tokens(text);
  const hunks = myers(a, b, 800);
  if (!hunks) return [trim(old, text, base)];
  const pa = [0]; for (const t of a) pa.push(pa[pa.length - 1] + t.length);
  const out: OffsetEdit[] = [];
  for (const h of hunks) out.push({ start: base + pa[h.a0], end: base + pa[h.a1], text: b.slice(h.b0, h.b1).join("") });
  return out;
}
/** common-prefix/suffix trimmed single edit */
function trim(old: string, text: string, base: number): OffsetEdit {
  let p = 0;
  while (p < old.length && p < text.length && old[p] === text[p]) p++;
  let q = 0;
  while (q < old.length - p && q < text.length - p && old[old.length - 1 - q] === text[text.length - 1 - q]) q++;
  return { start: base + p, end: base + old.length - q, text: text.slice(p, text.length - q) };
}

export function textEdits(oldText: string, newText: string): OffsetEdit[] {
  if (oldText === newText) return [];
  const a = lines(oldText), b = lines(newText);
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  const am = a.slice(pre, a.length - suf), bm = b.slice(pre, b.length - suf);
  const starts: number[] = [0];
  for (const l of a) starts.push(starts[starts.length - 1] + l.length);
  const hunks = myers(am, bm) ?? [{ a0: 0, a1: am.length, b0: 0, b1: bm.length }];
  const out: OffsetEdit[] = [];
  for (const h of hunks) {
    const start = starts[pre + h.a0];
    const end = starts[pre + h.a1];
    out.push(...refine(oldText.slice(start, end), bm.slice(h.b0, h.b1).join(""), start));
  }
  return out.filter((e) => e.start !== e.end || e.text);
}

export function applyOffsetEdits(text: string, edits: OffsetEdit[]): string {
  let out = text;
  for (const e of [...edits].sort((x, y) => y.start - x.start)) out = out.slice(0, e.start) + e.text + out.slice(e.end);
  return out;
}
