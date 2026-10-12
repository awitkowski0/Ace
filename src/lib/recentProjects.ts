/** Pure declutter logic for the recent-projects list (Welcome screen + project switcher). No IPC here, so it is unit-testable. */
import { basename, homeShorten, toPosixPath } from "./paths";

export interface Loc { host: string; path: string }

/** Folders that only exist for a test run / agent sandbox: never worth listing. Local paths only. */
const TRANSIENT: RegExp[] = [
  /^\/(private\/)?var\/folders\//,
  /^\/(private\/)?var\/tmp(\/|$)/,
  /^\/(private\/)?tmp(\/|$)/,
  /\/\.claude\/worktrees\//,
  /\/claude-\d+\//,
  /\/scratchpad(\/|$)/,
  /(^|\/)(atelier|ace)-(qa|mp|smoke|scratch|test|fixture)[\w.-]*(\/|$)/i,
];

export function normalizePath(p: string): string {
  let n = toPosixPath(p).replace(/\/{2,}/g, "/").replace(/\/\.(?=\/|$)/g, "");
  if (n.length > 1 && !/^[A-Za-z]:\/?$/.test(n)) n = n.replace(/\/+$/, "");
  return n.replace(/^\/private(?=\/(tmp|var|etc)(\/|$))/, "");
}
export const recentKey = (l: Loc) => `${l.host}:${normalizePath(l.path)}`;

export function isTransient(l: Loc, extra: string[] = []): boolean {
  if (l.host !== "local") return false;
  const p = normalizePath(l.path);
  if (TRANSIENT.some((r) => r.test(p) || r.test(l.path))) return true;
  return extra.filter(Boolean).some((t) => { const n = normalizePath(t); return p === n || p.startsWith(n + "/"); });
}

/** Drop transient entries, then duplicates (same host + normalized path); keeps the first (= most recent) occurrence. */
export function dedupe<T extends Loc>(list: T[], opts: { tmpdir?: string } = {}): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const l of list) {
    if (!l || typeof l.path !== "string" || typeof l.host !== "string") continue;
    if (isTransient(l, opts.tmpdir ? [opts.tmpdir] : [])) continue;
    const k = recentKey(l);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(l.path.length > 1 && l.path.endsWith("/") ? { ...l, path: l.path.replace(/\/+$/, "") } : l);
  }
  return out;
}

/** "/Users/x/foo" -> "~/foo" (local), "mc:/home/x" (remote). */
export const abbrevPath = (l: Loc, home?: string): string => {
  if (l.host !== "local") return `${l.host}:${l.path}`;
  return homeShorten(l.path, home);
};

const base = (p: string) => basename(p) || p;

/** Two-letter tile text like IntelliJ: initials of words/camelCase humps ("Thematic-Collections" -> "TC", "HeirloomSite" -> "HS"), single word -> first 2 letters ("Ace" -> "Ac"). */
export function initials(name: string): string {
  const words = name.split(/[^A-Za-z0-9]+/).filter(Boolean);
  if (!words.length) return (name.trim().slice(0, 2) || "?").toUpperCase();
  let parts = words;
  if (words.length === 1) {
    const humps = words[0].match(/[A-Z]+(?![a-z])|[A-Z][a-z0-9]*|[a-z0-9]+/g) ?? [];
    if (humps.length > 1) parts = humps;
  }
  if (parts.length === 1) { const w = parts[0]; return w[0].toUpperCase() + (w[1] ?? "").toLowerCase(); }
  return (parts[0][0] + parts[1][0]).toUpperCase();
}

/** Stable tile colours (Nord aurora/frost, darkened enough for white text). */
export const TILE_COLORS = ["#5e81ac", "#81a1c1", "#8fa876", "#b48ead", "#d08770", "#bf616a", "#6f9aa8", "#c2a45c", "#7a8fb8", "#9a7fa0"];
export function tileColor(key: string): string {
  let h = 5381;
  for (let i = 0; i < key.length; i++) h = ((h << 5) + h + key.charCodeAt(i)) | 0;
  return TILE_COLORS[Math.abs(h) % TILE_COLORS.length];
}

/** `.git` file content "gitdir: /x/main/.git/worktrees/name" -> "/x/main" (the main working tree), else null. */
export function mainRepoFromGitFile(content: string): string | null {
  const m = /^gitdir:\s*(.+?)\s*$/m.exec(content);
  if (!m) return null;
  const g = normalizePath(m[1]);
  const i = g.indexOf("/.git/worktrees/");
  if (i > 0) return g.slice(0, i);
  return null; // submodule (.git/modules/...) or unknown layout: not a worktree
}

export interface RecentRow<T extends Loc = Loc> { loc: T; name: string; key: string }
export interface RecentGroup<T extends Loc = Loc> { main: RecentRow<T>; members: RecentRow<T>[] }

/**
 * Group worktrees under their main repo. `mainOf` maps a recentKey to the main repo path found from its `.git` file (local only,
 * lazily probed by the caller). Fallback when unknown: same parent dir and folder name `<main>-<suffix>`. A group needs the main
 * repo to be in the list. Order: groups/rows keep the order of their first (most recent) member.
 */
export function groupWorktrees<T extends Loc>(list: T[], mainOf: Record<string, string | null | undefined> = {}): (RecentRow<T> | RecentGroup<T>)[] {
  const rows: RecentRow<T>[] = list.map((loc) => ({ loc, name: base(loc.path), key: recentKey(loc) }));
  const byKey = new Map(rows.map((r) => [r.key, r]));
  const parentOf = new Map<string, RecentRow<T>>(); // member key -> main row
  for (const r of rows) {
    if (r.loc.host !== "local") continue;
    const declared = mainOf[r.key];
    let main: RecentRow<T> | undefined;
    if (declared) main = byKey.get(`local:${declared}`);
    else if (declared === undefined) {
      // fallback: folder-name prefix next to the main repo
      const dir = normalizePath(r.loc.path).replace(/\/[^/]*$/, "");
      main = rows.filter((c) => c !== r && c.loc.host === "local" && normalizePath(c.loc.path).replace(/\/[^/]*$/, "") === dir && r.name.startsWith(c.name + "-") && mainOf[c.key] == null)
        .sort((a, b) => b.name.length - a.name.length)[0];
    }
    if (main && main !== r) parentOf.set(r.key, main);
  }
  // a main that is itself a member of another group (chain) collapses to the top
  const top = (r: RecentRow<T>): RecentRow<T> => { let c = r; for (let i = 0; i < 5 && parentOf.has(c.key); i++) c = parentOf.get(c.key)!; return c; };
  const groups = new Map<string, RecentGroup<T>>();
  const out: (RecentRow<T> | RecentGroup<T>)[] = [];
  for (const r of rows) {
    const t = top(r);
    if (t === r && ![...parentOf.values()].some((m) => top(m) === r)) { out.push(r); continue; }
    let g = groups.get(t.key);
    if (!g) { g = { main: t, members: [] }; groups.set(t.key, g); out.push(g); }
    if (r !== t) g.members.push(r);
  }
  return out;
}
export const isGroup = <T extends Loc>(x: RecentRow<T> | RecentGroup<T>): x is RecentGroup<T> => "members" in x;

const alnum = (c: string) => /[A-Za-z0-9]/.test(c);
const boundary = (t: string, i: number) => i === 0 || !alnum(t[i - 1]) || (t[i - 1] === t[i - 1].toLowerCase() && t[i] !== t[i].toLowerCase());

/**
 * IntelliJ-style name matching: a substring, or camel-hump / word-start abbreviation ("tcs" -> Thematic-Collections-storage).
 * `fuzzy` is the loose scorer; it is accepted only when every matched char starts a word/hump or directly follows the previous one.
 */
export function matchName(query: string, text: string, fuzzy: (q: string, t: string) => { indices: number[] } | null): number[] | null {
  const q = query.trim();
  if (!q) return [];
  const at = text.toLowerCase().indexOf(q.toLowerCase());
  if (at >= 0) return Array.from({ length: q.length }, (_, i) => at + i);
  const f = fuzzy(q, text);
  if (!f) return null;
  const ok = f.indices.every((i, k) => boundary(text, i) || (k > 0 && f.indices[k - 1] === i - 1));
  return ok ? f.indices : null;
}
