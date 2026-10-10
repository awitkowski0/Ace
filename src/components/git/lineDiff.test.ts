import { describe, expect, it } from "vitest";
import { diffHunks } from "./lineDiff";

describe("diffHunks", () => {
  it("detects added / modified / deleted against buffer text", () => {
    expect(diffHunks("a\nb\nc\n", "a\nb\nc\n")).toEqual([]);
    expect(diffHunks("a\nb\nc\n", "a\nX\nc\n")).toEqual([{ kind: "modified", start: 2, end: 2 }]);
    expect(diffHunks("a\nb\nc\n", "a\nb\nY\nZ\nc\n")).toEqual([{ kind: "added", start: 3, end: 4 }]);
    expect(diffHunks("a\nb\nc\n", "a\nc\n")).toEqual([{ kind: "deleted", start: 2, end: 2 }]);
  });
});
