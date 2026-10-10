import { describe, expect, it } from "vitest";
import { base64ToUtf8, isUnsafePaste, utf8ToBase64 } from "./clipboard";

describe("paste protection", () => {
  it("single line is safe, multi-line asks unless bracketed paste is on", () => {
    expect(isUnsafePaste("ls -la", false)).toBe(false);
    expect(isUnsafePaste("ls -la\n", false)).toBe(false); // trailing newline only
    expect(isUnsafePaste("a\nb", false)).toBe(true);
    expect(isUnsafePaste("a\nb", true)).toBe(false);
  });
  it("control characters and the bracketed-paste terminator always ask", () => {
    expect(isUnsafePaste("rm\x1b[201~ x", true)).toBe(true);
    expect(isUnsafePaste("a\x07b", true)).toBe(true);
    expect(isUnsafePaste("tab\there", true)).toBe(false);
  });
  it("base64 round-trips UTF-8 (OSC 52)", () => {
    expect(base64ToUtf8(utf8ToBase64("héllo 世界 😀"))).toBe("héllo 世界 😀");
  });
});
