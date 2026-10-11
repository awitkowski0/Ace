import { describe, expect, it } from "vitest";
import { computeMarkers, configFor, targetAt } from "./context";

const SRC = `import pytest\nfrom app.util import add\n\n\ndef test_add():\n    assert add(1, 2) == 3\n\n\nclass TestGroup:\n    def test_inner_ok(self):\n        x = 1\n        assert x\n\n    def helper(self):\n        pass\n\n\nclass Plain:\n    def test_not_collected(self):\n        pass\n`;
const MAIN = `class Counter:\n    def bump(self):\n        pass\n\n\nif __name__ == "__main__":\n    Counter().bump()\n`;
const UT = `import unittest\n\n\nclass AddTests(unittest.TestCase):\n    def test_ok(self):\n        self.assertEqual(1, 1)\n`;

describe("targetAt", () => {
  it("test function, method, class, file, script", () => {
    expect(targetAt("tests/test_m.py", SRC, 6)).toMatchObject({ kind: "test-fn", chain: ["test_add"] });
    expect(targetAt("tests/test_m.py", SRC, 12)).toMatchObject({ kind: "test-fn", chain: ["TestGroup", "test_inner_ok"] });
    expect(targetAt("tests/test_m.py", SRC, 14)).toMatchObject({ kind: "test-class", chain: ["TestGroup"] });
    expect(targetAt("tests/test_m.py", SRC, 1)).toMatchObject({ kind: "test-file" });
    expect(targetAt("tests/test_m.py", SRC, 19)).toMatchObject({ kind: "test-file" }); // Plain is not a test class
    expect(targetAt("app/main.py", MAIN, 2)).toMatchObject({ kind: "script" });
    expect(targetAt("app/main.py", MAIN, 7, "script")).toMatchObject({ kind: "script" });
  });
});
describe("configFor", () => {
  const o = { rootPath: "/p", hasPytest: true };
  it("pytest node ids and names", () => {
    expect(configFor("/p/tests/test_m.py", targetAt("/p/tests/test_m.py", SRC, 12), o)).toMatchObject({ type: "pytest", name: "pytest for test_m.TestGroup.test_inner_ok", target: "tests/test_m.py::TestGroup::test_inner_ok" });
    expect(configFor("/p/tests/test_m.py", targetAt("/p/tests/test_m.py", SRC, 1), o)).toMatchObject({ type: "pytest", name: "pytest in test_m.py", target: "tests/test_m.py" });
    expect(configFor("/p/hello.py", { kind: "script", chain: [], unittestStyle: false }, o)).toMatchObject({ type: "python", name: "hello", script: "hello.py" });
  });
  it("unittest when pytest is missing", () => {
    const t = targetAt("/p/tests/test_unit.py", UT, 6);
    expect(configFor("/p/tests/test_unit.py", t, { rootPath: "/p", hasPytest: false })).toMatchObject({ type: "unittest", targetKind: "names", target: "tests.test_unit.AddTests.test_ok" });
    expect(configFor("/p/tests/test_unit.py", t, o).type).toBe("pytest");
  });
});
describe("computeMarkers", () => {
  it("finds main, test functions, methods and classes", () => {
    expect(computeMarkers("/p/tests/test_m.py", SRC).map((m) => [m.line, m.kind, m.target.chain.join(".")])).toEqual([
      [5, "test", "test_add"], [9, "test-class", "TestGroup"], [10, "test", "TestGroup.test_inner_ok"],
    ]);
    expect(computeMarkers("/p/app/main.py", MAIN).map((m) => [m.line, m.kind])).toEqual([[6, "main"]]);
    expect(computeMarkers("/p/tests/test_unit.py", UT).map((m) => [m.line, m.kind])).toEqual([[4, "test-class"], [5, "test"]]);
    expect(computeMarkers("/p/notes.txt", MAIN)).toEqual([]);
  });
  it("ignores test-looking functions in non-test files", () => {
    expect(computeMarkers("/p/app/util.py", "def test_connection():\n    pass\n")).toEqual([]);
  });
});
