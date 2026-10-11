/** Typed wrappers over the Rust python/runner/dap/pstore commands (src-tauri/src/{python,runner,dap,pstore}.rs). */
import { invoke, listen, type Location, type UnlistenFn } from "../../lib/ipc";

export interface Interp {
  id: string; // = path
  path: string;
  version: string; // 3.12.6
  kind: "venv" | "uv" | "poetry" | "pipenv" | "conda" | "pyenv" | "system";
  name: string; // "Python 3.12 (proj)"
  envRoot: string | null; // venv / conda prefix
  project: boolean; // lives in / belongs to the project
  host: string;
}
export interface ProbeInfo {
  version: [number, number, number];
  prefix: string;
  basePrefix: string;
  executable: string;
  sitePackages: string[];
  inVenv: boolean;
  /** importable in that interpreter: pip, debugpy, pytest, IPython, ruff, black, isort, basedpyright, pyright, jupyter_client, ipykernel, setuptools */
  modules: Record<string, boolean>;
}
/** tool name -> absolute path. Names: basedpyright-langserver, pyright-langserver, ruff, black, isort, uv, pipx, conda, poetry, pipenv */
export type Tools = Record<string, string>;

/** What to run and where. `argv` is exec'd directly; `shell` is a command line for a login shell instead. */
export interface RunSpec {
  host: string;
  cwd: string;
  argv?: string[];
  shell?: string;
  env?: Record<string, string>;
  /** directories put in front of PATH (the venv bin dir) */
  pathPrepend?: string[];
}
export interface ExecOut { code: number | null; stdout: string; stderr: string; timedOut: boolean }
export interface OutSeg { s: "out" | "err"; d: string }
export interface PypiHit { name: string; version: string; summary: string }

export const pyApi = {
  discover: (host: string, root: string) => invoke<Interp[]>("py_discover", { host, root }),
  probe: (host: string, python: string) => invoke<ProbeInfo>("py_probe", { host, python }),
  tools: (host: string, python?: string) => invoke<Tools>("py_tools", { host, python: python ?? null }),
  createVenv: (o: { host: string; dir: string; base?: string; tool: "uv" | "venv"; uv?: string; systemSite?: boolean }) =>
    invoke<string>("py_create_venv", { host: o.host, dir: o.dir, base: o.base ?? null, tool: o.tool, uv: o.uv ?? null, systemSite: o.systemSite ?? false }),
  createConda: (o: { host: string; conda: string; dir: string; pythonVersion?: string }) =>
    invoke<string>("py_create_conda", { host: o.host, conda: o.conda, dir: o.dir, pythonVersion: o.pythonVersion ?? null }),
  pypiSearch: (query: string) => invoke<PypiHit[]>("py_pypi_search", { query }),
  pypiInfo: (name: string) => invoke<{ name: string; version: string; summary: string; versions: string[] }>("py_pypi_info", { name }),
  /** local dir holding ace_pytest.py / ace_unittest.py / ace_console.py (put it on PYTHONPATH; nothing is installed anywhere) */
  scriptsDir: () => invoke<string>("py_scripts_dir"),
  /** source of a bundled script ("ace_pytest" | "ace_unittest" | "ace_console"), to run remotely with `python -c` */
  scriptSource: (name: string) => invoke<string>("py_script_source", { name }),
  /** pipe `stdin` through a command (ruff format -, black -q -, isort -) and return its output */
  filter: (root: Location, argv: string[], stdin: string) =>
    invoke<{ code: number | null; stdout: string; stderr: string; timedOut: boolean }>("py_filter", { locRoot: root, argv, stdin }),
};

/** Per-project JSON in the app data dir (never inside the project). */
export const pstore = {
  async get<T>(root: Location, name: string): Promise<T | null> {
    const t = await invoke<string | null>("pstore_get", { root, name }).catch(() => null);
    if (!t) return null;
    try { return JSON.parse(t) as T; } catch { return null; }
  },
  set: (root: Location, name: string, value: unknown) => invoke<void>("pstore_set", { root, name, json: JSON.stringify(value) }),
};

const sleepless = () => Math.random().toString(36).slice(2, 10);
export const newId = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${sleepless()}`;

/** Streaming processes (Run window, debuggee, console, package installs). Window-scoped events; every child is registered
 * with procs::register_for(window label) in Rust. Subscribe BEFORE start (the id is chosen here) so no output is missed. */
export const runner = {
  /** Starts `spec`; resolves once running. onOut gets coalesced segments, onExit fires once. Returns the run id + a dispose fn. */
  async start(spec: RunSpec, o: { label?: string; kind?: string; onOut: (segs: OutSeg[]) => void; onExit: (r: { code: number | null; signal: number | null }) => void }) {
    const id = newId("run");
    const un: UnlistenFn[] = [];
    un.push(await listen<OutSeg[]>(`run://out/${id}`, (e) => o.onOut(e.payload)));
    un.push(await listen<{ code: number | null; signal: number | null }>(`run://exit/${id}`, (e) => { o.onExit(e.payload); dispose(); }));
    const dispose = () => { un.splice(0).forEach((u) => u()); };
    try {
      await invoke("run_start", { id, spec, label: o.label ?? null, kind: o.kind ?? null });
    } catch (e) { dispose(); throw e; }
    return { id, dispose };
  },
  write: (id: string, data: string) => invoke<void>("run_write", { id, data }),
  closeStdin: (id: string) => invoke<void>("run_close_stdin", { id }),
  /** SIGTERM the process tree, SIGKILL after ~400 ms */
  stop: (id: string) => invoke<void>("run_stop", { id }),
  /** Ctrl+C */
  interrupt: (id: string) => invoke<void>("run_interrupt", { id }),
  alive: (id: string) => invoke<boolean>("run_alive", { id }),
  /** one-shot capture */
  exec: (spec: RunSpec, stdin?: string, timeoutMs?: number) => invoke<ExecOut>("proc_exec", { spec, stdin: stdin ?? null, timeoutMs: timeoutMs ?? null }),
};

/** Debug adapter bridge (DAP over the adapter's stdio, Content-Length framed by Rust). */
export const dapBridge = {
  start: (id: string, spec: RunSpec) => invoke<string>("dap_start", { id, spec }),
  send: (id: string, json: string) => invoke<void>("dap_send", { sessionId: id, json }),
  stop: (id: string) => invoke<void>("dap_stop", { sessionId: id }),
  onMsg: (id: string, cb: (json: string) => void) => listen<string>(`dap://msg/${id}`, (e) => cb(e.payload)),
  onLog: (id: string, cb: (line: string) => void) => listen<string>(`dap://log/${id}`, (e) => cb(e.payload)),
  onClosed: (id: string, cb: () => void) => listen(`dap://closed/${id}`, () => cb()),
};
