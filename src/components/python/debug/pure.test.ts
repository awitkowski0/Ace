import { describe, expect, it } from "vitest";
import { dapBreakpoints, dapExceptionFilters, exitText, hoverExpression, inlineValues, parseAnsi, scopeStart, splitLinks, subRanges, type Bp } from "./pure";

describe("ansi", () => {
  it("splits colours and carries style", () => {
    const a = parseAnsi("a\x1b[31mred\x1b[0m plain \x1b[1;32mgreen");
    expect(a.spans.map((s) => [s.t, !!s.fg, !!s.bold])).toEqual([["a", false, false], ["red", true, false], [" plain ", false, false], ["green", true, true]]);
    const b = parseAnsi("more", a.st);
    expect(b.spans[0].bold).toBe(true);
  });
  it("drops other escapes", () => {
    expect(parseAnsi("x\x1b[2Ky\x1b]0;title\x07z").spans.map((s) => s.t).join("")).toBe("xyz");
  });
  it("256 and truecolor", () => {
    expect(parseAnsi("\x1b[38;5;196mx").spans[0].fg).toMatch(/^rgb/);
    expect(parseAnsi("\x1b[38;2;1;2;3mx").spans[0].fg).toBe("rgb(1,2,3)");
  });
});

describe("links", () => {
  it("finds traceback and path:line links", () => {
    const parts = splitLinks('  File "/a/b.py", line 12, in f\n  /x/y.py:7: error');
    const links = parts.filter((p) => p.path);
    expect(links.map((l) => [l.path, l.line])).toEqual([["/a/b.py", 12], ["/x/y.py", 7]]);
  });
  it("no links in plain text", () => expect(splitLinks("hello 12:30")).toEqual([{ t: "hello 12:30" }]));
});

describe("paging", () => {
  it("small is one range, big is subdivided", () => {
    expect(subRanges(0, 50)).toEqual([{ start: 0, len: 50 }]);
    expect(subRanges(0, 250).map((r) => r.len)).toEqual([100, 100, 50]);
    const big = subRanges(0, 10000);
    expect(big.length).toBe(10);
    expect(big[1]).toEqual({ start: 1000, len: 1000 });
  });
});

describe("inline values", () => {
  const src = ["def compute(n):", "    total = 0", "    for i in range(n):", "        total = add(total, i)  # total", "    return 's total'"];
  it("shows each used local once per line", () => {
    const r = inlineValues(src, 4, [{ name: "n", value: "5" }, { name: "total", value: "3" }, { name: "i", value: "3" }, { name: "add", value: "<function>", type: "function" }]);
    expect(r).toEqual([{ line: 1, text: "n = 5" }, { line: 2, text: "total = 3" }, { line: 3, text: "i = 3, n = 5" }, { line: 4, text: "total = 3, i = 3" }]);
  });
  it("scopeStart finds the def", () => expect(scopeStart(src, 4)).toBe(1));
});

describe("hover", () => {
  it("expands attribute chains left of the cursor word", () => {
    const l = "x = self.value.bit_length()";
    expect(hoverExpression(l, 14)?.expr).toBe("self.value");
    expect(hoverExpression(l, 6)?.expr).toBe("self");
    expect(hoverExpression("if x:", 2)).toBeNull();
    expect(hoverExpression("a = 12", 6)).toBeNull();
  });
});

describe("breakpoints", () => {
  const bp = (o: Partial<Bp>): Bp => ({ id: "x", path: "/a.py", line: 1, enabled: true, ...o });
  it("builds DAP breakpoints for one file", () => {
    const r = dapBreakpoints([bp({ line: 9, condition: " i == 3 " }), bp({ line: 2 }), bp({ line: 5, enabled: false }), bp({ path: "/b.py" }), bp({ line: 4, logMessage: "hi", hitCount: "2" })], "/a.py");
    expect(r).toEqual([{ line: 2 }, { line: 4, logMessage: "hi", hitCondition: "2" }, { line: 9, condition: "i == 3" }]);
  });
  it("exception filters honour support", () => {
    expect(dapExceptionFilters({ raised: true, uncaught: true, userUnhandled: true }, ["raised", "uncaught"])).toEqual(["raised", "uncaught"]);
  });
  it("exit text", () => {
    expect(exitText(0, null)).toBe("Process finished with exit code 0");
    expect(exitText(null, 15)).toBe("Process finished with exit code -15");
  });
});
