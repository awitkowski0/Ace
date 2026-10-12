/** File-path link detection for terminal output (`src/foo.ts:12:3`, `res://a/b.gd:40`, Python tracebacks, ...). */
import { isMod } from "../../lib/platform";
import type { IBuffer, IBufferLine, ILink, ILinkProvider, Terminal } from "@xterm/xterm";
import { fs, type Location } from "../../lib/ipc";

export interface PathMatch { text: string; start: number; end: number; raw: string; line?: number; col?: number }

const EXT = "(?:ts|tsx|js|jsx|mjs|cjs|json|md|txt|rs|toml|yaml|yml|py|go|java|kt|kts|gd|tscn|tres|cs|c|h|cpp|hpp|cc|css|scss|html|vue|svelte|sh|zsh|bash|lock|log|xml|gradle|properties|sql|rb|php|swift|lua|ini|cfg|conf|csv)";
const PATH_CHARS = "[\\w@.+\\-]";
// 1) explicit path (res://, ~/, ./, ../, /, or contains a slash)   2) bare file name with a known extension or a :line suffix
const RE_SRC =
  "(?<![\\w@.+\\-/~:])(" +
    "(?:res:\\/\\/|~\\/|\\.{1,2}\\/|\\/)?(?:" + PATH_CHARS + "+\\/)+" + PATH_CHARS + "*[\\w@+\\-]" +
    "|" + PATH_CHARS + "*[\\w@+\\-]\\." + EXT + "(?![\\w])" +
    "|" + PATH_CHARS + "+\\.[A-Za-z][\\w]{0,9}(?=:\\d)" +
  ")(?::(\\d+))?(?::(\\d+))?";

/** Find path-like tokens in one line of text. */
export function findPaths(text: string): PathMatch[] {
  const out: PathMatch[] = [];
  const re = new RegExp(RE_SRC, "g");
  for (const m of text.matchAll(re)) {
    const raw = m[1];
    if (!raw || /^\d+(\.\d+)*$/.test(raw) || /^https?:/.test(raw)) continue;
    // URLs: `//host/x` right after a scheme
    if (text.slice(Math.max(0, (m.index ?? 0) - 6), m.index).includes("://") && !raw.startsWith("res://")) continue;
    let line = m[2] ? +m[2] : undefined;
    let col = m[3] ? +m[3] : undefined;
    let end = (m.index ?? 0) + m[0].length;
    if (line === undefined) {
      const py = /^",\s*line\s+(\d+)/.exec(text.slice(end));
      if (py) line = +py[1];
    }
    out.push({ text: text.slice(m.index, end), start: m.index ?? 0, end, raw, line, col });
  }
  return out;
}

export function normalizePath(p: string): string {
  const out: string[] = [];
  for (const seg of p.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") out.pop();
    else out.push(seg);
  }
  return "/" + out.join("/");
}

/** Resolve a matched path against the shell's cwd. `res://` is relative to the project root (Godot). */
export function resolvePath(raw: string, cwd: string, project: Location | null, host: string, home?: string): string | null {
  if (raw.startsWith("res://")) return project && project.host === host ? normalizePath(project.path + "/" + raw.slice(6)) : null;
  if (raw.startsWith("~/")) return home ? normalizePath(home + raw.slice(1)) : null;
  if (raw.startsWith("/")) return normalizePath(raw);
  if (!cwd || cwd === "~" || cwd.startsWith("~/")) return cwd.startsWith("~/") && home ? normalizePath(home + "/" + cwd.slice(2) + "/" + raw) : home ? normalizePath(home + "/" + raw) : null;
  return normalizePath(cwd + "/" + raw);
}

/** Buffer line -> text plus the terminal column (0-based) of every character (wide cells and combining marks handled). */
export function lineText(line: IBufferLine, cols: number): { text: string; colOf: number[] } {
  let text = "";
  const colOf: number[] = [];
  for (let x = 0; x < cols; x++) {
    const cell = line.getCell(x);
    if (!cell || cell.getWidth() === 0) continue;
    const ch = cell.getChars() || " ";
    for (let k = 0; k < ch.length; k++) colOf.push(x);
    text += ch;
  }
  return { text: text.replace(/\s+$/, ""), colOf };
}

export interface LinkCtx {
  host: () => string;
  cwd: () => string;
  project: () => Location | null;
  home: () => Promise<string | undefined>;
  open: (loc: Location, line?: number, col?: number) => void;
}

const statCache = new Map<string, { at: number; file: boolean }>();
async function isFile(loc: Location): Promise<boolean> {
  const k = `${loc.host}:${loc.path}`;
  const hit = statCache.get(k);
  if (hit && Date.now() - hit.at < 5000) return hit.file;
  let file = false;
  try { file = (await fs.stat(loc)).isFile; } catch {}
  statCache.set(k, { at: Date.now(), file });
  if (statCache.size > 500) statCache.clear();
  return file;
}

/** xterm link provider: underlines paths that exist; ⌘-click opens them in the editor at line:col. */
export function filePathLinks(term: Terminal, ctx: LinkCtx): ILinkProvider {
  return {
    provideLinks(y: number, cb: (links: ILink[] | undefined) => void) {
      const buf: IBuffer = term.buffer.active;
      const line = buf.getLine(y - 1);
      if (!line) return cb(undefined);
      const { text, colOf } = lineText(line, term.cols);
      const found = findPaths(text);
      if (!found.length) return cb(undefined);
      void (async () => {
        const home = await ctx.home();
        const links: ILink[] = [];
        for (const f of found) {
          const path = resolvePath(f.raw, ctx.cwd(), ctx.project(), ctx.host(), home);
          if (!path) continue;
          const loc: Location = { host: ctx.host(), path };
          if (!(await isFile(loc))) continue;
          const sx = colOf[f.start] ?? 0;
          const ex = colOf[Math.min(f.end, colOf.length) - 1] ?? sx;
          links.push({
            range: { start: { x: sx + 1, y }, end: { x: ex + 1, y } },
            text: f.text,
            decorations: { underline: true, pointerCursor: true },
            activate: (e) => { if (isMod(e)) ctx.open(loc, f.line, f.col); },
          });
        }
        cb(links.length ? links : undefined);
      })();
    },
  };
}
