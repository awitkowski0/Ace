import { invoke } from "../../../lib/ipc";

export interface Jdk { home: string; major: number; version: string; vendor: string; jbr: boolean; hasJavac: boolean; agent: string | null }
export interface Prepared { initScript: string; jbrPaths: string; jbrMajors: number[]; note: string | null }
export interface VmInfo { description: string; vmName: string; vmVersion: string; jdwp: string; canRedefine: boolean; canAddMethod: boolean; canUnrestrictedRedefine: boolean; javaVersion: string }
export interface BpResult { line: number; verified: boolean; message: string | null }
export interface JFrame { id: number; name: string; line: number; path: string | null; className: string; method: string; top: boolean }
export interface JVar { name: string; value: string; type: string; ref: number; indexed: number }
export interface JScope { name: string; ref: number; expensive: boolean }
export interface JThread { id: number; name: string }
export type AttachState =
  | { state: "waiting"; port: number; waitedMs?: number }
  | { state: "attached"; port: number; vm: VmInfo; waitedMs: number }
  | { state: "detached" | "closed" | "timeout"; port: number; waitedMs?: number };
export interface VmEvent { kind: "vmDeath" | "vmStart" | "classPrepare" | "breakpoint" | "step"; signature: string | null; thread: number; requestId: number; suspendPolicy: number }
export interface HotswapResult {
  ok: boolean; stage: "resolve" | "compile" | "redefine" | "done"; message: string; redefined: string[]; skipped: string[]; warnings: string[];
  output: string; errorCode: number | null; errorName: string | null; elapsedMs: number; compiled: number; javac: string; release: number; sourceSet: string; dumped: boolean;
}

export const javaApi = {
  freePort: () => invoke<number>("jdwp_free_port"),
  attach: (id: string, port: number, timeoutSecs: number, root: string) => invoke<void>("jdwp_attach", { args: { id, port, timeoutSecs, root } }),
  breakpoints: (id: string, file: string, lines: number[]) => invoke<BpResult[]>("jdwp_breakpoints", { id, file, lines: lines.map((line) => ({ line })) }),
  threads: (id: string) => invoke<JThread[]>("jdwp_threads", { id }),
  stack: (id: string, thread: number) => invoke<JFrame[]>("jdwp_stack", { id, thread }),
  scopes: (id: string, frame: number) => invoke<JScope[]>("jdwp_scopes", { id, frame }),
  variables: (id: string, reference: number) => invoke<JVar[]>("jdwp_variables", { id, reference }),
  resume: (id: string) => invoke<void>("jdwp_resume", { id }),
  suspend: (id: string) => invoke<void>("jdwp_suspend", { id }),
  step: (id: string, thread: number, depth: "into" | "over" | "out") => invoke<void>("jdwp_step", { id, thread, depth }),
  detach: (id: string, kill: boolean) => invoke<void>("jdwp_detach", { id, kill }),
  killGame: (port: number) => invoke<number[]>("jdwp_kill_game", { port }),
  info: (id: string) => invoke<AttachState | null>("jdwp_info", { id }),
  watchClasses: (id: string, classPattern: string) => invoke<number>("jdwp_events", { id, classPattern }),
  jdks: () => invoke<Jdk[]>("hotswap_jdks"),
  prepare: (port: number, enhanced: boolean) => invoke<Prepared>("gradle_debug_prepare", { args: { port, enhanced } }),
  cleanup: (port: number) => invoke<void>("gradle_debug_cleanup", { port }),
  hotswap: (id: string, file: string, root: string, o: { enhanced?: boolean; refresh?: boolean; dryRun?: boolean; ran?: string[] } = {}) => invoke<HotswapResult>("hotswap_run", { args: { id, file, root, enhanced: !!o.enhanced, refresh: !!o.refresh, dryRun: !!o.dryRun, ran: o.ran ?? [] } }),
  forget: (id: string) => invoke<void>("hotswap_forget", { id }),
};
export const dumpClasspath = (root: string, file: string) => invoke<Record<string, unknown>>("hotswap_dump", { root, file });
