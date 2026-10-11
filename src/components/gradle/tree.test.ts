import { describe, expect, it } from "vitest";
import { pinsOf, subprojectDirs, visibleRows, type GModel } from "./tree";

const t = (path: string, group: string | null, description: string | null = null) => ({ name: path.split(":").pop()!, path, group, description });
const model: GModel = {
  name: "demo", dir: "/p", gradleVersion: "9.8.0", daemonPid: "1", includedBuilds: [],
  projects: [
    { name: "demo", path: ":", dir: "/p", description: null, tasks: [t(":build", "build"), t(":help", "help"), t(":zed", null)] },
    { name: "app", path: ":app", dir: "/p/app", description: null, tasks: [t(":app:run", "application")] },
    { name: "fabric", path: ":app:fabric", dir: "/p/app/fabric", description: null, tasks: [] },
  ],
};
const open = (...ids: string[]) => ({ has: (i: string) => ids.includes(i) });

describe("gradle tree", () => {
  it("groups sorted, other last, subprojects nested", () => {
    const rows = visibleRows(model, [], open("proj::", "tasks::", "group:::build", "group:::other", "proj::app", "tasks::app"));
    expect(rows.map((r) => `${r.depth}${r.kind}:${r.label}`)).toEqual([
      "0project:demo", "1tasks:Tasks", "2group:build", "3task:build", "2group:help", "2group:other", "3task:zed",
      "1project:app", "2tasks:Tasks", "3group:application", "2project:fabric",
    ]);
  });
  it("pinned section first", () => {
    const rows = visibleRows(model, [{ task: ":app:run", args: "--info" }], open("pinned"));
    expect(rows.slice(0, 2).map((r) => [r.kind, r.task, r.args])).toEqual([["pinned-root", undefined, undefined], ["pinned", ":app:run", "--info"]]);
  });
  it("helpers", () => {
    expect(subprojectDirs(model, "/p")).toEqual(["app", "app/fabric"]);
    expect(pinsOf({ pinned: [{ task: ":a" }, { x: 1 }, null] })).toEqual([{ task: ":a" }]);
    expect(pinsOf(undefined)).toEqual([]);
  });
});
