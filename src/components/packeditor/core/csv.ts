/**
 * A byte-keeping CSV reader for Thematic's ability_defaults sheets (`ability_id,cooldown,...` and `ability,key,value`):
 * every cell comes with its exact text offsets, so a single cell can be replaced and every other byte of the file (line
 * endings, padding, comments, a missing final newline) stays as it was. Not a general CSV parser: a quoted cell may hold
 * commas, but not a line break.
 */

export interface CsvCell { text: string; s: number; e: number }
export interface CsvRow {
  /** 0-based line number in the file */
  line: number;
  /** span of the line without its line ending */
  s: number;
  e: number;
  cells: CsvCell[];
}
export interface Csv {
  /** the first line that is not blank or a `#` comment, as column names (lower-cased, trimmed) */
  header: string[];
  /** every following data row */
  rows: CsvRow[];
  eol: "\n" | "\r\n";
  endsWithNewline: boolean;
}

/** Split one line (no line ending) into cells with offsets relative to `base`. */
function cellsOf(line: string, base: number): CsvCell[] {
  const out: CsvCell[] = [];
  let start = 0;
  let quoted = false;
  for (let i = 0; i <= line.length; i++) {
    const c = line[i];
    if (c === '"') quoted = !quoted;
    if (i === line.length || (c === "," && !quoted)) {
      const raw = line.slice(start, i);
      const lead = raw.length - raw.trimStart().length;
      const core = raw.trim();
      // a quoted cell reads without its quotes
      const text = core.length >= 2 && core[0] === '"' && core.endsWith('"') ? core.slice(1, -1).replace(/""/g, '"') : core;
      out.push({ text, s: base + start + (core ? lead : 0), e: base + start + (core ? lead + core.length : 0) });
      start = i + 1;
    }
  }
  return out;
}

export function parseCsv(text: string): Csv {
  const rows: CsvRow[] = [];
  let header: string[] | null = null;
  let off = 0;
  let line = 0;
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  for (const raw of text.split("\n")) {
    const content = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    const t = content.trim();
    if (t && !t.startsWith("#")) {
      const cells = cellsOf(content, off);
      if (!header) header = cells.map((c) => c.text.toLowerCase());
      else rows.push({ line, s: off, e: off + content.length, cells });
    }
    off += raw.length + 1;
    line++;
  }
  return { header: header ?? [], rows, eol, endsWithNewline: text.endsWith("\n") };
}

/** The file with cell `col` of `row` set to `value`; a row shorter than that gets empty cells up to it. Nothing else changes. */
export function setCell(text: string, row: CsvRow, col: number, value: string): string {
  const c = row.cells[col];
  if (c) {
    // an empty cell has a zero-width span at its comma
    return text.slice(0, c.s) + value + text.slice(c.e);
  }
  return text.slice(0, row.e) + ",".repeat(col - row.cells.length + 1) + value + text.slice(row.e);
}

/** The file with a data row appended, in the file's own line-ending style (and with or without a final newline, as it had). */
export function appendRow(text: string, cells: string[]): string {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const line = cells.join(",");
  if (!text) return line + eol;
  if (text.endsWith("\n")) return text + line + eol;
  return text + eol + line;
}

/** Number as a csv cell: no trailing zeros, `-1` stays `-1`. */
export function csvNum(v: number): string {
  if (!Number.isFinite(v)) return "-1";
  return String(Math.round(v * 1e4) / 1e4);
}
