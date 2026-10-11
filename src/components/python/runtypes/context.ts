/** Python source analysis for "Run context configuration" (⌃⇧R) and the editor gutter run markers. Pure (unit-tested). */
import { basename } from "../../../lib/ipc";
import { relPath } from "../../run/util";
import type { RunConfig } from "../../run/types";
import { dottedName } from "./pytest";

interface Entry { indent: number; kind: "class" | "def"; name: string; testCase: boolean; line: number }
export interface Scope {
  /** enclosing classes, outermost first */
  classes: Entry[];
  /** the test-level def (directly inside the innermost class / module) the caret is in */
  fn: Entry | null;
}

const CLASS_RE = /^(\s*)class\s+([A-Za-z_]\w*)\s*(?:\(([^)]*)\))?\s*:/;
const DEF_RE = /^(\s*)(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(/;
const indentOf = (s: string) => { let n = 0; for (const c of s) n += c === "\t" ? 4 : 1; return n; };

/** Class / def nesting at 1-based `line` (the line itself counts: a caret on a `def` line is inside it). */
export function scopeAt(text: string, line: number): Scope {
  const lines = text.split("\n");
  const stack: Entry[] = [];
  const end = Math.min(line, lines.length);
  for (let i = 0; i < end; i++) {
    const l = lines[i];
    if (!l.trim() || l.trim().startsWith("#")) continue;
    const ind = indentOf(/^\s*/.exec(l)![0]);
    while (stack.length && stack[stack.length - 1].indent >= ind) stack.pop();
    let m = CLASS_RE.exec(l);
    if (m) { stack.push({ indent: ind, kind: "class", name: m[2], testCase: /TestCase\b/.test(m[3] ?? ""), line: i + 1 }); continue; }
    m = DEF_RE.exec(l);
    if (m) stack.push({ indent: ind, kind: "def", name: m[2], testCase: false, line: i + 1 });
  }
  const classes = stack.filter((e) => e.kind === "class");
  const lastClassIdx = stack.map((e) => e.kind).lastIndexOf("class");
  const fn = stack.slice(lastClassIdx + 1).find((e) => e.kind === "def") ?? null;
  return { classes, fn };
}

export const isTestFileName = (path: string) => /^test_.*\.py$|_test\.py$/.test(basename(path));
const isTestClass = (c: Entry) => c.testCase || c.name.startsWith("Test");
const isTestFn = (f: Entry | null) => !!f && f.name.startsWith("test");
const testish = (path: string, text: string) => isTestFileName(path) || /^\s*(import|from)\s+(pytest|unittest)\b/m.test(text);

export interface PyTarget {
  kind: "script" | "test-file" | "test-class" | "test-fn";
  /** pytest node id parts after the file */
  chain: string[];
  unittestStyle: boolean;
}

/** What the caret points at. `force: "script"` makes it the file as a script regardless of its name (the `if __name__` marker). */
export function targetAt(path: string, text: string, line: number, force?: "script"): PyTarget {
  if (force === "script") return { kind: "script", chain: [], unittestStyle: false };
  const sc = scopeAt(text, line);
  const classes = sc.classes;
  const inTestClass = classes.length > 0 && isTestClass(classes[classes.length - 1]);
  const ut = classes.some((c) => c.testCase);
  if (isTestFn(sc.fn) && (classes.length === 0 ? testish(path, text) : inTestClass)) {
    return { kind: "test-fn", chain: [...classes.map((c) => c.name), sc.fn!.name], unittestStyle: ut };
  }
  if (classes.length && inTestClass) return { kind: "test-class", chain: classes.map((c) => c.name), unittestStyle: ut };
  if (isTestFileName(path)) return { kind: "test-file", chain: [], unittestStyle: /TestCase\b/.test(text) && !/^\s*import pytest|^\s*from pytest/m.test(text) };
  return { kind: "script", chain: [], unittestStyle: false };
}

export interface Opts { rootPath: string; hasPytest: boolean }

/** The configuration (without id) that runs `target` of the file at absolute `path`. */
export function configFor(path: string, target: PyTarget, o: Opts): Omit<RunConfig, "id"> {
  const rel = relPath(o.rootPath, path);
  const stem = basename(path).replace(/\.py$/, "");
  if (target.kind === "script") return { type: "python", name: stem, script: rel };
  const usePytest = o.hasPytest || !target.unittestStyle;
  const node = [rel, ...target.chain].join("::");
  if (usePytest) {
    const name = target.kind === "test-file" ? `pytest in ${basename(path)}` : `pytest for ${[stem, ...target.chain].join(".")}`;
    return { type: "pytest", name, targetKind: "path", target: node };
  }
  const name = target.kind === "test-file" ? `Unittests in ${basename(path)}` : `Unittests for ${[stem, ...target.chain].join(".")}`;
  return { type: "unittest", name, targetKind: "names", target: dottedName(node) };
}

export interface MarkerInfo { line: number; kind: "main" | "test" | "test-class"; target: PyTarget; force?: "script" }

/** Gutter markers: `if __name__ == "__main__":`, test classes, test functions / methods. */
export function computeMarkers(path: string, text: string): MarkerInfo[] {
  if (!path.endsWith(".py")) return [];
  const out: MarkerInfo[] = [];
  const lines = text.split("\n");
  const tf = testish(path, text);
  const stack: Entry[] = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (!l.trim() || l.trim().startsWith("#")) continue;
    if (/^if\s+__name__\s*==\s*["']__main__["']\s*:/.test(l)) { out.push({ line: i + 1, kind: "main", target: { kind: "script", chain: [], unittestStyle: false }, force: "script" }); continue; }
    const ind = indentOf(/^\s*/.exec(l)![0]);
    while (stack.length && stack[stack.length - 1].indent >= ind) stack.pop();
    let m = CLASS_RE.exec(l);
    if (m) {
      const e: Entry = { indent: ind, kind: "class", name: m[2], testCase: /TestCase\b/.test(m[3] ?? ""), line: i + 1 };
      stack.push(e);
      if (tf && isTestClass(e) && stack.filter((s) => s.kind === "class").every(isTestClass)) {
        out.push({ line: i + 1, kind: "test-class", target: { kind: "test-class", chain: stack.filter((s) => s.kind === "class").map((s) => s.name), unittestStyle: stack.some((s) => s.testCase) } });
      }
      continue;
    }
    m = DEF_RE.exec(l);
    if (m) {
      const e: Entry = { indent: ind, kind: "def", name: m[2], testCase: false, line: i + 1 };
      const parent = stack[stack.length - 1];
      stack.push(e);
      if (!e.name.startsWith("test")) continue;
      if (!parent && tf) out.push({ line: i + 1, kind: "test", target: { kind: "test-fn", chain: [e.name], unittestStyle: false } });
      else if (parent && parent.kind === "class" && isTestClass(parent) && stack.filter((s) => s.kind === "class").every(isTestClass)) {
        const chain = [...stack.filter((s) => s.kind === "class").map((s) => s.name), e.name];
        out.push({ line: i + 1, kind: "test", target: { kind: "test-fn", chain, unittestStyle: stack.some((s) => s.testCase) } });
      }
    }
  }
  return out;
}
