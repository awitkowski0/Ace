import { describe, expect, it } from "vitest";
import { basename, dirname, homeShorten, isAbsPath, isWithin, joinPath, relativeTo, toPosixPath } from "./paths";

describe("dirname / basename / joinPath, posix", () => {
  it("keeps the existing behaviour", () => {
    expect(dirname("/a/b/c")).toBe("/a/b");
    expect(dirname("/a")).toBe("/");
    expect(dirname("a")).toBe("/");
    expect(basename("/a/b/c.txt")).toBe("c.txt");
    expect(basename("c.txt")).toBe("c.txt");
    expect(joinPath("/a/b", "c")).toBe("/a/b/c");
    expect(joinPath("/", "c")).toBe("/c");
    expect(joinPath("/a/", "c")).toBe("/a/c");
  });
});

describe("dirname / basename / joinPath, Windows", () => {
  it("backslash paths", () => {
    expect(dirname("C:\\Users\\x\\proj")).toBe("C:\\Users\\x");
    expect(basename("C:\\Users\\x\\proj")).toBe("proj");
    expect(joinPath("C:\\Users\\x", "proj")).toBe("C:\\Users\\x\\proj");
  });
  it("drive roots", () => {
    expect(dirname("C:\\a")).toBe("C:\\");
    expect(dirname("C:/a")).toBe("C:/");
    expect(dirname("C:/")).toBe("C:/");
    expect(joinPath("C:/", "a")).toBe("C:/a");
    expect(joinPath("C:\\", "a")).toBe("C:\\a");
  });
  it("forward-slash Windows paths", () => {
    expect(dirname("C:/Users/x/proj")).toBe("C:/Users/x");
    expect(basename("C:/Users/x/proj/")).toBe("");
    expect(joinPath("C:/Users/x", "proj")).toBe("C:/Users/x/proj");
  });
  it("mixed separators use the last one", () => {
    expect(basename("C:/Users\\x\\proj")).toBe("proj");
    expect(dirname("C:/Users\\x\\proj")).toBe("C:/Users\\x");
  });
});

describe("toPosixPath / isAbsPath", () => {
  it("normalises drive and UNC paths only", () => {
    expect(toPosixPath("C:\\Users\\x")).toBe("C:/Users/x");
    expect(toPosixPath("\\\\srv\\share\\x")).toBe("//srv/share/x");
    expect(toPosixPath("/Users/a/b\\c")).toBe("/Users/a/b\\c");
  });
  it("recognises absolute paths of both kinds", () => {
    expect(isAbsPath("C:\\x")).toBe(true);
    expect(isAbsPath("c:/x")).toBe(true);
    expect(isAbsPath("/x")).toBe(true);
    expect(isAbsPath("x/y")).toBe(false);
    expect(isAbsPath("~/x")).toBe(false);
  });
});

describe("isWithin / relativeTo", () => {
  it("works with both separators and mixed case drive letters", () => {
    expect(isWithin("C:\\proj", "C:\\proj\\src\\a.ts")).toBe(true);
    expect(isWithin("C:/proj/", "C:\\proj\\src")).toBe(true);
    expect(isWithin("c:\\proj", "C:\\proj")).toBe(true);
    expect(isWithin("C:\\proj", "C:\\proj2\\a")).toBe(false);
    expect(isWithin("/a/b", "/a/b/c")).toBe(true);
    expect(isWithin("/a/b", "/a/bc")).toBe(false);
  });
  it("relative paths use forward slashes", () => {
    expect(relativeTo("C:\\proj", "C:\\proj\\src\\a.ts")).toBe("src/a.ts");
    expect(relativeTo("C:/proj", "C:/proj/a.ts")).toBe("a.ts");
    expect(relativeTo("/a/b", "/a/b/c/d")).toBe("c/d");
    expect(relativeTo("/a/b", "/x/y")).toBe("/x/y");
  });
});

describe("homeShorten", () => {
  it("shortens mac, linux and windows homes", () => {
    expect(homeShorten("/Users/alex/proj")).toBe("~/proj");
    expect(homeShorten("/home/alex/proj")).toBe("~/proj");
    expect(homeShorten("C:\\Users\\alex\\proj")).toBe("~/proj");
    expect(homeShorten("/Users/alex")).toBe("~");
    expect(homeShorten("/opt/x")).toBe("/opt/x");
  });
  it("uses an explicit home first", () => {
    expect(homeShorten("C:\\Users\\alex\\proj", "C:\\Users\\alex")).toBe("~/proj");
    expect(homeShorten("D:\\work\\x", "D:\\work")).toBe("~/x");
  });
});
