import { describe, expect, it } from "vitest";
import { listAdd, listMove, listRemove, listSet, readAttributes, readStats, readSuit, setTop } from "./suit";

// The shape of a shipped suit (Thematic's iron_man.json, two-space indent), reproduced here, never read from the repo.
const IRON = `{
  "tier": 8,
  "abilities": [
    {"identifier": "immunity_fire", "keybind": "key.thematic.passive"},
    {"identifier": "toggle_hood", "keybind": "key.thematic.cosmetic"},
    {"identifier": "flight", "keybind": "key.thematic.passive"}
  ],
  "stats": [
    {
      "identifier": "thematic:base_generic_attack",
      "minimum": 55,
      "maximum": 65
    },
    {
      "identifier": "thematic:base_combat",
      "minimum": 80,
      "maximum": 98
    }
  ],
  "fighting_type": ["DUELIST"],
  "flight_type": "JETPACK",
  "flight_profile": "thematic:repulsor",
  "jet_groups": "both"
}`;

const ob = (t: string) => JSON.parse(t) as Record<string, unknown>;

describe("setTop", () => {
  it("changes one value and leaves every other byte alone", () => {
    const out = setTop(IRON, "tier", 9);
    expect(out).toBe(IRON.replace('"tier": 8,', '"tier": 9,'));
  });

  it("removes a field", () => {
    const out = setTop(IRON, "jet_groups", undefined);
    expect(ob(out)).not.toHaveProperty("jet_groups");
    expect(out.replace(/,\n  "jet_groups": "both"/, "")).toBe(out.replace(/,\n  "jet_groups": "both"/, ""));
    expect(out).toBe(IRON.replace(',\n  "jet_groups": "both"', ""));
  });

  it("inserts a new key in the file's key order", () => {
    const out = setTop(IRON, "parent", "thematic:superman");
    expect(out).toBe(IRON.replace('  "tier": 8,', '  "parent": "thematic:superman",\n  "tier": 8,'));
    const boss = setTop(IRON, "boss", true);
    expect(boss).toBe(IRON.replace('"jet_groups": "both"\n}', '"jet_groups": "both",\n  "boss": true\n}'));
  });

  it("keeps a number's own spelling when it is set to the value it has", () => {
    expect(setTop(IRON, "tier", 8)).toBe(IRON);
  });
});

describe("list edits", () => {
  it("appends an ability in the list's own layout and nothing else changes", () => {
    const out = listAdd(IRON, "abilities", { identifier: "hive_control", keybind: "key.thematic.ability_0" });
    expect(ob(out).abilities).toEqual([...(ob(IRON).abilities as unknown[]), { identifier: "hive_control", keybind: "key.thematic.ability_0" }]);
    expect(out).toBe(IRON.replace('{"identifier": "flight", "keybind": "key.thematic.passive"}\n  ]', '{"identifier": "flight", "keybind": "key.thematic.passive"},\n    {"identifier": "hive_control", "keybind": "key.thematic.ability_0"}\n  ]'));
  });

  it("creates a missing list at its canonical place", () => {
    const src = '{\n  "tier": 3,\n  "wip": false\n}';
    const out = listAdd(src, "abilities", { identifier: "x", keybind: "key.thematic.passive" });
    expect(ob(out)).toEqual({ tier: 3, wip: false, abilities: [{ identifier: "x", keybind: "key.thematic.passive" }] });
    expect(out.indexOf('"tier"')).toBeLessThan(out.indexOf('"abilities"'));
  });

  it("removes an ability by index", () => {
    const out = listRemove(IRON, "abilities", 1);
    expect(ob(out).abilities).toEqual([{ identifier: "immunity_fire", keybind: "key.thematic.passive" }, { identifier: "flight", keybind: "key.thematic.passive" }]);
    expect(out.includes('"toggle_hood"')).toBe(false);
  });

  it("moves an ability up or down", () => {
    const out = listMove(IRON, "abilities", 2, 0);
    expect((ob(out).abilities as Array<{ identifier: string }>).map((a) => a.identifier)).toEqual(["flight", "immunity_fire", "toggle_hood"]);
    const down = listMove(IRON, "abilities", 0, 1);
    expect((ob(down).abilities as Array<{ identifier: string }>).map((a) => a.identifier)).toEqual(["toggle_hood", "immunity_fire", "flight"]);
    expect(listMove(IRON, "abilities", 0, 0)).toBe(IRON);
    expect(listMove(IRON, "abilities", 0, 9)).toBe(IRON);
  });

  it("sets an ability's keybind; the rest of the line stays", () => {
    const out = listSet(IRON, "abilities", 0, "keybind", "key.thematic.ability_3");
    expect(out).toBe(IRON.replace('"identifier": "immunity_fire", "keybind": "key.thematic.passive"', '"identifier": "immunity_fire", "keybind": "key.thematic.ability_3"'));
  });

  it("edits a stat's min and max inside the multi-line rows", () => {
    const out = listSet(IRON, "stats", 0, "maximum", 70);
    expect(out).toBe(IRON.replace('"maximum": 65', '"maximum": 70'));
    expect(readStats(ob(out))[0]).toEqual({ index: 0, identifier: "thematic:base_generic_attack", minimum: 55, maximum: 70 });
    expect(readStats(ob(out))[1]).toEqual(readStats(ob(IRON))[1]);
  });

  it("appends a stat in the multi-line layout of the rows", () => {
    const out = listAdd(IRON, "stats", { identifier: "thematic:base_regen", minimum: 0, maximum: 100 });
    expect(out).toContain('    {\n      "identifier": "thematic:base_regen",\n      "minimum": 0,\n      "maximum": 100\n    }\n  ],');
    expect(readStats(ob(out))).toHaveLength(3);
  });

  it("is a no-op for a missing index or a list that is not there", () => {
    expect(listRemove(IRON, "abilities", 7)).toBe(IRON);
    expect(listSet(IRON, "attributes", 0, "effect", 1)).toBe(IRON);
  });

  it("refuses a value that is not a list where a list belongs", () => {
    expect(() => listAdd('{ "abilities": 3 }', "abilities", { identifier: "x" })).toThrow(/not a list/);
  });
});

describe("readers", () => {
  it("reads the shapes the designer shows", () => {
    const raw = ob(IRON);
    expect(readStats(raw)).toEqual([
      { index: 0, identifier: "thematic:base_generic_attack", minimum: 55, maximum: 65 },
      { index: 1, identifier: "thematic:base_combat", minimum: 80, maximum: 98 },
    ]);
    expect(readAttributes({ attributes: [{ identifier: "pehkui:base", effect: 1.1 }] })).toEqual([{ index: 0, identifier: "pehkui:base", effect: 1.1 }]);
    const s = readSuit(IRON);
    expect(s.abilities.map((a) => a.id)).toEqual(["immunity_fire", "toggle_hood", "flight"]);
    expect(s.flightProfile).toBe("thematic:repulsor");
  });
});
