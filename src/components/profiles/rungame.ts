/**
 * Run Game (docs/PROFILES.md): discovers the project's Gradle client run task by READING its files (never running or writing anything),
 * then starts it through the normal Run infrastructure (a "gradle" run configuration + the Run window). The Run window is the console.
 *   precedence: the task this user picked in the Run Game menu (remembered per project + Minecraft version)
 *               > `.ace/config.json` "assetRun": { "task": ":1.20.1:fabricRunClient", "args": "" }  (one fixed task), or
 *                 { "choices": [{ "task", "name", "args"?, "branch"? }], "default"? }  (a menu; `branch` = regex of branches that use it)
 *               > the pinned Gradle client task for the Minecraft version in the branch name (v1.20.1-x -> :1.20.1:fabricRunClient)
 *               > first non-parked Fabric client task pinned in `gradle.pinned` > first Fabric target of versions/targets.json > `runClient`.
 *   The menu lists `assetRun.choices`, else every pinned client task.
 */
import { createStore } from "../../lib/store";
import { fs, invoke, joinPath } from "../../lib/ipc";
import { projectKey, projectStore } from "../../lib/project";
import { gitStore } from "../git/api";
import { repoConfigStore, ensureRepoConfig } from "../../lib/repoConfig";
import { ensureConfig } from "../run/configs";
import { sessionStore, startRun, stopSession, subscribeOut, getSession, showRunWindow, type Session } from "../run/sessions";
import { GAME_STARTED, branchVersion, pickClientTask, runOptions, type RunChoice, type RunDiscoveryInput, type RunOption } from "./gate";
import { ensureLatest } from "./updates";
import { toast } from "./notice";

export type GameState = "idle" | "building" | "running" | "closed" | "crashed";
export const gameStore = createStore<{ state: GameState; sessionId: string | null; task: string | null }>({ state: "idle", sessionId: null, task: null });

// ---- the user's pick from the Run Game menu: per user (app data), per project + Minecraft version of the branch ----
const PREF = "assetRun";
let picks: Record<string, string> = {};
let picksLoaded: Promise<void> | null = null;
const pickKey = () => {
  const root = projectStore.get().root;
  return root ? `${projectKey(root)}#${branchVersion(gitStore.get().status?.branch) ?? ""}` : "";
};
const loadPicks = () => picksLoaded ??= invoke<string | null>("ui_pref_get", { name: PREF }).then((t) => { const v = t ? JSON.parse(t) : null; picks = v && typeof v === "object" ? v : {}; }).catch(() => {});
/** Remember (or with null forget) the task picked for the current project + branch version. */
export async function chooseRunTask(task: string | null) {
  await invoke<string | null>("ui_pref_get", { name: PREF }).then((t) => { const v = t ? JSON.parse(t) : null; picks = v && typeof v === "object" ? v : {}; }).catch(() => {}); // another window may have written meanwhile
  const k = pickKey();
  if (!k) return;
  if (task) picks[k] = task; else delete picks[k];
  await invoke("ui_pref_set", { name: PREF, value: JSON.stringify(picks) }).catch(() => {});
}

interface PinLite { task?: unknown; name?: unknown }
export async function readRunInput(): Promise<{ input: RunDiscoveryInput; gradle: boolean }> {
  const root = projectStore.get().root;
  ensureRepoConfig();
  await loadPicks();
  const raw = repoConfigStore.get().raw;
  const input: RunDiscoveryInput = { branch: gitStore.get().status?.branch ?? null, chosen: picks[pickKey()] ?? null };
  const ar = raw.assetRun as { task?: unknown; args?: unknown; default?: unknown; choices?: unknown } | undefined;
  if (ar && typeof ar === "object") {
    input.assetRun = {
      task: typeof ar.task === "string" ? ar.task : undefined, args: typeof ar.args === "string" ? ar.args : undefined, default: typeof ar.default === "string" ? ar.default : undefined,
      choices: Array.isArray(ar.choices) ? ar.choices : undefined,
    };
  }
  const pins = (raw.gradle as { pinned?: PinLite[] } | undefined)?.pinned;
  if (Array.isArray(pins)) input.pinned = pins.filter((p) => typeof p?.task === "string").map((p) => ({ task: p.task as string, name: typeof p.name === "string" ? p.name : undefined }));
  let gradle = false;
  if (root) {
    gradle = await fs.stat({ host: root.host, path: joinPath(root.path, "gradlew") }).then((s) => s.exists, () => false);
    if (!input.assetRun?.task && !input.assetRun?.choices?.length && !input.pinned?.length) {
      try {
        const t = JSON.parse(await fs.readFile({ host: root.host, path: joinPath(root.path, "versions/targets.json") }));
        if (Array.isArray(t.targets)) input.targets = t.targets.filter((x: { mc?: unknown; loader?: unknown }) => typeof x.mc === "string" && typeof x.loader === "string");
      } catch { /* no targets.json */ }
    }
  }
  return { input, gradle };
}

export async function discoverRun(): Promise<RunChoice & { gradle: boolean; options: RunOption[] }> {
  const { input, gradle } = await readRunInput();
  return { ...pickClientTask(input), gradle, options: runOptions(input) };
}

let unOut: (() => void) | null = null;
function watch(s: Session) {
  unOut?.();
  const evaluate = () => {
    const cur = getSession(s.id);
    if (!cur || gameStore.get().sessionId !== s.id) return;
    let state: GameState;
    if (cur.status === "finished") {
      state = cur.stopRequested || cur.exit?.code === 0 ? "closed" : "crashed";
    } else {
      const was = gameStore.get().state;
      state = was === "running" ? "running" : cur.buf.fullText().slice(-20000).match(GAME_STARTED) ? "running" : "building";
    }
    if (state !== gameStore.get().state) gameStore.set({ state });
  };
  const u1 = subscribeOut(s)(evaluate);
  const u2 = sessionStore.subscribe(evaluate);
  unOut = () => { u1(); u2(); };
  evaluate();
}

export const gameRunning = () => ["building", "running"].includes(gameStore.get().state);

export async function runGame(): Promise<void> {
  if (gameRunning()) return void showRunWindow();
  if (!(await ensureLatest("run"))) return;
  const d = await discoverRun();
  if (!d.gradle && d.source === "default") {
    toast("This project doesn't have a game to run yet. Ask a teammate to add a Run Game setting to the project.", "warn", 6000);
    return;
  }
  const cfg = ensureConfig({ type: "gradle", name: `Run Game (${d.task})`, temporary: true, tasks: d.task, args: d.args, workingDir: "", env: [], enhancedHotswap: false });
  const s = await startRun(cfg.id, "run", { show: true });
  if (!s) return void toast("The game couldn't be started. See the Run window for details.", "warn");
  gameStore.set({ state: "building", sessionId: s.id, task: d.task });
  watch(s);
}

export function stopGame() {
  const s = getSession(gameStore.get().sessionId);
  if (s && s.status !== "finished") stopSession(s);
}

export const GAME_TEXT: Record<GameState, string> = { idle: "", building: "Building the game…", running: "Game is running", closed: "Game closed", crashed: "Game crashed — see the Run window" };
