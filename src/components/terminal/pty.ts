import { invoke, listen, type UnlistenFn } from "../../lib/ipc";

export interface PtySpawnOpts {
  host: string;
  cwd: string;
  command?: string;
  cols: number;
  rows: number;
  login?: boolean;
  shellIntegration?: boolean;
  /** Frontend-chosen id so listeners can be attached before the first byte. */
  id?: string;
}
export const pty = {
  spawn: (opts: PtySpawnOpts) => invoke<string>("pty_spawn", { opts }),
  write: (id: string, data: string) => invoke<void>("pty_write", { id, data }),
  ack: (id: string, bytes: number) => invoke<void>("pty_ack", { id, bytes }),
  resize: (id: string, cols: number, rows: number) => invoke<void>("pty_resize", { id, cols, rows }),
  kill: (id: string) => invoke<void>("pty_kill", { id }),
  onData: (id: string, cb: (bytes: Uint8Array) => void): Promise<UnlistenFn> =>
    listen<string>(`pty://data/${id}`, (e) => {
      const bin = atob(e.payload);
      const out = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
      cb(out);
    }),
  onExit: (id: string, cb: (code: number | null) => void): Promise<UnlistenFn> =>
    listen<number | null>(`pty://exit/${id}`, (e) => cb(e.payload)),
};
