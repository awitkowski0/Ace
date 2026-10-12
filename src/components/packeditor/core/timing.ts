/**
 * An ability's timing, the way Thematic reads it (docs/addon-format.md "Tuning: the ability_defaults CSV"):
 *   - cooldown, duration, range, damage, amplifier are one row of `data/<ns>/ability_defaults/*.csv`
 *     (`ability_id,cooldown,duration,range,damage,amplifier,disabled`), found by the id's NAME alone (`thematic:x`, `my_pack:x`
 *     and `x` are one row). Seconds, blocks and health points; a blank cell or -1 is "not set".
 *   - every other tuned number is a row `ability,key,value` (the shipped ones live in `ability_defaults/tuning/<suit>.csv`; the
 *     file name only organises them, the lookup is by ability name). An ability's own row beats one owned by `all`.
 *   - in a script `tuned("duration" | "damage" | "radius" | "amplifier")` reads the row's column (radius is the `range` column),
 *     `tuned(key, times?, otherwise?)` any other key, scaled by `times`; `otherwise` and the suit's option of that name are used
 *     only when no row has the key. `lasts("duration")` is the row's duration, `lasts(n)` is n seconds.
 * The pure half: finding the rows, reading the script's phases, laying them out as a timeline, and the single-cell edits.
 */
import { appendRow, csvNum, parseCsv, setCell, type Csv, type CsvRow } from "./csv";
import { callsOn, fnArg, strArg, scanCalls, type JsCall, type JsValue, type TextEdit } from "./jsdsl";

export const STAT_COLS = ["cooldown", "duration", "range", "damage", "amplifier", "disabled"] as const;
export type StatCol = (typeof STAT_COLS)[number];
/** What the columns mean, for tooltips (docs/addon-format.md). */
export const STAT_DOC: Record<StatCol, string> = {
  cooldown: "Seconds before it can be used again. Blank or -1: not set (the ability's own default applies).",
  duration: "Seconds: how long a phase with lasts(\"duration\") or a zone with no `for` lasts, and the default for effect durations. Scripts read it as tuned(\"duration\").",
  range: "Blocks. A script reads this column as tuned(\"radius\"): the default radius of targets(\"around\"), a cone's length, a beam's reach.",
  damage: "Health points (2 = one heart): the default for damage() with no number. Scripts read it as tuned(\"damage\").",
  amplifier: "The default effect level (0 = I). Scripts read it as tuned(\"amplifier\").",
  disabled: "TRUE turns the ability off for everyone.",
};
/** `tuned("x")` for these keys reads a column of the row; the column is named `range` but the key is `radius`. */
export const TUNED_COLUMN: Record<string, StatCol> = { duration: "duration", damage: "damage", radius: "range", amplifier: "amplifier" };

export const nameOfId = (id: string) => (id.includes(":") ? id.slice(id.indexOf(":") + 1) : id);

export interface CsvIn { path: string; text: string }

/** What kind of sheet a csv is, by its header. */
export function csvKind(c: Csv): "defaults" | "tuning" | null {
  if (c.header[0] === "ability_id") return "defaults";
  if (c.header[0] === "ability" && c.header[1] === "key") return "tuning";
  return null;
}

export interface StatRow { path: string; line: number; id: string; values: Partial<Record<StatCol, string>> }
export interface TuneRow { path: string; line: number; owner: string; key: string; value: string; num: number | null; /** owned by this ability (else by `all`) */ own: boolean }

const parseNum = (s: string | undefined): number | null => {
  if (s === undefined || s.trim() === "") return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};

/** The defaults rows for ability `name`, in file order (a pack that defines it twice shows both; the first wins here). */
export function findStatRows(files: CsvIn[], name: string): StatRow[] {
  const out: StatRow[] = [];
  for (const f of files) {
    const csv = parseCsv(f.text);
    if (csvKind(csv) !== "defaults") continue;
    for (const r of csv.rows) {
      const id = r.cells[0]?.text ?? "";
      if (nameOfId(id) !== name) continue;
      const values: Partial<Record<StatCol, string>> = {};
      for (const col of STAT_COLS) { const i = csv.header.indexOf(col); if (i >= 0 && r.cells[i]) values[col] = r.cells[i].text; }
      out.push({ path: f.path, line: r.line, id, values });
    }
  }
  return out;
}

/** The tuning rows that apply to ability `name`: its own (owner `name`, with or without a namespace) and the shared `all` ones. */
export function findTuneRows(files: CsvIn[], name: string): TuneRow[] {
  const out: TuneRow[] = [];
  for (const f of files) {
    const csv = parseCsv(f.text);
    if (csvKind(csv) !== "tuning") continue;
    const ki = csv.header.indexOf("key"), vi = csv.header.indexOf("value");
    for (const r of csv.rows) {
      const owner = r.cells[0]?.text ?? "";
      const own = nameOfId(owner) === name;
      if (!own && owner !== "all") continue;
      const value = r.cells[vi]?.text ?? "";
      out.push({ path: f.path, line: r.line, owner, key: r.cells[ki]?.text ?? "", value, num: parseNum(value), own });
    }
  }
  return out;
}

/** A stat as a number: blank, -1 and anything that is not a number are "not set". */
export function statNumber(row: StatRow | undefined, col: StatCol): number | null {
  const n = parseNum(row?.values[col]);
  return n === null || n === -1 ? null : n;
}

export interface TimingCtx {
  /** the row the ability resolves to (the first found), if any */
  stat?: StatRow;
  tune: TuneRow[];
  /** the preview suit's `options` for this ability: consulted for a key with no row */
  suitOptions?: Record<string, unknown>;
}

export type TunedFrom = "column" | "tuning" | "all" | "suit option" | "otherwise" | "unset" | "error";
export interface TunedValue { value: number | null; from: TunedFrom; row?: TuneRow; col?: StatCol }

/** What `tuned(key, times, otherwise)` is for this ability, with where it came from. */
export function tunedValue(ctx: TimingCtx, key: string, times = 1, otherwise?: number): TunedValue {
  if (key === "range") return { value: null, from: "error" }; // "tuned("range") is an error: the column is read as radius"
  const col = TUNED_COLUMN[key];
  if (col) {
    const n = statNumber(ctx.stat, col);
    return n === null ? { value: null, from: "unset", col } : { value: n * times, from: "column", col };
  }
  const own = ctx.tune.find((r) => r.own && r.key === key && r.num !== null);
  if (own) return { value: own.num! * times, from: "tuning", row: own };
  const all = ctx.tune.find((r) => !r.own && r.key === key && r.num !== null);
  if (all) return { value: all.num! * times, from: "all", row: all };
  const opt = ctx.suitOptions?.[key];
  const on = typeof opt === "number" ? opt : typeof opt === "string" && opt.trim() !== "" && Number.isFinite(Number(opt)) ? Number(opt) : null;
  if (on !== null) return { value: on * times, from: "suit option" };
  if (otherwise !== undefined) return { value: otherwise * times, from: "otherwise" };
  return { value: null, from: "unset" };
}

// ---------------------------------------------------------------- the script's phases

export interface LastsSpec {
  kind: "none" | "literal" | "duration" | "tuned" | "other";
  /** the argument's source, for `other` */
  raw?: string;
  /** `literal`: the number and its span in the script */
  value?: number;
  span?: { s: number; e: number };
  /** `tuned`: tuned(key, times, otherwise) */
  key?: string;
  times?: number;
  otherwise?: number;
}
export interface PhaseInfo {
  name: string;
  /** 1-based line of the `phase(...)` call */
  line: number;
  lasts: LastsSpec;
  /** where running out leads: `cooldown`, `ready` or a phase name; undefined when the phase never says */
  then?: string;
}

const numArg = (a: JsValue | undefined): number | undefined => (a?.t === "lit" && typeof a.value === "number" ? a.value : undefined);

function lastsOf(a: JsValue | undefined, calls: JsCall[], src: string): LastsSpec {
  if (!a) return { kind: "none" };
  if (a.t === "lit" && typeof a.value === "number") return { kind: "literal", value: a.value, span: { s: a.s, e: a.e } };
  if (a.t === "lit" && a.value === "duration") return { kind: "duration" };
  if (a.t === "obj") {
    // the file form of a worked-out number: { tuned: "charge", times?, else? }
    const e = (k: string) => a.entries.find((x) => x.key === k)?.value;
    const t = e("tuned");
    if (t?.t === "lit" && typeof t.value === "string") return { kind: "tuned", key: t.value, times: numArg(e("times")), otherwise: numArg(e("else")) };
  }
  const t = calls.find((c) => !c.recv && c.method === "tuned" && c.s === a.s && c.e === a.e);
  if (t && strArg(t, 0) !== undefined) return { kind: "tuned", key: strArg(t, 0), times: numArg(t.args[1]), otherwise: numArg(t.args[2]) };
  return { kind: "other", raw: src.slice(a.s, a.e) };
}

const TRIGGERS = ["press", "hold", "toggle"];

/** The script's phases (`component.phase("name", p => { p.lasts(X); p.then(Y) })`) and the one the key press leads to. */
export function readPhases(src: string): { phases: PhaseInfo[]; entry?: string } {
  const calls = scanCalls(src);
  const phases: PhaseInfo[] = [];
  for (const c of calls) {
    if (c.method !== "phase") continue;
    const name = strArg(c, 0);
    const fn = fnArg(c);
    if (name === undefined || !fn) continue;
    const inner = callsOn(calls, fn);
    const lastsCall = inner.find((x) => x.method === "lasts");
    const thenCall = inner.find((x) => x.method === "then");
    phases.push({ name, line: src.slice(0, c.s).split("\n").length, lasts: lastsOf(lastsCall?.args[0], calls, src), then: thenCall ? strArg(thenCall, 0) : undefined });
  }
  let entry: string | undefined;
  for (const t of TRIGGERS) {
    for (const c of calls) {
      if (c.method !== t) continue;
      const fn = fnArg(c);
      const to = callsOn(calls, fn).find((x) => x.method === "then" && strArg(x, 0) !== undefined);
      if (to) { entry = strArg(to, 0); break; }
    }
    if (entry) break;
  }
  return { phases, entry };
}

/** The edit that makes phase `name`'s literal `lasts(n)` n seconds, or null when it is not a literal. */
export function setLastsLiteral(src: string, name: string, seconds: number): TextEdit | null {
  const p = readPhases(src).phases.find((x) => x.name === name);
  if (!p || p.lasts.kind !== "literal" || !p.lasts.span) return null;
  return { s: p.lasts.span.s, e: p.lasts.span.e, text: csvNum(seconds) };
}

// ---------------------------------------------------------------- timeline

export type LastsFrom = "literal" | "duration column" | "tuning" | "shared tuning" | "suit option" | "otherwise" | "unset" | "expression" | "no lasts";
export type LastsEdit =
  | { kind: "literal" }
  | { kind: "stat"; col: StatCol }
  | { kind: "tuning"; key: string; row: TuneRow };
export interface ResolvedLasts { seconds: number | null; from: LastsFrom; edit: LastsEdit | null; /** `lasts(tuned("x", 2))`: the edit changes the base, the time is base x times */ times: number }

export function resolveLasts(spec: LastsSpec, ctx: TimingCtx): ResolvedLasts {
  switch (spec.kind) {
    case "none": return { seconds: null, from: "no lasts", edit: null, times: 1 };
    case "literal": return { seconds: spec.value!, from: "literal", edit: { kind: "literal" }, times: 1 };
    case "duration": {
      const n = statNumber(ctx.stat, "duration");
      return { seconds: n, from: n === null ? "unset" : "duration column", edit: ctx.stat ? { kind: "stat", col: "duration" } : null, times: 1 };
    }
    case "tuned": {
      const times = spec.times ?? 1;
      const t = tunedValue(ctx, spec.key!, times, spec.otherwise);
      const from: LastsFrom = t.from === "column" ? "duration column" : t.from === "tuning" ? "tuning" : t.from === "all" ? "shared tuning" : t.from === "suit option" ? "suit option" : t.from === "otherwise" ? "otherwise" : "unset";
      let edit: LastsEdit | null = null;
      if (t.col && ctx.stat) edit = { kind: "stat", col: t.col };
      else if (t.row) edit = { kind: "tuning", key: spec.key!, row: t.row };
      return { seconds: t.value, from, edit, times };
    }
    default: return { seconds: null, from: "expression", edit: null, times: 1 };
  }
}

export interface Step {
  kind: "press" | "phase" | "cooldown" | "ready";
  name: string;
  /** null when it is not a fixed time (until a reaction, a computed length, a value with no row) */
  seconds: number | null;
  /** seconds from the press; null once an earlier step has no fixed length */
  start: number | null;
  phase?: PhaseInfo;
  lasts?: ResolvedLasts;
}
export interface Timeline { steps: Step[]; /** press to ready again, when every step has a length */ total: number | null; orphans: PhaseInfo[]; notes: string[] }

/** press -> the phases in the order `then()` leads through them -> the cooldown. */
export function buildTimeline(src: string, ctx: TimingCtx): Timeline {
  const { phases, entry } = readPhases(src);
  const steps: Step[] = [{ kind: "press", name: "press", seconds: 0, start: 0 }];
  const notes: string[] = [];
  const used = new Set<string>();
  let t: number | null = 0;
  const add = (s: Omit<Step, "start">) => {
    steps.push({ ...s, start: t });
    t = t === null || s.seconds === null ? null : t + s.seconds;
  };
  const cool = () => {
    const cd = statNumber(ctx.stat, "cooldown");
    add({ kind: "cooldown", name: "cooldown", seconds: cd });
  };
  let cur = entry && entry !== "cooldown" && entry !== "ready" ? entry : phases[0]?.name;
  if (entry === "ready") steps.push({ kind: "ready", name: "ready", seconds: 0, start: t });
  else if (entry === "cooldown" || (!cur && !phases.length)) cool();
  else {
    while (cur && !used.has(cur)) {
      const p = phases.find((x) => x.name === cur);
      if (!p) { notes.push(`The script leads to a phase "${cur}" that this file does not declare.`); break; }
      used.add(cur);
      const lasts = resolveLasts(p.lasts, ctx);
      add({ kind: "phase", name: p.name, seconds: lasts.seconds, phase: p, lasts });
      // running out of lasts() leads to the cooldown unless then() says otherwise
      const next = p.then ?? (p.lasts.kind !== "none" ? "cooldown" : undefined);
      if (next === undefined) { notes.push(`"${p.name}" has no lasts() or then(): it ends on a reaction, an until() or a release, so the time after it is not fixed.`); break; }
      if (next === "cooldown") { cool(); break; }
      if (next === "ready") { steps.push({ kind: "ready", name: "ready", seconds: 0, start: t }); break; }
      cur = next;
    }
  }
  const orphans = phases.filter((p) => !used.has(p.name));
  const known = steps.every((s) => s.seconds !== null);
  return { steps, total: known ? steps.reduce((a, s) => a + (s.seconds ?? 0), 0) : null, orphans, notes };
}

// ---------------------------------------------------------------- csv edits (a single cell each)

/** The defaults file with `col` of ability `name`'s row set to `value` (a number as csv text). Null when the file has no such row. */
export function setStatCell(text: string, name: string, col: StatCol, value: number | string): string | null {
  const csv = parseCsv(text);
  if (csvKind(csv) !== "defaults") return null;
  const row = csv.rows.find((r) => nameOfId(r.cells[0]?.text ?? "") === name);
  const ci = csv.header.indexOf(col);
  if (!row || ci < 0) return null;
  return setCell(text, row, ci, typeof value === "number" ? csvNum(value) : value);
}

/** The tuning file with the value of ability `name`'s `key` row set. `owner` pins the row when `all` also has the key. */
export function setTuneCell(text: string, name: string, key: string, value: number, owner: "own" | "all" = "own"): string | null {
  const csv = parseCsv(text);
  if (csvKind(csv) !== "tuning") return null;
  const ki = csv.header.indexOf("key"), vi = csv.header.indexOf("value");
  const row = csv.rows.find((r: CsvRow) => r.cells[ki]?.text === key && (owner === "all" ? r.cells[0]?.text === "all" : nameOfId(r.cells[0]?.text ?? "") === name));
  if (!row) return null;
  return setCell(text, row, vi, csvNum(value));
}

/** The row a new ability gets: zeros for the times, -1 ("not set") for the rest, as the shipped rows do. */
export function newTimingCells(ns: string, name: string): string[] {
  return [`${ns}:${name}`, "0", "0", "-1", "-1", "-1", "FALSE"];
}

export const DEFAULTS_HEADER = "ability_id,cooldown,duration,range,damage,amplifier,disabled";

/** Add the timing row of `name` to a defaults file (an empty `text` becomes a new file with the header). */
export function addTimingRow(text: string, ns: string, name: string): string {
  const base = text.trim() === "" ? DEFAULTS_HEADER + "\n" : text;
  return appendRow(base, newTimingCells(ns, name));
}

/**
 * Which defaults csv in a pack is "its own" (the one new rows go to): the one named after the pack's folder
 * (`src/packs/heroes/resources` -> `heroes.csv`), else the only one there is, else a new file of that name.
 * `files` are the defaults csvs of the pack's own resources root and namespace folder (paths).
 */
export function packDefaultsCsv(files: string[], dir: string, root: string): string {
  const parts = root.replace(/\\/g, "/").split("/");
  const pack = (parts[parts.length - 1] === "resources" ? parts[parts.length - 2] : parts[parts.length - 1]) || "pack";
  const named = `${dir}/${pack}.csv`;
  const base = (p: string) => p.replace(/\\/g, "/");
  if (files.some((f) => base(f) === named)) return files.find((f) => base(f) === named)!;
  if (files.length === 1) return files[0];
  return named;
}
