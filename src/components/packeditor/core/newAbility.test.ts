import { describe, expect, it } from "vitest";
import { scanCatalog } from "./catalog";
import {
  abilityLangKeys, abilityNameProblem, abilityTargetPath, addLangEntries, blankAbility, defaultFolder, newAbilityId, newLangText,
  normalizeAbilityName, normalizeFolder, retitleAbility, titleFromName,
} from "./newAbility";

describe("names and ids", () => {
  it("normalises a typed name", () => {
    expect(normalizeAbilityName("  Uni Beam! ")).toBe("uni_beam");
    expect(normalizeAbilityName("Repulsor-Blast  2")).toBe("repulsor_blast_2");
    expect(normalizeAbilityName("__x__")).toBe("x");
    expect(normalizeAbilityName("thematic:Unibeam")).toBe("unibeam");
    expect(normalizeAbilityName("my_pack:Unibeam", "my_pack")).toBe("unibeam");
    expect(normalizeAbilityName("???")).toBe("");
  });
  it("ids are bare for thematic, namespaced otherwise", () => {
    expect(newAbilityId("thematic", "unibeam")).toBe("unibeam");
    expect(newAbilityId("my_pack", "unibeam")).toBe("my_pack:unibeam");
  });
  it("rejects empty names and ids that exist", () => {
    expect(abilityNameProblem("", "thematic", [])).toMatch(/Type a name/);
    expect(abilityNameProblem("hand_beam", "thematic", ["hand_beam"])).toMatch(/already exists/);
    expect(abilityNameProblem("hand_beam", "thematic", ["thematic:hand_beam"])).toMatch(/already exists/);
    expect(abilityNameProblem("hand_beam", "my_pack", ["hand_beam"])).toBeNull();
    expect(abilityNameProblem("hand_beam", "my_pack", ["my_pack:hand_beam"])).toMatch(/already exists/);
    expect(abilityNameProblem("unibeam", "thematic", ["hand_beam"])).toBeNull();
  });
  it("makes a title from a name", () => {
    expect(titleFromName("unibeam")).toBe("Unibeam");
    expect(titleFromName("repulsor_blast")).toBe("Repulsor Blast");
  });
});

describe("retitleAbility", () => {
  it("replaces the title and keeps the text after the colon", () => {
    expect(retitleAbility("// Repulsor Blast: fires a beam\ncomponent(c => {});\n", "Unibeam", "js")).toBe("// Unibeam: fires a beam\ncomponent(c => {});\n");
  });
  it("replaces the whole line when there is no colon", () => {
    expect(retitleAbility("// Hand Beam\ncomponent(c => {});\n", "Unibeam", "js")).toBe("// Unibeam\ncomponent(c => {});\n");
  });
  it("treats a late colon as part of a sentence", () => {
    const long = "// ignite with only maxSeconds sets nothing alight; it cuts each burn: down to two\nx\n";
    expect(retitleAbility(long, "Unibeam", "js")).toBe("// Unibeam\nx\n");
  });
  it("skips blank lines and only edits the first comment line", () => {
    expect(retitleAbility("\n// A: one\n// B: two\nx", "N", "js")).toBe("\n// N: one\n// B: two\nx");
  });
  it("keeps CRLF", () => {
    expect(retitleAbility("// A: one\r\nx\r\n", "N", "js")).toBe("// N: one\r\nx\r\n");
  });
  it("adds a title line to a script with no leading comment", () => {
    expect(retitleAbility("component(c => {});\n", "Unibeam", "js")).toBe("// Unibeam\ncomponent(c => {});\n");
  });
  it("sets a JSON ability's description, formatting kept; no description: unchanged", () => {
    const j = `{\n  "type": "thematic:dry_humor",\n  "description": "Dry Humor: a joke"\n}\n`;
    expect(retitleAbility(j, "Cold Shoulder", "json")).toBe(`{\n  "type": "thematic:dry_humor",\n  "description": "Cold Shoulder: a joke"\n}\n`);
    const n = `{ "type": "x" }\n`;
    expect(retitleAbility(n, "Cold Shoulder", "json")).toBe(n);
  });
  it("the retitled copy is what the catalog reads as its description", () => {
    const text = retitleAbility("// Repulsor Blast: fires a beam\ncomponent(c => {});\n", "Unibeam", "js");
    const cat = scanCatalog([{ path: "/r/data/thematic/abilities/x/unibeam.js", text }], "thematic");
    expect(cat.abilities[0]).toMatchObject({ id: "unibeam", folder: "x", description: "Unibeam: fires a beam" });
  });
});

describe("blank, folder and path", () => {
  it("a blank script is a titled component skeleton the catalog reads", () => {
    const t = blankAbility("Unibeam");
    expect(t).toContain("component(component => {");
    expect(t.startsWith("// Unibeam: ")).toBe(true);
    const cat = scanCatalog([{ path: "/r/data/thematic/abilities/unibeam.js", text: t }], "thematic");
    expect(cat.abilities[0].description).toMatch(/^Unibeam: /);
  });
  it("normalises folders", () => {
    expect(normalizeFolder(" Iron Man/ Sub-Dir/ ")).toBe("iron_man/sub_dir");
    expect(normalizeFolder("")).toBe("");
  });
  it("default folder: the copy's, else the suit's if it exists, else top", () => {
    expect(defaultFolder("shared", "iron_man", ["iron_man"])).toBe("shared");
    expect(defaultFolder("", "iron_man", ["shared", "iron_man"])).toBe("iron_man");
    expect(defaultFolder(undefined, "iron_man", ["shared"])).toBe("");
  });
  it("target path", () => {
    expect(abilityTargetPath("/p/resources", "thematic", "iron_man", "unibeam", "js")).toBe("/p/resources/data/thematic/abilities/iron_man/unibeam.js");
    expect(abilityTargetPath("/p/resources", "my_pack", "", "unibeam", "json")).toBe("/p/resources/data/my_pack/abilities/unibeam.json");
  });
});

describe("lang entries", () => {
  it("names both keys", () => {
    expect(abilityLangKeys("unibeam")).toEqual(["unibeam", "ability.thematic.unibeam"]);
    expect(abilityLangKeys("my_pack:unibeam")).toEqual(["my_pack:unibeam", "ability.thematic.my_pack:unibeam"]);
  });
  const entries = { unibeam: "Unibeam", "ability.thematic.unibeam": "Unibeam" };
  it("appends before the closing brace, keeping everything else", () => {
    const src = `{\n  "a": "A",\n  "b": "B"\n}\n`;
    expect(addLangEntries(src, entries)).toBe(`{\n  "a": "A",\n  "b": "B",\n  "unibeam": "Unibeam",\n  "ability.thematic.unibeam": "Unibeam"\n}\n`);
  });
  it("handles a one-line file, no trailing newline, tabs, and an empty object", () => {
    expect(JSON.parse(addLangEntries(`{ "a": "A" }`, entries))).toEqual({ a: "A", ...entries });
    expect(addLangEntries(`{\n\t"a": "A"\n}`, { x: "X" })).toBe(`{\n\t"a": "A",\n\t"x": "X"\n}`);
    expect(addLangEntries(`{}`, { x: "X" })).toBe(`{\n  "x": "X"\n}`);
  });
  it("skips keys that exist, escapes values, and rejects non-objects", () => {
    const src = `{\n  "unibeam": "Mine"\n}\n`;
    expect(JSON.parse(addLangEntries(src, entries))).toEqual({ unibeam: "Mine", "ability.thematic.unibeam": "Unibeam" });
    expect(addLangEntries(src, { unibeam: "X" })).toBe(src);
    expect(JSON.parse(addLangEntries("{}", { k: 'Say "hi"' })).k).toBe('Say "hi"');
    expect(() => addLangEntries("[]", entries)).toThrow();
  });
  it("makes a new lang file", () => {
    expect(JSON.parse(newLangText(entries))).toEqual(entries);
  });
});
