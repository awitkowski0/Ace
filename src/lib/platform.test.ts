import { describe, expect, it } from "vitest";
import { detectPlatform, fileManagerName, formatShortcut, isMac, isMod, modKey } from "./platform";

const MAC_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15";
const WIN_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Edg/120.0";

describe("detectPlatform", () => {
  it("detects mac from user agent or platform", () => {
    expect(detectPlatform(MAC_UA)).toEqual({ mac: true, windows: false });
    expect(detectPlatform("", "MacIntel")).toEqual({ mac: true, windows: false });
  });
  it("detects windows", () => {
    expect(detectPlatform(WIN_UA)).toEqual({ mac: false, windows: true });
    expect(detectPlatform("", "Win32")).toEqual({ mac: false, windows: true });
  });
  it("jsdom / linux is neither", () => {
    expect(detectPlatform("Mozilla/5.0 (X11; Linux x86_64) jsdom/24.0.0")).toEqual({ mac: false, windows: false });
  });
});

describe("labels follow the detected platform", () => {
  it("mac uses the glyph and Finder, everything else Ctrl and Explorer", () => {
    expect(modKey).toBe(isMac ? "⌘" : "Ctrl");
    expect(fileManagerName).toBe(isMac ? "Finder" : "Explorer");
  });
});

describe("isMod", () => {
  it("mac uses metaKey, elsewhere ctrlKey", () => {
    expect(isMod({ metaKey: true, ctrlKey: false }, true)).toBe(true);
    expect(isMod({ metaKey: false, ctrlKey: true }, true)).toBe(false);
    expect(isMod({ metaKey: false, ctrlKey: true }, false)).toBe(true);
    expect(isMod({ metaKey: true, ctrlKey: false }, false)).toBe(false);
  });
});

describe("formatShortcut", () => {
  it("returns the string unchanged on mac", () => {
    expect(formatShortcut("⇧⌘C", true)).toBe("⇧⌘C");
    expect(formatShortcut("⌃⌥W", true)).toBe("⌃⌥W");
  });
  it("converts modifier glyphs on Windows", () => {
    expect(formatShortcut("⇧⌘C", false)).toBe("Ctrl+Shift+C");
    expect(formatShortcut("⌥⇧R", false)).toBe("Alt+Shift+R");
    expect(formatShortcut("⌃⌥W", false)).toBe("Ctrl+Alt+W");
  });
  it("maps key glyphs and chords", () => {
    expect(formatShortcut("⌥↩", false)).toBe("Alt+Enter");
    expect(formatShortcut("⌘↩", false)).toBe("Ctrl+Enter");
    expect(formatShortcut("⌘K ⌘C", false)).toBe("Ctrl+K Ctrl+C");
    expect(formatShortcut("⌘⌫", false)).toBe("Ctrl+Backspace");
  });
  it("leaves plain keys alone", () => {
    expect(formatShortcut("F5", false)).toBe("F5");
    expect(formatShortcut("", false)).toBe("");
  });
});
