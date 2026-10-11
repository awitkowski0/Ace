/** Run configuration model shared by every config type (Python now, Gradle / Godot later). */
import type { ComponentType, ReactNode } from "react";
import type { Location } from "../../lib/ipc";
import type { RunSpec } from "../python/api";
import type { PythonDebugTarget } from "./hooks";
import type { Session } from "./sessions";

export type Mode = "run" | "debug";

/** A saved configuration. Everything besides these four keys is type specific (see ConfigType.fields). */
export interface RunConfig {
  id: string;
  type: string;
  name: string;
  /** created by ⌃⇧R / the gutter: italic, at most 5, promoted when saved through the Edit dialog */
  temporary?: boolean;
  [field: string]: unknown;
}

interface FieldBase {
  key: string;
  label: string;
  hint?: string;
  placeholder?: string;
  /** hide the field for some states of the config (e.g. "custom" target kind) */
  visible?: (cfg: RunConfig) => boolean;
}
export type FieldDef =
  | (FieldBase & { kind: "text" })
  | (FieldBase & { kind: "path"; dir?: boolean })
  | (FieldBase & { kind: "textarea"; rows?: number })
  /** KEY=VALUE rows, stored as [key, value][] */
  | (FieldBase & { kind: "env" })
  | (FieldBase & { kind: "checkbox" })
  | (FieldBase & { kind: "select"; options: { value: string; label: string }[] })
  /** Python interpreter: "" = project default, else an interpreter path */
  | (FieldBase & { kind: "interpreter" });

export interface ConfigCtx {
  root: Location;
}

/** What a config resolves to for one execution. */
export interface ResolvedRun {
  spec: RunSpec;
  /** short title used for the tab tooltip / debug session */
  title: string;
  /** first console line (PyCharm prints the interpreter + script command line) */
  commandLine: string;
  /** Debug mode: the program for the debugger (instead of `spec`) */
  debug?: PythonDebugTarget;
  /** The process speaks the Ace test protocol (`\x1e##ace:{json}` lines): the Run window shows the test tree */
  tests?: { kind: "pytest" | "unittest" | string };
  /** Other control events (anything that is not a test event) */
  onControl?: (ev: Record<string, unknown>, session: Session) => void;
  /** Extra side panel for the session (replaces the test tree) */
  panel?: ComponentType<{ session: Session }>;
  /** Notes printed in the console before the process starts (e.g. "pytest is not installed") */
  warnings?: string[];
  /** pytest is missing etc: the Run window offers an install hint with this package */
  missingPackage?: { name: string; message: string; detail: string; install(log: (text: string) => void): Promise<boolean> };
}

export interface ConfigType {
  id: string;
  label: string;
  icon: ReactNode;
  fields: FieldDef[];
  /** field values for a new configuration of this type */
  defaults(ctx: ConfigCtx): Record<string, unknown>;
  suggestName(cfg: RunConfig): string;
  resolve(cfg: RunConfig, mode: Mode, ctx: ConfigCtx): ResolvedRun | Promise<ResolvedRun>;
  /** string that identifies "the same" temporary configuration (default: all fields except id/name/temporary) */
  identity?(cfg: RunConfig): string;
  /** the type can be offered for this project (Python types only in Python projects) */
  available?(): boolean;
  /** why `cfg` cannot run (shown by the Edit dialog and when starting) */
  validate?(cfg: RunConfig): string | null;
  /** test types: a config that runs exactly these node ids (Rerun Failed Tests, "Run this test") */
  forTestNodes?(cfg: RunConfig, ids: string[]): RunConfig;
  /** sort position in the "Add New Configuration" menu */
  order?: number;
  /** whether Debug mode is supported */
  debuggable?: boolean;
}

/** Context from the editor for Run Context Configuration (⌃⇧R). */
export interface EditorContext {
  loc: Location;
  text: string;
  line: number;
  language: string;
}
export type ContextProvider = (ctx: EditorContext) => Omit<RunConfig, "id"> | null | Promise<Omit<RunConfig, "id"> | null>;
