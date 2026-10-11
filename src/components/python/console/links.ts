/** Clickable `File "x.py", line N` (CPython) and `File /x.py:N` (IPython) references in console output. */
export interface Link { start: number; end: number; path: string; line: number }

const PY = /File "([^"<>]+)", line (\d+)/g;
const IPY = /(?:File\s+|^|[\s(])((?:~|\.{1,2})?\/?[\w.\-/ ]*?[\w\-]\.py):(\d+)/g;

export function findLinks(text: string): Link[] {
  const out: Link[] = [];
  for (const m of text.matchAll(PY)) {
    const q = m.index! + 'File '.length;
    out.push({ start: q, end: m.index! + m[0].length, path: m[1], line: parseInt(m[2], 10) });
  }
  for (const m of text.matchAll(IPY)) {
    const whole = m[0];
    const pathStart = m.index! + whole.indexOf(m[1]);
    const end = pathStart + m[1].length + 1 + m[2].length;
    if (out.some((l) => l.start <= pathStart && l.end >= end)) continue;
    if (m[1].includes(" ") && !m[1].startsWith("/")) continue;
    out.push({ start: pathStart, end, path: m[1], line: parseInt(m[2], 10) });
  }
  return out.sort((a, b) => a.start - b.start);
}

/** Resolve a path from a traceback against the project root. `~` paths are not resolvable (unknown remote home) -> null. */
export function resolveLinkPath(p: string, root: string): string | null {
  if (p.startsWith("~")) return null;
  const abs = p.startsWith("/") ? p : `${root.replace(/\/$/, "")}/${p}`;
  const parts: string[] = [];
  for (const seg of abs.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") parts.pop();
    else parts.push(seg);
  }
  return "/" + parts.join("/");
}
