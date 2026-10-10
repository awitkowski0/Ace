import { invoke, listen, type Location } from "../../lib/ipc";

export interface FileHit { path: string; rel: string; name: string; nameStart: number; indices: number[]; score: number }
export interface FileResult { hits: FileHit[]; line: number | null; col: number | null; total: number; elapsedMs: number }
export interface SymHit { name: string; kind: string; path: string; rel: string; line: number; indices: number[]; score: number }
export interface TextOpts {
  query: string;
  caseSensitive: boolean;
  words: boolean;
  regex: boolean;
  mask: string;
  scope?: string | null;
  maxResults?: number;
}
export interface TextMatch { path: string; rel: string; line: number; col: number; text: string; ranges: [number, number][] }
interface Batch { id: number; matches: TextMatch[]; done: boolean; total: number; truncated: boolean; error: string | null; elapsedMs: number }

export const searchIndex = (root: Location, rebuild = false) => invoke<{ count: number; elapsedMs: number }>("search_index", { root, rebuild });
export const searchFiles = (root: Location, query: string, limit: number, recent: string[]) =>
  invoke<FileResult>("search_files", { root, query, limit, recent });
export const searchSymbols = (root: Location, query: string, kind: "all" | "classes", limit: number) =>
  invoke<{ hits: SymHit[]; elapsedMs: number }>("search_symbols", { root, query, kind, limit });
export const searchReplace = (root: Location, opts: TextOpts, replacement: string, files: string[]) =>
  invoke<{ files: number; replacements: number; errors: string[] }>("search_replace", { root, opts, replacement, files });

let nextId = Math.floor(Date.now() % 1e9) * 10;

export interface TextSearchHandle {
  id: number;
  cancel: () => void;
}
/** Streams matches; `onBatch(matches, done, info)` is called per batch. */
export function searchText(
  root: Location,
  opts: TextOpts,
  onBatch: (m: TextMatch[], done: boolean, info: { total: number; truncated: boolean; error: string | null; elapsedMs: number }) => void,
): TextSearchHandle {
  const id = nextId++;
  let dead = false;
  let un: (() => void) | null = null;
  const cleanup = () => { un?.(); un = null; };
  const handle: TextSearchHandle = {
    id,
    cancel() {
      if (dead) return;
      dead = true;
      cleanup();
      invoke("search_cancel", { id }).catch(() => {});
    },
  };
  listen<Batch>(`search://results/${id}`, (e) => {
    if (dead) return;
    const b = e.payload;
    onBatch(b.matches, b.done, { total: b.total, truncated: b.truncated, error: b.error, elapsedMs: b.elapsedMs });
    if (b.done) { dead = true; cleanup(); }
  }).then((u) => {
    if (dead) return u();
    un = u;
    invoke("search_text", { id, root, opts }).catch((err) => {
      if (!dead) onBatch([], true, { total: 0, truncated: false, error: String(err), elapsedMs: 0 });
    });
  });
  return handle;
}
