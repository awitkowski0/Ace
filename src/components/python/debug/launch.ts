/** Starting, restarting and stopping debug sessions (the glue between run configs, adapter choice, session and Debug window). */
import { showToolWindow } from "../../../lib/layout";
import type { DebugLaunchContext, PythonDebugTarget } from "../../run/hooks";
import { chooseAdapter, offerInstallDebugpy } from "./adapter";
import { loadBreakpoints } from "./bps";
import { DebugSession, debugStore, liveSessions } from "./session";

export interface StartOpts { replace?: DebugSession; quiet?: boolean }

/** Starts a debug session for `target`. Resolves with the session (or null when debugpy is missing: a notification offers the install). */
export async function startDebugSession(target: PythonDebugTarget, _ctx?: Partial<DebugLaunchContext>, o: StartOpts = {}): Promise<DebugSession | null> {
  await loadBreakpoints();
  const adapter = await chooseAdapter(target.host, target.python);
  if (!adapter) {
    offerInstallDebugpy(target.host, target.python, () => void startDebugSession(target, _ctx, o));
    return null;
  }
  const s = new DebugSession(target, adapter);
  debugStore.set((st) => {
    const i = o.replace ? st.sessions.indexOf(o.replace) : -1;
    const sessions = i >= 0 ? st.sessions.map((x, j) => (j === i ? s : x)) : [...st.sessions, s];
    return { sessions, activeId: s.id };
  });
  if (!o.quiet) showToolWindow("debug");
  await s.start();
  return s;
}

export async function rerunSession(s: DebugSession) {
  const target = s.target;
  await s.stop();
  return startDebugSession(target, undefined, { replace: s });
}

/** Closes a finished (or stops and closes a live) session tab. */
export async function closeSession(s: DebugSession) {
  await s.stop();
  debugStore.set((st) => {
    const sessions = st.sessions.filter((x) => x !== s);
    return { sessions, activeId: st.activeId === s.id ? sessions[sessions.length - 1]?.id ?? null : st.activeId };
  });
}

export async function stopAllSessions() {
  await Promise.all(liveSessions().map((s) => s.stop()));
}
