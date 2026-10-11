/** Small pure helpers shared by the run configuration code (shell-like argument splitting, paths). */

/** Split a command line like a POSIX shell would: whitespace separated, '…' and "…" quoting, backslash escapes. */
export function shellSplit(s: string): string[] {
  const out: string[] = [];
  let cur = "";
  let has = false;
  let q: "'" | '"' | null = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q === "'") {
      if (c === "'") q = null;
      else cur += c;
    } else if (q === '"') {
      if (c === '"') q = null;
      else if (c === "\\" && i + 1 < s.length && /["\\$`]/.test(s[i + 1])) cur += s[++i];
      else cur += c;
    } else if (c === "'" || c === '"') {
      q = c;
      has = true;
    } else if (c === "\\" && i + 1 < s.length) {
      cur += s[++i];
      has = true;
    } else if (/\s/.test(c)) {
      if (has || cur) out.push(cur);
      cur = "";
      has = false;
    } else {
      cur += c;
      has = true;
    }
  }
  if (has || cur) out.push(cur);
  return out;
}

/** Quote one argument for display / for a `shellSplit` round trip. */
export function shellQuote(a: string): string {
  if (a === "") return "''";
  if (/^[\w@%+=:,./~-]+$/.test(a)) return a;
  return `'${a.replace(/'/g, `'\\''`)}'`;
}
export const shellJoin = (argv: string[]) => argv.map(shellQuote).join(" ");

export const isAbsPath = (p: string) => p.startsWith("/") || p.startsWith("~");

/** Collapse `.`/`..`/duplicate slashes of an absolute path. */
export function normPath(p: string): string {
  const abs = p.startsWith("/");
  const parts: string[] = [];
  for (const seg of p.split("/")) {
    if (!seg || seg === ".") continue;
    if (seg === "..") {
      if (parts.length && parts[parts.length - 1] !== "..") parts.pop();
      else if (!abs) parts.push("..");
    } else parts.push(seg);
  }
  return (abs ? "/" : "") + parts.join("/");
}
export const resolvePath = (base: string, p: string) => (isAbsPath(p) ? normPath(p) : normPath(`${base}/${p}`));
export const relPath = (root: string, p: string) => (p.startsWith(root.endsWith("/") ? root : root + "/") ? p.slice(root.length).replace(/^\//, "") : p);

/** [key, value] rows of an env field -> record (empty keys dropped). */
export function envRecord(rows: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!Array.isArray(rows)) return out;
  for (const r of rows) {
    if (Array.isArray(r) && typeof r[0] === "string" && r[0].trim()) out[r[0].trim()] = String(r[1] ?? "");
  }
  return out;
}

export const SIGNALS: Record<number, string> = { 1: "SIGHUP", 2: "SIGINT", 3: "SIGQUIT", 6: "SIGABRT", 9: "SIGKILL", 13: "SIGPIPE", 14: "SIGALRM", 15: "SIGTERM" };
