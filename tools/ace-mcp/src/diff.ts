import { minimalEdit } from "./core";

const clip = (s: string, n = 160) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

/** Compact unified-style diff. Long/minified lines are shown as a char-level window around the change. */
export function compactDiff(a: string, b: string, maxLines = 60): { diff: string; added: number; removed: number } {
  if (a === b) return { diff: "(no changes)", added: 0, removed: 0 };
  const al = a.split("\n");
  const bl = b.split("\n");
  const long = [...al, ...bl].some((l) => l.length > 400);
  if (long && Math.min(al.length, bl.length) <= 3) {
    const e = minimalEdit(a, b);
    const ctx = 40;
    const old = a.slice(e.start, e.end);
    const pre = a.slice(Math.max(0, e.start - ctx), e.start);
    const post = a.slice(e.end, e.end + ctx);
    return { diff: `@@ char ${e.start} @@\n${pre}[-${clip(old, 300)}-]{+${clip(e.text, 600)}+}${post}`, added: e.text.length ? 1 : 0, removed: old.length ? 1 : 0 };
  }
  let s = 0;
  while (s < al.length && s < bl.length && al[s] === bl[s]) s++;
  let ea = al.length;
  let eb = bl.length;
  while (ea > s && eb > s && al[ea - 1] === bl[eb - 1]) { ea--; eb--; }
  const A = al.slice(s, ea);
  const B = bl.slice(s, eb);
  // LCS on the differing middle (bounded), else plain replace
  const ops: Array<[" " | "-" | "+", string]> = [];
  if (A.length * B.length <= 400_000) {
    const n = A.length;
    const m = B.length;
    const dp: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (A[i] === B[j]) { ops.push([" ", A[i]]); i++; j++; }
      else if (dp[i + 1][j] >= dp[i][j + 1]) ops.push(["-", A[i++]]);
      else ops.push(["+", B[j++]]);
    }
    while (i < n) ops.push(["-", A[i++]]);
    while (j < m) ops.push(["+", B[j++]]);
  } else {
    for (const l of A) ops.push(["-", l]);
    for (const l of B) ops.push(["+", l]);
  }
  const CTX = 2;
  const out: string[] = [`@@ line ${s + 1} @@`];
  for (const l of al.slice(Math.max(0, s - CTX), s)) out.push("  " + clip(l));
  let added = 0;
  let removed = 0;
  let run = 0;
  const lines: string[] = [];
  for (const [k, l] of ops) {
    if (k === "-") removed++;
    if (k === "+") added++;
    if (k === " ") { run++; if (run > CTX * 2 + 1) continue; } else run = 0;
    lines.push(`${k} ${clip(l)}`);
  }
  out.push(...lines);
  for (const l of al.slice(ea, ea + CTX)) out.push("  " + clip(l));
  if (out.length > maxLines) {
    const extra = out.length - maxLines;
    out.length = maxLines;
    out.push(`… ${extra} more diff lines`);
  }
  return { diff: out.join("\n"), added, removed };
}
