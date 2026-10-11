/** Python Packages window state (module level: an install keeps streaming while the window is hidden). */
import { createStore } from "../../../lib/store";
import { projectStore } from "../../../lib/project";
import { pyApi, runner, type PypiHit, type RunSpec } from "../api";
import { currentInterpreter, ensurePython, pyStore } from "../interpreter";
import { commandLine, compareVersions, isExternallyManaged, isPrerelease, listArgv, norm, opArgv, parseList, type OpKind, type Pkg } from "./pip";

export interface Detail { name: string; version: string; summary: string; versions: string[] }
export interface PkgState {
  pkgs: Pkg[];
  loading: boolean;
  error: string | null;
  query: string;
  mode: "installed" | "pypi";
  hits: PypiHit[];
  searching: boolean;
  selected: { name: string; source: "installed" | "pypi" } | null;
  detail: Detail | null;
  detailError: string | null;
  detailLoading: boolean;
  log: string;
  running: string | null;
  status: { text: string; error: boolean } | null;
  /** interpreter whose packages are listed */
  interp: string | null;
  tool: "uv" | "pip" | null;
}
export const pkgStore = createStore<PkgState>({
  pkgs: [], loading: false, error: null, query: "", mode: "installed", hits: [], searching: false, selected: null, detail: null, detailError: null,
  detailLoading: false, log: "", running: null, status: null, interp: null, tool: null,
});
const set = (p: Partial<PkgState>) => pkgStore.set(p);

// eslint-disable-next-line no-control-regex
const strip = (s: string) => s.replace(/\x1b\[[0-9;:?]*[ -/]*[@-~]/g, "");
const root = () => projectStore.get().root;
let token = 0;

/** QA only: list/operate on another host's interpreter without opening a project there. */
let override: { host: string; cwd: string; python: string } | null = null;
export function setPackagesOverride(o: { host: string; cwd: string; python: string } | null) { override = o; }

async function target() {
  if (override) {
    const i = { id: override.python, path: override.python, version: "", kind: "system" as const, name: "override", envRoot: null, project: false, host: override.host };
    return { i, r: { host: override.host, path: override.cwd }, uv: null as string | null };
  }
  if (!currentInterpreter()) await ensurePython().catch(() => {});
  const i = currentInterpreter();
  const r = root();
  if (!i || !r) return null;
  const uv = pyStore.get().tools.uv ?? null;
  return { i, r, uv };
}
const specFor = (r: { host: string; path: string }, argv: string[]): RunSpec => ({ host: r.host, cwd: r.path, argv });

/** List the installed packages of the selected interpreter. Called on open, on interpreter change and after operations only. */
export async function refresh() {
  const t = await target();
  if (!t) { set({ error: "No Python interpreter is configured for this project.", pkgs: [], interp: null }); return; }
  const my = ++token;
  set({ loading: true, error: null, interp: t.i.path, tool: t.uv ? "uv" : "pip" });
  try {
    const out = await runner.exec(specFor(t.r, listArgv(t.i.path, t.uv)), undefined, 60000);
    if (my !== token) return;
    if (out.code !== 0) {
      const msg = (out.stderr || out.stdout).trim().split("\n").slice(-3).join("\n") || `exit code ${out.code}`;
      set({ loading: false, pkgs: [], error: out.timedOut ? "Timed out listing packages." : msg });
      return;
    }
    set({ loading: false, pkgs: parseList(out.stdout), error: null });
  } catch (e) {
    if (my === token) set({ loading: false, pkgs: [], error: String((e as Error)?.message ?? e) });
  }
}

export async function lookup(name: string): Promise<Detail | null> {
  try { return await pyApi.pypiInfo(name); } catch { return null; }
}

export async function select(name: string, source: "installed" | "pypi") {
  set({ selected: { name, source }, detail: null, detailError: null, detailLoading: true });
  const d = await lookup(name);
  const cur = pkgStore.get().selected;
  if (!cur || cur.name !== name) return;
  if (!d) set({ detailLoading: false, detailError: "No PyPI information available (offline or not on PyPI)." });
  else set({ detailLoading: false, detail: { ...d, versions: [...d.versions].sort((a, b) => compareVersions(b, a)) } });
}

export async function search(query: string) {
  set({ query, mode: "pypi", searching: true, hits: [] });
  const q = query.trim();
  if (!q) { set({ searching: false }); return; }
  let hits: PypiHit[] = [];
  try { hits = await pyApi.pypiSearch(q); } catch { /* offline */ }
  if (pkgStore.get().query !== query) return;
  set({ hits, searching: false });
}
export function setMode(mode: "installed" | "pypi") {
  set({ mode });
  if (mode === "pypi" && pkgStore.get().query.trim()) void search(pkgStore.get().query);
}
export const setQuery = (query: string) => set({ query });
export function clearLog() { set({ log: "" }); }

export const installedVersion = (name: string) => pkgStore.get().pkgs.find((p) => norm(p.name) === norm(name))?.version ?? null;
export const stableVersions = (d: Detail | null) => (d ? d.versions.filter((v) => !isPrerelease(v)) : []);

export interface OpResult { ok: boolean; code: number | null; output: string; command: string; cancelled?: boolean }

/** Ask for confirmation (showing the exact command), then run it and stream into the log. Never runs without the confirmation. */
export async function requestOp(kind: OpKind, name: string, version?: string | null, o: { skipConfirm?: boolean } = {}): Promise<OpResult> {
  const t = await target();
  if (!t) { set({ status: { text: "No Python interpreter is configured.", error: true } }); return { ok: false, code: null, output: "", command: "" }; }
  const argv = opArgv(kind, t.i.path, t.uv, name, version);
  const command = commandLine(argv);
  if (pkgStore.get().running) { set({ status: { text: "Another package operation is still running.", error: true } }); return { ok: false, code: null, output: "", command, cancelled: true }; }
  if (!o.skipConfirm) {
    const { confirmDialog } = await import("../../shell/dialogs");
    const verb = kind === "install" ? "Install" : kind === "upgrade" ? "Upgrade" : "Uninstall";
    const ok = await confirmDialog({
      title: `${verb} package "${name}"?`,
      message: `This will modify the environment of\n${t.i.name} (${t.i.path})\n\nCommand:\n${command}`,
      okLabel: verb,
    });
    if (!ok) return { ok: false, code: null, output: "", command, cancelled: true };
  }
  return runOp(kind, name, command, specFor(t.r, argv));
}

function runOp(kind: OpKind, name: string, command: string, spec: RunSpec): Promise<OpResult> {
  const verb = kind === "install" ? "Installing" : kind === "upgrade" ? "Upgrading" : "Uninstalling";
  set({ running: `${verb} ${name}`, status: { text: `${verb} ${name}…`, error: false }, log: pkgStore.get().log + `$ ${command}\n` });
  let output = "";
  return new Promise<OpResult>((resolve) => {
    const finish = async (code: number | null) => {
      const ok = code === 0;
      let text = ok ? `${{ install: "Installed", upgrade: "Upgraded", uninstall: "Uninstalled" }[kind]} ${name} successfully.` : `Failed (exit code ${code ?? "?"}): ${kind} ${name}.`;
      if (!ok && isExternallyManaged(output)) {
        text = "This environment is externally managed (PEP 668): the operating system or Homebrew owns its packages, so nothing was changed. Select or create a virtual environment for this project (Python interpreter widget > Add Interpreter) and install there.";
      } else if (!ok) {
        const last = strip(output).trim().split("\n").filter(Boolean).slice(-1)[0];
        if (last) text += ` ${last}`;
      }
      set({ running: null, status: { text, error: !ok }, log: pkgStore.get().log + (ok ? "" : "\n") + `\n${ok ? "Done" : "Failed"} (exit code ${code ?? "?"})\n\n` });
      await refresh();
      if (pkgStore.get().selected?.name === name) void select(name, pkgStore.get().selected!.source);
      resolve({ ok, code, output, command });
    };
    runner
      .start(spec, {
        label: `pip ${kind} ${name}`,
        kind: "pypackages",
        onOut: (segs) => {
          const t = strip(segs.map((s) => s.d).join(""));
          output += t;
          set({ log: pkgStore.get().log + t });
        },
        onExit: (r) => void finish(r.code),
      })
      .catch((e) => {
        output += String(e);
        set({ log: pkgStore.get().log + `${String(e)}\n` });
        void finish(null);
      });
  });
}
