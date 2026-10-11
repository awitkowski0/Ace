/** File links in console text: Python tracebacks (`File "x.py", line 3`) and `path/to/file.py:LINE[:COL]` (pytest, compilers). */
import { fs, type Location } from "../../lib/ipc";
import { resolvePath } from "./util";

export interface RawLink { start: number; end: number; path: string; line: number; col: number }

const PY_TB = /File "([^"\n]+)", line (\d+)/g;
const PATH_LINE = /(?<![\w./~-])((?:~|\.{1,2})?\/?(?:[\w@+.-]+\/)*[\w@+.-]+\.[A-Za-z][A-Za-z0-9]{0,5}):(\d+)(?::(\d+))?(?![\w])/g;

// Gradle / Kotlin: `e: file:///abs/Foo.kt:12:5 msg` and `Build file '/abs/build.gradle' line: 12`
const FILE_URL = /file:\/\/(\/[^\s:'"()<>]+?\.[A-Za-z][A-Za-z0-9]{0,5}):(\d+)(?::(\d+))?/g;
// Godot: `res://scripts/x.gd:12` (also inside `at: fn (res://x.gd:12)`)
const RES_LINK = /res:\/\/([\w@+.\-/]+?\.[A-Za-z][A-Za-z0-9]{0,5}):(\d+)(?::(\d+))?(?![\w])/g;
const GRADLE_SCRIPT = /(?:Build|Script|Settings|Initialization) file '([^'\n]+)' line: (\d+)/g;

export function findLinks(text: string): RawLink[] {
  const out: RawLink[] = [];
  if (!text.includes(".")) return out;
  PY_TB.lastIndex = 0;
  let m: RegExpExecArray | null;
  if (text.includes('File "')) {
    while ((m = PY_TB.exec(text))) {
      const s = m.index + m[0].indexOf('"') + 1;
      out.push({ start: s, end: m.index + m[0].length, path: m[1], line: +m[2], col: 1 });
      // only the quoted path is the link target; the span covers path + line so a click anywhere on it works
    }
  }
  if (text.includes("file://")) {
    FILE_URL.lastIndex = 0;
    while ((m = FILE_URL.exec(text))) {
      let p = m[1];
      try { p = decodeURI(p); } catch { /* keep raw */ }
      out.push({ start: m.index, end: m.index + m[0].length, path: p, line: +m[2], col: m[3] ? +m[3] : 1 });
    }
  }
  if (text.includes(" file '")) {
    GRADLE_SCRIPT.lastIndex = 0;
    while ((m = GRADLE_SCRIPT.exec(text))) {
      const s = m.index + m[0].indexOf("'") + 1;
      out.push({ start: s, end: m.index + m[0].length, path: m[1], line: +m[2], col: 1 });
    }
  }
  if (text.includes("res://")) {
    RES_LINK.lastIndex = 0;
    while ((m = RES_LINK.exec(text))) out.push({ start: m.index, end: m.index + m[0].length, path: "res://" + m[1], line: +m[2], col: m[3] ? +m[3] : 1 });
  }
  PATH_LINE.lastIndex = 0;
  while ((m = PATH_LINE.exec(text))) {
    const start = m.index;
    const end = start + m[0].length;
    if (out.some((o) => start < o.end && end > o.start)) continue;
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text.slice(Math.max(0, start - 8), end))) continue; // URL host:port
    if (/^\d+\.\d+$/.test(m[1])) continue; // 1.5:3
    out.push({ start, end, path: m[1], line: +m[2], col: m[3] ? +m[3] : 1 });
  }
  return out.sort((a, b) => a.start - b.start);
}

const cache = new Map<string, Promise<Location | null>>();
/** Resolve a link path against the run's cwd, then the project root; null when no such file exists. Cached. */
export function resolveLink(raw: string, host: string, cwd: string, root: string): Promise<Location | null> {
  const key = `${host}\0${cwd}\0${root}\0${raw}`;
  let p = cache.get(key);
  if (!p) {
    p = (async () => {
      if (raw.startsWith("res://")) {
        // Godot resource paths: relative to the project directory (the run's cwd), else the IDE project root
        const rel = raw.slice(6);
        for (const c of new Set([resolvePath(cwd, rel), resolvePath(root, rel)])) {
          const st = await fs.stat({ host, path: c }).catch(() => null);
          if (st?.exists && st.isFile) return { host, path: c };
        }
        return null;
      }
      const cands = raw.startsWith("/") || raw.startsWith("~") ? [raw] : [resolvePath(cwd, raw), resolvePath(root, raw)];
      for (const c of new Set(cands)) {
        const st = await fs.stat({ host, path: c }).catch(() => null);
        if (st?.exists && st.isFile) return { host, path: c };
      }
      return null;
    })();
    if (cache.size > 2000) cache.clear();
    cache.set(key, p);
  }
  return p;
}
export const forgetLinks = () => cache.clear();
