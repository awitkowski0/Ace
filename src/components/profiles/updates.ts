/**
 * "Not on the latest" watcher for Asset Dev (docs/PROFILES.md). A quiet background `git fetch` on project open, on window focus and every
 * ~5 minutes while the window is focused (never while unfocused: perf rules). When the branch (or the main branch) is ahead of the user,
 * a non-blocking balloon offers [Get latest] [Later]; Later snoozes until a newer commit arrives. Get latest buttons show a badge.
 */
import { createStore } from "../../lib/store";
import { projectStore, projectKey } from "../../lib/project";
import { gitStore } from "../git/api";
import { getProfile, onProfileChange } from "./profile";
import { behindTotal, incomingNotice, type IncomingLite } from "./gate";
import { gx, getLatest } from "./gitops";
import { resolveBase } from "./assets";
import { ask, hideBalloon, showBalloon } from "./notice";

export const FETCH_EVERY_MS = 5 * 60 * 1000;
export const updatesStore = createStore<{ incoming: IncomingLite | null; checking: boolean; lastCheck: number; error: string | null }>({ incoming: null, checking: false, lastCheck: 0, error: null });
const snoozed = new Set<string>();
const BALLOON = "profiles.newer";

export const behindCount = () => behindTotal(updatesStore.get().incoming);

function present() {
  const branch = gitStore.get().status?.branch ?? null;
  const n = incomingNotice(branch, updatesStore.get().incoming, snoozed);
  if (!n || getProfile() !== "asset") return hideBalloon(BALLOON);
  showBalloon({
    id: BALLOON, text: n.text, kind: "info",
    actions: [
      { label: "Get latest", primary: true, run: async () => { hideBalloon(BALLOON); await getLatest(); await checkNow(false); } },
      { label: "Later", run: () => { snoozed.add(n.key); hideBalloon(BALLOON); } },
    ],
  });
}

let inflight: Promise<void> | null = null;
/** Fetch quietly, then recompute what's incoming. `fetch=false` only recomputes (after a pull). */
export function checkNow(fetch = true): Promise<void> {
  if (inflight) return inflight;
  const root = projectStore.get().root;
  if (!root || !gitStore.get().status?.isRepo) return Promise.resolve();
  updatesStore.set({ checking: true });
  inflight = (async () => {
    try {
      if (fetch) await gx.fetchQuiet(root).catch((e) => updatesStore.set({ error: String(e) }));
      const inc = await gx.incoming(root, resolveBase(gitStore.get().status?.branch ?? null));
      updatesStore.set({ incoming: inc, lastCheck: Date.now(), error: null });
    } catch (e) {
      updatesStore.set({ error: String(e) });
    } finally {
      updatesStore.set({ checking: false });
      inflight = null;
      present();
    }
  })();
  return inflight;
}

/** Before Run Game / Save to Git: nudge when behind. Resolves true to continue. */
export async function ensureLatest(why: "run" | "save"): Promise<boolean> {
  await Promise.race([checkNow(), new Promise((r) => setTimeout(r, 4000))]);
  if (behindCount() === 0) return true;
  const r = await ask({
    title: "You're not on the latest",
    message: `Your teammates have saved newer changes. Get them first${why === "run" ? " so the game matches the latest" : " so your save doesn't clash with theirs"}?`,
    buttons: [{ label: "Get latest & continue", value: "get", primary: true }, { label: "Continue anyway", value: "go" }, { label: "Cancel", value: null }],
  });
  if (r.value === null) return false;
  if (r.value === "get") {
    const res = await getLatest();
    await checkNow(false);
    return res.ok;
  }
  return true;
}

let timer: ReturnType<typeof setInterval> | undefined;
let wired = false;
let lastKey = "";
function onFocus() { if (getProfile() === "asset") void checkNow(); }

function sync() {
  const on = getProfile() === "asset";
  clearInterval(timer);
  timer = undefined;
  if (!on) { hideBalloon(BALLOON); updatesStore.set({ incoming: null }); return; }
  timer = setInterval(() => { if (document.hasFocus() && !document.hidden) void checkNow(); }, FETCH_EVERY_MS);
  void checkNow();
}

export function startUpdates() {
  if (wired) return;
  wired = true;
  window.addEventListener("focus", onFocus);
  onProfileChange(sync);
  // project open (or switch): new repo, fresh state
  projectStore.subscribe(() => {
    const r = projectStore.get().root;
    const k = r ? projectKey(r) : "";
    if (k === lastKey) return;
    lastKey = k;
    updatesStore.set({ incoming: null });
    hideBalloon(BALLOON);
  });
  // the git module learns the repo is there / the branch changed
  let lastBranch: string | null | undefined;
  gitStore.subscribe(() => {
    const st = gitStore.get().status;
    const b = st?.isRepo ? st.branch : null;
    if (b !== lastBranch) { lastBranch = b; if (getProfile() === "asset" && st?.isRepo) void checkNow(); }
  });
  sync();
}
