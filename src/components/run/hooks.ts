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
/** A Godot game under the remote debugger (Ace is the debug server; see godot/dapShim.ts). `argv` is the full Godot command line
 * WITHOUT the `--remote-debug` / `--breakpoints` flags (the debug client adds them). */
export interface GodotDebugTarget {
  kind: "godot";
  host: string;
  cwd: string;
  /** project directory (res:// maps here) */
  projectDir: string;
  argv: string[];
  env: Record<string, string>;
  pathPrepend: string[];
  title: string;
}
export type DebugTarget = PythonDebugTarget | GodotDebugTarget;
export interface DebugLaunchContext {
  /** Run-tool-window session id the debug session belongs to (output of the debuggee is mirrored there when it makes sense) */
  sessionId?: string;
  /** line to run to (Run to Cursor at start) */
  title: string;
}
/** A Gradle run whose JavaExec JVMs carry a JDWP agent (built by the gradle config type in Debug mode). */
export interface JavaDebugTarget {
  kind: "java";
  host: string;
  cwd: string;
  /** loopback port of the agent (`address=127.0.0.1:<port>`) */
  port: number;
  title: string;
  /** generated init script (removed when the session ends) */
  initScript: string;
  enhanced: boolean;
  /** console note (e.g. Enhanced HotSwap requested but no JetBrains Runtime installed) */
  note?: string | null;
}
export type JavaDebugLauncher = (target: JavaDebugTarget, run: import("./sessions").Session, cfg: import("./types").RunConfig) => Promise<void>;
let javaLauncher: JavaDebugLauncher | null = null;
export const setJavaDebugLauncher = (l: JavaDebugLauncher | null) => { javaLauncher = l; };
export const getJavaDebugLauncher = () => javaLauncher;
export type DebugLauncher = (target: DebugTarget, ctx: DebugLaunchContext) => Promise<void>;

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

/** Extra entries in the toolbar widget's configuration dropdown (Gradle: pinned tasks). `run` starts something. */
export interface WidgetItem { id: string; label: string; title?: string; run(): void; /** picking the item in the dropdown only selects it (temporary config) so ▶ / ⌃R runs it; default = run() */ select?(): void }
type WidgetItemProvider = () => WidgetItem[];
const widgetProviders = new Map<string, WidgetItemProvider>();
const widgetSubs = new Set<() => void>();
export const registerWidgetItems = (id: string, p: WidgetItemProvider) => { widgetProviders.set(id, p); widgetSubs.forEach((f) => f()); };
export const notifyWidgetItems = () => widgetSubs.forEach((f) => f());
export const subscribeWidgetItems = (f: () => void) => { widgetSubs.add(f); return () => { widgetSubs.delete(f); }; };
export const widgetItems = (): WidgetItem[] => [...widgetProviders.values()].flatMap((p) => p());

/** Editor languages (besides python) whose files take line breakpoints / execution marks / hover evaluation. */
const dbgLangs = new Set<string>();
const dbgLangSubs = new Set<() => void>();
export const enableDebugLanguage = (id: string) => { if (!dbgLangs.has(id)) { dbgLangs.add(id); dbgLangSubs.forEach((f) => f()); } };
export const debugLanguages = (): string[] => [...dbgLangs];
export const isDebugLanguage = (id: string) => dbgLangs.has(id);
export const subscribeDebugLanguages = (f: () => void) => { dbgLangSubs.add(f); return () => { dbgLangSubs.delete(f); }; };
