// The three Godot run configuration types: "Godot: Run Project", "Godot: Run Scene", "Godot: Run Script" (docs/GODOT.md).
import { registerConfigType } from "../run/configs";
import type { ConfigType, FieldDef, OutputFilter, RunConfig } from "../run/types";
import type { GodotDebugTarget } from "../run/hooks";
import { addRunProblem, beginRunProblems } from "../run/problems";
import { envRecord, resolvePath, shellJoin } from "../run/util";
import { projectStore } from "../../lib/project";
import { basename } from "../../lib/ipc";
import { godotArgv, instanceCount, instanceLabel, str, type Kind } from "./cmdline";
import { GodotIcon } from "./icons";
import { GameLink } from "./link";
import { godotBinary, godotStore } from "./model";
import { GodotOutputFilter, toRunProblem } from "./output";

const LABEL: Record<Kind, string> = { project: "Godot: Run Project", scene: "Godot: Run Scene", script: "Godot: Run Script" };

function fieldsFor(kind: Kind): FieldDef[] {
  return [
    ...(kind === "scene" ? [{ kind: "text", key: "scene", label: "Scene", placeholder: "res://scenes/main.tscn", hint: "res:// path or a file inside the project" } as FieldDef] : []),
    ...(kind === "script" ? [{ kind: "text", key: "script", label: "Script", placeholder: "res://tools/sim/sim_match.gd", hint: "a script that extends SceneTree or MainLoop (--script)" } as FieldDef] : []),
    { kind: "text", key: "scriptArgs", label: kind === "script" ? "Script arguments" : "Program arguments", placeholder: "5 8", hint: "passed after `--` (user args: OS.get_cmdline_user_args())" },
    { kind: "checkbox", key: "headless", label: "Headless (--headless)" },
    { kind: "text", key: "timeLimit", label: "Time limit (seconds)", placeholder: "0 = unlimited", hint: "like tools/run_godot.sh: only this process is stopped when it expires" },
    { kind: "text", key: "instances", label: "Instances", placeholder: "1", hint: "Run Multiple Instances: each gets its own Run tab; Stop / Rerun act on all of them" },
    { kind: "textarea", key: "instanceArgs", label: "Per-instance arguments", rows: 3, placeholder: "host\nclient", hint: "one line per instance, appended after the program arguments (net_test: host / client)" },
    { kind: "text", key: "args", label: "Godot arguments", placeholder: "--fixed-fps 30 --quit-after 600" },
    { kind: "checkbox", key: "verbose", label: "Verbose output (--verbose)" },
    { kind: "text", key: "resolution", label: "Window size", placeholder: "1280x720" },
    { kind: "text", key: "position", label: "Window position", placeholder: "100,100" },
    ...(kind !== "script" ? [{ kind: "checkbox", key: "liveReload", label: "Connect the debugger (enables Reload Scripts in Running Game)" } as FieldDef] : []),
    { kind: "env", key: "env", label: "Environment variables" },
    { kind: "path", key: "projectDir", label: "Project directory", dir: true, placeholder: "(project root)" },
    { kind: "path", key: "godotPath", label: "Godot executable", placeholder: "(auto: PATH, /opt/homebrew/bin/godot, Godot.app)" },
  ];
}

const baseName = (c: RunConfig, kind: Kind) => {
  if (kind === "project") return godotStore.get().name || "Run Project";
  const f = kind === "scene" ? str(c.scene) : str(c.script);
  return f ? basename(f).replace(/\.(tscn|gd)$/, "") : LABEL[kind];
};

/** Closes the live-reload link when the run ends; colours + extracts problems. */
class RunFilter implements OutputFilter {
  private inner: GodotOutputFilter;
  constructor(sessionId: string, private projectDir: string, host: string, private link: GameLink | null) {
    this.inner = new GodotOutputFilter((p) => addRunProblem(sessionId, toRunProblem(p, this.projectDir, host)));
  }
  push(kind: "out" | "err", text: string, emit: (k: "out" | "err", t: string) => void) { this.inner.push(kind, text, emit); }
  end(emit: (k: "out" | "err", t: string) => void) { this.inner.end(emit); this.link?.close(); }
}

function makeType(kind: Kind, order: number): ConfigType {
  return {
    id: `godot-${kind}`, label: LABEL[kind], icon: <GodotIcon />, order, debuggable: true,
    available: () => godotStore.get().detected,
    fields: fieldsFor(kind),
    defaults: () => ({
      scene: "", script: "", scriptArgs: "", headless: kind === "script", verbose: false, timeLimit: "", instances: "1", instanceArgs: "", args: "", resolution: "", position: "",
      liveReload: kind !== "script", env: [], projectDir: "", godotPath: "",
    }),
    suggestName: (c) => baseName(c, kind),
    validate: (c) => {
      const root = projectStore.get().root;
      if (root && root.host !== "local") return "Godot runs are available for local projects only.";
      if (kind === "scene" && !str(c.scene)) return "Scene is not specified";
      if (kind === "script" && !str(c.script)) return "Script is not specified";
      if (str(c.timeLimit) && !(Number(str(c.timeLimit)) >= 0)) return "Time limit must be a number of seconds";
      return null;
    },
    expand(cfg) {
      if (typeof cfg.instanceIndex === "number") return null; // already one instance of a group
      const n = instanceCount(cfg);
      if (n < 2) return null;
      return Array.from({ length: n }, (_, k) => ({
        ...cfg, id: `${cfg.id}#${k}`, name: `${cfg.name} (${instanceLabel(cfg, k)})`, temporary: cfg.temporary,
        groupId: cfg.id, groupOf: { ...cfg }, instanceIndex: k, instances: "1",
      }));
    },
    async resolve(cfg, mode, ctx) {
      const root = ctx.root;
      if (root.host !== "local") throw new Error("Godot runs are available for local projects only.");
      const bin = await godotBinary(str(cfg.godotPath));
      const projectDir = str(cfg.projectDir) ? resolvePath(root.path, str(cfg.projectDir)) : godotStore.get().projectDir || root.path;
      const inst = typeof cfg.instanceIndex === "number" ? cfg.instanceIndex : 0;
      const args = godotArgv(kind, cfg, projectDir, inst);
      const env = envRecord(cfg.env);
      const timeLimitSec = Math.max(0, Number(str(cfg.timeLimit)) || 0);
      const title = str(cfg.name) || baseName(cfg, kind);
      if (mode === "debug") {
        const debug: GodotDebugTarget = { kind: "godot", host: "local", cwd: projectDir, projectDir, argv: [bin.path, ...args], env, pathPrepend: [], title };
        return { spec: { host: "local", cwd: projectDir, argv: debug.argv, env }, title, commandLine: `$ ${shellJoin([basename(bin.path), ...args])}`, debug };
      }
      // Run with the debugger attached but no breakpoints: costs nothing, enables "Reload Scripts in Running Game".
      // `breakpoint` statements are continued automatically; error breaks are off (a plain run never stops on its own).
      let link: GameLink | null = null;
      let full = args;
      if (cfg.liveReload === true && kind !== "script") {
        link = new GameLink();
        link.onMessage = (m) => { if (m.cmd === "debug_enter") void link!.send("continue", [], m.thread); };
        const port = await link.open();
        full = ["--remote-debug", `tcp://127.0.0.1:${port}`, "--ignore-error-breaks", ...args];
      }
      const l = link;
      return {
        spec: { host: "local", cwd: projectDir, argv: [bin.path, ...full], env },
        title,
        commandLine: `$ ${shellJoin([basename(bin.path), ...args])}${timeLimitSec ? `   # time limit ${timeLimitSec} s` : ""}`,
        timeLimitSec: timeLimitSec || undefined,
        output: (session) => {
          beginRunProblems(session.id, session.name);
          return new RunFilter(session.id, projectDir, "local", l);
        },
      };
    },
  };
}

export const godotTypes = (["project", "scene", "script"] as Kind[]).map((k, i) => makeType(k, 40 + i));
for (const t of godotTypes) registerConfigType(t);
