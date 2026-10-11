/** Pure: Godot command line from a run configuration (and the instance logic of "Run Multiple Instances"). */
import { shellSplit } from "../run/util";
import type { GodotSpec } from "./presets";

export type Kind = "project" | "scene" | "script";
export const str = (v: unknown) => (typeof v === "string" ? v.trim() : typeof v === "number" ? String(v) : "");

/** Non-empty lines of the per-instance arguments field. */
export const instanceLines = (cfg: Record<string, unknown>): string[] =>
  String(cfg.instanceArgs ?? "").split("\n").map((l) => l.trim()).filter(Boolean);

/** How many processes one run starts: the larger of the count field and the number of per-instance lines. */
export function instanceCount(cfg: Record<string, unknown>): number {
  const n = Math.floor(Number(str(cfg.instances)) || 1);
  return Math.max(1, Math.min(16, Math.max(n, instanceLines(cfg).length)));
}

/** Tab suffix for instance k: the first word of its arguments ("host", "client") or #k. */
export function instanceLabel(cfg: Record<string, unknown>, k: number): string {
  const w = (instanceLines(cfg)[k] ?? "").split(/\s+/)[0];
  return w && /^[A-Za-z0-9_][\w.-]{0,15}$/.test(w) ? w : `#${k + 1}`;
}

/** Arguments after the executable. `inst` selects the per-instance line. */
export function godotArgv(kind: Kind, cfg: Record<string, unknown>, projectDir: string, inst = 0): string[] {
  const a = ["--path", projectDir];
  if (cfg.headless === true) a.push("--headless");
  if (cfg.verbose === true) a.push("--verbose");
  if (str(cfg.resolution)) a.push("--resolution", str(cfg.resolution));
  if (str(cfg.position)) a.push("--position", str(cfg.position));
  a.push(...shellSplit(String(cfg.args ?? "")));
  if (kind === "scene" && str(cfg.scene)) a.push(str(cfg.scene));
  if (kind === "script" && str(cfg.script)) a.push("--script", str(cfg.script));
  const user = [...shellSplit(String(cfg.scriptArgs ?? "")), ...shellSplit(instanceLines(cfg)[inst] ?? "")];
  if (user.length) a.push("--", ...user);
  return a;
}

/** A GodotSpec (preset / pin / discovered script / scene) as run configuration fields. */
export function specFields(s: GodotSpec): Record<string, unknown> {
  const lines = s.instanceArgs ?? [];
  return {
    type: `godot-${s.type}`,
    name: s.name,
    scene: s.scene ?? "",
    script: s.script ?? "",
    headless: !!s.headless,
    verbose: !!s.verbose,
    timeLimit: s.timeLimit ? String(s.timeLimit) : "",
    args: s.args ?? "",
    scriptArgs: s.scriptArgs ?? "",
    instanceArgs: lines.join("\n"),
    instances: String(Math.max(1, lines.length)),
    resolution: s.resolution ?? "",
    position: "",
    liveReload: s.type !== "script",
    env: [],
    projectDir: "",
    godotPath: "",
  };
}
