import { describe, expect, it } from "vitest";
import { applyCr, parseAnsi, stripAnsi } from "./ansi";
import { Splitter } from "./stream";
import { findLinks, resolveLinkPath } from "./links";
import { codeToExecute, dedent, statementAt } from "./selection";

describe("ansi", () => {
  it("parses SGR colours", () => {
    const s = parseAnsi("a\x1b[31mred\x1b[0m b\x1b[1;32mgo\x1b[m");
    expect(s.map((x) => x.text)).toEqual(["a", "red", " b", "go"]);
    expect(s[1].fg).toContain("nord11");
    expect(s[3].bold).toBe(true);
  });
  it("handles 256 and truecolor and strips other escapes", () => {
    const s = parseAnsi("\x1b[38;5;196mx\x1b[38;2;1;2;3my\x1b[2Kz");
    expect(s[0].fg).toBe("rgb(255,0,0)");
    expect(s[1].fg).toBe("rgb(1,2,3)");
    expect(stripAnsi("\x1b[31ma\x1b[0m")).toBe("a");
  });
  it("applies carriage returns", () => {
    expect(applyCr("", "abc\rXY")).toBe("XYc");
    expect(applyCr("10%\r", "20%")).toBe("20%");
    expect(applyCr("a\r", "\nb")).toBe("a\nb");
    expect(applyCr("", "x\r\ny")).toBe("x\ny");
  });
});

describe("splitter", () => {
  const M = "\x1e##ace:";
  it("separates events from text, across chunks", () => {
    const sp = new Splitter();
    const a = sp.push({ s: "out", d: `hi\n${M}{"k":"re` });
    expect(a).toEqual([{ t: "text", err: false, d: "hi\n" }]);
    const b = sp.push({ s: "out", d: `ady"}\nmore` });
    expect(b[0]).toEqual({ t: "ev", ev: { k: "ready" } });
    expect(b[1]).toEqual({ t: "text", err: false, d: "more" });
  });
  it("event after a partial line", () => {
    const sp = new Splitter();
    const r = sp.push({ s: "out", d: `x${M}{"k":"done","id":1}\n` });
    expect(r.map((i) => i.t)).toEqual(["text", "ev"]);
  });
  it("lone control char is text", () => {
    const sp = new Splitter();
    expect(sp.push({ s: "out", d: "a\x1eb\n" }).map((i) => (i.t === "text" ? i.d : "ev")).join("")).toBe("a\x1eb\n".replace("\x1e", "\x1e"));
  });
  it("err passes through", () => {
    expect(new Splitter().push({ s: "err", d: "boom" })).toEqual([{ t: "text", err: true, d: "boom" }]);
  });
});

describe("links", () => {
  it("finds CPython frames", () => {
    const l = findLinks('  File "/a/b/x.py", line 12, in <module>');
    expect(l).toHaveLength(1);
    expect(l[0]).toMatchObject({ path: "/a/b/x.py", line: 12 });
    expect('  File "/a/b/x.py", line 12, in <module>'.slice(l[0].start, l[0].end)).toBe('"/a/b/x.py", line 12');
  });
  it("skips <console>", () => expect(findLinks('  File "<console>", line 1, in <module>')).toEqual([]));
  it("finds IPython frames", () => {
    const l = findLinks("File /tmp/p/crash.py:5, in boom(x)");
    expect(l[0]).toMatchObject({ path: "/tmp/p/crash.py", line: 5 });
    expect(findLinks("File ~/x.py:3, in f()")[0].path).toBe("~/x.py");
  });
  it("resolves", () => {
    expect(resolveLinkPath("app/x.py", "/p")).toBe("/p/app/x.py");
    expect(resolveLinkPath("./a/../b.py", "/p/")).toBe("/p/b.py");
    expect(resolveLinkPath("~/x.py", "/p")).toBeNull();
  });
});

describe("selection", () => {
  const src = [
    "import os", // 0
    "", // 1
    "@deco", // 2
    "def f(a,", // 3
    "      b):", // 4
    "    if a:", // 5
    "        return 1", // 6
    "    else:", // 7
    "        return 2", // 8
    "", // 9
    "x = [1,", // 10
    "     2]", // 11
    "for i in range(3):", // 12
    "    print(i)", // 13
    "else:", // 14
    "    print('done')", // 15
    "s = '''a", // 16
    "b'''", // 17
    "# note", // 18
    "y = 1", // 19
  ];
  it("single line", () => expect(statementAt(src, 0)).toEqual({ start: 0, end: 0 }));
  it("blank/comment -> null", () => { expect(statementAt(src, 1)).toBeNull(); expect(statementAt(src, 18)).toBeNull(); });
  it("decorated def with multi-line header and inner else", () => {
    expect(statementAt(src, 2)).toEqual({ start: 2, end: 8 });
    expect(statementAt(src, 4)).toEqual({ start: 3, end: 8 });
  });
  it("inner statement only", () => expect(statementAt(src, 6)).toEqual({ start: 6, end: 6 }));
  it("inner if block inside def", () => expect(statementAt(src, 5)).toEqual({ start: 5, end: 8 }));
  it("bracket continuation", () => expect(statementAt(src, 11)).toEqual({ start: 10, end: 11 }));
  it("for/else", () => expect(statementAt(src, 12)).toEqual({ start: 12, end: 15 }));
  it("triple string", () => expect(statementAt(src, 17)).toEqual({ start: 16, end: 17 }));
  it("dedents", () => {
    expect(dedent("    a\n      b\n\n    c")).toBe("a\n  b\n\nc");
    expect(codeToExecute(src, "", 6)).toBe("return 1");
    expect(codeToExecute(src, "  x = 1\n  y = 2\n", 0)).toBe("x = 1\ny = 2");
    expect(codeToExecute(src, "", 1)).toBeNull();
  });
});
