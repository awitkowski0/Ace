/**
 * Per-project Python interpreter state. Everything Python (LSP, run configs, debugger, console, packages, terminal activation)
 * reads the selected interpreter from here. Nothing is spawned until `ensurePython()` runs, which happens only for a Python
 * project (marker files) or once a .py file is open.
 */
import { createStore, useStore } from "../../lib/store";
import { fs, joinPath, type Location } from "../../lib/ipc";
import { projectStore } from "../../lib/project";
import { editorStore } from "../../editor/store";
import { pstore, pyApi, type Interp, type ProbeInfo, type RunSpec, type Tools } from "./api";

export interface PyState {
  /** is this a Python project (markers or an open .py file)? Gates the status widget and every Python process. */
  active: boolean;
  loading: boolean;
  interpreters: Interp[];
  /** selected interpreter (explicit choice, else auto: first project venv, else first discovered) */
  current: Interp | null;
  /** user explicitly chose (persisted) */
  explicit: boolean;
  probe: ProbeInfo | null;
  tools: Tools;
  error?: string;
  rev: number;
}
export const pyStore = createStore<PyState>({ active: false, loading: false, interpreters: [], current: null, explicit: false, probe: null, tools: {}, rev: 0 });
export const usePy = () => useStore(pyStore);

interface Saved { interpreter: string | null; custom: Interp[] }
const root = (): Location | null => projectStore.get().root;
const MARKERS = ["pyproject.toml", "setup.py", "setup.cfg", "requirements.txt", "Pipfile", "poetry.lock", "uv.lock", "manage.py", ".venv/pyvenv.cfg", "venv/pyvenv.cfg"];

let loadedFor = "";
let ensuring: Promise<void> | null = null;
const key = (r: Location) => `${r.host}:${r.path}`;
const listeners = new Set<(i: Interp | null) => void>();
/** called whenever the effective interpreter changes (LSP restarts, console restarts ...) */
export const onInterpreterChange = (cb: (i: Interp | null) => void) => (listeners.add(cb), () => listeners.delete(cb));

export const currentInterpreter = () => pyStore.get().current;
export const isPythonActive = () => pyStore.get().active;

/** Markers / open .py files: cheap fs.stat calls only. */
export async function detectPythonProject(): Promise<boolean> {
  const r = root();
  if (!r) return false;
  if (Object.values(editorStore.get().docs).some((d) => d.language === "python")) return true;
  for (const m of MARKERS) {
    const st = await fs.stat({ host: r.host, path: joinPath(r.path, m) }).catch(() => null);
    if (st?.exists) return true;
  }
  return false;
}

/** Idempotent per project: discover interpreters, restore the saved choice, probe it, find tools. */
export function ensurePython(force = false): Promise<void> {
  const r = root();
  if (!r) return Promise.resolve();
  if (!force && loadedFor === key(r) && pyStore.get().current) return Promise.resolve();
  if (ensuring && !force) return ensuring;
  ensuring = (async () => {
    pyStore.set({ active: true, loading: true, error: undefined });
    try {
      const saved = (await pstore.get<Saved>(r, "python")) ?? { interpreter: null, custom: [] };
      const found = await pyApi.discover(r.host, r.path).catch((e) => { pyStore.set({ error: String(e) }); return [] as Interp[]; });
      const all = [...found];
      for (const c of saved.custom ?? []) if (!all.some((i) => i.path === c.path)) all.push(c);
      let current = saved.interpreter ? all.find((i) => i.path === saved.interpreter) ?? null : null;
      const explicit = !!current;
      if (!current) current = all.find((i) => i.project) ?? all[0] ?? null;
      loadedFor = key(r);
      pyStore.set({ interpreters: all, current, explicit });
      await applyProbe(current);
    } finally {
      pyStore.set({ loading: false, rev: pyStore.get().rev + 1 });
      ensuring = null;
    }
  })();
  return ensuring;
}

async function applyProbe(i: Interp | null) {
  const r = root();
  if (!r || !i) { pyStore.set({ probe: null }); return; }
  const [probe, tools] = await Promise.all([pyApi.probe(i.host, i.path).catch(() => null), pyApi.tools(i.host, i.path).catch(() => ({}) as Tools)]);
  if (pyStore.get().current?.path !== i.path) return;
  pyStore.set({ probe, tools, rev: pyStore.get().rev + 1 });
  listeners.forEach((cb) => cb(i));
}

async function save(patch: Partial<Saved>) {
  const r = root();
  if (!r) return;
  const cur = (await pstore.get<Saved>(r, "python")) ?? { interpreter: null, custom: [] };
  await pstore.set(r, "python", { ...cur, ...patch });
}

/** Switch the project interpreter (persisted per project). `interp` may be new (not discovered): it is remembered as custom. */
export async function setInterpreter(interp: Interp) {
  const st = pyStore.get();
  const known = st.interpreters.some((i) => i.path === interp.path);
  const interpreters = known ? st.interpreters : [...st.interpreters, interp];
  pyStore.set({ interpreters, current: interp, explicit: true, probe: null });
  const r = root();
  if (r) {
    const saved = (await pstore.get<Saved>(r, "python")) ?? { interpreter: null, custom: [] };
    const custom = known ? saved.custom ?? [] : [...(saved.custom ?? []).filter((c) => c.path !== interp.path), interp];
    await save({ interpreter: interp.path, custom });
  }
  await applyProbe(interp);
}

/** An interpreter built from a bare path (the "existing interpreter" field): probes it for the version. */
export async function interpreterFromPath(host: string, path: string, label?: string): Promise<Interp> {
  const p = await pyApi.probe(host, path);
  const v = `${p.version[0]}.${p.version[1]}.${p.version[2]}`;
  const envRoot = p.inVenv ? p.prefix : null;
  const kind: Interp["kind"] = envRoot ? (/conda-meta/.test(envRoot) ? "conda" : "venv") : "system";
  const name = label ?? (envRoot ? `Python ${p.version[0]}.${p.version[1]} (${envRoot.split("/").filter(Boolean).slice(-2, -1)[0] ?? "venv"})` : `Python ${p.version[0]}.${p.version[1]}`);
  return { id: path, path, version: v, kind, name, envRoot, project: false, host };
}

/** PATH/env additions that "activate" `i` for a child process (VIRTUAL_ENV is derived from `<venv>/bin` by Rust). */
export function envFor(i: Interp | null = currentInterpreter()): { pathPrepend: string[]; env: Record<string, string> } {
  if (!i) return { pathPrepend: [], env: {} };
  const bin = i.path.slice(0, i.path.lastIndexOf("/"));
  const env: Record<string, string> = {};
  if (i.kind === "conda" && i.envRoot) env.CONDA_PREFIX = i.envRoot;
  return { pathPrepend: i.envRoot ? [bin] : [], env };
}

/** A RunSpec for the selected interpreter: `args` are appended to the python executable (e.g. ["-m","pytest"]). */
export function pythonSpec(args: string[], o: { cwd?: string; env?: Record<string, string>; interp?: Interp | null; loc?: Location } = {}): RunSpec {
  const i = o.interp === undefined ? currentInterpreter() : o.interp;
  const r = o.loc ?? root()!;
  const e = envFor(i);
  return { host: r.host, cwd: o.cwd ?? r.path, argv: [i?.path ?? "python3", ...args], env: { ...e.env, ...(o.env ?? {}) }, pathPrepend: e.pathPrepend };
}

/** Is `tool` ("ruff", "black", ...) available for the selected interpreter (its bin dir first, then the login PATH)? */
export const toolPath = (name: string) => pyStore.get().tools[name] ?? null;

/** Wire-up: activates on project open / when a .py doc appears. Called once from register.tsx. */
export function watchPythonProject() {
  let last = "";
  const check = async () => {
    const r = root();
    if (!r) return;
    const k = key(r);
    if (pyStore.get().active && loadedFor === k) return;
    if (k !== last) { last = k; pyStore.set({ active: false, interpreters: [], current: null, probe: null, tools: {}, explicit: false }); loadedFor = ""; }
    if (await detectPythonProject()) void ensurePython();
  };
  projectStore.subscribe(check);
  editorStore.subscribe(() => { if (!pyStore.get().active) void check(); });
  void check();
}
