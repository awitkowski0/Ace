import { invoke, listen } from "../../lib/ipc";

export type Kind = "gradle" | "kotlin" | "java" | "lsp" | "claude" | "atelier";
export interface ProcRow {
  host: string;
  pid: number;
  kind: Kind;
  label: string;
  version: string | null;
  rss: number;
  cpu: number;
  uptimeSecs: number;
  cwd: string | null;
  busy: boolean | null;
  atelier: boolean;
  cmd: string;
}
export interface ListResult {
  rows: ProcRow[];
  elapsedMs: number;
}
export interface CleanItem {
  id: string;
  group: "daemon" | "caches" | "wrapper";
  label: string;
  path: string;
  bytes: number | null;
  cleanable: boolean;
  note: string | null;
}
export interface CleanEvent {
  host: string;
  scan: string;
  items: CleanItem[] | null;
  id: string | null;
  bytes: number | null;
  done: boolean;
  error: string | null;
  progress: [number, number] | null;
}
export interface CleanResult {
  moved: string[];
  skipped: [string, string][];
}

export const daemonsApi = {
  list: (host: string) => invoke<ListResult>("daemons_list", { host }),
  summary: () => invoke<{ gradleCount: number; rss: number }>("daemons_summary"),
  stop: (r: ProcRow) => invoke<string>("daemons_stop", { host: r.host, pid: r.pid, kind: r.kind, version: r.version }),
  kill: (r: ProcRow) => invoke<void>("daemons_kill", { host: r.host, pid: r.pid }),
  terminate: (host: string, pids: number[]) => invoke<void>("daemons_terminate", { host, pids }),
  stopAllGradle: (host: string, rows: ProcRow[]) =>
    invoke<string>("daemons_stop_all_gradle", { host, daemons: rows.map((r) => [r.pid, r.version]) }),
  cleanupScan: (host: string, scan: string) => invoke<void>("daemons_cleanup_scan", { host, scan }),
  cleanupCancel: (host: string) => invoke<void>("daemons_cleanup_cancel", { host }),
  cleanupRun: (host: string, paths: string[]) => invoke<CleanResult>("daemons_cleanup_run", { host, paths }),
  onCleanup: (cb: (e: CleanEvent) => void) => listen<CleanEvent>("daemons://cleanup", (e) => cb(e.payload)),
};

export function fmtBytes(n: number): string {
  if (n >= 1 << 30) return (n / (1 << 30)).toFixed(1) + " GB";
  if (n >= 1 << 20) return Math.round(n / (1 << 20)) + " MB";
  if (n >= 1 << 10) return Math.round(n / (1 << 10)) + " KB";
  return n + " B";
}
export function fmtUptime(s: number): string {
  if (s >= 86400) return `${Math.floor(s / 86400)}d ${Math.floor((s % 86400) / 3600)}h`;
  if (s >= 3600) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
  if (s >= 60) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${s}s`;
}
