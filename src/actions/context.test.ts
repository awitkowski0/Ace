import { describe, expect, it } from "vitest";
import { candidates, type FocusState } from "./context";
import type { Action } from "./registry";

const mk = (id: string, context?: Action["context"], enabled = true): Action => ({ id, title: id, run() {}, context, isEnabled: () => enabled });
const table = (...as: Action[]) => (id: string) => as.find((a) => a.id === id);
const st = (p: Partial<FocusState> = {}): FocusState => ({ popupOpen: false, toolWindow: null, editor: true, ...p });

describe("context-aware dispatch", () => {
  const dup = mk("EditorDuplicate", "editor");
  const diff = mk("Diff.ShowDiff", { toolWindow: "commit" });
  const glob = mk("Global");
  const get = table(dup, diff, glob);
  const ids = ["Global", "EditorDuplicate", "Diff.ShowDiff"];

  it("editor focus: editor action beats global", () => {
    expect(candidates(ids, get, st()).map((a) => a.id)).toEqual(["EditorDuplicate", "Global"]);
  });
  it("commit window focus: tool window action first, editor action inactive (⌘D)", () => {
    expect(candidates(ids, get, st({ toolWindow: "commit", editor: false })).map((a) => a.id)).toEqual(["Diff.ShowDiff", "Global"]);
  });
  it("other tool window focus: neither editor nor commit actions", () => {
    expect(candidates(ids, get, st({ toolWindow: "project", editor: false })).map((a) => a.id)).toEqual(["Global"]);
  });
  it("popup open: only popup + global", () => {
    const pop = mk("P", "popup");
    const g = table(dup, diff, glob, pop);
    expect(candidates([...ids, "P"], g, st({ popupOpen: true })).map((a) => a.id)).toEqual(["P", "Global"]);
    expect(candidates([...ids, "P"], g, st()).map((a) => a.id)).toEqual(["EditorDuplicate", "Global"]);
  });
  it("terminal ⌘K: terminal-scoped clear beats global Commit", () => {
    const clear = mk("Terminal.Clear", { toolWindow: "terminal" });
    const commit = mk("CheckinProject");
    const g = table(commit, clear);
    expect(candidates(["CheckinProject", "Terminal.Clear"], g, st({ toolWindow: "terminal", editor: false })).map((a) => a.id)).toEqual(["Terminal.Clear", "CheckinProject"]);
    expect(candidates(["CheckinProject", "Terminal.Clear"], g, st()).map((a) => a.id)).toEqual(["CheckinProject"]);
  });
  it("disabled actions fall through", () => {
    const off = mk("Off", "editor", false);
    expect(candidates(["Off", "Global"], table(off, glob), st()).map((a) => a.id)).toEqual(["Global"]);
  });
});
