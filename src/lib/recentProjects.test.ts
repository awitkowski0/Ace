import { describe, expect, it } from "vitest";
import { fuzzy } from "../components/search/fuzzy";
import { matchName, dedupe, groupWorktrees, initials, isGroup, isTransient, mainRepoFromGitFile, normalizePath, recentKey, tileColor, TILE_COLORS, abbrevPath } from "./recentProjects";

const L = (path: string, host = "local") => ({ host, path });

describe("transient paths", () => {
  it("flags temp/scratch folders (local only)", () => {
    for (const p of ["/private/var/folders/ab/xyz/T/atelier-qa-1/proj", "/var/folders/x/T/foo", "/tmp/foo", "/private/tmp/a", "/Users/a/p/.claude/worktrees/fix-1", "/Users/a/x/atelier-mp-123/proj-a", "/private/tmp/claude-501/-Users-a/scratchpad"])
      expect(isTransient(L(p)), p).toBe(true);
    for (const p of ["/Users/a/IdeaProjects/Ace", "/Users/a/tmpfiles/app", "/Users/a/thematic-kyf"]) expect(isTransient(L(p)), p).toBe(false);
    expect(isTransient(L("/tmp/x", "mc"))).toBe(false);
  });
  it("honours an explicit TMPDIR", () => {
    expect(isTransient(L("/Volumes/ram/t/app"), ["/Volumes/ram/t/"])).toBe(true);
    expect(isTransient(L("/Volumes/ram/tx/app"), ["/Volumes/ram/t"])).toBe(false);
  });
});

describe("dedupe", () => {
  it("normalizes slashes / private prefix and keeps the first", () => {
    expect(normalizePath("/Users/a//b/./c/")).toBe("/Users/a/b/c");
    const out = dedupe([L("/Users/a/App"), L("/Users/a/App/"), L("/Users/a/Other"), L("/Users/a//App"), L("/App", "mc"), L("/App", "mc"), L("/App", "other")]);
    expect(out.map((l) => l.host + l.path)).toEqual(["local/Users/a/App", "local/Users/a/Other", "mc/App", "other/App"]);
  });
  it("strips trailing slashes from the kept entry", () => {
    expect(dedupe([L("/Users/a/App/")])[0].path).toBe("/Users/a/App");
  });
  it("drops transient entries", () => {
    expect(dedupe([L("/tmp/a"), L("/Users/a/x")]).length).toBe(1);
  });
});

describe("initials & colour", () => {
  it("makes IntelliJ-style tile text", () => {
    expect(initials("Thematic-Collections")).toBe("TC");
    expect(initials("HeirloomSite")).toBe("HS");
    expect(initials("Ace")).toBe("Ac");
    expect(initials("thematic-kyf")).toBe("TK");
    expect(initials("x")).toBe("X");
    expect(initials("my_cool_app")).toBe("MC");
    expect(initials("...")).toBe("..");
  });
  it("colour is stable and from the palette", () => {
    const c = tileColor("local:/Users/a/Ace");
    expect(c).toBe(tileColor("local:/Users/a/Ace"));
    expect(TILE_COLORS).toContain(c);
    expect(new Set(["a", "b", "c", "d", "e", "f", "g"].map(tileColor)).size).toBeGreaterThan(2);
  });
  it("abbreviates the home dir", () => {
    expect(abbrevPath(L("/Users/a/x/y"))).toBe("~/x/y".replace("~", "~"));
    expect(abbrevPath(L("/home/q/p", "mc"))).toBe("mc:/home/q/p");
    expect(abbrevPath(L("/opt/h/p"), "/opt/h")).toBe("~/p");
  });
});

describe("worktree grouping", () => {
  const D = "/Users/a/IdeaProjects";
  const list = [L(`${D}/Thematic-Collections-spidey`), L(`${D}/thematic-kyf`), L(`${D}/Thematic-Collections`), L(`${D}/Thematic-Collections-guide-tablet`), L(`${D}/Ace`), L("/home/a/app", "mc")];
  it("parses worktree .git files", () => {
    expect(mainRepoFromGitFile("gitdir: /Users/a/IdeaProjects/Thematic-Collections/.git/worktrees/spidey\n")).toBe(`${D}/Thematic-Collections`);
    expect(mainRepoFromGitFile("gitdir: ../.git/modules/x")).toBeNull();
  });
  it("groups by declared main repo", () => {
    const main = `${D}/Thematic-Collections`;
    const g = groupWorktrees(list, { [recentKey(list[0])]: main, [recentKey(list[3])]: main, [recentKey(list[2])]: null });
    expect(g.length).toBe(4);
    const grp = g[0];
    expect(isGroup(grp) && grp.main.name).toBe("Thematic-Collections");
    expect(isGroup(grp) && grp.members.map((m) => m.name)).toEqual(["Thematic-Collections-spidey", "Thematic-Collections-guide-tablet"]);
  });
  it("falls back to the folder-name prefix", () => {
    const g = groupWorktrees(list);
    const grp = g.find(isGroup)!;
    expect(grp.main.name).toBe("Thematic-Collections");
    expect(grp.members.length).toBe(2);
    expect(g.filter((x) => !isGroup(x)).length).toBe(3);
  });
  it("does not group when the main repo is not listed, or across remotes", () => {
    const g = groupWorktrees([L(`${D}/Foo-a`), L(`${D}/Foo-b`), L("/x/Bar", "mc"), L("/x/Bar-z", "mc")]);
    expect(g.some(isGroup)).toBe(false);
  });
  it("a declared standalone repo is never grouped by name", () => {
    const a = L(`${D}/Ace`), b = L(`${D}/Ace-docs`);
    expect(groupWorktrees([a, b], { [recentKey(b)]: null }).some(isGroup)).toBe(false);
  });
});

describe("matchName", () => {
  const f = fuzzy;
  it("accepts substrings and hump abbreviations, rejects scattered letters", () => {
    expect(matchName("heir", "HeirloomSite", f)).toEqual([0, 1, 2, 3]);
    expect(matchName("tcs", "Thematic-Collections-storage", f)).toEqual([0, 9, 21]);
    expect(matchName("hs", "HeirloomSite", f)).toEqual([0, 8]);
    expect(matchName("heir", "Thematic-Collections-storage", f)).toBeNull();
  });
});
