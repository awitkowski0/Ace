/** Command lines and output parsing for ruff / black / isort and the pyright `workspace/configuration` answers. Pure (unit-tested). */
import type { Diag, DiagFix } from "../../../editor/lsp/state";
import type { Tools } from "../api";

export type FormatterKind = "ruff" | "black";
export interface Formatter { kind: FormatterKind; bin: string }

/** ruff first, then black (both come from `pyStore.tools`: the interpreter's bin dir wins, then the login PATH). */
export function pickFormatter(tools: Tools): Formatter | null {
  if (tools.ruff) return { kind: "ruff", bin: tools.ruff };
  if (tools.black) return { kind: "black", bin: tools.black };
  return null;
}
/** 1-based inclusive line range (+ columns for ruff) */
export interface FmtRange { l1: number; c1: number; l2: number; c2: number }

export function formatArgv(f: Formatter, file: string, range?: FmtRange): string[] {
  if (f.kind === "ruff") return [f.bin, "format", ...(range ? ["--range", `${range.l1}:${range.c1}-${range.l2}:${range.c2}`] : []), "--stdin-filename", file, "-"];
  return [f.bin, "-q", "--stdin-filename", file, ...(range ? ["--line-ranges", `${range.l1}-${range.l2}`] : []), "-"];
}

/** Optimize Imports: ruff (sort + drop unused) else isort (sort only). */
export function optimizeArgv(tools: Tools, file: string): { argv: string[]; tool: "ruff" | "isort" } | null {
  if (tools.ruff) return { tool: "ruff", argv: [tools.ruff, "check", "--select", "I,F401", "--fix", "--exit-zero", "--quiet", "--stdin-filename", file, "-"] };
  if (tools.isort) return { tool: "isort", argv: [tools.isort, "--filename", file, "-"] };
  return null;
}
export const ruffCheckArgv = (ruff: string, file: string) => [ruff, "check", "--output-format=json", "--exit-zero", "--stdin-filename", file, "-"];

interface RuffPos { row: number; column: number }
interface RuffJson {
  code: string | null; message: string; url?: string; location: RuffPos; end_location: RuffPos;
  fix?: { applicability?: string; message?: string | null; edits: { content: string; location: RuffPos; end_location: RuffPos }[] } | null;
}
const pos = (p: RuffPos) => ({ line: Math.max(0, p.row - 1), character: Math.max(0, p.column - 1) });

/** Rules that are real problems (errors); everything else ruff reports is a warning. */
const ERROR_CODES = /^(E9\d\d|F63\d|F7\d\d|F82\d)$/;

export function parseRuff(stdout: string, path: string): Diag[] | null {
  let arr: RuffJson[];
  try { arr = JSON.parse(stdout); } catch { return null; }
  if (!Array.isArray(arr)) return null;
  return arr.map((r) => {
    const fix: DiagFix | undefined = r.fix?.edits?.length
      ? { title: (r.fix.message || `Fix ${r.code ?? "issue"}`).replace(/^./, (c) => c.toUpperCase()), edits: r.fix.edits.map((e) => ({ range: { start: pos(e.location), end: pos(e.end_location) }, newText: e.content })) }
      : undefined;
    return {
      uri: path, range: { start: pos(r.location), end: pos(r.end_location ?? r.location) },
      severity: !r.code || ERROR_CODES.test(r.code) ? 1 : 2, message: r.message, source: "ruff", code: r.code ?? undefined, owner: "ruff", fix,
    } as Diag;
  });
}

// ---- pyright / basedpyright workspace/configuration ----
export interface PyConfigInput { pythonPath: string | null; envRoot?: string | null }
export const ANALYSIS = { autoSearchPaths: true, useLibraryCodeForTypes: true, diagnosticMode: "openFilesOnly", typeCheckingMode: "standard", autoImportCompletions: true } as const;

/** Answer for one requested `section` (null = unknown section). `venvPath`/`venv` are only set when the env lives in a named directory. */
export function pythonSettings(section: string | undefined, c: PyConfigInput): unknown {
  switch (section) {
    case "python": return { pythonPath: c.pythonPath ?? undefined, ...(c.envRoot ? venvFields(c.envRoot) : {}), analysis: { ...ANALYSIS } };
    case "python.analysis":
    case "basedpyright.analysis":
    case "pyright.analysis": return { ...ANALYSIS };
    case "pyright": return { disableLanguageServices: false, disableOrganizeImports: true };
    case "basedpyright": return { disableLanguageServices: false, disableOrganizeImports: true, analysis: { ...ANALYSIS } };
    default: return null;
  }
}
function venvFields(envRoot: string): Record<string, string> {
  const i = envRoot.replace(/\/+$/, "").lastIndexOf("/");
  return i > 0 ? { venvPath: envRoot.slice(0, i), venv: envRoot.slice(i + 1).replace(/\/+$/, "") } : {};
}

/** The command shown in the "Install basedpyright" confirmation. */
export function installPlan(tools: Tools, python: string | null): { primary: string[] | null; alt: string[] | null } {
  const primary = tools.uv ? [tools.uv, "tool", "install", "basedpyright"] : tools.pipx ? [tools.pipx, "install", "basedpyright"] : null;
  const alt = python ? (tools.uv ? [tools.uv, "pip", "install", "--python", python, "basedpyright"] : [python, "-m", "pip", "install", "basedpyright"]) : null;
  return { primary, alt };
}
export const shellLine = (argv: string[]) => argv.map((a) => (/^[\w@%+=:,./~-]+$/.test(a) ? a : `'${a.replace(/'/g, "'\\''")}'`)).join(" ");
