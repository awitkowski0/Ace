import { describe, expect, it } from "vitest";
import { debugArgs, enhancedHintText, ranProjects } from "./pure";

describe("ranProjects", () => {
  it("maps task lines to project paths", () => {
    const t = [
      "> Configure project :",
      "> Task :compileJava UP-TO-DATE",
      "> Task :1.20.1:fabric:processResources NO-SOURCE",
      "> Task :26.2:compileCommonJava",
      "> Task :runApp",
      "value=1",
    ].join("\n");
    expect(ranProjects(t).sort()).toEqual([":", ":1.20.1:fabric", ":26.2"].sort());
  });
  it("ignores other lines", () => {
    expect(ranProjects("> Task nothing\nBUILD SUCCESSFUL")).toEqual([]);
  });
});

describe("debugArgs", () => {
  it("adds the init script, and the JBR search path only when there is one", () => {
    expect(debugArgs("/x/ace-debug-1.gradle", "")).toEqual(["--init-script", "/x/ace-debug-1.gradle"]);
    expect(debugArgs("/x/a.gradle", "/j/21,/j/25")).toEqual(["--init-script", "/x/a.gradle", "-Dorg.gradle.java.installations.paths=/j/21,/j/25"]);
  });
});

describe("enhancedHintText", () => {
  it("explains what was found", () => {
    expect(enhancedHintText(null)).toMatch(/Looking for/);
    expect(enhancedHintText([])).toMatch(/No JetBrains Runtime was found/);
    expect(enhancedHintText(["21.0.9", "25.0.4.1"])).toMatch(/JBR 21\.0\.9, JBR 25\.0\.4\.1/);
  });
});
