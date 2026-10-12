/**
 * Number-field expressions for the keyframe inspector (Blockbench number inputs evaluate math; with several keys selected a
 * leading operator means "relative to each key's own value"). Pure, unit-tested.
 *
 *   45        set every selected key to 45          10*2+1  set to 21        math.sin(..)  set to the molang string
 *   +5  -10   add to each key's value               *1.5  /2   scale each key's value      =-10   set to -10 (forces "set")
 */
import { addToComp, mulComp, type Comp } from "../../core";

export type ValueOp = { kind: "set"; value: Comp } | { kind: "add"; n: number } | { kind: "mul"; n: number };

/** Evaluate a pure arithmetic expression (+ - * / parentheses, unary minus, decimals). null when it is anything else. */
export function evalArithmetic(src: string): number | null {
  const s = src.replace(/\s+/g, "");
  if (!s || !/^[0-9+\-*/().]+$/.test(s)) return null;
  let i = 0;
  const peek = () => s[i];
  const expr = (): number => { let v = term(); while (peek() === "+" || peek() === "-") { const o = s[i++]; const r = term(); v = o === "+" ? v + r : v - r; } return v; };
  const term = (): number => { let v = unary(); while (peek() === "*" || peek() === "/") { const o = s[i++]; const r = unary(); v = o === "*" ? v * r : v / r; } return v; };
  const unary = (): number => {
    if (peek() === "-") { i++; return -unary(); }
    if (peek() === "+") { i++; return unary(); }
    if (peek() === "(") { i++; const v = expr(); if (peek() !== ")") throw new Error("paren"); i++; return v; }
    const m = /^[0-9]*\.?[0-9]+(?:\.)?|^[0-9]+\./.exec(s.slice(i));
    if (!m) throw new Error("num");
    i += m[0].length;
    return Number(m[0]);
  };
  try {
    const v = expr();
    return i === s.length && Number.isFinite(v) ? v : null;
  } catch { return null; }
}

/**
 * Parse what was typed into a value field. `many` = more than one key of this channel is selected: only then a leading `+`/`-`
 * is relative (with one key `-10` simply sets -10, like every number field). `*` and `/` are always relative; `=` always sets.
 * Returns undefined for empty / invalid input.
 */
export function parseValueOp(text: string, many: boolean): ValueOp | undefined {
  const t = text.trim();
  if (!t) return undefined;
  if (t[0] === "=") { const r = parseValueOp(t.slice(1).trim(), false); return r?.kind === "set" ? r : undefined; }
  if (t[0] === "*" || t[0] === "/") {
    const n = evalArithmetic(t.slice(1));
    if (n === null || (t[0] === "/" && n === 0)) return undefined;
    return { kind: "mul", n: t[0] === "*" ? n : 1 / n };
  }
  if (many && (t[0] === "+" || t[0] === "-")) {
    const n = evalArithmetic(t);
    if (n !== null) return { kind: "add", n };
  }
  const n = evalArithmetic(t);
  if (n !== null) return { kind: "set", value: Math.round(n * 1e6) / 1e6 };
  return { kind: "set", value: t }; // molang
}

/** Apply a parsed op to one component. */
export function applyValueOp(op: ValueOp, c: Comp): Comp {
  if (op.kind === "set") return op.value;
  return op.kind === "add" ? addToComp(c, op.n) : mulComp(c, op.n);
}

const fmt = (n: number) => String(+n.toFixed(4));
/** One-line description shown under the field while typing ("Set X to 45 on 3 keys" / "Add +10 to X of each key"). */
export function describeOp(op: ValueOp | undefined, axisName: string, count: number): string {
  if (!op) return "";
  const keys = count === 1 ? "the key" : `all ${count} keys`;
  if (op.kind === "set") return `Set ${axisName} to ${typeof op.value === "number" ? fmt(op.value) : op.value} on ${keys}`;
  if (op.kind === "add") return `Offset ${axisName} by ${op.n >= 0 ? "+" : ""}${fmt(op.n)} (each key keeps its own value)`;
  return `Multiply ${axisName} by ${fmt(op.n)} (each key keeps its own value)`;
}

/** Scrub step per pixel for a channel (Shift = fine x0.1, Alt/Ctrl = coarse x10). */
export const scrubStep = (channel: "rotation" | "position" | "scale") => (channel === "rotation" ? 0.5 : channel === "position" ? 0.1 : 0.01);
export const scrubDelta = (dx: number, channel: "rotation" | "position" | "scale", mods: { shift?: boolean; alt?: boolean; ctrl?: boolean }) =>
  Math.round(dx * scrubStep(channel) * (mods.shift ? 0.1 : mods.alt || mods.ctrl ? 10 : 1) * 1e4) / 1e4;
