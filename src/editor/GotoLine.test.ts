import { describe, expect, it } from "vitest";
import { parseLineCol } from "./GotoLine";

const cur = { line: 10, col: 3 };
describe("parseLineCol (IntelliJ Go to Line:Column)", () => {
  it("line only", () => expect(parseLineCol("42", cur, 100)).toEqual({ line: 42, col: 1 }));
  it("line:col", () => expect(parseLineCol("42:7", cur, 100)).toEqual({ line: 42, col: 7 }));
  it("clamps to the file", () => expect(parseLineCol("999", cur, 100)).toEqual({ line: 100, col: 1 }));
  it(":col stays on the current line", () => expect(parseLineCol(":9", cur, 100)).toEqual({ line: 10, col: 9 }));
  it("negative counts from the end", () => expect(parseLineCol("-1", cur, 100)).toEqual({ line: 100, col: 1 }));
  it("rejects garbage", () => { expect(parseLineCol("abc", cur, 100)).toBeNull(); expect(parseLineCol("", cur, 100)).toBeNull(); });
});
