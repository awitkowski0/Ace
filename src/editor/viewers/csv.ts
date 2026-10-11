/** RFC 4180 CSV/TSV parsing + table sorting (pure, unit-tested). */
export function detectDelimiter(text: string, ext: string): string {
  if (ext === "tsv") return "\t";
  const head = text.slice(0, 4096).split("\n").slice(0, 5).join("\n");
  const score = (d: string) => (head.match(new RegExp(d === "|" ? "\\|" : d, "g")) ?? []).length;
  const c = [",", ";", "\t", "|"].map((d) => [d, score(d)] as const).sort((a, b) => b[1] - a[1])[0];
  return c[1] > 0 ? c[0] : ",";
}

export function parseCsv(text: string, delim = ","): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], field = "", q = false;
  const n = text.length;
  for (let i = 0; i < n; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; }
      else field += c;
    } else if (c === '"' && field === "") q = true;
    else if (c === delim) { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field); field = "";
      rows.push(row); row = [];
    } else field += c;
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  return rows;
}

const num = (s: string) => (s.trim() !== "" && Number.isFinite(+s) ? +s : null);
/** Numeric when both cells are numbers, otherwise locale-aware natural string compare; empties last. */
export function compareCells(a: string, b: string): number {
  if (a === b) return 0;
  if (a === "") return 1;
  if (b === "") return -1;
  const x = num(a), y = num(b);
  if (x !== null && y !== null) return x - y;
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
}
export function sortedIndex(rows: string[][], col: number, dir: 1 | -1 | 0): number[] {
  const idx = rows.map((_, i) => i);
  if (!dir) return idx;
  return idx.sort((i, j) => {
    const a = rows[i][col] ?? "", b = rows[j][col] ?? "";
    if ((a === "") !== (b === "")) return a === "" ? 1 : -1; // empties stay last in both directions
    return dir * compareCells(a, b) || i - j;
  });
}
