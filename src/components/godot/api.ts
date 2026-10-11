import { invoke, listen, type Location, type UnlistenFn } from "../../lib/ipc";

export interface GodotBin { path: string; source: string }
export interface ScanScript { path: string; kind: "SceneTree" | "MainLoop" | string; doc: string }
export interface Scan { isProject: boolean; name: string; mainScene: string; scenes: string[]; scripts: ScanScript[]; readme: string }
export interface DbgMsg { cmd: string; thread: number; data: unknown[] }

export const godotApi = {
  find: (configured?: string) => invoke<GodotBin | null>("godot_find", { configured: configured || null }),
  scan: (root: string) => invoke<Scan>("godot_scan", { root }),
  changedScripts: (root: string, sinceMs: number) => invoke<string[]>("godot_changed_scripts", { root, sinceMs }),
  scenesUsing: (root: string, script: string) => invoke<string[]>("godot_scenes_using", { root, script }),
  /** the TCP port a game connects to with `--remote-debug tcp://127.0.0.1:<port>` */
  dbgListen: (id: string) => invoke<number>("godot_dbg_listen", { id }),
  dbgSend: (id: string, cmd: string, data: unknown[] = [], thread = 1) => invoke<void>("godot_dbg_send", { id, cmd, thread, data }),
  dbgClose: (id: string) => invoke<void>("godot_dbg_close", { id }),
  onDbg: (id: string, cb: (m: DbgMsg) => void): Promise<UnlistenFn> => listen<DbgMsg>(`godot://dbg/${id}`, (e) => cb(e.payload)),
  onConn: (id: string, cb: () => void): Promise<UnlistenFn> => listen(`godot://dbg-conn/${id}`, () => cb()),
  onClosed: (id: string, cb: () => void): Promise<UnlistenFn> => listen(`godot://dbg-closed/${id}`, () => cb()),
  openEditor: (project: string, scene?: string, godot?: string) => invoke<string[]>("godot_open_editor", { project, scene: scene ?? null, godot: godot || null }),
};
export type { Location };
