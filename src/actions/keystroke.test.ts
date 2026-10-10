import { describe, expect, it } from "vitest";
import { formatKeystroke, parseKeystroke } from "./keystroke";

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
