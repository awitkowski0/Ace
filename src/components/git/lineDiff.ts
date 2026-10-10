/** Line diff (Myers, O(ND)) -> gutter hunks in "new" (buffer) line numbers. */
export interface Hunk { kind: "added" | "modified" | "deleted"; start: number; end: number }

const MAX_D = 3000;

export function diffHunks(oldText: string, newText: string): Hunk[] {
  if (oldText === newText) return [];
  const a = oldText.split("\n"), b = newText.split("\n");
  // trim common prefix/suffix
  let p = 0;
  while (p < a.length && p < b.length && a[p] === b[p]) p++;
  let s = 0;
  while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;
  const A = a.slice(p, a.length - s), B = b.slice(p, b.length - s);
  const ops = myers(A, B); // array of [aStart, aLen, bStart, bLen] edits
  const out: Hunk[] = [];
  for (const [, al, bs, bl] of ops) {
    if (bl === 0) out.push({ kind: "deleted", start: Math.max(1, p + bs + 1), end: Math.max(1, p + bs + 1) });
    else out.push({ kind: al === 0 ? "added" : "modified", start: p + bs + 1, end: p + bs + bl });
  }
  return out;
}

/** Returns merged edit regions [aStart, aLen, bStart, bLen]. Falls back to one big region past MAX_D. */
function myers(A: string[], B: string[]): [number, number, number, number][] {
  const n = A.length, m = B.length;
  if (n === 0 && m === 0) return [];
  if (n === 0) return [[0, 0, 0, m]];
  if (m === 0) return [[0, n, 0, 0]];
  const max = Math.min(n + m, MAX_D);
  const off = max + 1;
  let v = new Int32Array(2 * max + 3);
  const trace: Int32Array[] = [];
  let found = -1;
  for (let d = 0; d <= max; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[off + k - 1] < v[off + k + 1]) ? v[off + k + 1] : v[off + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && A[x] === B[y]) { x++; y++; }
      v[off + k] = x;
      if (x >= n && y >= m) { found = d; break; }
    }
    if (found >= 0) break;
  }
  if (found < 0) return [[0, n, 0, m]];
  // backtrack
  const edits: [number, number, number, number][] = [];
  let x = n, y = m;
  for (let d = found; d > 0; d--) {
    const vv = trace[d];
    const k = x - y;
    const prevK = k === -d || (k !== d && vv[off + k - 1] < vv[off + k + 1]) ? k + 1 : k - 1;
    const prevX = vv[off + prevK], prevY = prevX - prevK;
    while (x > prevX && y > prevY) { x--; y--; }
    if (x === prevX) edits.push([x, 0, y - 1, 1]); // insertion of B[y-1]
    else edits.push([x - 1, 1, y, 0]); // deletion of A[x-1]
    x = prevX; y = prevY;
  }
  edits.reverse();
  // merge adjacent edits
  const merged: [number, number, number, number][] = [];
  for (const e of edits) {
    const last = merged[merged.length - 1];
    if (last && last[0] + last[1] === e[0] && last[2] + last[3] === e[2]) { last[1] += e[1]; last[3] += e[3]; }
    else merged.push([...e]);
  }
  return merged;
}
