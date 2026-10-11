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
  it("gradle / kotlin / java compiler output", () => {
    expect(L("e: file:///tmp/p/src/Foo.kt:12:5 Unresolved reference")).toEqual([["file:///tmp/p/src/Foo.kt:12:5", "/tmp/p/src/Foo.kt", 12, 5]]);
    expect(L("/tmp/p/src/Foo.java:12: error: cannot find symbol")).toEqual([["/tmp/p/src/Foo.java:12", "/tmp/p/src/Foo.java", 12, 1]]);
    expect(L("Build file '/tmp/p/build.gradle' line: 7")).toEqual([["/tmp/p/build.gradle' line: 7", "/tmp/p/build.gradle", 7, 1]]);
  });
  it("godot res:// paths", () => {
    expect(L("   at: boom (res://tools/err.gd:13)")).toEqual([["res://tools/err.gd:13", "res://tools/err.gd", 13, 1]]);
    expect(L("res://scenes/main.tscn:7:3 x")).toEqual([["res://scenes/main.tscn:7:3", "res://scenes/main.tscn", 7, 3]]);
  });
  it("ignores urls and versions", () => {
    expect(L("see http://example.com:8080/x")).toEqual([]);
    expect(L("took 1.5:3")).toEqual([]);
    expect(L("nothing here")).toEqual([]);
  });
});
