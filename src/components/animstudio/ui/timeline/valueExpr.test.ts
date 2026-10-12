import { describe, expect, it } from "vitest";
import { applyValueOp, describeOp, evalArithmetic, parseValueOp, scrubDelta } from "./valueExpr";

describe("evalArithmetic", () => {
  it("evaluates + - * / parentheses and unary minus", () => {
    expect(evalArithmetic("1+2*3")).toBe(7);
    expect(evalArithmetic("(1+2)*3")).toBe(9);
    expect(evalArithmetic("-4/8")).toBe(-0.5);
    expect(evalArithmetic("2*-3")).toBe(-6);
    expect(evalArithmetic(" 10 * 2 + 1 ")).toBe(21);
    expect(evalArithmetic(".5+.25")).toBe(0.75);
  });
  it("rejects anything that is not plain arithmetic (no eval)", () => {
    for (const bad of ["", "abc", "math.sin(1)", "1+", "(1", "1)", "1/0", "2**3", "alert(1)"]) expect(evalArithmetic(bad)).toBeNull();
  });
});

describe("parseValueOp", () => {
  it("plain numbers and arithmetic SET", () => {
    expect(parseValueOp("45", true)).toEqual({ kind: "set", value: 45 });
    expect(parseValueOp("10*2+1", true)).toEqual({ kind: "set", value: 21 });
    expect(parseValueOp("12.5", false)).toEqual({ kind: "set", value: 12.5 });
  });
  it("leading + / - is relative with several keys, absolute with one", () => {
    expect(parseValueOp("+5", true)).toEqual({ kind: "add", n: 5 });
    expect(parseValueOp("-10", true)).toEqual({ kind: "add", n: -10 });
    expect(parseValueOp("-10", false)).toEqual({ kind: "set", value: -10 });
    expect(parseValueOp("+5", false)).toEqual({ kind: "set", value: 5 });
    expect(parseValueOp("-2*3", true)).toEqual({ kind: "add", n: -6 });
  });
  it("* and / are relative; = forces set", () => {
    expect(parseValueOp("*1.5", true)).toEqual({ kind: "mul", n: 1.5 });
    expect(parseValueOp("/2", true)).toEqual({ kind: "mul", n: 0.5 });
    expect(parseValueOp("/0", true)).toBeUndefined();
    expect(parseValueOp("=-10", true)).toEqual({ kind: "set", value: -10 });
    expect(parseValueOp("=*2", true)).toBeUndefined();
  });
  it("molang stays a string; empty is ignored", () => {
    expect(parseValueOp("math.sin(query.anim_time*90)*5", true)).toEqual({ kind: "set", value: "math.sin(query.anim_time*90)*5" });
    expect(parseValueOp("  ", true)).toBeUndefined();
  });
});

describe("applyValueOp / describeOp / scrub", () => {
  it("applies per component", () => {
    expect(applyValueOp({ kind: "add", n: 10 }, 5)).toBe(15);
    expect(applyValueOp({ kind: "mul", n: 0.5 }, 5)).toBe(2.5);
    expect(applyValueOp({ kind: "set", value: 45 }, 5)).toBe(45);
    expect(applyValueOp({ kind: "add", n: -3 }, "q")).toBe("(q)-3");
  });
  it("describes which happens", () => {
    expect(describeOp(parseValueOp("45", true), "X", 3)).toBe("Set X to 45 on all 3 keys");
    expect(describeOp(parseValueOp("+10", true), "X", 3)).toMatch(/Offset X by \+10 \(each key keeps its own value\)/);
    expect(describeOp(undefined, "X", 3)).toBe("");
  });
  it("scrub delta scales with modifiers", () => {
    expect(scrubDelta(10, "rotation", {})).toBe(5);
    expect(scrubDelta(10, "rotation", { shift: true })).toBe(0.5);
    expect(scrubDelta(10, "scale", { alt: true })).toBe(1);
    expect(scrubDelta(-10, "position", {})).toBe(-1);
  });
});
