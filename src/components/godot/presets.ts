/** Pure helpers: README "Dev tools" parsing -> presets, pins, and the shape shared by the tool window and the run configs. */
import { shellJoin, shellSplit } from "../run/util";

/** A ready-made way to run something in a Godot project (preset, discovered script, scene, the project itself). */
export interface GodotSpec {
  type: "project" | "scene" | "script";
  /** display name (a preset's comment, a script's file name...) */
  name?: string;
  scene?: string;
  script?: string;
  headless?: boolean;
  /** seconds, 0 / undefined = unlimited */
  timeLimit?: number;
  /** extra Godot engine arguments (before the scene / --script) */
  args?: string;
  /** user arguments after `--` (common to all instances) */
  scriptArgs?: string;
  /** one line per instance: user arguments appended after scriptArgs (N lines = N instances) */
  instanceArgs?: string[];
  resolution?: string;
  verbose?: boolean;
}

export interface Preset extends GodotSpec {
  /** original README line (without the comment) */
  line: string;
  comment: string;
}

/** Engine flags that take a value (kept together with it as one extra argument). */
const VALUE_FLAGS = new Set([
  "--resolution", "--position", "--fixed-fps", "--quit-after", "--max-fps", "--audio-driver", "--rendering-driver", "--rendering-method",
  "--display-driver", "--write-movie", "--time-scale", "--log-file", "--gpu-index", "--lang", "--main-pack", "--scene",
]);

/** Cut a trailing `# comment` (a `#` preceded by whitespace and outside quotes). */
export function splitComment(line: string): { code: string; comment: string } {
  let q: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) { if (c === q) q = null; else if (c === "\\" && q === '"') i++; }
    else if (c === '"' || c === "'") q = c;
    else if (c === "#" && (i === 0 || /\s/.test(line[i - 1]))) return { code: line.slice(0, i).trim(), comment: line.slice(i + 1).trim() };
  }
  return { code: line.trim(), comment: "" };
}

const capitalize = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);
const ALT = /^[\w.=:/-]+(\|[\w.=:/-]+)+$/;

/** Parse one command line into a spec. Returns null when it is not a Godot invocation. */
export function parseGodotLine(raw: string): Preset | null {
  const { code, comment } = splitComment(raw.trim());
  if (!code) return null;
  const t = shellSplit(code);
  if (!t.length) return null;
  const head = t[0].replace(/^\.\//, "");
  let seconds = 0;
  let rest: string[];
  if (/(^|\/)run_godot\.sh$/.test(head)) {
    const n = Number(t[1]);
    if (!Number.isFinite(n)) return null;
    seconds = n;
    rest = t.slice(2);
  } else if (/(^|\/)godot(4)?$/i.test(head) || /Godot$/.test(head)) {
    rest = t.slice(1);
  } else return null;
  const out: Preset = { type: "project", line: shellJoin(t), comment, timeLimit: seconds || undefined };
  const extra: string[] = [];
  let user: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === "--") { user = rest.slice(i + 1); break; }
    if (a === "--path") { i++; continue; } // the project is the IDE's
    if (a === "--headless") out.headless = true;
    else if (a === "--verbose" || a === "-v") out.verbose = true;
    else if (a === "--script" || a === "-s") { out.script = rest[++i]; out.type = "script"; }
    else if (a === "--resolution") out.resolution = rest[++i];
    else if (/\.tscn$/.test(a) && !a.startsWith("-")) { out.scene = a; if (out.type === "project") out.type = "scene"; }
    else if (a.startsWith("-")) {
      extra.push(a);
      if (VALUE_FLAGS.has(a) && i + 1 < rest.length) extra.push(rest[++i]);
    } else extra.push(a);
  }
  if (extra.length) out.args = shellJoin(extra);
  // `net_test.gd -- host|client`: one alternative token = one instance each
  const alt = user.findIndex((u) => ALT.test(u));
  if (alt >= 0) {
    out.instanceArgs = user[alt].split("|").map((v) => shellJoin([...user.slice(0, alt), v, ...user.slice(alt + 1)]));
  } else if (user.length) out.scriptArgs = shellJoin(user);
  const base = (out.script ?? out.scene ?? "").split("/").pop()?.replace(/\.(gd|tscn)$/, "") ?? "";
  out.name = comment ? capitalize(comment) : base || "Godot";
  return out;
}

/** Presets from the README's "Dev tools" code block(s); falls back to every fenced block when there is no such heading. */
export function parseDevTools(readme: string): Preset[] {
  const lines = readme.split("\n");
  const blocks: { heading: string; lines: string[] }[] = [];
  let heading = "";
  let cur: { heading: string; lines: string[] } | null = null;
  for (const l of lines) {
    if (/^\s*```/.test(l)) {
      if (cur) { blocks.push(cur); cur = null; } else cur = { heading, lines: [] };
    } else if (cur) cur.lines.push(l);
    else if (/^#{1,6}\s/.test(l)) heading = l.replace(/^#+\s*/, "").trim();
  }
  const dev = blocks.filter((b) => /dev(eloper)?\s*tools?/i.test(b.heading));
  const pick = dev.length ? dev : blocks;
  const out: Preset[] = [];
  const names = new Map<string, number>();
  for (const b of pick) {
    for (const l of b.lines) {
      const p = parseGodotLine(l);
      if (!p) continue;
      const n = names.get(p.name!) ?? 0;
      names.set(p.name!, n + 1);
      if (n) p.name = `${p.name} (${n + 1})`;
      out.push(p);
    }
  }
  return out;
}

// ---------------------------------------------------------------- pins (.ace/config.json -> godot.pinned)

export interface GodotPin extends GodotSpec { name?: string }

/** Identity of a pin / spec: everything that changes what runs (not the name). */
export function specKey(s: GodotSpec): string {
  const norm = {
    t: s.type, scene: s.scene || undefined, script: s.script || undefined, h: s.headless || undefined, tl: s.timeLimit || undefined,
    a: s.args?.trim() || undefined, sa: s.scriptArgs?.trim() || undefined, ia: s.instanceArgs?.length ? s.instanceArgs : undefined,
    r: s.resolution || undefined, v: s.verbose || undefined,
  };
  return JSON.stringify(norm);
}

export function pinsOf(section: unknown): GodotPin[] {
  const arr = section && typeof section === "object" ? (section as { pinned?: unknown }).pinned : undefined;
  if (!Array.isArray(arr)) return [];
  const out: GodotPin[] = [];
  for (const p of arr) {
    if (!p || typeof p !== "object") continue;
    const o = p as Record<string, unknown>;
    if (o.type !== "project" && o.type !== "scene" && o.type !== "script") continue;
    const pin: GodotPin = { type: o.type };
    for (const k of ["name", "scene", "script", "args", "scriptArgs", "resolution"] as const) if (typeof o[k] === "string" && o[k]) pin[k] = o[k] as string;
    if (typeof o.headless === "boolean" && o.headless) pin.headless = true;
    if (typeof o.verbose === "boolean" && o.verbose) pin.verbose = true;
    if (typeof o.timeLimit === "number" && o.timeLimit > 0) pin.timeLimit = o.timeLimit;
    if (Array.isArray(o.instanceArgs) && o.instanceArgs.every((x) => typeof x === "string")) pin.instanceArgs = o.instanceArgs as string[];
    out.push(pinRecord(pin)); // canonical key order, so a rewrite of an untouched pin never reorders its keys
  }
  return out;
}

/** What gets written for a pin: only the meaningful keys, in a stable order. */
export function pinRecord(s: GodotSpec): GodotPin {
  const p: GodotPin = { type: s.type };
  if (s.name) p.name = s.name;
  if (s.scene) p.scene = s.scene;
  if (s.script) p.script = s.script;
  if (s.headless) p.headless = true;
  if (s.verbose) p.verbose = true;
  if (s.timeLimit) p.timeLimit = s.timeLimit;
  if (s.args?.trim()) p.args = s.args.trim();
  if (s.scriptArgs?.trim()) p.scriptArgs = s.scriptArgs.trim();
  if (s.instanceArgs?.length) p.instanceArgs = s.instanceArgs;
  if (s.resolution) p.resolution = s.resolution;
  return p;
}

export function specLabel(s: GodotSpec): string {
  if (s.name) return s.name;
  if (s.type === "project") return "Run Project";
  const f = (s.type === "scene" ? s.scene : s.script) ?? "";
  return f.split("/").pop() ?? f;
}

/** Heuristic default for scripts discovered in the project: simulations / checks under tools/sim run headless. */
export const defaultHeadless = (script: string) => /\/tools\/sim\//.test(script) || /\/(check|test)[\w]*\.gd$/.test(script) || /_(check|test)\.gd$/.test(script);
