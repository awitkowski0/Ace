import { describe, expect, it } from "vitest";
import { badges, branchLabel, buildRows, currentIndex, defaultWorktreePath, filterRows, folderSafe, freeBranches, parseWorktreePorcelain, planBranch, removeBlocker } from "./worktrees";

const SAMPLE = `worktree /Users/a/Thematic-Collections
HEAD 1111111111111111111111111111111111111111
branch refs/heads/main

worktree /Users/a/Thematic-Collections-spidey
HEAD 2222222222222222222222222222222222222222
branch refs/heads/feature/spidey
locked in use on usb

worktree /Users/a/Thematic-Collections-old
HEAD 3333333333333333333333333333333333333333
detached
prunable gitdir file points to non-existent location

worktree /Users/a/bare.git
bare

worktree /Users/a/Thematic-Collections-locked
HEAD 4444444444444444444444444444444444444444
branch refs/heads/x
locked
`;

describe("parseWorktreePorcelain", () => {
  const l = parseWorktreePorcelain(SAMPLE);
  it("parses every block, first is main", () => {
    expect(l.map((w) => w.path.split("/").pop())).toEqual(["Thematic-Collections", "Thematic-Collections-spidey", "Thematic-Collections-old", "bare.git", "Thematic-Collections-locked"]);
    expect(l.map((w) => w.main)).toEqual([true, false, false, false, false]);
  });
  it("branch short name, detached, bare", () => {
    expect(l[1].branch).toBe("feature/spidey");
    expect(l[2]).toMatchObject({ branch: null, detached: true });
    expect(l[3].bare).toBe(true);
    expect(l[3].head).toBeNull();
  });
  it("locked with and without reason, prunable reason", () => {
    expect(l[1].locked).toBe("in use on usb");
    expect(l[4].locked).toBe("");
    expect(l[0].locked).toBeNull();
    expect(l[2].prunable).toContain("non-existent");
  });
  it("tolerates CRLF, empty input and trailing blanks", () => {
    expect(parseWorktreePorcelain("")).toEqual([]);
    expect(parseWorktreePorcelain("worktree /a\r\nHEAD abc\r\nbranch refs/heads/m\r\n\r\n\r\n")).toHaveLength(1);
  });
  it("paths with spaces survive", () => {
    expect(parseWorktreePorcelain("worktree /a b/c d\nHEAD 1\nbranch refs/heads/m\n")[0].path).toBe("/a b/c d");
  });
});

describe("row model", () => {
  const list = parseWorktreePorcelain(SAMPLE);
  it("current = longest containing path, also from a subfolder", () => {
    expect(currentIndex(list, "/Users/a/Thematic-Collections-spidey")).toBe(1);
    expect(currentIndex(list, "/Users/a/Thematic-Collections-spidey/src/x")).toBe(1);
    expect(currentIndex(list, "/Users/a/Thematic-Collections/sub")).toBe(0);
    expect(currentIndex(list, "/elsewhere")).toBe(-1);
  });
  it("git's toplevel wins over a symlinked project path", () => {
    expect(currentIndex(list, "/link/spidey", "/Users/a/Thematic-Collections-spidey")).toBe(1);
  });
  it("labels", () => {
    expect(branchLabel(list[2])).toBe("detached @ 3333333");
    expect(branchLabel(list[3])).toBe("bare");
    expect(branchLabel(list[1])).toBe("feature/spidey");
  });
  it("buildRows attaches status by normalized path and marks current", () => {
    const rows = buildRows(list, { "/Users/a/Thematic-Collections-spidey": { dirty: 3, ahead: 1, behind: 0, upstream: "origin/x" } }, "/Users/a/Thematic-Collections");
    expect(rows[0].current).toBe(true);
    expect(rows[1].status?.dirty).toBe(3);
    expect(rows[0].status).toBeNull();
  });
  it("badges: dirty, ahead, behind, locked, prunable", () => {
    const rows = buildRows(list, { "/Users/a/Thematic-Collections-spidey": { dirty: 3, ahead: 1, behind: 2, upstream: "origin/x" } }, "/");
    expect(badges(rows[1]).map((b) => b.text)).toEqual(["3", "↑1", "↓2", "locked"]);
    expect(badges(rows[2]).map((b) => b.kind)).toEqual(["prunable"]);
    expect(badges(rows[0])).toEqual([]);
  });
  it("removeBlocker", () => {
    const rows = buildRows(list, {}, "/Users/a/Thematic-Collections-spidey");
    expect(removeBlocker(rows[0])).toMatch(/main/);
    expect(removeBlocker(rows[1])).toMatch(/in/);
    expect(removeBlocker(rows[4])).toBeNull();
    expect(removeBlocker(rows[4], true)).toMatch(/another window/);
  });
});

describe("filterRows", () => {
  const rows = buildRows(parseWorktreePorcelain(SAMPLE), {}, "/Users/a/Thematic-Collections");
  it("empty query keeps order", () => expect(filterRows(rows, "").length).toBe(5));
  it("camel-hump on the folder name", () => {
    const h = filterRows(rows, "tcsp");
    expect(h.map((x) => x.row.name)).toEqual(["Thematic-Collections-spidey"]);
    expect(h[0].name.length).toBeGreaterThan(0);
  });
  it("matches the branch and reports branch ranges", () => {
    const h = filterRows(rows, "feature");
    expect(h).toHaveLength(1);
    expect(h[0].branch).toEqual([[0, 7]]);
    expect(h[0].name).toEqual([]);
  });
  it("name hits rank before branch hits", () => {
    const h = filterRows(rows, "x");
    expect(h[0].row.branch).toBe("x");
  });
  it("path-only match", () => expect(filterRows(rows, "users/a/bare").map((x) => x.row.name)).toEqual(["bare.git"]));
  it("no match", () => expect(filterRows(rows, "zzzz")).toEqual([]));
});

describe("new worktree naming", () => {
  it("sibling <repo>-<branch>", () => {
    expect(defaultWorktreePath("/Users/a/Thematic-Collections", "spidey")).toBe("/Users/a/Thematic-Collections-spidey");
    expect(defaultWorktreePath("/Users/a/Thematic-Collections/", "feature/new thing")).toBe("/Users/a/Thematic-Collections-feature-new-thing");
    expect(defaultWorktreePath("/repo", "x")).toBe("/repo-x");
    expect(defaultWorktreePath("/Users/a/R", "")).toBe("/Users/a/R");
  });
  it("folderSafe", () => {
    expect(folderSafe("refs/heads/a/b")).toBe("a-b");
    expect(folderSafe(" a:b*c ")).toBe("a-b-c");
  });
  it("freeBranches excludes branches checked out elsewhere", () => {
    expect(freeBranches(["main", "feature/spidey", "other"], parseWorktreePorcelain(SAMPLE))).toEqual(["other"]);
  });
  it("planBranch", () => {
    expect(planBranch("other", ["other"], [])).toEqual({ kind: "existing", branch: "other" });
    expect(planBranch("origin/dev", [], ["origin/dev"])).toEqual({ kind: "remote", branch: "origin/dev" });
    expect(planBranch("dev", [], ["origin/dev"])).toEqual({ kind: "remote", branch: "origin/dev" });
    expect(planBranch("brand-new", ["a"], ["origin/a"])).toEqual({ kind: "new", branch: "brand-new" });
  });
});

import { isAgentPath, layoutAgents } from "./worktrees";
describe("agent worktree group", () => {
  const items = ["/r/a", "/r/.claude/worktrees/agent-1", "/r/b", "/r/.claude/worktrees/wf_2"];
  const lay = (e: boolean, s: boolean) => layoutAgents(items, isAgentPath, e, s).map((x) => ("row" in x ? x.row.split("/").pop() : `G${x.group.count}${x.group.open ? "+" : "-"}`));
  it("collapsed at the bottom with a count", () => expect(lay(false, false)).toEqual(["a", "b", "G2-"]));
  it("expanded or searching shows them", () => { expect(lay(true, false)).toEqual(["a", "b", "G2+", "agent-1", "wf_2"]); expect(lay(false, true)).toEqual(["a", "b", "G2+", "agent-1", "wf_2"]); });
  it("no group without agents", () => expect(layoutAgents(["/x"], isAgentPath, false, false)).toHaveLength(1));
});
