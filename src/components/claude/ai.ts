/**
 * AI sessions: which terminal panes are Claude sessions, "done / needs input" signals (hooks + transcript fallback), badges and
 * OS notifications. State lives per window (every project window is its own webview). See docs/AI-SESSIONS.md.
 */
import { invoke, listen, basename } from "../../lib/ipc";
import { createStore } from "../../lib/store";
import { projectStore } from "../../lib/project";
import { layoutStore } from "../../lib/layout";
import { onWindowActive } from "../../lib/activity";
import { setToolBadge } from "../../toolwindows/registry";
import { desktopNotify } from "../terminal/notify";
import { setSpawnHook } from "../terminal/spawnHook";
import { bumpTerm, getPane, getTab, paneVisible, renameTab, tabDecor, tabOf, termStore, type Tab } from "../terminal/sessions";
import { leaves } from "../terminal/splitTree";
import { claudeStore, refreshHost } from "./api";

// ------------------------------------------------------------------------------------------------ settings
export interface AiSettings {
  notifyDone: boolean;
  notifyQuestion: boolean;
  /** only notify when Ace is in the background or the session's terminal is not on screen */
  onlyWhenUnfocused: boolean;
  sound: boolean;
  /** pass Ace's Stop/Notification hooks to `claude` started from Ace (UI launches and plain `claude` in Ace shells) */
  hooks: boolean;
  /** transcript fallback: watch sessions of the current project that Ace did not launch */
  watchProject: boolean;
  /** seconds a trailing tool call must stay unanswered before the transcript fallback calls it a permission question */
  pendingSecs: number;
  /** activating Ace within a few seconds of one of its notifications jumps to that session (the plugin has no click callback) */
  jumpOnActivate: boolean;
}
export const DEFAULT_SETTINGS: AiSettings = {
  notifyDone: true, notifyQuestion: true, onlyWhenUnfocused: true, sound: false, hooks: true, watchProject: true, pendingSecs: 30, jumpOnActivate: true,
};
const SKEY = "ace.ai.settings";
const readSettings = (): AiSettings => {
  try {
    return { ...DEFAULT_SETTINGS, ...JSON.parse(localStorage.getItem(SKEY) ?? "{}") };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
};
export const aiSettings = createStore<AiSettings>(readSettings());
export function updateAiSettings(p: Partial<AiSettings>) {
  aiSettings.set(p);
  try { localStorage.setItem(SKEY, JSON.stringify(aiSettings.get())); } catch {}
}

// ------------------------------------------------------------------------------------------------ pane <-> session
export interface PaneSession {
  paneId: string;
  tabId: string;
  host: string;
  cwd: string;
  sessionId?: string;
  /** tab title Ace set (so a user rename is never overwritten) */
  autoTitle?: string;
}
const paneSessions = new Map<string, PaneSession>();
/** most recently focused Claude pane first */
let mru: string[] = [];
const touchMru = (id: string) => { mru = [id, ...mru.filter((x) => x !== id)].slice(0, 20); };

export const isClaudePane = (paneId: string) => paneSessions.has(paneId);
export const paneSessionOf = (paneId: string) => paneSessions.get(paneId);
export const skey = (host: string, sessionId: string) => `${host}:${sessionId}`;

export function paneForSession(host: string, sessionId: string): string | undefined {
  for (const ps of paneSessions.values()) if (ps.host === host && ps.sessionId === sessionId && getPane(ps.paneId)) return ps.paneId;
  return undefined;
}

/** Called for every Claude session Ace launches (the tab id comes from openTerminal). */
export function registerLaunch(tabId: string, o: { host: string; cwd: string; sessionId?: string; title?: string }) {
  const tab = getTab(tabId);
  if (!tab) return;
  for (const paneId of leaves(tab.root)) {
    paneSessions.set(paneId, { paneId, tabId, host: o.host, cwd: o.cwd, sessionId: o.sessionId, autoTitle: o.title });
    touchMru(paneId);
  }
  emitChange();
}

/** The Claude pane to return to: last focused one that still exists. */
export function mruPane(): string | undefined {
  for (const id of mru) if (paneSessions.has(id) && getPane(id) && tabOf(id)) return id;
  for (const id of paneSessions.keys()) if (getPane(id) && tabOf(id)) return id;
  return undefined;
}
export const claudePaneCount = () => [...paneSessions.keys()].filter((id) => getPane(id) && tabOf(id)).length;

function pruneDead() {
  for (const id of [...paneSessions.keys()]) if (!getPane(id) || !tabOf(id)) { paneSessions.delete(id); mru = mru.filter((x) => x !== id); }
}

// ------------------------------------------------------------------------------------------------ attention (badges)
export type AttnKind = "done" | "question";
export interface Attn {
  key: string;
  host: string;
  sessionId: string;
  paneId?: string;
  cwd: string;
  kind: AttnKind;
  text: string;
  ts: number;
}
export const aiStore = createStore<{ attn: Record<string, Attn>; version: number }>({ attn: {}, version: 0 });
/** decisions log (capped) for the automation harness and debugging */
export interface LogEntry { t: number; key: string; kind: string; source: string; action: string; reason?: string; title?: string; body?: string }
export const aiLog: LogEntry[] = [];
const log = (e: Omit<LogEntry, "t">) => { aiLog.push({ t: Date.now(), ...e }); if (aiLog.length > 300) aiLog.splice(0, aiLog.length - 300); };

const emitChange = () => { aiStore.set((s) => ({ version: s.version + 1 })); bumpTerm(); renderBadges(); };

export const attnList = () => Object.values(aiStore.get().attn);
export const attnFor = (host: string, sessionId: string) => aiStore.get().attn[skey(host, sessionId)];
function setAttn(a: Attn | null, key: string) {
  aiStore.set((s) => {
    const attn = { ...s.attn };
    if (a) attn[key] = a; else delete attn[key];
    return { attn };
  });
  emitChange();
}
export const clearAttn = (key: string) => { if (aiStore.get().attn[key]) setAttn(null, key); };

function renderBadges() {
  const list = attnList();
  const n = list.length;
  const q = list.some((a) => a.kind === "question");
  const text = n ? String(n) : "";
  const title = n ? `${n} AI session${n > 1 ? "s" : ""} waiting: ${list.map((a) => `${basename(a.cwd) || a.cwd} (${a.kind === "question" ? "needs input" : "finished"})`).join(", ")}` : "";
  // "claude" is the AI Sessions header tab, "project" the group's stripe button
  setToolBadge("claude", n ? { text, title, kind: q ? "question" : "done" } : null);
}

tabDecor.badge = (t: Tab) => {
  const ids = new Set(leaves(t.root));
  const mine = attnList().filter((a) => a.paneId && ids.has(a.paneId));
  if (!mine.length) return null;
  const q = mine.some((a) => a.kind === "question");
  return { text: q ? "?" : "✓", title: q ? "Claude needs input" : "Claude finished", kind: q ? "question" : "done" };
};

/** A pane counts as seen when the window is focused and the pane is on screen. */
const isViewed = (paneId?: string) => !!paneId && document.hasFocus() && paneVisible(paneId);
const isFocusedVisible = (paneId?: string) => isViewed(paneId) && !!getPane(paneId!)?.el.contains(document.activeElement);

/** Drop badges for sessions the user is now looking at. Event driven (focus, tab/tool-window changes). */
export function reconcile() {
  for (const a of attnList()) if (a.paneId && isViewed(a.paneId)) clearAttn(a.key);
}

// ------------------------------------------------------------------------------------------------ signals
export type SigKind = "done" | "question" | "working" | "pending";
export interface Signal {
  source: "hook" | "fallback";
  host: string;
  sessionId: string;
  paneId?: string;
  cwd: string;
  kind: SigKind;
  text?: string;
  tool?: string | null;
}
/** sessions that report through hooks: the transcript fallback ignores them */
const hooked = new Set<string>();
/** false = a "done" was announced and no new prompt was seen since (one notification per turn) */
const armed = new Map<string, boolean>();
const lastRaise = new Map<string, number>();
const pendingTimers = new Map<string, number>();
const DEBOUNCE_MS = 3000;

export function ingest(sig: Signal) {
  const key = skey(sig.host, sig.sessionId);
  const tm = pendingTimers.get(key);
  if (tm !== undefined) { clearTimeout(tm); pendingTimers.delete(key); }
  if (sig.source === "fallback" && hooked.has(key)) { log({ key, kind: sig.kind, source: sig.source, action: "ignored", reason: "hooked session" }); return; }
  switch (sig.kind) {
    case "working":
      armed.set(key, true);
      clearAttn(key);
      log({ key, kind: "working", source: sig.source, action: "state" });
      return;
    case "pending":
      pendingTimers.set(key, window.setTimeout(() => {
        pendingTimers.delete(key);
        ingest({ ...sig, kind: "question", text: `May be waiting for permission${sig.tool ? ` (${sig.tool})` : ""}` });
      }, Math.max(1, aiSettings.get().pendingSecs) * 1000));
      log({ key, kind: "pending", source: sig.source, action: "timer", reason: sig.tool ?? "" });
      return;
    case "done":
      if (armed.get(key) === false) { log({ key, kind: "done", source: sig.source, action: "ignored", reason: "already announced this turn" }); return; }
      armed.set(key, false);
      return void raise(sig, "done");
    case "question":
      return void raise(sig, "question");
  }
}

function raise(sig: Signal, kind: AttnKind) {
  const key = skey(sig.host, sig.sessionId);
  const now = Date.now();
  const dk = key + kind;
  if (now - (lastRaise.get(dk) ?? 0) < DEBOUNCE_MS) { log({ key, kind, source: sig.source, action: "ignored", reason: "debounce" }); return; }
  lastRaise.set(dk, now);
  const paneId = sig.paneId ?? paneForSession(sig.host, sig.sessionId);
  const text = sig.text || (kind === "done" ? "Finished" : "Waiting for your input");
  const viewed = isViewed(paneId);
  const a: Attn = { key, host: sig.host, sessionId: sig.sessionId, paneId, cwd: sig.cwd, kind, text, ts: now };
  if (viewed) clearAttn(key); else setAttn(a, key);
  void notifyOs(a, viewed, sig.source);
}

async function notifyOs(a: Attn, viewed: boolean, source: string) {
  const s = aiSettings.get();
  const base = { key: a.key, kind: a.kind, source };
  if (a.kind === "done" ? !s.notifyDone : !s.notifyQuestion) return log({ ...base, action: "suppressed", reason: "disabled" });
  if (isFocusedVisible(a.paneId)) return log({ ...base, action: "suppressed", reason: "focused terminal" });
  if (s.onlyWhenUnfocused && viewed) return log({ ...base, action: "suppressed", reason: "visible" });
  const title = a.kind === "done" ? "Claude finished" : "Claude needs input";
  const proj = basename(a.cwd) || a.cwd;
  const body = `${proj}: ${a.text}`;
  const shown = await desktopNotify(title, body, { force: true, sound: s.sound });
  log({ ...base, action: shown ? "notified" : "suppressed", reason: shown ? undefined : "not shown", title, body });
  if (shown) void invoke("claude_note_shown", { key: a.key }).catch(() => {});
}

// ------------------------------------------------------------------------------------------------ hook events
interface HookEvent { host: string; pane: string; event: string; sessionId: string; cwd: string; transcript: string; message: string; ntype: string; last: string }
interface Turn { kind: SigKind; text: string; tool: string | null; uuid: string; tsMs: number }
interface TurnEvent extends Turn { host: string; sessionId: string; file: string; cwd: string }

let queue: Promise<void> = Promise.resolve();
const turnInfo = (host: string, file: string) => (file ? invoke<Turn | null>("claude_turn_info", { host, file }).catch(() => null) : Promise.resolve(null));

async function onHook(e: HookEvent) {
  if (!e.sessionId) return;
  const key = skey(e.host, e.sessionId);
  hooked.add(key);
  bindPane(e);
  const base = { source: "hook" as const, host: e.host, sessionId: e.sessionId, paneId: e.pane, cwd: e.cwd };
  if (e.event === "UserPromptSubmit") return ingest({ ...base, kind: "working" });
  if (e.event === "Stop") {
    const text = e.last || (await turnInfo(e.host, e.transcript))?.text || "";
    return ingest({ ...base, kind: "done", text });
  }
  if (e.event === "Notification") {
    // Claude's idle reminder ("waiting for your input", ~60 s after a finished turn) repeats what Stop already announced.
    if (e.ntype === "idle_prompt" && armed.get(key) === false) return log({ key, kind: "question", source: "hook", action: "ignored", reason: "idle reminder after Stop" });
    const t = await turnInfo(e.host, e.transcript);
    const text = t?.kind === "question" && t.text ? t.text : e.message || "Waiting for your input";
    return ingest({ ...base, kind: "question", text });
  }
}

function bindPane(e: HookEvent) {
  const pane = getPane(e.pane);
  if (!pane) return;
  const tab = tabOf(e.pane);
  let ps = paneSessions.get(e.pane);
  if (!ps) {
    ps = { paneId: e.pane, tabId: tab?.id ?? "", host: e.host, cwd: e.cwd };
    paneSessions.set(e.pane, ps);
    emitChange();
  }
  if (!ps.sessionId || ps.sessionId !== e.sessionId) { ps.sessionId = e.sessionId; ps.cwd = e.cwd || ps.cwd; void syncTitle(ps); }
}

/** Put the session title on the terminal tab (once the transcript has one); never overrides a title the user chose. */
const titled = new Set<string>();
async function syncTitle(ps: PaneSession) {
  const k = skey(ps.host, ps.sessionId ?? "");
  if (!ps.sessionId || titled.has(k)) return;
  titled.add(k);
  const find = () => (claudeStore.get().hosts[ps.host]?.sessions ?? []).find((x) => x.id === ps.sessionId);
  let s = find();
  if (!s) {
    await refreshHost(ps.host);
    s = find();
  }
  if (!s) { titled.delete(k); return; }
  const tab = getTab(ps.tabId) ?? tabOf(ps.paneId);
  if (!tab) return;
  if (tab.custom && tab.custom !== ps.autoTitle) return; // user renamed it
  const title = tabTitleFor(s.title);
  renameTab(tab.id, title);
  ps.autoTitle = title;
}
export const tabTitleFor = (t: string) => `Claude: ${t.slice(0, 28)}`;
// ------------------------------------------------------------------------------------------------ transcript fallback events
function onTurn(e: TurnEvent) {
  const sig: Signal = { source: "fallback", host: e.host, sessionId: e.sessionId, cwd: e.cwd, kind: e.kind, text: e.text, tool: e.tool };
  const key = skey(e.host, e.sessionId);
  if (hooked.has(key)) { log({ key, kind: e.kind, source: "fallback", action: "ignored", reason: "hooked session" }); return; }
  if (e.kind === "done" || e.kind === "question") {
    // a hook event for the same turn arrives within a moment: give it priority before announcing from the transcript
    window.setTimeout(() => ingest(sig), HOOK_GRACE_MS);
  } else ingest(sig);
}
export const HOOK_GRACE_MS = 1500;

/** Sessions the user opted in to ("Notify When Done" on a session row); persisted per machine. */
export interface OptIn { host: string; id: string; file: string }
const OKEY = "ace.ai.optin";
export const optIns = (): OptIn[] => { try { return JSON.parse(localStorage.getItem(OKEY) ?? "[]"); } catch { return []; } };
export const isOptedIn = (host: string, id: string) => optIns().some((o) => o.host === host && o.id === id);
export function toggleOptIn(o: OptIn) {
  const cur = optIns();
  const on = cur.some((x) => x.host === o.host && x.id === o.id);
  try { localStorage.setItem(OKEY, JSON.stringify(on ? cur.filter((x) => !(x.host === o.host && x.id === o.id)) : [...cur, o])); } catch {}
  if (o.host !== "local") void (on ? invoke("claude_unfollow", { host: o.host, file: o.file }) : invoke("claude_follow", { host: o.host, file: o.file, sessionId: o.id })).catch(() => {});
  syncFallback();
  emitChange();
  return !on;
}

export function syncFallback() {
  const root = projectStore.get().root;
  const s = aiSettings.get();
  const cwd = s.watchProject && root && root.host === "local" ? root.path : null;
  const sessions = optIns().filter((o) => o.host === "local").map((o) => o.id);
  void invoke("claude_fallback_set", { cwd, sessions }).catch(() => {});
}

// ------------------------------------------------------------------------------------------------ jumping to a session
type Goto = (a: { host: string; sessionId?: string; paneId?: string; cwd: string }) => void;
let gotoImpl: Goto = () => {};
export const setGoto = (g: Goto) => { gotoImpl = g; };
export const gotoAttention = (a: Attn) => { clearAttn(a.key); gotoImpl(a); };
export const nextAttention = (): Attn | undefined => attnList().sort((x, y) => (x.kind === y.kind ? y.ts - x.ts : x.kind === "question" ? -1 : 1))[0];

// ------------------------------------------------------------------------------------------------ install
let installed = false;
export function installAi() {
  if (installed) return;
  installed = true;

  setSpawnHook(async ({ host, command }) => {
    if (!aiSettings.get().hooks) return undefined;
    if (command && !/^\s*claude(\s|$)/.test(command)) return undefined;
    try {
      return (await invoke<{ file: string }>("claude_hook_channel", { host })).file;
    } catch {
      return undefined; // never block a terminal on the optional channel
    }
  });

  void listen<HookEvent>("claude://hook", (e) => { queue = queue.then(() => onHook(e.payload)).catch(() => {}); });
  void listen<TurnEvent>("claude://turn", (e) => onTurn(e.payload));
  void listen<string>("claude://goto", (e) => {
    const a = aiStore.get().attn[e.payload] ?? attnList().find((x) => x.key === e.payload);
    if (a) gotoAttention(a);
  });

  // MRU + "seen" bookkeeping, all event driven
  document.addEventListener("focusin", (ev) => {
    const slot = (ev.target as Element | null)?.closest?.("[data-pane]");
    const id = slot?.getAttribute("data-pane");
    if (id && paneSessions.has(id)) touchMru(id);
    reconcile();
  }, true);
  onWindowActive(() => {
    reconcile();
    if (aiSettings.get().jumpOnActivate) void invoke<boolean>("claude_note_claim").catch(() => false);
  });
  termStore.subscribe(() => { pruneDead(); reconcile(); });
  layoutStore.subscribe(reconcile);
  projectStore.subscribe(syncFallback);
  aiSettings.subscribe(syncFallback);
  window.addEventListener("storage", (ev) => { if (ev.key === SKEY) aiSettings.set(readSettings()); });
  for (const o of optIns()) if (o.host !== "local") void invoke("claude_follow", { host: o.host, file: o.file, sessionId: o.id }).catch(() => {});
  syncFallback();
  renderBadges();
}
