import { basename } from "../../../lib/ipc";
import { PythonIcon } from "../../run/icons";
import { shellJoin, shellSplit } from "../../run/util";
import type { ConfigType, FieldDef, RunConfig } from "../../run/types";
import { pythonSpec } from "../interpreter";
import { isPythonActive } from "../interpreter";
import { abs, cwdOf, dirname, pickInterpreter, pythonEnv, rootLoc } from "./common";

const common = (cwdHint: string): FieldDef[] => [
  { kind: "text", key: "params", label: "Parameters", placeholder: "arguments passed to the program" },
  { kind: "path", key: "workingDir", label: "Working directory", dir: true, placeholder: cwdHint },
  { kind: "env", key: "env", label: "Environment variables" },
  { kind: "interpreter", key: "interpreter", label: "Python interpreter" },
  { kind: "checkbox", key: "addRoots", label: "Add content roots to PYTHONPATH" },
];
const defaults = () => ({ params: "", workingDir: "", env: [] as [string, string][], interpreter: "", addRoots: true });

function build(cfg: RunConfig, mode: "run" | "debug", prog: { script?: string; module?: string }, cwd: string) {
  const interp = pickInterpreter(cfg);
  const args = shellSplit(String(cfg.params ?? ""));
  const env = pythonEnv(cfg);
  const lead = prog.module ? ["-m", prog.module] : [prog.script!];
  const spec = pythonSpec([...lead, ...args], { cwd, env, interp, loc: rootLoc() });
  const title = prog.module ?? basename(prog.script!).replace(/\.py$/, "");
  void mode;
  return {
    spec,
    title,
    commandLine: shellJoin(spec.argv!),
    debug: {
      kind: "python" as const, host: spec.host, cwd, python: spec.argv![0], program: prog.script, module: prog.module, args, env: spec.env ?? {}, pathPrepend: spec.pathPrepend ?? [], title,
    },
  };
}

export const pythonType: ConfigType = {
  id: "python", label: "Python", icon: <PythonIcon />, order: 10, debuggable: true,
  available: isPythonActive,
  fields: [{ kind: "path", key: "script", label: "Script path", placeholder: "path/to/script.py" }, ...common("(script directory)")],
  defaults: () => ({ script: "", ...defaults() }),
  suggestName: (c) => basename(String(c.script || "")).replace(/\.py$/, "") || "Python",
  validate: (c) => (String(c.script ?? "").trim() ? null : "Script path is not specified"),
  resolve(cfg, mode) {
    const script = abs(String(cfg.script));
    return build(cfg, mode, { script }, cwdOf(cfg, dirname(script)));
  },
};

export const moduleType: ConfigType = {
  id: "python-module", label: "Python Module", icon: <PythonIcon />, order: 11, debuggable: true,
  available: isPythonActive,
  fields: [{ kind: "text", key: "module", label: "Module name", placeholder: "package.module" }, ...common("(project root)")],
  defaults: () => ({ module: "", ...defaults() }),
  suggestName: (c) => String(c.module || "") || "Python module",
  validate: (c) => (String(c.module ?? "").trim() ? null : "Module name is not specified"),
  resolve(cfg, mode) {
    return build(cfg, mode, { module: String(cfg.module).trim() }, cwdOf(cfg, rootLoc().path));
  },
};
