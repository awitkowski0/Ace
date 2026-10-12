/** Interpreter operations shared by the dialog, the popup and the QA hooks. */
import { createStore } from "../../../lib/store";
import { projectStore } from "../../../lib/project";
import { pyApi, type Interp } from "../api";
import { ensurePython, interpreterFromPath, pyStore, setInterpreter } from "../interpreter";
import { insideProject } from "./logic";

const root = () => projectStore.get().root;

/** Finish an interpreter that was just created/typed: label it as a project interpreter when it lives under the project. */
async function adopt(host: string, python: string, kind?: Interp["kind"]): Promise<Interp> {
  const i = await interpreterFromPath(host, python);
  const r = root();
  if (kind) i.kind = kind;
  if (r && r.host === host && i.envRoot && insideProject(i.envRoot, r.path)) i.project = true;
  return i;
}

/** Use an existing interpreter given by path (probed first; throws with the interpreter's own error if it does not run). */
export async function useExistingInterpreter(python: string): Promise<Interp> {
  const r = root();
  if (!r) throw new Error("No project is open");
  const known = pyStore.get().interpreters.find((i) => i.path === python);
  const i = known ?? (await adopt(r.host, python));
  await setInterpreter(i);
  return i;
}

export interface VenvOpts { dir: string; base?: string; systemSite?: boolean }
/** New virtualenv (uv when available, else venv), then select it. */
export async function createVenvAndUse(o: VenvOpts): Promise<Interp> {
  const r = root();
  if (!r) throw new Error("No project is open");
  const uv = pyStore.get().tools.uv;
  const python = await pyApi.createVenv({ host: r.host, dir: o.dir, base: o.base, tool: uv ? "uv" : "venv", uv, systemSite: o.systemSite });
  const i = await adopt(r.host, python, "venv");
  await setInterpreter(i);
  return i;
}

export async function createCondaAndUse(o: { dir: string; pythonVersion?: string }): Promise<Interp> {
  const r = root();
  const conda = pyStore.get().tools.conda;
  if (!r || !conda) throw new Error("conda was not found");
  const python = await pyApi.createConda({ host: r.host, conda, dir: o.dir, pythonVersion: o.pythonVersion });
  const i = await adopt(r.host, python, "conda");
  await setInterpreter(i);
  return i;
}

export const refreshInterpreters = () => ensurePython(true);

// ---- terminal activation setting (localStorage ace.python.terminalActivate, default on) ----
const KEY = "ace.python.terminalActivate";
const read = () => { try { return localStorage.getItem(KEY) !== "0"; } catch { return true; } };
export const terminalActivateSetting = createStore<{ on: boolean }>({ on: read() });
export const setTerminalActivate = (on: boolean) => {
  terminalActivateSetting.set({ on });
  try { localStorage.setItem(KEY, on ? "1" : "0"); } catch { /* ignore */ }
};
