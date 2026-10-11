import { projectStore } from "../../../lib/project";
import { dirname } from "../../../lib/ipc";
import type { Location } from "../../../lib/ipc";
import { envRecord, resolvePath } from "../../run/util";
import type { RunConfig } from "../../run/types";
import { pyStore } from "../interpreter";
import type { Interp } from "../api";

export const rootLoc = (): Location => projectStore.get().root ?? { host: "local", path: "/" };

/** The interpreter a configuration selects: "" = project default, else a discovered one (or a bare path). */
export function pickInterpreter(cfg: RunConfig): Interp | null {
  const want = String(cfg.interpreter ?? "");
  const st = pyStore.get();
  if (!want) return st.current;
  return st.interpreters.find((i) => i.path === want) ?? { id: want, path: want, version: "", kind: "system", name: want, envRoot: null, project: false, host: rootLoc().host };
}

/** User env rows + PYTHONPATH (project root first when "Add content roots to PYTHONPATH" is on; `extra` dirs follow). */
export function pythonEnv(cfg: RunConfig, extra: string[] = []): Record<string, string> {
  const env = envRecord(cfg.env);
  const parts = [...(cfg.addRoots !== false ? [rootLoc().path] : []), ...extra];
  if (env.PYTHONPATH) parts.push(env.PYTHONPATH);
  if (parts.length) env.PYTHONPATH = parts.join(":");
  return env;
}

export const abs = (p: string) => resolvePath(rootLoc().path, p);
export const cwdOf = (cfg: RunConfig, fallback: string) => (String(cfg.workingDir ?? "").trim() ? abs(String(cfg.workingDir).trim()) : fallback);
export { dirname };
