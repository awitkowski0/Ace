import { describe, expect, it, vi } from "vitest";
import { ASSET_TOOL_WINDOWS, activateActionId, behindTotal, gateAction, incomingNotice, pickClientTask, toolWindowAllowed, viewToolWindow, type IncomingLite } from "./gate";

// the shipped tool windows (ids registered by the modules) and a sample of action ids
const WINDOWS = ["project", "claude", "remote-files", "processes", "commit", "git", "run", "debug", "terminal", "find", "usages", "gradle", "godot", "structure", "problems"];
const ACTIONS = ["Run", "Debug", "SaveAll", "CloseContent", "GotoFile", "Git.Commit", "Vcs.UpdateProject", "ActivateTerminalToolWindow", "ActivateGradleToolWindow", "Terminal.New", "Gradle.Refresh", "StepOver", "FindInPath", "ShowSettings", "$Undo"];

describe("Developer profile is unchanged", () => {
  it("shows every tool window, the very same objects", () => {
    for (const id of WINDOWS) {
      const tw = { id, title: id };
      expect(toolWindowAllowed("developer", id)).toBe(true);
      expect(viewToolWindow("developer", tw, { project: () => ({ id: "x" }) })).toBe(tw);
    }
  });
  it("every action is ok", () => {
    for (const id of ACTIONS) expect(gateAction("developer", { id }, new Set(["ActivateTerminalToolWindow"]))).toBe("ok");
  });
  it("only profile-tagged actions can be hidden", () => {
    expect(gateAction("developer", { id: "Assets.Save", profiles: ["asset"] }, new Set())).toBe("hidden");
    expect(gateAction("developer", { id: "SwitchProfile" }, new Set())).toBe("ok");
  });
});

describe("Asset Dev gating", () => {
  it("allows only Assets, Changes and Run", () => {
    expect(WINDOWS.filter((id) => toolWindowAllowed("asset", id))).toEqual(["project", "commit", "run"]);
    expect(ASSET_TOOL_WINDOWS).toEqual(["project", "commit", "run"]);
  });
  it("view replaces allowed windows and hides the rest", () => {
    const o = { project: (t: { id: string; title: string }) => ({ ...t, title: "Assets" }) };
    expect(viewToolWindow("asset", { id: "project", title: "Project" }, o)?.title).toBe("Assets");
    expect(viewToolWindow("asset", { id: "terminal", title: "Terminal" }, o)).toBeNull();
    const run = { id: "run", title: "Run" };
    expect(viewToolWindow("asset", run, o)).toBe(run);
  });
  it("blocks hidden-window shortcuts and developer actions, keeps editing actions", () => {
    const hidden = new Set(["ActivateTerminalToolWindow", "ActivateGradleToolWindow"]);
    for (const id of ["ActivateTerminalToolWindow", "ActivateGradleToolWindow", "Terminal.New", "Gradle.Refresh", "Debug", "StepOver", "Vcs.ToggleAmendCommitMode"])
      expect(gateAction("asset", { id }, hidden), id).toBe("blocked");
    for (const id of ["SaveAll", "CloseContent", "GotoFile", "FindInPath", "ShowSettings", "ActivateRunToolWindow", "SwitchProfile"])
      expect(gateAction("asset", { id }, hidden), id).toBe("ok");
  });
  it("redirects run and commit keys to the Asset Bar actions", () => {
    expect(gateAction("asset", { id: "Run" }, new Set())).toEqual({ redirect: "Assets.RunGame" });
    expect(gateAction("asset", { id: "CheckinProject" }, new Set())).toEqual({ redirect: "Assets.Save" });
    expect(gateAction("asset", { id: "Vcs.UpdateProject" }, new Set())).toEqual({ redirect: "Assets.GetLatest" });
  });
  it("profile-tagged actions", () => {
    expect(gateAction("asset", { id: "Assets.Save", profiles: ["asset"] }, new Set())).toBe("ok");
  });
  it("activate action ids follow the registry rule", () => {
    expect(activateActionId({ id: "remote-files" })).toBe("ActivateRemoteFilesToolWindow");
    expect(activateActionId({ id: "git", actionId: "ActivateVersionControlToolWindow" })).toBe("ActivateVersionControlToolWindow");
  });
});

describe("not-on-the-latest notice", () => {
  const inc = (o: Partial<IncomingLite>): IncomingLite => ({ behind: 0, authors: [], tip: null, base: null, baseBehind: 0, baseTip: null, baseAuthors: [], ...o });
  it("none when up to date", () => expect(incomingNotice("main", inc({}), new Set())).toBeNull());
  it("names the people and counts", () => {
    const n = incomingNotice("assets/x/a", inc({ behind: 3, authors: ["Sam"], tip: "abc" }), new Set())!;
    expect(n.text).toBe("There's a newer version of assets/x/a — 3 updates from Sam.");
  });
  it("Later snoozes until the tip changes", () => {
    const n1 = incomingNotice("m", inc({ behind: 1, authors: ["A"], tip: "t1" }), new Set())!;
    const snoozed = new Set([n1.key]);
    expect(incomingNotice("m", inc({ behind: 1, authors: ["A"], tip: "t1" }), snoozed)).toBeNull();
    expect(incomingNotice("m", inc({ behind: 2, authors: ["A", "B"], tip: "t2" }), snoozed)?.text).toContain("2 updates from A and B");
  });
  it("main branch moved", () => {
    const n = incomingNotice("feat", inc({ base: "origin/main", baseBehind: 1, baseTip: "m1", baseAuthors: ["Kim"] }), new Set())!;
    expect(n.text).toContain("main version has moved on");
    expect(n.text).toContain("1 update from Kim");
  });
  it("badge counts", () => {
    expect(behindTotal(null)).toBe(0);
    expect(behindTotal(inc({ behind: 4, baseBehind: 9 }))).toBe(4);
    expect(behindTotal(inc({ baseBehind: 2 }))).toBe(2);
  });
});

describe("Run Game discovery", () => {
  const pinned = [{ task: ":1.20.1:fabricRunClient", name: "1.20.1 Fabric" }, { task: ":1.20.1:forgeRunClient", name: "1.20.1 Forge" }, { task: ":26.3:fabricRunClient", name: "26.3 Fabric (parked)" }];
  it("config wins", () => expect(pickClientTask({ assetRun: { task: ":x:run", args: "--info" }, pinned })).toMatchObject({ task: ":x:run", args: "--info", source: "config" }));
  it("first non-parked pinned Fabric client", () => expect(pickClientTask({ pinned })).toMatchObject({ task: ":1.20.1:fabricRunClient", source: "pinned" }));
  it("targets.json next", () => expect(pickClientTask({ targets: [{ mc: "1.20.1", loader: "forge" }, { mc: "1.21.1", loader: "fabric" }] })).toMatchObject({ task: ":1.21.1:fabricRunClient", source: "targets" }));
  it("falls back to runClient", () => expect(pickClientTask({})).toMatchObject({ task: "runClient", source: "default" }));
  it("a pinned neoforge-only list still works", () => expect(pickClientTask({ pinned: [{ task: ":1.21.1:neoforgeRunClient" }] }).task).toBe(":1.21.1:neoforgeRunClient"));
});

describe("registry hook leaves Developer untouched", async () => {
  const reg = await import("../../toolwindows/registry");
  it("no view = registered order, view filters and is reversible", () => {
    const C = () => null;
    for (const [id, order] of [["project", 0], ["terminal", 5], ["run", 15]] as const) reg.registerToolWindow({ id, title: id, icon: null, side: "left", order, component: C });
    const before = reg.listToolWindows().map((t) => t.id);
    expect(before).toEqual(["project", "terminal", "run"]);
    const fn = vi.fn();
    const off = reg.subscribeToolWindows(fn);
    reg.setToolWindowView((tw) => viewToolWindow("asset", tw, {}));
    expect(reg.listToolWindows().map((t) => t.id)).toEqual(["project", "run"]);
    expect(reg.getToolWindow("terminal")).toBeUndefined();
    expect(fn).toHaveBeenCalled();
    reg.setToolWindowView(null);
    expect(reg.listToolWindows().map((t) => t.id)).toEqual(before);
    expect(reg.listToolWindows()).toBe(reg.listToolWindows());
    off();
  });
});
