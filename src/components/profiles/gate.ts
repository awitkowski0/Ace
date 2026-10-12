/** Pure profile gating (docs/PROFILES.md). Developer = everything allowed, nothing rewritten (zero behaviour change). */

export type Profile = "developer" | "asset";
export const PROFILE_LIST: { id: Profile; label: string; blurb: string }[] = [
  { id: "developer", label: "Developer", blurb: "Everything: code editor, terminal, Gradle, debugger and all tool windows." },
  { id: "asset", label: "Asset Dev", blurb: "Just models, animations and textures: an Assets list, Save to Git, Get latest and Run Game." },
];
export const profileLabel = (p: Profile) => PROFILE_LIST.find((x) => x.id === p)?.label ?? p;
export const isProfile = (v: unknown): v is Profile => v === "developer" || v === "asset";

/** Tool windows visible in Asset Dev (`project` is shown as "Assets", `commit` as "Changes"). */
export const ASSET_TOOL_WINDOWS = ["project", "commit", "run"];
export const toolWindowAllowed = (p: Profile, id: string) => p === "developer" || ASSET_TOOL_WINDOWS.includes(id);

const cap = (s: string) => s.replace(/(^|[-_ ])(\w)/g, (_, __, c: string) => c.toUpperCase());
/** The Activate<X>ToolWindow action id of a tool window (same rule as actions/builtin.ts) */
export const activateActionId = (tw: { id: string; actionId?: string }) => tw.actionId ?? `Activate${cap(tw.id)}ToolWindow`;

export type GateResult = "ok" | "hidden" | "blocked" | { redirect: string };
export interface GateAction { id: string; profiles?: string[] }

/** Asset Dev: shortcuts for these actions do something friendlier instead */
export const ASSET_REDIRECTS: Record<string, string> = {
  Run: "Assets.RunGame", CheckinProject: "Assets.Save", "Vcs.UpdateProject": "Assets.GetLatest", "Vcs.Push": "Assets.Save",
  "Git.Branches": "Assets.Branch", "Git.Fetch": "Assets.GetLatest", "Git.Commit": "Assets.Save",
};
const DENY = /^(Terminal|Gradle\.|Godot\.|Ace\.|Claude\.|Python|Debug|Step|SmartStep|ForceStep|Resume$|Pause$|RunToCursor|ForceRunToCursor|ShowExecutionPoint|EvaluateExpression|AddToWatch|ToggleLineBreakpoint|ViewBreakpoints|MuteBreakpoints|Rerun\.Debug|RerunDebug|ChooseDebug|EditRunConfigurations|NewRunConfiguration|ChooseRunConfiguration|RunClass|DebugClass|Git\.Annotate|Vcs\.|RerunTests|RerunFailedTests|Processes|Daemons|.*Terminal.*)/;

/**
 * `hiddenWindowActions`: Activate<X>ToolWindow ids of tool windows the profile hides (computed from the raw registry by the caller).
 * ok = run; hidden = behave as if the action does not exist (try the next binding); blocked = swallow the key and show the notice.
 */
export function gateAction(p: Profile, a: GateAction, hiddenWindowActions: ReadonlySet<string>): GateResult {
  if (a.profiles && !a.profiles.includes(p)) return "hidden";
  if (p === "developer") return "ok";
  if (a.profiles) return "ok";
  const r = ASSET_REDIRECTS[a.id];
  if (r) return { redirect: r };
  if (hiddenWindowActions.has(a.id) || DENY.test(a.id)) return "blocked";
  return "ok";
}

/** Tool-window view: null = hidden; developer returns the very same object. */
export function viewToolWindow<T extends { id: string }>(p: Profile, tw: T, overrides: Record<string, (tw: T) => T>): T | null {
  if (p === "developer") return tw;
  if (!toolWindowAllowed(p, tw.id)) return null;
  return overrides[tw.id]?.(tw) ?? tw;
}

// ---------- "not on the latest" notice (pure part) ----------
export interface IncomingLite { behind: number; authors: string[]; tip: string | null; base: string | null; baseBehind: number; baseTip: string | null; baseAuthors: string[] }
export interface Notice { key: string; text: string; behind: number }

const people = (a: string[]) => (a.length === 0 ? "" : a.length === 1 ? ` from ${a[0]}` : a.length === 2 ? ` from ${a[0]} and ${a[1]}` : ` from ${a[0]}, ${a[1]} and others`);
const updates = (n: number) => `${n} update${n === 1 ? "" : "s"}`;
/** snoozed = keys the user dismissed with "Later"; a dismissed notice comes back only when a newer commit changes its key. */
export function incomingNotice(branch: string | null, inc: IncomingLite | null, snoozed: ReadonlySet<string>): Notice | null {
  if (!inc || !branch) return null;
  const cands: Notice[] = [];
  if (inc.behind > 0 && inc.tip) cands.push({ key: `up:${branch}:${inc.tip}`, behind: inc.behind, text: `There's a newer version of ${branch} — ${updates(inc.behind)}${people(inc.authors)}.` });
  if (inc.baseBehind > 0 && inc.baseTip && inc.base) {
    const main = inc.base.replace(/^origin\//, "");
    cands.push({ key: `base:${inc.baseTip}`, behind: inc.baseBehind, text: `The ${main} version has moved on — ${updates(inc.baseBehind)}${people(inc.baseAuthors)} ${inc.baseBehind === 1 ? "isn't" : "aren't"} in your branch yet.` });
  }
  return cands.find((c) => !snoozed.has(c.key)) ?? null;
}
/** Badge on the Get latest button: newer commits on the branch, else on the main branch (snoozed or not) */
export const behindTotal = (inc: IncomingLite | null) => (inc ? (inc.behind > 0 ? inc.behind : Math.max(inc.baseBehind, 0)) : 0);

// ---------- Run Game discovery (pure part) ----------
export interface RunOption { task: string; name: string; args: string; parked: boolean; /** regex source: use this one on matching branches */ branch?: string }
export interface RunDiscoveryInput {
  /** `.ace/config.json` assetRun: one fixed `task`, or `choices` (+ `default`) for several, e.g. one per Minecraft version */
  assetRun?: { task?: string; args?: string; default?: string; choices?: { task?: unknown; name?: unknown; args?: unknown; branch?: unknown }[] } | null;
  pinned?: { task: string; name?: string }[];
  targets?: { mc: string; loader: string; parked?: boolean }[];
  /** current Git branch: picks the version it belongs to ("v1.20.1-wolverine" -> 1.20.1) */
  branch?: string | null;
  /** the task this user picked in the Run Game menu for this project + version */
  chosen?: string | null;
}
export interface RunChoice { task: string; args: string; source: "chosen" | "config" | "branch" | "pinned" | "targets" | "default"; name?: string }

const isClientTask = (t: string) => /RunClient$|(^|:)runClient$/.test(t);
/** "v1.20.1-wolverine" / "release/1.21.1" -> "1.20.1" / "1.21.1"; null when the branch names no Minecraft version */
export function branchVersion(branch: string | null | undefined): string | null {
  return branch?.match(/(?:^|[^0-9.])v?(\d+\.\d+(?:\.\d+)?)(?![0-9])/)?.[1] ?? null;
}
const nameOf = (task: string) => task.replace(/^:/, "").replace(/:?(fabric|forge|neoforge)?RunClient$/i, (_, l) => (l ? " " + l[0].toUpperCase() + l.slice(1) : "")).replace(/:/g, " ").trim() || task;

/** Everything the Run Game menu offers: config `choices`, else the pinned Gradle client tasks (parked ones last). */
export function runOptions(i: RunDiscoveryInput): RunOption[] {
  const cfg = (i.assetRun?.choices ?? []).flatMap((c) =>
    typeof c?.task === "string" && c.task.trim()
      ? [{ task: c.task.trim(), name: typeof c.name === "string" && c.name ? c.name : nameOf(c.task), args: typeof c.args === "string" ? c.args.trim() : "", parked: /parked/i.test(String(c.name ?? "")), branch: typeof c.branch === "string" ? c.branch : undefined }]
      : []);
  const list = cfg.length ? cfg : (i.pinned ?? []).filter((p) => isClientTask(p.task)).map((p) => ({ task: p.task, name: p.name || nameOf(p.task), args: "", parked: /parked/i.test(p.name ?? ""), branch: undefined as string | undefined }));
  return [...list.filter((o) => !o.parked), ...list.filter((o) => o.parked)];
}

export function pickClientTask(i: RunDiscoveryInput): RunChoice {
  const opts = runOptions(i);
  const argsOf = (t: string) => opts.find((o) => o.task === t)?.args ?? "";
  const pick = (t: string, source: RunChoice["source"], args = argsOf(t)): RunChoice => ({ task: t, args, source, name: opts.find((o) => o.task === t)?.name });
  if (i.chosen?.trim()) return pick(i.chosen.trim(), "chosen");
  const a = i.assetRun;
  if (a?.task?.trim()) return { task: a.task.trim(), args: a.args?.trim() ?? "", source: "config" };
  // a config choice whose `branch` regex matches the current branch, then the config default
  if (i.branch) {
    const hit = opts.find((o) => { if (!o.branch) return false; try { return new RegExp(o.branch).test(i.branch!); } catch { return false; } });
    if (hit) return pick(hit.task, "config", hit.args);
  }
  if (a?.default?.trim()) return pick(a.default.trim(), "config");
  // the version on the branch name, else the first non-parked Fabric client task
  const ver = branchVersion(i.branch);
  const live = opts.filter((o) => !o.parked);
  const fab = (o: RunOption) => /fabric/i.test(o.task) && !/neoforge/i.test(o.task);
  if (ver) {
    const m = live.filter((o) => o.task.startsWith(`:${ver}:`));
    const hit = m.find(fab) ?? m[0];
    if (hit) return pick(hit.task, "branch", hit.args);
  }
  const fabric = live.find(fab);
  if (fabric) return pick(fabric.task, "pinned", fabric.args);
  const t = (i.targets ?? []).filter((x) => !x.parked).find((x) => x.loader === "fabric");
  if (t) return { task: `:${t.mc}:fabricRunClient`, args: "", source: "targets" };
  if (live[0]) return pick(live[0].task, "pinned", live[0].args);
  return { task: "runClient", args: "", source: "default" };
}

/** Console-output heuristic: has the game window started? */
export const GAME_STARTED = /\[Render thread\/|Setting user:|Loading Minecraft|LWJGL|Narrator library|Backend library/;
