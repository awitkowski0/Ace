import { describe, expect, it } from "vitest";
import { copyName, freeName, isWithin, pasteTarget, relPath, sameSet, topLevel } from "./fileOps";

describe("copyName", () => {
  it("adds ' copy' before the extension, then numbers", () => {
    expect(copyName("a.txt", new Set(["a.txt"]))).toBe("a copy.txt");
    expect(copyName("a.txt", new Set(["a.txt", "a copy.txt"]))).toBe("a copy 2.txt");
    expect(copyName("a.txt", new Set(["a.txt", "a copy.txt", "a copy 2.txt"]))).toBe("a copy 3.txt");
  });
  it("duplicating a copy continues the sequence", () => {
    expect(copyName("a copy.txt", new Set(["a.txt", "a copy.txt"]))).toBe("a copy 2.txt");
    expect(copyName("a copy 2.txt", new Set(["a.txt", "a copy.txt", "a copy 2.txt"]))).toBe("a copy 3.txt");
  });
  it("handles folders, dotfiles, multi-dot and no extension", () => {
    expect(copyName("src.v2", new Set(), true)).toBe("src.v2 copy");
    expect(copyName(".env", new Set())).toBe(".env copy");
    expect(copyName("a.tar.gz", new Set())).toBe("a.tar copy.gz");
    expect(copyName("Makefile", new Set(["Makefile"]))).toBe("Makefile copy");
  });
  it("freeName keeps a free name", () => {
    expect(freeName("a.txt", new Set(["b"]))).toBe("a.txt");
    expect(freeName("a.txt", new Set(["a.txt"]))).toBe("a copy.txt");
  });
});

describe("paths", () => {
  it("isWithin", () => {
    expect(isWithin("/p/a", "/p/a")).toBe(true);
    expect(isWithin("/p/a", "/p/a/b/c")).toBe(true);
    expect(isWithin("/p/a", "/p/ab")).toBe(false);
    expect(isWithin("/", "/x")).toBe(true);
  });
  it("topLevel drops nested paths", () => {
    expect(topLevel(["/p/a", "/p/a/b", "/p/c"])).toEqual(["/p/a", "/p/c"]);
  });
  it("pasteTarget", () => {
    expect(pasteTarget({ path: "/p/d", isDir: true }, "/p")).toBe("/p/d");
    expect(pasteTarget({ path: "/p/d/f.ts", isDir: false }, "/p")).toBe("/p/d");
    expect(pasteTarget(undefined, "/p")).toBe("/p");
  });
  it("relPath", () => {
    expect(relPath("/p", "/p/src/a.ts")).toBe("src/a.ts");
    expect(relPath("/p/", "/p/a")).toBe("a");
    expect(relPath("/p", "/p")).toBe(".");
    expect(relPath("/p", "/q/a")).toBe("/q/a");
  });
  it("sameSet", () => {
    expect(sameSet(["a", "b"], ["b", "a"])).toBe(true);
    expect(sameSet(["a"], ["a", "b"])).toBe(false);
  });
});
