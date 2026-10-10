import { describe, expect, it } from "vitest";
import { ModifierGesture } from "./modifierGesture";

const tap = (g: ModifierGesture, name: "shift" | "alt", t: number, hold = 40) => {
  const r = g.modDown(name, false, t);
  g.modUp(name, t + hold);
  return r;
};

describe("ModifierGesture", () => {
  it("fires on the second clean tap within 300ms", () => {
    const g = new ModifierGesture();
    expect(tap(g, "shift", 0)).toBeNull();
    expect(tap(g, "shift", 150)).toBe("shift");
  });
  it("does not fire when taps are > 300ms apart", () => {
    const g = new ModifierGesture();
    tap(g, "shift", 0);
    expect(tap(g, "shift", 301)).toBeNull();
    // ...but that second tap arms a new window
    expect(tap(g, "shift", 500)).toBe("shift");
  });
  it("ignores auto-repeat", () => {
    const g = new ModifierGesture();
    g.modDown("shift", false, 0);
    expect(g.modDown("shift", true, 50)).toBeNull();
    expect(g.modDown("shift", true, 100)).toBeNull();
    g.modUp("shift", 120);
    expect(g.modDown("shift", true, 130)).toBeNull();
  });
  it("another key between the taps resets", () => {
    const g = new ModifierGesture();
    tap(g, "shift", 0);
    g.otherInput();
    expect(tap(g, "shift", 100)).toBeNull();
  });
  it("shift+letter is not a tap", () => {
    const g = new ModifierGesture();
    g.modDown("shift", false, 0);
    g.otherInput(); // 'A'
    g.modUp("shift", 80);
    expect(tap(g, "shift", 120)).toBeNull();
  });
  it("another modifier held invalidates", () => {
    const g = new ModifierGesture();
    g.modDown("meta", false, 0);
    expect(g.modDown("shift", false, 10)).toBeNull();
    g.modUp("shift", 40);
    expect(g.modDown("shift", false, 100)).toBeNull();
  });
  it("different modifiers do not combine", () => {
    const g = new ModifierGesture();
    tap(g, "shift", 0);
    expect(tap(g, "alt", 100)).toBeNull();
  });
  it("triple tap fires once then restarts", () => {
    const g = new ModifierGesture();
    tap(g, "shift", 0);
    expect(tap(g, "shift", 100)).toBe("shift");
    expect(tap(g, "shift", 200)).toBeNull();
  });
  it("double-alt stays 'held' until the second alt is released (caret clone gesture)", () => {
    const g = new ModifierGesture();
    tap(g, "alt", 0);
    expect(g.modDown("alt", false, 100)).toBe("alt");
    expect(g.doubleHeld).toBe("alt");
    g.otherInput(); // arrow key
    expect(g.doubleHeld).toBe("alt");
    g.modUp("alt", 400);
    expect(g.doubleHeld).toBeNull();
  });
  it("reset (blur / mouse) clears the armed tap", () => {
    const g = new ModifierGesture();
    tap(g, "shift", 0);
    g.reset();
    expect(tap(g, "shift", 100)).toBeNull();
  });
});
