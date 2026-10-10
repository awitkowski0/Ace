/** Small camel-hump / word-start fuzzy matcher for in-memory lists (actions, tool windows). */
export interface FuzzyHit { score: number; indices: number[] }

const isAlnum = (c: string) => /[A-Za-z0-9]/.test(c);

export function fuzzy(query: string, text: string): FuzzyHit | null {
  const q = query.replace(/\s+/g, "");
  const m = q.length, n = text.length;
  if (!m) return { score: 0, indices: [] };
  if (m > n) return null;
  const ql = q.toLowerCase(), tl = text.toLowerCase();
  const NEG = -1e9;
  const dp: number[][] = Array.from({ length: m }, () => new Array(n).fill(NEG));
  const par: number[][] = Array.from({ length: m }, () => new Array(n).fill(-1));
  for (let i = 0; i < m; i++) {
    let runBest = NEG, runIdx = -1; // max over k <= j-2 of dp[i-1][k] + 0.3k
    for (let j = 0; j < n; j++) {
      if (i > 0 && j >= 2 && dp[i - 1][j - 2] > NEG) {
        const v = dp[i - 1][j - 2] + 0.3 * (j - 2);
        if (v > runBest) { runBest = v; runIdx = j - 2; }
      }
      if (tl[j] !== ql[i]) continue;
      let bonus = 0;
      if (j === 0) bonus = 10;
      else if (!isAlnum(text[j - 1])) bonus = 8;
      else if (text[j - 1] === text[j - 1].toLowerCase() && text[j] !== text[j].toLowerCase()) bonus = 7;
      if (q[i] === text[j]) bonus += 1; // exact case
      const base = 1 + bonus;
      if (i === 0) { dp[i][j] = base - j * 0.1; continue; }
      let best = NEG, from = -1;
      if (j >= 1 && dp[i - 1][j - 1] > NEG) { best = dp[i - 1][j - 1] + 5; from = j - 1; }
      if (runIdx >= 0) {
        const v = runBest - (j - 1) * 0.3;
        if (v > best) { best = v; from = runIdx; }
      }
      if (from >= 0) { dp[i][j] = best + base; par[i][j] = from; }
    }
  }
  let bj = -1, bs = NEG;
  for (let j = 0; j < n; j++) if (dp[m - 1][j] > bs) { bs = dp[m - 1][j]; bj = j; }
  if (bj < 0) return null;
  const indices: number[] = [];
  for (let i = m - 1, j = bj; i >= 0; i--) { indices.push(j); j = par[i][j]; }
  indices.reverse();
  return { score: bs - n * 0.05, indices };
}
