import { describe, expect, it } from "vitest";
import { GodotOutputFilter, resToPath } from "./output";

function run(chunks: [("out" | "err"), string][]) {
  const probs: unknown[] = [];
  const f = new GodotOutputFilter((p) => probs.push(p));
  let out = "";
  const emit = (_k: "out" | "err", t: string) => { out += t; };
  for (const [k, t] of chunks) f.push(k, t, emit);
  f.end(emit);
  return { out, probs };
}
// eslint-disable-next-line no-control-regex
const plain = (s: string) => s.replace(/\x1b\[\d+m/g, "");

describe("godot output", () => {
  it("parse error blocks", () => {
    const { out, probs } = run([["err", 'SCRIPT ERROR: Parse Error: Identifier "u" not declared in the current scope.\n          at: GDScript::reload (res://tools/parse_err.gd:5)\nERROR: Failed to load script "res://tools/parse_err.gd" with error "Parse error".\n   at: load (modules/gdscript/gdscript_resource_format.cpp:46)\n']]);
    expect(probs).toEqual([
      { sev: 1, message: 'Parse Error: Identifier "u" not declared in the current scope.', res: "res://tools/parse_err.gd", line: 5, detail: "in GDScript::reload" },
      { sev: 1, message: 'Failed to load script "res://tools/parse_err.gd" with error "Parse error".', res: null, line: 1, detail: "in load" },
    ]);
    expect(out).toContain("\x1b[31mSCRIPT ERROR");
    expect(plain(out)).toContain("          at: GDScript::reload (res://tools/parse_err.gd:5)\n");
  });
  it("warning + error with backtrace location", () => {
    const { probs } = run([["err", "WARNING: careful now\n     at: push_warning (core/variant/variant_utility.cpp:1033)\n     GDScript backtrace (most recent call first):\n         [0] _init (res://tools/warn.gd:4)\nERROR: bad\n   at: push_error (core/x.cpp:1)\n   GDScript backtrace (most recent call first):\n       [0] _init (res://tools/warn.gd:5)\nplain\n"]]);
    expect(probs).toEqual([
      { sev: 2, message: "careful now", res: "res://tools/warn.gd", line: 4, detail: "in push_warning" },
      { sev: 1, message: "bad", res: "res://tools/warn.gd", line: 5, detail: "in push_error" },
    ]);
  });
  it("split chunks and stdout stays plain", () => {
    const { out, probs } = run([["out", "hel"], ["out", "lo\nworld\n"], ["err", "SCRIPT ERROR: x\n   at: f (res://a.gd:"], ["err", "7)\n"]]);
    expect(plain(out)).toBe("hello\nworld\nSCRIPT ERROR: x\n   at: f (res://a.gd:7)\n");
    expect(probs).toEqual([{ sev: 1, message: "x", res: "res://a.gd", line: 7, detail: "in f" }]);
  });
  it("res path mapping", () => { expect(resToPath("res://a/b.gd", "/p/")).toBe("/p/a/b.gd"); });
});
