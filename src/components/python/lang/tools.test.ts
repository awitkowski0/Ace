import { describe, expect, it } from "vitest";
import { formatArgv, installPlan, optimizeArgv, parseRuff, pickFormatter, pythonSettings, shellLine } from "./tools";

describe("python tools", () => {
  it("prefers ruff over black", () => {
    expect(pickFormatter({ ruff: "/v/ruff", black: "/b/black" })).toEqual({ kind: "ruff", bin: "/v/ruff" });
    expect(pickFormatter({ black: "/b/black" })).toEqual({ kind: "black", bin: "/b/black" });
    expect(pickFormatter({ isort: "/i" })).toBeNull();
  });
  it("format and optimize command lines", () => {
    expect(formatArgv({ kind: "ruff", bin: "r" }, "/p/a.py")).toEqual(["r", "format", "--stdin-filename", "/p/a.py", "-"]);
    expect(formatArgv({ kind: "ruff", bin: "r" }, "/p/a.py", { l1: 2, c1: 1, l2: 4, c2: 1 })).toContain("2:1-4:1");
    expect(formatArgv({ kind: "black", bin: "b" }, "/p/a.py")).toEqual(["b", "-q", "--stdin-filename", "/p/a.py", "-"]);
    expect(optimizeArgv({ ruff: "r", isort: "i" }, "f.py")?.argv.slice(0, 4)).toEqual(["r", "check", "--select", "I,F401"]);
    expect(optimizeArgv({ isort: "i" }, "f.py")).toEqual({ tool: "isort", argv: ["i", "--filename", "f.py", "-"] });
    expect(optimizeArgv({}, "f.py")).toBeNull();
  });
  it("parses ruff json with fixes", () => {
    const out = JSON.stringify([
      { code: "F401", message: "`sys` imported but unused", location: { row: 1, column: 8 }, end_location: { row: 1, column: 11 }, fix: { message: "Remove unused import: `sys`", edits: [{ content: "", location: { row: 1, column: 1 }, end_location: { row: 2, column: 1 } }] } },
      { code: null, message: "SyntaxError: bad", location: { row: 3, column: 1 }, end_location: { row: 3, column: 2 }, fix: null },
    ]);
    const d = parseRuff(out, "/p/a.py")!;
    expect(d).toHaveLength(2);
    expect(d[0]).toMatchObject({ code: "F401", severity: 2, source: "ruff", owner: "ruff", range: { start: { line: 0, character: 7 }, end: { line: 0, character: 10 } } });
    expect(d[0].fix?.edits[0].range).toEqual({ start: { line: 0, character: 0 }, end: { line: 1, character: 0 } });
    expect(d[1].severity).toBe(1);
    expect(parseRuff("not json", "x")).toBeNull();
  });
  it("answers workspace/configuration", () => {
    const s = pythonSettings("python", { pythonPath: "/p/.venv/bin/python", envRoot: "/p/.venv" }) as Record<string, unknown>;
    expect(s.pythonPath).toBe("/p/.venv/bin/python");
    expect(s).toMatchObject({ venvPath: "/p", venv: ".venv" });
    expect(pythonSettings("python.analysis", { pythonPath: null })).toMatchObject({ diagnosticMode: "openFilesOnly", typeCheckingMode: "standard" });
    expect(pythonSettings("basedpyright.analysis", { pythonPath: null })).toMatchObject({ autoSearchPaths: true, useLibraryCodeForTypes: true });
    expect(pythonSettings("unknown", { pythonPath: null })).toBeNull();
  });
  it("install plan", () => {
    expect(installPlan({ uv: "/u/uv" }, "/p/.venv/bin/python")).toEqual({ primary: ["/u/uv", "tool", "install", "basedpyright"], alt: ["/u/uv", "pip", "install", "--python", "/p/.venv/bin/python", "basedpyright"] });
    expect(installPlan({ pipx: "/u/pipx" }, null).primary).toEqual(["/u/pipx", "install", "basedpyright"]);
    expect(installPlan({}, "/p/py").primary).toBeNull();
    expect(installPlan({}, "/p/py").alt).toEqual(["/p/py", "-m", "pip", "install", "basedpyright"]);
    expect(shellLine(["/a b/uv", "tool"])).toBe("'/a b/uv' tool");
  });
});
