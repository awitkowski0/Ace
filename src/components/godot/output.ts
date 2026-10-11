/**
 * Godot console output: colours ERROR / WARNING / SCRIPT ERROR / Parse Error blocks (Godot only colours them on a tty) and extracts them as
 * problems with their res:// location. Pure except for the optional flush timer. Used through ResolvedRun.output (run/types.ts).
 *
 * Block shapes (Godot 4.x, stderr):
 *   SCRIPT ERROR: Parse Error: Identifier "x" not declared in the current scope.
 *             at: GDScript::reload (res://tools/a.gd:5)
 *   ERROR: bad thing
 *      at: push_error (core/variant/variant_utility.cpp:1023)
 *      GDScript backtrace (most recent call first):
 *          [0] _init (res://tools/warn.gd:5)
 *   WARNING: careful now          (same continuation shape)
 */
import type { OutputFilter } from "../run/types";
import type { RunProblem } from "../run/problems";

const START = /^(SCRIPT ERROR|USER ERROR|ERROR|SCRIPT WARNING|USER WARNING|WARNING|Parse Error):\s?(.*)$/;
const LOC = /(res:\/\/[^\s:()]+\.[A-Za-z0-9]+):(\d+)/;
const AT = /^\s+at:\s+([^(]+?)\s*\(/;
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const RESET = "\x1b[0m";

export interface RawProblem { sev: 1 | 2; message: string; res: string | null; line: number; detail?: string }

interface Block { sev: 1 | 2; message: string; res: string | null; line: number; detail?: string }

/** res://a/b.gd -> <projectDir>/a/b.gd */
export const resToPath = (res: string, projectDir: string) => `${projectDir.replace(/\/$/, "")}/${res.replace(/^res:\/\//, "")}`;

export class GodotOutputFilter implements OutputFilter {
  private st: Record<"out" | "err", { buf: string; raw: boolean; block: Block | null; timer?: ReturnType<typeof setTimeout> }> = {
    out: { buf: "", raw: false, block: null },
    err: { buf: "", raw: false, block: null },
  };
  constructor(private onProblem: (p: RawProblem) => void) {}

  push(kind: "out" | "err", text: string, emit: (kind: "out" | "err", text: string) => void) {
    const s = this.st[kind];
    clearTimeout(s.timer);
    s.buf += text;
    let nl: number;
    while ((nl = s.buf.indexOf("\n")) >= 0) {
      const line = s.buf.slice(0, nl);
      s.buf = s.buf.slice(nl + 1);
      const had = s.raw;
      s.raw = false;
      emit(kind, had ? line + "\n" : this.line(kind, line.replace(/\r$/, "")) + "\n");
    }
    if (s.buf) {
      // a partial line is shown after a short pause (prompts, progress dots); its rest then passes through unclassified
      s.timer = setTimeout(() => { if (s.buf) { emit(kind, s.buf); s.buf = ""; s.raw = true; } }, 120);
    }
  }

  end(emit: (kind: "out" | "err", text: string) => void) {
    for (const kind of ["out", "err"] as const) {
      const s = this.st[kind];
      clearTimeout(s.timer);
      if (s.buf) { emit(kind, s.raw ? s.buf : this.line(kind, s.buf)); s.buf = ""; }
      this.finish(s);
    }
  }

  private finish(s: { block: Block | null }) {
    const b = s.block;
    s.block = null;
    if (b) this.onProblem({ sev: b.sev, message: b.message, res: b.res, line: b.line, detail: b.detail });
  }

  /** Classify one complete line; returns the text to show (colour wrapped when it belongs to an error / warning block). */
  line(kind: "out" | "err", line: string): string {
    const s = this.st[kind];
    if (s.block && /^\s{2,}\S/.test(line)) {
      const b = s.block;
      const at = AT.exec(line);
      if (at && !b.detail) b.detail = `in ${at[1]}`;
      if (!b.res) {
        const m = LOC.exec(line);
        if (m) { b.res = m[1]; b.line = +m[2]; }
      }
      return (b.sev === 1 ? RED : YELLOW) + line + RESET;
    }
    this.finish(s);
    const m = START.exec(line);
    if (!m) return line;
    const warn = /WARNING/.test(m[1]);
    const b: Block = { sev: warn ? 2 : 1, message: m[2].trim() || m[1], res: null, line: 1 };
    const inl = LOC.exec(m[2]);
    if (inl) { b.res = inl[1]; b.line = +inl[2]; }
    s.block = b;
    return (warn ? YELLOW : RED) + line + RESET;
  }
}

export function toRunProblem(p: RawProblem, projectDir: string, host: string): RunProblem {
  return { sev: p.sev, message: p.message, path: p.res ? resToPath(p.res, projectDir) : null, host, line: p.line, col: 1, detail: p.detail };
}
