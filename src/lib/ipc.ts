/**
 * Typed wrappers over Tauri invoke/events. Other modules: import `invoke`/`listen` from here and
 * add your own typed wrappers in YOUR module's file (not here) to avoid conflicts.
 */
import { invoke } from "@tauri-apps/api/core";
import type { EventCallback, UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { toPosixPath } from "./paths";

export { invoke };
export type { UnlistenFn };

/**
 * Event subscription scoped to THIS window. Tauri's global `listen` registers with target `Any`, which receives every
 * event, even ones Rust sent with `emit_to(<other window>)`. Window-scoped listeners only get events addressed to this
 * window (or broadcast), which is what keeps two project windows from seeing each other's terminal / fs / lsp events.
 */
export function listen<T>(event: string, handler: EventCallback<T>): Promise<UnlistenFn> {
  return getCurrentWebviewWindow().listen<T>(event, handler);
}

export interface Location {
  host: string; // "local" | ssh alias
  path: string;
}
export interface DirEntry {
  name: string;
  path: string;
  isDir: boolean;
  isSymlink: boolean;
  size: number;
  modified: number | null;
}
export interface FileStat {
  exists: boolean;
  isDir: boolean;
  isFile: boolean;
  isSymlink: boolean;
  size: number;
  modified: number | null;
}
export interface FsChanged {
  root: string;
  paths: string[];
  kind: "create" | "remove" | "modify" | "other";
}

export const local = (path: string): Location => ({ host: "local", path });
export const locKey = (l: Location) => `${l.host}:${l.path}`;
export const sameLoc = (a: Location, b: Location) => a.host === b.host && a.path === b.path;

export { dirname, basename, joinPath } from "./paths";

/**
 * Windows decision: local paths are normalised to forward slashes at this boundary ("C:\\Users\\x" -> "C:/Users/x")
 * for everything the backend hands to the UI (directory listings, home, launch location, watch events). Rust accepts
 * forward slashes on Windows, and the UI helpers in ./paths accept both, so either form works. Mac paths have no drive
 * letter and pass through untouched.
 */
const posixLoc = (l: Location): Location => (l.host === "local" ? { ...l, path: toPosixPath(l.path) } : l);

export const fs = {
  listDir: async (loc: Location) =>
    (await invoke<DirEntry[]>("fs_list_dir", { loc })).map((e) => ({ ...e, path: toPosixPath(e.path) })),
  readFile: (loc: Location) => invoke<string>("fs_read_file", { loc }),
  /** raw bytes (ArrayBuffer, no base64); optional [offset, offset+len) range */
  readBytes: (loc: Location, offset?: number, len?: number) => invoke<ArrayBuffer>("fs_read_bytes", { loc, offset, len }),
  /** size + binary sniff (NUL / invalid UTF-8 in the first 8 KB) */
  probe: (loc: Location) => invoke<{ size: number; binary: boolean; modified: number | null }>("fs_probe", { loc }),
  writeFile: (loc: Location, contents: string) => invoke<void>("fs_write_file", { loc, contents }),
  stat: (loc: Location) => invoke<FileStat>("fs_stat", { loc }),
  rename: (from: Location, to: Location) => invoke<void>("fs_rename", { from, to }),
  /** recursive copy, same host, never overwrites */
  copy: (from: Location, to: Location) => invoke<void>("fs_copy", { from, to }),
  delete: (loc: Location) => invoke<void>("fs_delete", { loc }),
  /** local only: move to the Trash */
  trash: (paths: string[]) => invoke<void>("fs_trash", { paths }),
  createDir: (loc: Location) => invoke<void>("fs_create_dir", { loc }),
  home: async () => toPosixPath(await invoke<string>("fs_home")),
  launchLocation: async () => {
    const l = await invoke<Location | null>("launch_location");
    return l && posixLoc(l);
  },
  watch: (loc: Location) => invoke<void>("fs_watch", { loc }),
  unwatch: (loc: Location) => invoke<void>("fs_unwatch", { loc }),
  onChanged: (cb: (e: FsChanged) => void) =>
    listen<FsChanged>("fs://changed", (e) => cb({ ...e.payload, root: toPosixPath(e.payload.root), paths: e.payload.paths.map(toPosixPath) })),
};
