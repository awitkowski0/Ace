import { describe, expect, it } from "vitest";
import { commandLine, compareVersions, isExternallyManaged, listArgv, norm, opArgv, parseList } from "./pip";

describe("pip helpers", () => {
  it("builds uv and pip commands", () => {
    expect(commandLine(opArgv("install", "/v/bin/python", "/u/uv", "six", "1.16.0"))).toBe("/u/uv pip install --python /v/bin/python six==1.16.0");
    expect(opArgv("upgrade", "/v/bin/python", "/u/uv", "six")).toEqual(["/u/uv", "pip", "install", "--python", "/v/bin/python", "--upgrade", "six"]);
    expect(opArgv("uninstall", "/v/bin/python", "/u/uv", "six")).toEqual(["/u/uv", "pip", "uninstall", "--python", "/v/bin/python", "six"]);
    expect(opArgv("install", "/py", null, "six")).toEqual(["/py", "-m", "pip", "install", "six"]);
    expect(opArgv("upgrade", "/py", null, "six")).toEqual(["/py", "-m", "pip", "install", "--upgrade", "six"]);
    expect(opArgv("uninstall", "/py", null, "six")).toEqual(["/py", "-m", "pip", "uninstall", "-y", "six"]);
    expect(listArgv("/py", null)[0]).toBe("/py");
    expect(listArgv("/py", "/u/uv").slice(0, 3)).toEqual(["/u/uv", "pip", "list"]);
  });
  it("quotes spaces in the displayed command", () => expect(commandLine(["/a b/py", "-m", "pip"])).toBe("'/a b/py' -m pip"));
  it("parses and sorts the list", () => {
    expect(parseList('[{"name":"Zed","version":"1"},{"name":"alpha","version":"2"}]').map((p) => p.name)).toEqual(["alpha", "Zed"]);
    expect(parseList('warning: x\n[{"name":"a","version":"1"}]')).toHaveLength(1);
  });
  it("detects externally managed", () => expect(isExternallyManaged("error: externally-managed-environment\n× This environment is externally managed")).toBe(true));
  it("compares versions", () => {
    expect(["1.9", "1.10", "1.2.1", "1.2"].sort(compareVersions)).toEqual(["1.2", "1.2.1", "1.9", "1.10"]);
    expect(compareVersions("1.0", "1.0rc1")).toBeGreaterThan(0);
    expect(norm("Typing_Extensions")).toBe("typing-extensions");
  });
});
