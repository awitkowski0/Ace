import { invoke, listen, type DirEntry, type Location } from "../../lib/ipc";
import { createStore } from "../../lib/store";

export interface RichEntry extends DirEntry {
  mode: number;
}
export interface Bookmark {
  host: string;
  path: string;
  name: string;
}
export interface Transfer {
  id: string;
  name: string;
  direction: "upload" | "download";
  host: string;
  bytes: number;
  total: number;
  state: "queued" | "running" | "done" | "error" | "cancelled";
  error?: string | null;
}
export interface DiskUsage {
  total: number;
  used: number;
  avail: number;
}

export const rf = {
  hosts: () => invoke<string[]>("remote_hosts"),
  home: (host: string) => invoke<string>("remote_home", { host }),
  list: (loc: Location) => invoke<RichEntry[]>("remote_list_dir", { loc }),
  chmod: (loc: Location, mode: string, recursive: boolean) => invoke<void>("remote_chmod", { loc, mode, recursive }),
  du: (loc: Location) => invoke<DiskUsage>("remote_disk_usage", { loc }),
  upload: (host: string, localPaths: string[], remoteDir: string) => invoke<string[]>("remote_upload", { host, localPaths, remoteDir }),
  download: (host: string, remotePaths: string[], localDir: string) => invoke<string[]>("remote_download", { host, remotePaths, localDir }),
  cancel: (id: string) => invoke<void>("remote_cancel", { id }),
  bookmarks: () => invoke<Bookmark[]>("remote_bookmarks_get"),
  setBookmarks: (bookmarks: Bookmark[]) => invoke<void>("remote_bookmarks_set", { bookmarks }),
};

export const transferStore = createStore<{ items: Transfer[] }>({ items: [] });
let listening = false;
export function ensureTransferListener() {
  if (listening) return;
  listening = true;
  listen<Transfer>("remote://transfer", (e) => {
    const t = e.payload;
    transferStore.set((s) => {
      const i = s.items.findIndex((x) => x.id === t.id);
      return { items: i < 0 ? [...s.items, t] : s.items.map((x, j) => (j === i ? t : x)) };
    });
  });
}
export const clearFinishedTransfers = () =>
  transferStore.set((s) => ({ items: s.items.filter((t) => t.state === "queued" || t.state === "running") }));

export function lsGet(key: string): string | null {
  try {
    return localStorage.getItem("atelier.rf." + key);
  } catch {
    return null;
  }
}
export function lsSet(key: string, v: string) {
  try {
    localStorage.setItem("atelier.rf." + key, v);
  } catch {}
}

export function humanSize(n: number): string {
  if (n < 1024) return `${n} B`;
  const u = ["KB", "MB", "GB", "TB"];
  let i = -1;
  do {
    n /= 1024;
    i++;
  } while (n >= 1024 && i < u.length - 1);
  return `${n < 10 ? n.toFixed(1) : Math.round(n)} ${u[i]}`;
}
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export function fmtDate(ms: number | null): string {
  if (!ms) return "";
  const d = new Date(ms);
  const p = (x: number) => String(x).padStart(2, "0");
  const old = Date.now() - ms > 180 * 864e5;
  return `${MON[d.getMonth()]} ${d.getDate()} ${old ? d.getFullYear() : `${p(d.getHours())}:${p(d.getMinutes())}`}`;
}
export function fmtMode(mode: number, isDir: boolean, isLink: boolean): string {
  const bits = "rwxrwxrwx";
  let s = isLink ? "l" : isDir ? "d" : "-";
  for (let i = 0; i < 9; i++) s += mode & (1 << (8 - i)) ? bits[i] : "-";
  return s;
}
