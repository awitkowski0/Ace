// The "gradle" run configuration type: tasks + args + env + working dir, executed through the generic run infra (Run window).
import { registerConfigType } from "../run/configs";
import type { ConfigType, Mode, RunConfig } from "../run/types";
import type { JavaDebugTarget } from "../run/hooks";
import { envRecord, resolvePath, shellJoin, shellSplit } from "../run/util";
import { projectStore } from "../../lib/project";
import { fs } from "../../lib/ipc";
import { isWindows } from "../../lib/platform";
import { gradleApi } from "./api";
import { gradleStore } from "./model";
import { GradleIcon } from "./icons";
import { javaApi } from "./java/api";
import { enhancedHint } from "./java/jbr";
import { debugArgs } from "./java/pure";

/**
 * Extra (non-field) properties a caller may put on the config (kept through the Edit dialog):
 *   initScripts: string[]  additional `--init-script` files
 *   enhancedHotswap: boolean  Debug runs: JetBrains Runtime + -XX:+AllowEnhancedClassRedefinition (checkbox below)
 * Debug mode (⌃D): an init script injects a JDWP agent into every JavaExec (and, through nested `./gradlew` Exec tasks, into their
 * builds); the Run window shows the Gradle output, the Debug window attaches to the JVM for hot swap (src/components/gradle/java).
 */
export const gradleType: ConfigType = {
  id: "gradle", label: "Gradle", icon: <GradleIcon />, order: 30, debuggable: true,
  available: () => gradleStore.get().detected,
  fields: [
    { kind: "text", key: "tasks", label: "Tasks", placeholder: ":app:run", hint: "Task paths, space separated" },
    { kind: "text", key: "args", label: "Arguments", placeholder: "--info --stacktrace" },
    { kind: "path", key: "workingDir", label: "Working directory", dir: true, placeholder: "(project root)" },
    { kind: "env", key: "env", label: "Environment variables" },
    { kind: "checkbox", key: "enhancedHotswap", label: "Use JetBrains Runtime with enhanced class redefinition (Enhanced HotSwap)", hint: enhancedHint },
  ],
  defaults: () => ({ tasks: "", args: "", workingDir: "", env: [], enhancedHotswap: false }),
  suggestName: (c) => {
    const m = gradleStore.get().model;
    const t = `${String(c.tasks ?? "").trim()}${String(c.args ?? "").trim() ? " " + String(c.args).trim() : ""}`;
    return t ? `${m?.name ?? "gradle"} [${t}]` : "Gradle";
  },
  validate: (c) => (String(c.tasks ?? "").trim() || String(c.args ?? "").trim() ? null : "Tasks are not specified"),
  async resolve(cfg: RunConfig, mode: Mode) {
    const root = projectStore.get().root ?? { host: "local", path: "/" };
    const wd = String(cfg.workingDir ?? "").trim();
    const cwd = wd ? resolvePath(root.path, wd) : root.path;
    const inits = Array.isArray(cfg.initScripts) ? (cfg.initScripts as string[]) : [];
    const words = [...shellSplit(String(cfg.tasks ?? "")), ...shellSplit(String(cfg.args ?? ""))];
    let javaDebug: JavaDebugTarget | undefined;
    let dbgArgs: string[] = [];
    if (mode === "debug") {
      if (root.host !== "local") throw new Error("Debugging Gradle tasks is available for local projects only.");
      const port = await javaApi.freePort();
      const enhanced = cfg.enhancedHotswap === true;
      const prep = await javaApi.prepare(port, enhanced);
      dbgArgs = debugArgs(prep.initScript, prep.jbrPaths);
      javaDebug = { kind: "java", host: root.host, cwd, port, title: String(cfg.name || cfg.tasks || "gradle"), initScript: prep.initScript, enhanced: enhanced && prep.jbrMajors.length > 0, note: prep.note };
    }
    const argv = ["--console=plain", ...dbgArgs, ...inits.flatMap((f) => ["--init-script", f]), ...words];
    // wrapper if present, else gradle from the login PATH; always the normal shared daemon (no --no-daemon, no --stop).
    // Local Windows has no POSIX shell: exec gradlew.bat (else `gradle`, resolved to gradle.bat by the runner) directly.
    let launch: { argv: string[] } | { shell: string };
    if (isWindows && root.host === "local") {
      const wrapper = `${cwd.replace(/[\\/]+$/, "")}/gradlew.bat`;
      const st = await fs.stat({ host: "local", path: wrapper }).catch(() => null);
      launch = { argv: [st?.isFile ? wrapper : "gradle", ...argv] };
    } else {
      const a = shellJoin(argv);
      launch = { shell: `if [ -x ./gradlew ]; then exec ./gradlew ${a}; else exec gradle ${a}; fi` };
    }
    return {
      spec: { host: root.host, cwd, ...launch, env: envRecord(cfg.env) },
      title: String(cfg.tasks ?? "gradle"),
      commandLine: `$ ./gradlew ${shellJoin(words)}${javaDebug ? `   (debug: JDWP agent on 127.0.0.1:${javaDebug.port}${javaDebug.enhanced ? ", enhanced HotSwap" : ""})` : ""}`,
      javaDebug,
      softStop: (id: string) => void gradleApi.softStop(id),
    };
  },
};
registerConfigType(gradleType);
