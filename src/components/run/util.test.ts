import { describe, expect, it } from "vitest";
import { envRecord, normPath, resolvePath, shellJoin, shellQuote, shellSplit } from "./util";

describe("shellSplit", () => {
  it("splits plain, quoted and escaped", () => {
    expect(shellSplit("a b  c")).toEqual(["a", "b", "c"]);
    expect(shellSplit(`--name "Alex W" 'x y' z\\ w`)).toEqual(["--name", "Alex W", "x y", "z w"]);
    expect(shellSplit(`"" ''`)).toEqual(["", ""]);
    expect(shellSplit("")).toEqual([]);
  });
  it("round trips", () => {
    const a = ["tests/test_a.py::T::t[1-2]", "it's", "a b", ""];
    expect(shellSplit(shellJoin(a))).toEqual(a);
    expect(shellQuote("plain/path.py")).toBe("plain/path.py");
  });
});
describe("paths", () => {
  it("normalises", () => {
    expect(normPath("/a/b/../c/./d//e")).toBe("/a/c/d/e");
    expect(resolvePath("/p", "x/../y.py")).toBe("/p/y.py");
    expect(resolvePath("/p", "/abs/z.py")).toBe("/abs/z.py");
  });
  it("env rows", () => {
    expect(envRecord([["A", "1"], ["", "x"], [" B ", "2=3"]])).toEqual({ A: "1", B: "2=3" });
  });
});
