import { beforeEach, describe, expect, it, vi } from "vitest";

const files: Record<string, string> = {};
vi.mock("../lib/ipc", () => ({
  basename: (p: string) => p.slice(p.lastIndexOf("/") + 1),
  locKey: (l: { host: string; path: string }) => `${l.host}:${l.path}`,
  fs: {
    readFile: async (l: { path: string }) => files[l.path] ?? "",
    writeFile: async (l: { path: string }, t: string) => { files[l.path] = t; },
  },
}));
vi.mock("../components/shell/dialogs", () => ({ confirmDialog: async () => true }));

const L = (p: string) => ({ host: "local", path: p });
let S: typeof import("./store");

beforeEach(async () => {
  vi.resetModules();
  for (const k of Object.keys(files)) delete files[k];
  S = await import("./store");
});

describe("openFile", () => {
  it("opens a tab and issues a reveal request for line/col/select", async () => {
    files["/p/a.ts"] = "hello\nworld\n";
    await S.openFile(L("/p/a.ts"), { line: 2, col: 3, select: 2 });
    const st = S.editorStore.get();
    expect(st.groups[st.activeGroup].active).toBe("local:/p/a.ts");
    expect(st.reveal).toMatchObject({ key: "local:/p/a.ts", line: 2, col: 3, select: 2 });
    S.consumeReveal(st.reveal!.nonce);
    expect(S.editorStore.get().reveal).toBeNull();
  });
  it("still accepts a group id as 2nd argument", async () => {
    await S.openFile(L("/p/a.ts"), S.editorStore.get().activeGroup);
    expect(Object.keys(S.editorStore.get().docs)).toEqual(["local:/p/a.ts"]);
  });
  it("enforces the tab limit by closing the least recently used clean unpinned tab", async () => {
    for (let i = 0; i < S.MAX_TABS; i++) await S.openFile(L(`/p/f${i}.ts`));
    S.togglePin("local:/p/f0.ts"); // pinned: must survive
    await S.openFile(L("/p/extra.ts"));
    const g = S.editorStore.get().groups[S.editorStore.get().activeGroup];
    expect(g.tabs).toHaveLength(S.MAX_TABS);
    expect(g.tabs).toContain("local:/p/f0.ts");
    expect(g.tabs).not.toContain("local:/p/f1.ts"); // oldest unpinned went
    expect(g.tabs).toContain("local:/p/extra.ts");
  });
});

describe("tab operations", () => {
  it("close others / right / all keep pinned tabs; pinned tabs ignore plain close", async () => {
    for (const n of ["a", "b", "c", "d"]) await S.openFile(L(`/p/${n}.ts`));
    const gid = S.editorStore.get().activeGroup;
    S.togglePin("local:/p/a.ts");
    await S.closeTab(gid, "local:/p/a.ts");
    expect(S.editorStore.get().groups[gid].tabs).toContain("local:/p/a.ts");
    await S.closeTabsToRight(gid, "local:/p/b.ts");
    expect(S.editorStore.get().groups[gid].tabs).toEqual(["local:/p/a.ts", "local:/p/b.ts"]);
    await S.closeAllTabs(gid);
    expect(S.editorStore.get().groups[gid].tabs).toEqual(["local:/p/a.ts"]);
  });
  it("closing the active tab activates the most recently used remaining tab", async () => {
    for (const n of ["a", "b", "c"]) await S.openFile(L(`/p/${n}.ts`));
    const gid = S.editorStore.get().activeGroup;
    S.activateTab(gid, "local:/p/a.ts");
    S.activateTab(gid, "local:/p/c.ts");
    await S.closeTab(gid, "local:/p/c.ts");
    expect(S.editorStore.get().groups[gid].active).toBe("local:/p/a.ts");
  });
  it("cycleTab wraps", async () => {
    for (const n of ["a", "b"]) await S.openFile(L(`/p/${n}.ts`));
    const gid = S.editorStore.get().activeGroup;
    S.cycleTab(1);
    expect(S.editorStore.get().groups[gid].active).toBe("local:/p/a.ts");
    S.cycleTab(-1);
    expect(S.editorStore.get().groups[gid].active).toBe("local:/p/b.ts");
  });
});

describe("navigation history", () => {
  it("Back/Forward walk jumps across files", async () => {
    files["/p/a.ts"] = "1\n2\n3\n"; files["/p/b.ts"] = "x\ny\n";
    await S.openFile(L("/p/a.ts"), { line: 3, col: 1 });
    S.setCursor(3, 1);
    await S.openFile(L("/p/b.ts"), { line: 2, col: 1 });
    S.setCursor(2, 1);
    expect(S.canGoBack()).toBe(true);
    await S.navigateBack();
    const st = S.editorStore.get();
    expect(st.groups[st.activeGroup].active).toBe("local:/p/a.ts");
    expect(st.reveal).toMatchObject({ line: 3 });
    expect(S.canGoForward()).toBe(true);
    await S.navigateForward();
    expect(S.editorStore.get().groups[S.editorStore.get().activeGroup].active).toBe("local:/p/b.ts");
  });
});

describe("diff tabs", () => {
  const spec = (over: object = {}) => ({
    title: "src/a.ts", name: "a.ts", leftLabel: "HEAD", rightLabel: "Your version",
    left: async () => "old", right: async () => "new", openLoc: L("/p/src/a.ts"), ...over,
  });
  it("opens once per diff and does not pollute recent files", async () => {
    S.openDiff(spec());
    S.openDiff(spec());
    const st = S.editorStore.get();
    expect(Object.values(st.docs).filter((d) => d.kind === "diff")).toHaveLength(1);
    expect(st.recent).toEqual([]);
    expect(st.groups[st.activeGroup].tabs).toHaveLength(1);
  });
  it("⌘S in a diff tab writes the right side to the working file", async () => {
    S.openDiff(spec());
    const key = S.editorStore.get().groups[S.editorStore.get().activeGroup].active!;
    S.registerDiffController(key, { getRight: () => "edited" });
    S.setDiffDirty(key, true);
    await S.saveAll();
    expect(files["/p/src/a.ts"]).toBe("edited");
    expect(S.editorStore.get().docs[key].dirty).toBe(false);
  });
  it("a diff without a working file is never written", async () => {
    S.openDiff(spec({ openLoc: undefined, title: "c1:foo", rightLabel: "c1" }));
    const key = S.editorStore.get().groups[S.editorStore.get().activeGroup].active!;
    S.registerDiffController(key, { getRight: () => "x" });
    S.setDiffDirty(key, true);
    await S.saveAll();
    expect(Object.keys(files)).toEqual([]);
  });
});
