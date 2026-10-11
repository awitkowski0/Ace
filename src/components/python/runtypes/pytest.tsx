/** pytest and unittest run types. The bundled reporters (src-tauri/src/python/scripts/ace_pytest.py, ace_unittest.py) are never installed:
 *  local runs put their directory on PYTHONPATH; remote runs send the source through `python -c`. */
import { basename } from "../../../lib/ipc";
import { TestsIcon } from "../../run/icons";
import { relPath, shellJoin, shellSplit } from "../../run/util";
import type { ConfigType, ResolvedRun, RunConfig } from "../../run/types";
import { ensurePython, isPythonActive, pyStore, pythonSpec, toolPath } from "../interpreter";
import { pyApi, runner } from "../api";
import { cwdOf, pickInterpreter, pythonEnv, rootLoc } from "./common";

/** QA: force the `python -c` transport (what remote projects use) for local runs. */
export const pluginTransport = { inline: false };

const WRAP = (src: string) =>
  `import sys, types\nSRC = ${JSON.stringify(src)}\nm = types.ModuleType("ace_pytest")\nm.__file__ = "ace_pytest.py"\nexec(compile(SRC, "ace_pytest.py", "exec"), m.__dict__)\nsys.modules["ace_pytest"] = m\nimport pytest\nsys.exit(pytest.main(sys.argv[1:]))\n`;

async function missing(cfg: RunConfig, pkg: string): Promise<ResolvedRun["missingPackage"] | undefined> {
  const interp = pickInterpreter(cfg);
  if (!interp) return undefined;
  const st = pyStore.get();
  let has: boolean | undefined;
  if (st.current?.path === interp.path) has = st.probe?.modules?.[pkg];
  else has = (await pyApi.probe(interp.host, interp.path).catch(() => null))?.modules?.[pkg];
  if (has !== false) return undefined;
  return {
    name: pkg,
    message: `${pkg} is not installed in the interpreter '${interp.name}'.`,
    detail: `Install ${pkg} into ${interp.path}?\n\n${toolPath("uv") ? "uv pip install" : "python -m pip install"} ${pkg}`,
    async install(log) {
      const uv = toolPath("uv");
      const spec = uv && st.current?.path === interp.path
        ? { host: interp.host, cwd: rootLoc().path, argv: [uv, "pip", "install", "--python", interp.path, pkg] }
        : pythonSpec(["-m", "pip", "install", pkg], { interp, loc: rootLoc() });
      log(`$ ${shellJoin(spec.argv!)}\n`);
      const r = await runner.exec(spec, undefined, 240000);
      log((r.stdout + r.stderr).trim() + "\n");
      if (r.code !== 0) return false;
      await ensurePython(true);
      return true;
    },
  };
}

const COMMON_FIELDS: ConfigType["fields"] = [
  { kind: "path", key: "workingDir", label: "Working directory", dir: true, placeholder: "(project root)" },
  { kind: "env", key: "env", label: "Environment variables" },
  { kind: "interpreter", key: "interpreter", label: "Python interpreter" },
  { kind: "checkbox", key: "addRoots", label: "Add content roots to PYTHONPATH" },
];

export const pytestType: ConfigType = {
  id: "pytest", label: "pytest", icon: <TestsIcon />, order: 20, debuggable: true,
  available: isPythonActive,
  fields: [
    { kind: "select", key: "targetKind", label: "Target", options: [{ value: "path", label: "Script path / node id" }, { value: "custom", label: "Custom arguments" }] },
    { kind: "path", key: "target", label: "Path", placeholder: "tests, tests/test_a.py or tests/test_a.py::Class::test", visible: (c) => c.targetKind !== "custom" },
    { kind: "text", key: "target", label: "Arguments", placeholder: "-k expr tests/", visible: (c) => c.targetKind === "custom" },
    { kind: "text", key: "args", label: "Additional arguments", placeholder: "-x --maxfail=2" },
    ...COMMON_FIELDS,
  ],
  defaults: () => ({ targetKind: "path", target: "", args: "", workingDir: "", env: [], interpreter: "", addRoots: true }),
  suggestName: (c) => {
    const t = String(c.target ?? "").trim();
    if (!t) return "pytest";
    if (c.targetKind === "custom") return `pytest ${t}`.slice(0, 40);
    const parts = t.split("::");
    const file = basename(parts[0]).replace(/\.py$/, "");
    return parts.length > 1 ? `pytest for ${[file, ...parts.slice(1)].join(".")}` : `pytest in ${basename(parts[0]) || parts[0]}`;
  },
  forTestNodes: (cfg, ids) => ({ ...cfg, id: cfg.id, targetKind: "custom", target: shellJoin(ids), name: ids.length === 1 ? `pytest for ${ids[0]}` : `pytest (${ids.length} tests)`, temporary: true }),
  async resolve(cfg, mode) {
    const root = rootLoc();
    const cwd = cwdOf(cfg, root.path);
    const targets = cfg.targetKind === "custom" ? shellSplit(String(cfg.target ?? "")) : String(cfg.target ?? "").trim() ? [String(cfg.target).trim()] : [];
    const extra = shellSplit(String(cfg.args ?? ""));
    const interp = pickInterpreter(cfg);
    const miss = await missing(cfg, "pytest");
    if (mode === "debug") {
      const spec = pythonSpec(["-m", "pytest", ...targets, ...extra], { cwd, env: pythonEnv(cfg), interp, loc: root });
      return {
        spec, title: String(cfg.name), commandLine: shellJoin(spec.argv!),
        debug: { kind: "python", host: spec.host, cwd, python: spec.argv![0], module: "pytest", args: [...targets, ...extra], env: spec.env ?? {}, pathPrepend: spec.pathPrepend ?? [], extra: { justMyCode: false }, title: String(cfg.name) },
      };
    }
    const inline = pluginTransport.inline || root.host !== "local";
    let args: string[];
    let env: Record<string, string>;
    if (inline) {
      args = ["-c", WRAP(await pyApi.scriptSource("ace_pytest")), "-p", "ace_pytest", "--color=yes", ...targets, ...extra];
      env = pythonEnv(cfg);
    } else {
      args = ["-m", "pytest", "-p", "ace_pytest", "--color=yes", ...targets, ...extra];
      env = pythonEnv(cfg, [await pyApi.scriptsDir()]);
    }
    const spec = pythonSpec(args, { cwd, env, interp, loc: root });
    const shown = pythonSpec(["-m", "pytest", "--color=yes", ...targets, ...extra], { cwd, interp, loc: root });
    return { spec, title: String(cfg.name), commandLine: shellJoin(shown.argv!), tests: { kind: "pytest" }, missingPackage: miss };
  },
};

/** `tests/test_unit.py` -> `tests.test_unit`; `tests/test_unit.py::C::t` -> `tests.test_unit.C.t` */
export function dottedName(id: string): string {
  const [file, ...rest] = id.split("::");
  const mod = file.replace(/\.py$/, "").replace(/^\.\//, "").split("/").filter(Boolean).join(".");
  return [mod, ...rest].filter(Boolean).join(".");
}

export const unittestType: ConfigType = {
  id: "unittest", label: "Unittests", icon: <TestsIcon />, order: 21, debuggable: true,
  available: isPythonActive,
  fields: [
    { kind: "select", key: "targetKind", label: "Target", options: [{ value: "script", label: "Script path" }, { value: "names", label: "Dotted names" }, { value: "pattern", label: "Pattern" }] },
    { kind: "path", key: "target", label: "Script", placeholder: "tests/test_unit.py", visible: (c) => c.targetKind === "script" },
    { kind: "text", key: "target", label: "Names", placeholder: "tests.test_unit.AddTests.test_ok (space separated)", visible: (c) => c.targetKind === "names" },
    { kind: "path", key: "target", label: "Directory", dir: true, placeholder: "tests", visible: (c) => c.targetKind === "pattern" },
    { kind: "text", key: "pattern", label: "Pattern", placeholder: "test*.py", visible: (c) => c.targetKind === "pattern" },
    ...COMMON_FIELDS,
  ],
  defaults: () => ({ targetKind: "script", target: "", pattern: "test*.py", workingDir: "", env: [], interpreter: "", addRoots: true }),
  suggestName: (c) => {
    const t = String(c.target ?? "").trim();
    if (c.targetKind === "script") return t ? `Unittests in ${basename(t)}` : "Unittests";
    if (c.targetKind === "names") return t ? `Unittests for ${t.split(/\s+/)[0].split(".").slice(-2).join(".")}` : "Unittests";
    return `Unittests in ${t || "."}`;
  },
  forTestNodes: (cfg, ids) => ({ ...cfg, targetKind: "names", target: ids.map(dottedName).join(" "), name: ids.length === 1 ? `Unittests for ${dottedName(ids[0])}` : `Unittests (${ids.length} tests)`, temporary: true }),
  async resolve(cfg, mode) {
    const root = rootLoc();
    const cwd = cwdOf(cfg, root.path);
    const t = String(cfg.target ?? "").trim();
    let sel: string[];
    if (cfg.targetKind === "pattern") sel = ["-s", t || ".", "-p", String(cfg.pattern || "test*.py")];
    else if (cfg.targetKind === "names") sel = t.split(/\s+/).filter(Boolean);
    else sel = t ? [dottedName(relPath(cwd, t.startsWith("/") ? t : `${root.path}/${t}`))] : [];
    const interp = pickInterpreter(cfg);
    if (mode === "debug") {
      const dargs = cfg.targetKind === "pattern" ? ["discover", ...sel] : sel.length ? sel : ["discover"];
      const spec = pythonSpec(["-m", "unittest", ...dargs], { cwd, env: pythonEnv(cfg), interp, loc: root });
      return { spec, title: String(cfg.name), commandLine: shellJoin(spec.argv!), debug: { kind: "python", host: spec.host, cwd, python: spec.argv![0], module: "unittest", args: dargs, env: spec.env ?? {}, pathPrepend: spec.pathPrepend ?? [], extra: { justMyCode: false }, title: String(cfg.name) } };
    }
    const inline = pluginTransport.inline || root.host !== "local";
    let argv: string[];
    let env: Record<string, string>;
    if (inline) {
      argv = ["-c", await pyApi.scriptSource("ace_unittest"), ...sel];
      env = pythonEnv(cfg);
    } else {
      argv = [`${await pyApi.scriptsDir()}/ace_unittest.py`, ...sel];
      env = pythonEnv(cfg);
    }
    const spec = pythonSpec(argv, { cwd, env, interp, loc: root });
    const shown = pythonSpec(["-m", "unittest", ...(cfg.targetKind === "pattern" ? ["discover", ...sel] : sel)], { cwd, interp, loc: root });
    return { spec, title: String(cfg.name), commandLine: shellJoin(shown.argv!), tests: { kind: "unittest" } };
  },
};
