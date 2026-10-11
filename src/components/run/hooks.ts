/**
 * Tiny cross-module hooks between the Run infrastructure (src/components/run/*) and the debugger (src/components/python/debug/*).
 * Kept dependency-free so neither side imports the other.
 */
import type { RunSpec } from "../python/api";

/** A Python program to start under debugpy (built by the Python config types from a run configuration). */
export interface PythonDebugTarget {
  kind: "python";
  host: string;
  cwd: string;
  python: string; // interpreter path
  program?: string; // script path
  module?: string; // python -m <module>
  args: string[];
  env: Record<string, string>;
  pathPrepend: string[];
  /** extra debugpy launch fields (justMyCode...) */
  extra?: Record<string, unknown>;
  /** a human title for the session tab ("main", "pytest in tests/") */
  title: string;
}
export interface DebugLaunchContext {
  /** Run-tool-window session id the debug session belongs to (output of the debuggee is mirrored there when it makes sense) */
  sessionId?: string;
  /** line to run to (Run to Cursor at start) */
  title: string;
}
export type DebugLauncher = (target: PythonDebugTarget, ctx: DebugLaunchContext) => Promise<void>;

let launcher: DebugLauncher | null = null;
/** The debugger registers itself here (src/components/python/debug/register). */
export const setDebugLauncher = (l: DebugLauncher | null) => { launcher = l; };
export const getDebugLauncher = () => launcher;
export type { RunSpec };

/** An editor-gutter run marker (`if __name__ == "__main__":`, test functions / classes). The Python run types provide them,
 * the debugger's gutter module draws them next to breakpoints and routes the click (run / debug menu). */
export interface RunMarker {
  line: number; // 1-based
  kind: "main" | "test" | "test-class";
  label: string; // "Run 'main'" / "Run 'test_add'"
  run(): void;
  debug(): void;
}
type MarkerProvider = (model: { getValue(): string; uri: { path: string } }) => RunMarker[];
let markers: MarkerProvider = () => [];
export const setRunMarkerProvider = (p: MarkerProvider) => { markers = p; };
export const getRunMarkers: MarkerProvider = (m) => markers(m);

/** Stop (⌘F2) registry: the Run window registers its sessions, the debugger its debug session. `stopFocused()` is what the Stop action calls:
 * the handler with the highest priority that `canStop()` wins (debug session first when the Debug window is the active one). */
export interface StopHandler { id: string; priority: number; canStop(): boolean; stop(): void | Promise<void> }
const stoppers = new Map<string, StopHandler>();
const stopSubs = new Set<() => void>();
/** Call whenever a handler's `canStop()` result may have changed (a session started / ended): the toolbar Stop button follows. */
export const notifyStopChanged = () => stopSubs.forEach((f) => f());
export const subscribeStop = (f: () => void) => { stopSubs.add(f); return () => { stopSubs.delete(f); }; };
export const registerStopHandler = (h: StopHandler) => { stoppers.set(h.id, h); notifyStopChanged(); };
export const canStopAny = () => [...stoppers.values()].some((h) => h.canStop());
export function stopCurrent(): boolean {
  const h = [...stoppers.values()].filter((x) => x.canStop()).sort((a, b) => b.priority - a.priority)[0];
  if (!h) return false;
  void h.stop();
  return true;
}
