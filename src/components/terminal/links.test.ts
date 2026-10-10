import { describe, expect, it } from "vitest";
import { findPaths, normalizePath, resolvePath } from "./links";

const raws = (s: string) => findPaths(s).map((m) => [m.raw, m.line, m.col]);

describe("terminal file links", () => {
  it("finds file:line:col", () => {
    expect(raws("error in src/foo.ts:12:3 something")).toEqual([["src/foo.ts", 12, 3]]);
    expect(raws("  at ./a/b.rs:7")).toEqual([["./a/b.rs", 7, undefined]]);
    expect(raws("main.go:40:2: undefined")).toEqual([["main.go", 40, 2]]);
  });
  it("finds Godot res:// paths", () => {
    expect(raws("E 0:00:01   _ready: Invalid (res://scripts/player.gd:40)")).toEqual([["res://scripts/player.gd", 40, undefined]]);
  });
  it("finds python traceback paths", () => {
    expect(raws('  File "/home/a/x.py", line 31, in <module>')).toEqual([["/home/a/x.py", 31, undefined]]);
  });
  it("ignores URLs, versions and prose", () => {
    expect(raws("see https://example.com/a/b.html for 1.2.3 e.g. this")).toEqual([]);
  });
  it("resolves against cwd, project root and ~", () => {
    expect(normalizePath("/a/b/../c/./d")).toBe("/a/c/d");
    expect(resolvePath("src/foo.ts", "/work/proj", null, "local")).toBe("/work/proj/src/foo.ts");
    expect(resolvePath("../x.ts", "/work/proj", null, "local")).toBe("/work/x.ts");
    expect(resolvePath("res://a/b.gd", "/anywhere", { host: "local", path: "/p/game" }, "local")).toBe("/p/game/a/b.gd");
    expect(resolvePath("res://a/b.gd", "/anywhere", { host: "mc", path: "/p/game" }, "local")).toBeNull();
    expect(resolvePath("~/n.txt", "/x", null, "local", "/Users/a")).toBe("/Users/a/n.txt");
  });
});
