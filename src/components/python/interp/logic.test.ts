import { describe, expect, it } from "vitest";
import type { Interp } from "../api";
import { activateScript, defaultVenvDir, groupInterpreters, insideProject, pythonLabel, shortPath, widgetText } from "./logic";

const I = (o: Partial<Interp>): Interp => ({ id: o.path ?? "p", path: "/x/bin/python", version: "3.12.6", kind: "system", name: "Python 3.12", envRoot: null, project: false, host: "local", ...o });

describe("interp logic", () => {
  it("shortens home paths", () => {
    expect(shortPath("/Users/alex/proj/.venv/bin/python", "/Users/alex")).toBe("~/proj/.venv/bin/python");
    expect(shortPath("/Users/bob/x")).toBe("~/x");
    expect(shortPath("/usr/bin/python3")).toBe("/usr/bin/python3");
  });
  it("widget text", () => {
    expect(widgetText({ loading: true, current: null })).toBe("Detecting interpreter…");
    expect(widgetText({ loading: false, current: null })).toBe("<No interpreter>");
    expect(widgetText({ loading: false, current: I({ name: "Python 3.12 (proj)" }) })).toBe("Python 3.12 (proj)");
  });
  it("groups project interpreters first, then by kind", () => {
    const g = groupInterpreters([I({ kind: "system", path: "/a" }), I({ kind: "conda", path: "/b" }), I({ kind: "venv", project: true, path: "/c" }), I({ kind: "pyenv", path: "/d" })]);
    expect(g.map((x) => x.label)).toEqual(["Project interpreters", "Conda", "pyenv", "System Interpreter"]);
  });
  it("activate script only for venv-like local envs", () => {
    expect(activateScript(I({ kind: "venv", envRoot: "/p/.venv", path: "/p/.venv/bin/python" }))).toBe("/p/.venv/bin/activate");
    expect(activateScript(I({ kind: "uv", envRoot: "/p/.venv", path: "/p/.venv/bin/python" }))).toBe("/p/.venv/bin/activate");
    expect(activateScript(I({ kind: "conda", envRoot: "/c/envs/x", path: "/c/envs/x/bin/python" }))).toBeNull();
    expect(activateScript(I({ kind: "system" }))).toBeNull();
    expect(activateScript(I({ kind: "venv", envRoot: "/p/.venv", path: "/p/.venv/bin/python", host: "mc" }))).toBeNull();
    expect(activateScript(null)).toBeNull();
  });
  it("inside project", () => {
    expect(insideProject("/p/a", "/p")).toBe(true);
    expect(insideProject("/p", "/p/")).toBe(true);
    expect(insideProject("/pp", "/p")).toBe(false);
    expect(insideProject("~", "/p")).toBe(false);
  });
  it("labels", () => {
    expect(defaultVenvDir("/p/")).toBe("/p/.venv");
    expect(pythonLabel("3.12.6", "demo")).toBe("Python 3.12 (demo)");
  });
});
