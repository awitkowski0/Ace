import { describe, expect, it } from "vitest";
import { flatten, nodeOutcome, splitNodeId, TestModel } from "./testModel";

const mk = () => {
  const m = new TestModel();
  m.apply({ k: "collected", items: ["t/a.py::test_ok", "t/a.py::test_bad", "t/a.py::test_skip", "t/a.py::G::test_in[1::2]"].map((id) => ({ id, name: id, file: "/p/t/a.py", line: 3 })) });
  return m;
};
describe("TestModel", () => {
  it("splits node ids", () => {
    expect(splitNodeId("a/b.py::C::t[x::y]")).toEqual(["a/b.py", "C", "t[x::y]"]);
    expect(splitNodeId("a.py")).toEqual(["a.py"]);
  });
  it("builds a tree and counts", () => {
    const m = mk();
    expect(m.total).toBe(4);
    expect(m.statusText()).toBe("Tests passed: 0 of 4");
    m.apply({ k: "start", id: "t/a.py::test_ok" });
    expect(nodeOutcome(m.find("t/a.py::test_ok")!)).toBe("running");
    m.apply({ k: "result", id: "t/a.py::test_ok", outcome: "passed", duration: 0.01, file: "t/a.py", line: 3 });
    m.apply({ k: "result", id: "t/a.py::test_bad", outcome: "failed", duration: 0.02, message: "assert 3 == 4", longrepr: "boom" });
    m.apply({ k: "result", id: "t/a.py::test_skip", outcome: "skipped", duration: 0 });
    m.apply({ k: "result", id: "t/a.py::G::test_in[1::2]", outcome: "passed", duration: 0.5 });
    expect(m.statusText()).toBe("Tests passed: 2 of 4, 1 failed, 1 skipped");
    expect(nodeOutcome(m.find("t/a.py")!)).toBe("failed");
    expect(nodeOutcome(m.find("t/a.py::G")!)).toBe("passed");
    expect(m.failedIds()).toEqual(["t/a.py::test_bad"]);
    expect(m.progress()).toBe(1);
    expect(m.root.counts.duration).toBeCloseTo(0.53);
    expect(m.find("t/a.py::test_bad")!.file).toBe("/p/t/a.py"); // absolute path from collection wins
  });
  it("collect errors and finish()", () => {
    const m = new TestModel();
    m.apply({ k: "collect_error", id: "t/broken.py", longrepr: "x\nImportError: nope" });
    expect(m.statusText()).toBe("Tests passed: 0 of 1, 1 error");
    m.apply({ k: "start", id: "t/a.py::x" });
    m.finish();
    expect(m.find("t/a.py::x")!.outcome).toBe("error");
    expect(m.failedIds()).toEqual(["t/a.py::x"]);
  });
  it("flattens with filters, collapse and sorting", () => {
    const m = mk();
    m.apply({ k: "result", id: "t/a.py::test_ok", outcome: "passed", duration: 0 });
    m.apply({ k: "result", id: "t/a.py::test_bad", outcome: "failed", duration: 0 });
    m.apply({ k: "result", id: "t/a.py::test_skip", outcome: "skipped", duration: 0 });
    m.apply({ k: "result", id: "t/a.py::G::test_in[1::2]", outcome: "passed", duration: 0 });
    const names = (o: Partial<Parameters<typeof flatten>[1]> = {}) => flatten(m, { showPassed: true, showSkipped: true, alpha: false, collapsed: new Set(), ...o }).map((r) => r.node.name);
    expect(names()).toEqual(["", "t/a.py", "test_ok", "test_bad", "test_skip", "G", "test_in[1::2]"]);
    expect(names({ showPassed: false })).toEqual(["", "t/a.py", "test_bad", "test_skip"]);
    expect(names({ showSkipped: false, showPassed: false })).toEqual(["", "t/a.py", "test_bad"]);
    expect(names({ alpha: true })).toEqual(["", "t/a.py", "G", "test_in[1::2]", "test_bad", "test_ok", "test_skip"]);
    expect(names({ collapsed: new Set(["t/a.py"]) })).toEqual(["", "t/a.py"]);
  });
});
