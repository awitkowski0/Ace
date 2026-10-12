import { describe, expect, it } from "vitest";
import { migrateStorage } from "./migrateStorage";

function fake(init: Record<string, string>) {
  const m = new Map(Object.entries(init));
  return {
    m,
    get length() { return m.size; },
    key: (i: number) => [...m.keys()][i] ?? null,
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => { m.set(k, v); },
  };
}

describe("migrateStorage", () => {
  it("copies atelier.* to ace.* and keeps the old keys", () => {
    const s = fake({ "atelier.recent": "[1]", "atelier.python.terminalActivate": "0", "other": "x" });
    expect(migrateStorage(s)).toBe(2);
    expect(s.m.get("ace.recent")).toBe("[1]");
    expect(s.m.get("ace.python.terminalActivate")).toBe("0");
    expect(s.m.get("atelier.recent")).toBe("[1]");
    expect(s.m.has("ace.other")).toBe(false);
  });
  it("never overwrites an existing ace.* key", () => {
    const s = fake({ "atelier.recent": "old", "ace.recent": "new" });
    expect(migrateStorage(s)).toBe(0);
    expect(s.m.get("ace.recent")).toBe("new");
  });
  it("migrates panel layout keys", () => {
    const s = fake({ "react-resizable-panels:atelier:local:/p:h": "L" });
    migrateStorage(s);
    expect(s.m.get("react-resizable-panels:ace:local:/p:h")).toBe("L");
  });
  it("swallows storage errors", () => {
    const bad = { length: 1, key: () => { throw new Error("denied"); }, getItem: () => null, setItem: () => {} };
    expect(migrateStorage(bad)).toBe(0);
  });
});
