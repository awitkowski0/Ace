/**
 * Typed wrappers over Tauri invoke/events. Other modules: import `invoke`/`listen` from here and
 * add your own typed wrappers in YOUR module's file (not here) to avoid conflicts.
 */
import { invoke } from "@tauri-apps/api/core";
import type { EventCallback, UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";

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

export const dirname = (p: string) => {
  const i = p.lastIndexOf("/");
  return i <= 0 ? "/" : p.slice(0, i);
};
export const basename = (p: string) => p.slice(p.lastIndexOf("/") + 1);
export const joinPath = (dir: string, name: string) => (dir.endsWith("/") ? dir + name : `${dir}/${name}`);

export const fs = {
  listDir: (loc: Location) => invoke<DirEntry[]>("fs_list_dir", { loc }),
  readFile: (loc: Location) => invoke<string>("fs_read_file", { loc }),
  /** raw bytes (ArrayBuffer, no base64); optional [offset, offset+len) range */
  readBytes: (loc: Location, offset?: number, len?: number) => invoke<ArrayBuffer>("fs_read_bytes", { loc, offset, len }),
  /** size + binary sniff (NUL / invalid UTF-8 in the first 8 KB) */
  probe: (loc: Location) => invoke<{ size: number; binary: boolean; modified: number | null }>("fs_probe", { loc }),
  writeFile: (loc: Location, contents: string) => invoke<void>("fs_write_file", { loc, contents }),
  stat: (loc: Location) => invoke<FileStat>("fs_stat", { loc }),
  rename: (from: Location, to: Location) => invoke<void>("fs_rename", { from, to }),
  delete: (loc: Location) => invoke<void>("fs_delete", { loc }),
  createDir: (loc: Location) => invoke<void>("fs_create_dir", { loc }),
  home: () => invoke<string>("fs_home"),
  launchLocation: () => invoke<Location | null>("launch_location"),
  watch: (loc: Location) => invoke<void>("fs_watch", { loc }),
  unwatch: (loc: Location) => invoke<void>("fs_unwatch", { loc }),
  onChanged: (cb: (e: FsChanged) => void) => listen<FsChanged>("fs://changed", (e) => cb(e.payload)),
};
