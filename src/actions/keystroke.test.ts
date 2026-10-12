import { describe, expect, it } from "vitest";
import { formatKeystroke, parseKeystroke, strokeCandidates } from "./keystroke";

describe("parseKeystroke", () => {
  it("canonicalises modifier order", () => {
    expect(parseKeystroke("meta shift O")).toBe("shift meta O");
    expect(parseKeystroke("shift meta O")).toBe("shift meta O");
    expect(parseKeystroke("alt shift UP")).toBe("alt shift UP");
  });
  it("double modifier taps", () => {
    expect(parseKeystroke("shift shift")).toBe("double shift");
    expect(parseKeystroke("alt alt")).toBe("double alt");
  });
  it("double-alt + arrow hold gesture", () => {
    expect(parseKeystroke("alt alt DOWN")).toBe("doublehold alt DOWN");
    expect(formatKeystroke("alt alt DOWN")).toBe("⌥⌥↓");
  });
  it("chords, comma- or space-separated", () => {
    expect(parseKeystroke("meta alt MULTIPLY, 1")).toBe("alt meta MULTIPLY , 1");
    expect(parseKeystroke("meta K meta C")).toBe("meta K , meta C");
  });
  it("ignores mouse shortcuts and junk", () => {
    expect(parseKeystroke("meta button1")).toBeNull();
    expect(parseKeystroke("meta")).toBeNull();
    expect(parseKeystroke("")).toBeNull();
  });
});

describe("Windows / Linux key mapping", () => {
  const ev = (code: string, mods: Partial<Record<"ctrlKey" | "altKey" | "shiftKey" | "metaKey", boolean>> = {}) =>
    ({ code, key: "", ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...mods }) as KeyboardEvent;

  it("mac: exactly one stroke, metaKey = meta, ctrlKey = control", () => {
    expect(strokeCandidates(ev("KeyO", { metaKey: true, shiftKey: true }), true)).toEqual(["shift meta O"]);
    expect(strokeCandidates(ev("KeyW", { ctrlKey: true, altKey: true }), true)).toEqual(["control alt W"]);
  });
  it("Ctrl is the command key", () => {
    expect(strokeCandidates(ev("KeyO", { ctrlKey: true, shiftKey: true }), false)).toEqual(["shift meta O"]);
    expect(strokeCandidates(ev("KeyS", { ctrlKey: true }), false)).toEqual(["meta S"]);
  });
  it("Ctrl+Alt tries the control forms before the meta-alt form", () => {
    expect(strokeCandidates(ev("KeyW", { ctrlKey: true, altKey: true }), false)).toEqual(["control alt W", "control W", "alt meta W"]);
    expect(strokeCandidates(ev("KeyR", { ctrlKey: true, altKey: true, shiftKey: true }), false))
      .toEqual(["control alt shift R", "control shift R", "alt shift meta R"]);
  });
  it("Alt alone and the Windows key", () => {
    expect(strokeCandidates(ev("KeyR", { altKey: true, shiftKey: true }), false)).toEqual(["alt shift R"]);
    expect(strokeCandidates(ev("KeyR", { metaKey: true }), false)).toEqual(["R"]);
  });
  it("lone modifiers and unmapped keys produce nothing", () => {
    expect(strokeCandidates(ev("ControlLeft", { ctrlKey: true }), false)).toEqual([]);
    expect(strokeCandidates(ev("IntlBackslash"), false)).toEqual([]);
  });
  it("formatKeystroke on Windows shows the same chords the keys produce", () => {
    expect(formatKeystroke("meta shift O", false)).toBe("Ctrl+Shift+O");
    expect(formatKeystroke("control alt W", false)).toBe("Ctrl+Alt+W");
    expect(formatKeystroke("control O", false)).toBe("Ctrl+Alt+O");
    expect(formatKeystroke("alt shift R", false)).toBe("Alt+Shift+R");
    expect(formatKeystroke("meta K meta C", false)).toBe("Ctrl+K Ctrl+C");
    expect(formatKeystroke("shift ESCAPE", false)).toBe("Shift+Esc");
    expect(formatKeystroke("meta R", true)).toBe("⌘R");
  });
});
