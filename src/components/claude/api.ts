import { invoke, listen, type Location } from "../../lib/ipc";
import { createStore } from "../../lib/store";
import { projectStore, openProject } from "../../lib/project";
import { openTerminal } from "../terminal/api";
import { registerLaunch, tabTitleFor } from "./ai";
import { focusSessionTerminal } from "./flip";

export interface SessionInfo {
  id: string;
  host: string;
  file: string;
  cwd: string;
  title: string;
  messages: number;
  approx: boolean;
  modified: number;
  size: number;
  branch: string | null;
}
export interface RunningClaude {
  pid: number;
  cwd: string;
  sessionId: string | null;
  /** plain `claude`: session whose jsonl in this cwd was appended in the last ~60s (unambiguous only) */
  activeSessionId: string | null;
}

export const claudeApi = {
  sessions: (host: string) => invoke<SessionInfo[]>("claude_sessions", { host }),
  /** Last persisted listing (instant, possibly stale). */
  sessionsCached: (host: string) => invoke<SessionInfo[]>("claude_sessions_cached", { host }),
  running: (host: string) => invoke<RunningClaude[]>("claude_running", { host }),
  watch: () => invoke<void>("claude_watch"),
  unwatch: () => invoke<void>("claude_unwatch"),
  reveal: (path: string) => invoke<void>("claude_reveal", { path }),
  onChanged: (cb: () => void) => listen("claude://changed", cb),
};

interface HostData {
  sessions: SessionInfo[];
  running: RunningClaude[];
  loading: boolean;
  error: string | null;
  at: number;
}
/** Module-level cache so reopening the tool window is instant and actions can use it. */
export const claudeStore = createStore<{ hosts: Record<string, HostData> }>({ hosts: {} });

const EMPTY: HostData = { sessions: [], running: [], loading: false, error: null, at: 0 };
const inflight = new Map<string, Promise<void>>();
const primed = new Set<string>();
export function refreshHost(host: string): Promise<void> {
  const cur = inflight.get(host);
  if (cur) return cur;
  const set = (p: Partial<HostData>) =>
    claudeStore.set((s) => ({ hosts: { ...s.hosts, [host]: { ...(s.hosts[host] ?? EMPTY), ...p } } }));
  set({ loading: true });
  // First time this session: show the persisted list immediately, then refresh in the background.
  if (!primed.has(host)) {
    primed.add(host);
    claudeApi.sessionsCached(host).then((sessions) => {
      const cur = claudeStore.get().hosts[host];
      if (sessions.length && !(cur && cur.at > 0)) set({ sessions });
    }).catch(() => {});
  }
  const p = Promise.all([claudeApi.sessions(host), claudeApi.running(host).catch(() => [] as RunningClaude[])])
    .then(([sessions, running]) => set({ sessions, running, loading: false, error: null, at: Date.now() }))
    .catch((e) => set({ loading: false, error: String(e) }))
    .finally(() => inflight.delete(host));
  inflight.set(host, p);
  return p;
}

/** Session ids that are provably running: explicit --resume id, or the session being appended by a plain `claude`. */
export function runningIds(d: HostData | undefined): Set<string> {
  const out = new Set<string>();
  if (!d) return out;
  for (const r of d.running) {
    if (r.sessionId) out.add(r.sessionId);
    else if (r.activeSessionId) out.add(r.activeSessionId);
  }
  return out;
}

/** cwd -> number of running claude processes whose session we cannot identify. Never attributed to a session. */
export function unknownRunning(d: HostData | undefined): Map<string, number> {
  const m = new Map<string, number>();
  for (const r of d?.running ?? []) {
    if (!r.sessionId && !r.activeSessionId && r.cwd) m.set(r.cwd, (m.get(r.cwd) ?? 0) + 1);
  }
  return m;
}

const L = (s: { host: string }) => ({ host: s.host, login: true });
/** Start `claude ...` in a terminal tab and remember which session lives there (flip, badges, notifications). */
const start = (host: string, cwd: string, command: string, title: string, sessionId?: string) => {
  const tab = openTerminal({ ...L({ host }), cwd, command, title });
  registerLaunch(tab, { host, cwd, sessionId, title });
  return tab;
};
export const launch = {
  newSession: (host: string, cwd: string) => start(host, cwd, "claude", "Claude"),
  /** A session that already runs in an Ace terminal is focused instead of resumed twice. */
  resume: (s: SessionInfo) => (focusSessionTerminal(s.host, s.id) ? null : start(s.host, s.cwd, `claude --resume ${s.id}`, tabTitleFor(s.title), s.id)),
  fork: (s: SessionInfo) => start(s.host, s.cwd, `claude --resume ${s.id} --fork-session`, `Claude fork: ${s.title.slice(0, 20)}`),
  continueLast: (host: string, cwd: string) => start(host, cwd, "claude -c", "Claude (continue)"),
};

export const openSessionProject = (s: SessionInfo) => openProject({ host: s.host, path: s.cwd } as Location);

export const currentRoot = () => projectStore.get().root;

export function relTime(ms: number): string {
  const d = (Date.now() - ms) / 1000;
  if (d < 60) return "just now";
  if (d < 3600) return `${Math.floor(d / 60)}m ago`;
  if (d < 86400) return `${Math.floor(d / 3600)}h ago`;
  if (d < 86400 * 30) return `${Math.floor(d / 86400)}d ago`;
  return new Date(ms).toLocaleDateString();
}
