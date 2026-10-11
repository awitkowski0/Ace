import { describe, expect, it } from "vitest";
import { applyOffsetEdits, textEdits } from "./diff";

const check = (a: string, b: string) => {
  const e = textEdits(a, b);
  expect(applyOffsetEdits(a, e)).toBe(b);
  return e;
};

describe("textEdits", () => {
  it("no change -> no edits", () => expect(textEdits("a\nb\n", "a\nb\n")).toEqual([]));
  it("single line tweak is character-minimal", () => {
    const e = check("x=1\ny=2\n", "x = 1\ny=2\n");
    expect(e.length).toBeLessThanOrEqual(2);
    expect(e.every((x) => x.end - x.start === 0 && x.text === " ")).toBe(true);
  });
  it("keeps untouched regions out of the edits", () => {
    const a = Array.from({ length: 50 }, (_, i) => `line${i}\n`).join("");
    const b = a.replace("line10\n", "line10 changed\n").replace("line40\n", "");
    const e = check(a, b);
    expect(e.length).toBe(2);
  });
  it("handles insertion, deletion, no trailing newline", () => {
    check("a\nb\nc", "a\nB\nc\nd");
    check("", "x\n");
    check("x\n", "");
    check("a\n\n\nb\n", "a\n\nb\n");
  });
  it("messy.py reformat", () => {
    const a = "import sys\nimport os\nfrom app.util import greet\nx=1\ndef f( a,b ):\n  return a+b\nprint(greet(\"x\"),x)\n";
    const b = "import sys\nimport os\nfrom app.util import greet\n\nx = 1\n\n\ndef f(a, b):\n    return a + b\n\n\nprint(greet(\"x\"), x)\n";
    const e = check(a, b);
    expect(e.length).toBeGreaterThanOrEqual(1);
  });
  it("unchanged tokens inside changed lines are not touched (caret stays)", () => {
    const a = "x=1\ndef f( a,b ):\n  return a+b\nprint(greet(\"x\"),x)\n";
    const b = "x = 1\n\n\ndef f(a, b):\n    return a + b\n\n\nprint(greet(\"x\"), x)\n";
    const e = check(a, b);
    const caret = a.indexOf("greet(") + 6; // right after "greet("
    expect(e.every((x) => x.end <= caret - 6 || x.start >= caret)).toBe(true);
  });
  it("random edits round trip", () => {
    let seed = 7;
    const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    for (let t = 0; t < 200; t++) {
      const a = Array.from({ length: Math.floor(rnd() * 30) }, () => `l${Math.floor(rnd() * 6)}\n`);
      const b = a.filter(() => rnd() > 0.2).flatMap((l) => (rnd() > 0.85 ? [l, `n${Math.floor(rnd() * 3)}\n`] : [l]));
      check(a.join(""), b.join(""));
    }
  });
});
