import { describe, expect, it } from "vitest";
import { parseRepoConfig, serializeRepoConfig } from "./repoConfig";

describe("repoConfig", () => {
  it("stable pretty print, version first, unknown keys kept in order", () => {
    const raw = parseRepoConfig('{"zeta":1,"gradle":{"pinned":[{"task":":a"}]},"version":1}');
    expect(serializeRepoConfig(raw)).toBe('{\n  "version": 1,\n  "zeta": 1,\n  "gradle": {\n    "pinned": [\n      {\n        "task": ":a"\n      }\n    ]\n  }\n}\n');
  });
  it("rejects non objects", () => {
    expect(() => parseRepoConfig("[]")).toThrow();
    expect(() => parseRepoConfig("{")).toThrow();
  });
});
