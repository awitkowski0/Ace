import { describe, expect, it } from "vitest";
import { findLinks } from "./links";

const L = (s: string) => findLinks(s).map((l) => [s.slice(l.start, l.end), l.path, l.line, l.col]);

describe("findLinks", () => {
  it("python traceback frames", () => {
    expect(L('  File "/tmp/p/crash.py", line 2, in boom')).toEqual([['/tmp/p/crash.py", line 2', "/tmp/p/crash.py", 2, 1]]);
  });
  it("path:line[:col]", () => {
    expect(L("tests/test_math.py:9: AssertionError")).toEqual([["tests/test_math.py:9", "tests/test_math.py", 9, 1]]);
    expect(L("src/a/b.rs:10:5: error")).toEqual([["src/a/b.rs:10:5", "src/a/b.rs", 10, 5]]);
    expect(L("./x.py:3 and /abs/y.py:4")).toEqual([["./x.py:3", "./x.py", 3, 1], ["/abs/y.py:4", "/abs/y.py", 4, 1]]);
  });
  it("ignores urls and versions", () => {
    expect(L("see http://example.com:8080/x")).toEqual([]);
    expect(L("took 1.5:3")).toEqual([]);
    expect(L("nothing here")).toEqual([]);
  });
});
