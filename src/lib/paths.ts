/**
 * Path helpers that accept both separators. macOS/Linux paths use "/"; Windows paths may arrive as "C:\\Users\\x\\proj"
 * (or "C:/Users/x/proj" once normalised at the IPC boundary, see toPosixPath in ipc.ts). Every helper here works with
 * either, and returns forward slashes when it builds a new string from a Windows-style path.
 */

const DRIVE = /^[A-Za-z]:/;
const WINDOWS_LIKE = /^(?:[A-Za-z]:|\\\\)/;

/** "C:\\a\\b" -> "C:/a/b". Only drive-letter and UNC paths are rewritten, so mac/Linux paths are returned untouched. */
export function toPosixPath(p: string): string {
  if (!p.includes("\\") || !WINDOWS_LIKE.test(p)) return p;
  return p.replace(/\\/g, "/");
}

/** Index of the last path separator (either kind), or -1. */
const lastSep = (p: string) => Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));

/** Separator to use when joining onto `p`: backslash only for a backslash-only Windows path. */
const sepFor = (p: string) => (p.includes("\\") && !p.includes("/") ? "\\" : "/");

/** Parent directory. "/a" -> "/", "/a/b" -> "/a", "C:/a" -> "C:/", "C:\\a\\b" -> "C:\\a". */
export function dirname(p: string): string {
  const i = lastSep(p);
  if (i <= 0) return i === 0 ? p.slice(0, 1) : "/";
  if (i === 2 && DRIVE.test(p)) return p.slice(0, 3); // "C:/" is its own parent
  return p.slice(0, i);
}

/** Last path segment, separator-agnostic. */
export const basename = (p: string): string => p.slice(lastSep(p) + 1);

/** `dir` + `name` with the separator the path already uses (never doubles it). */
export function joinPath(dir: string, name: string): string {
  if (dir.endsWith("/") || dir.endsWith("\\")) return dir + name;
  return dir + sepFor(dir) + name;
}

/** Absolute local path: "/x", "\\x", "C:/x", "C:\\x" or UNC "\\\\host\\share". */
export const isAbsPath = (p: string): boolean => p.startsWith("/") || p.startsWith("\\") || /^[A-Za-z]:[\\/]/.test(p);

/** Comparison key: forward slashes, no trailing slash (except the root), lower-cased drive letter. */
export function pathKey(p: string): string {
  let n = toPosixPath(p);
  if (n.length > 1) n = n.replace(/\/+$/, "") || "/";
  return DRIVE.test(n) ? n[0].toLowerCase() + n.slice(1) : n;
}

/** True when `child` is `parent` or lies under it. Separator-agnostic. */
export function isWithin(parent: string, child: string): boolean {
  const p = pathKey(parent), c = pathKey(child);
  return c === p || c.startsWith(p.endsWith("/") ? p : p + "/");
}

/** `p` relative to `root` with forward slashes when it lies under `root`; otherwise `p` unchanged. */
export function relativeTo(root: string, p: string): string {
  if (!isWithin(root, p)) return p;
  const r = pathKey(root), c = toPosixPath(p);
  return c.slice(r.length).replace(/^\/+/, "");
}

/** "/Users/me/x" -> "~/x"; "C:/Users/me/x" -> "~/x"; "/home/me/x" -> "~/x". With `home`, shortens that prefix first. */
export function homeShorten(p: string, home?: string): string {
  const n = toPosixPath(p);
  if (home) {
    const h = pathKey(home), k = pathKey(p); // k: same length as n, only the drive letter is lower-cased
    if (k === h || k.startsWith(h + "/")) return "~" + n.slice(h.length);
  }
  return n.replace(/^(?:\/Users\/[^/]+|\/home\/[^/]+|[A-Za-z]:\/Users\/[^/]+)(?=\/|$)/, "~");
}

/** The home-directory prefix of a local path ("/Users/me", "/home/me", "C:/Users/me"), if it has one. */
export const homeOf = (p: string): string | undefined => toPosixPath(p).match(/^(?:\/Users\/[^/]+|\/home\/[^/]+|[A-Za-z]:\/Users\/[^/]+)/)?.[0];
