/** Test hooks for scripts/qa/ai.mjs (only loaded by the automation harness). */
import { invoke } from "../../lib/ipc";
import { layoutStore, setActive } from "../../lib/layout";
import { qaHooks } from "../terminal/notify";
import { createSession, getPane, tabOf, termStore, paneVisible } from "../terminal/sessions";
import { aiLog, aiSettings, attnList, clearAttn, mruPane, optIns, paneSessionOf, updateAiSettings, DEFAULT_SETTINGS, ingest, type Signal } from "./ai";
import { leaves } from "../terminal/splitTree";
import { flip, flipState, inAiContext } from "./flip";
import { launch } from "./api";
import { runSpawnHook } from "../terminal/spawnHook";

const notes: Array<{ title: string; body: string; at: number }> = [];

export const aiQa = {
  /** Record (and swallow) desktop notifications instead of showing them. */
  capture() {
    notes.length = 0;
    qaHooks.notify = (title, body) => { notes.push({ title, body, at: Date.now() }); return true; };
  },
  release() { qaHooks.notify = undefined; },
  notes: () => notes.slice(),
  clearNotes: () => { notes.length = 0; },
  log: () => aiLog.slice(),
  clearLog: () => { aiLog.length = 0; },
  attn: () => attnList(),
  clearAttn: () => attnList().forEach((a) => clearAttn(a.key)),
  settings: () => aiSettings.get(),
  update: updateAiSettings,
  reset: () => updateAiSettings({ ...DEFAULT_SETTINGS }),
  optIns,
  flip,
  flipState,
  inAiContext,
  launch,
  ingest: (s: Signal) => ingest(s),
  spawnHook: (o: { host: string; cwd: string; command?: string; id: string }) => runSpawnHook(o),
  channel: (host = "local") => invoke<{ host: string; file: string }>("claude_hook_channel", { host }),
  /** Claude panes: id, tab, session, visible */
  panes() {
    return termStore.get().tabs.flatMap((tab) =>
      leaves(tab.root).map((id) => ({ id, tab: tab.id, title: tab.custom ?? getPane(id)?.title ?? "", session: paneSessionOf(id) ?? null, visible: paneVisible(id), exited: !!getPane(id)?.exited })));
  },
  mru: () => mruPane() ?? null,
  tabOf: (id: string) => tabOf(id)?.id ?? null,
  layout: () => layoutStore.get().active,
  hideTerminal: () => setActive("bottom", null),
  plainShell: (host: string, cwd: string) => createSession({ host, cwd }),
};
