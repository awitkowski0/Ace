import { describe, expect, it } from "vitest";
import { abilityId, defaultKeybind, DOCUMENTED, filterAbilities, leadingComment, scanCatalog, type SourceFile } from "./catalog";

// A synthetic project tree (never the real repo): two namespaces, suits in an alt folder, lang, flight profiles.
const suit = (id: string, abilities: Array<[string, string]>, extra: Record<string, unknown> = {}) => ({
  path: `/proj/src/common/resources/data/thematic/armors/heroes/${id}.json`,
  text: JSON.stringify({ tier: 5, abilities: abilities.map(([identifier, keybind]) => ({ identifier, keybind })), ...extra }),
});
const TREE: SourceFile[] = [
  { path: "/proj/src/common/resources/data/thematic/abilities/shared/hand_beam.js", text: "// Hand Beam\ncomponent(() => {});\n" },
  { path: "/proj/src/common/resources/data/thematic/abilities/ultron/hive_control.js", text: "// Hive Control\nconst GROUP = 'hive';\n" },
  { path: "/proj/src/common/resources/data/thematic/abilities/flight.json", text: '{ "description": "Flight by jets" }' },
  { path: "/proj/src/common/resources/data/thematic/abilities/bare.js", text: "component(() => {});\n" },
  { path: "/proj/src/common/resources/data/spark_pack/abilities/spark_step.js", text: "// Spark Step: a short hop.\n" },
  { path: "/proj/src/common/resources/data/thematic/flight_profiles/repulsor.json", text: "{}" },
  { path: "/proj/src/common/resources/data/thematic/flight_profiles/jetpack.json", text: "{}" },
  { path: "/proj/src/common/resources/data/spark_pack/flight_profiles/other.json", text: "{}" },
  suit("iron_man", [["immunity_fire", "key.thematic.passive"], ["hand_beam", "key.thematic.ability_0"], ["flight", "key.thematic.passive"]], {
    stats: [{ identifier: "thematic:base_combat", minimum: 80, maximum: 98 }, { identifier: "thematic:base_custom", minimum: 1, maximum: 2 }],
    fighting_type: ["DUELIST"], flight_type: "JETPACK", flight_profile: "thematic:repulsor", jet_groups: "both", tags: ["auto_reload"],
    attributes: [{ identifier: "pehkui:base", effect: 1.1 }],
  }),
  suit("spider", [["hand_beam", "key.thematic.ability_1"], ["flight", "key.thematic.passive"]], { fighting_type: ["BRAWLER"], flight_type: "one_hand_left" }),
  suit("batman", [["hand_beam", "key.thematic.ability_1"]], { tags: ["auto_reload", "lantern"] }),
  { path: "/proj/src/common/resources/data/thematic/armors/heroes/alt/iron_man_b.json", text: JSON.stringify({ parent: "thematic:iron_man", abilities: [{ identifier: "hand_beam", keybind: "key.thematic.ability_2" }] }) },
  { path: "/proj/src/common/resources/data/thematic/armors/heroes/broken.json", text: "{ nope" },
  { path: "/proj/src/common/resources/assets/thematic/lang/en_us.json", text: JSON.stringify({ "key.thematic.ability_0": "Ability 1", "key.thematic.cosmetic": "Cosmetic", "thematic.x": "y" }) },
  { path: "/proj/src/common/resources/assets/spark_pack/lang/en_us.json", text: JSON.stringify({ "key.thematic.spark": "Spark" }) },
  { path: "/proj/src/common/resources/assets/thematic/lang/en_us.broken.json", text: "{" },
];

describe("leadingComment", () => {
  it("takes the first comment line, JSON description, nothing otherwise", () => {
    expect(leadingComment("// Hand Beam\n// more\n")).toBe("Hand Beam");
    expect(leadingComment("\n\n// Spark Step: hop\n")).toBe("Spark Step: hop");
    expect(leadingComment("component(() => {});")).toBeUndefined();
    expect(leadingComment("//\n// later\n")).toBe("later");
    expect(leadingComment('{ "description": " Flight by jets " }')).toBe("Flight by jets");
    expect(leadingComment("{ broken")).toBeUndefined();
  });
});

describe("abilityId", () => {
  it("bare for thematic, namespaced otherwise", () => {
    expect(abilityId("thematic", "hand_beam")).toBe("hand_beam");
    expect(abilityId("spark_pack", "spark_step")).toBe("spark_pack:spark_step");
  });
});

describe("scanCatalog", () => {
  const cat = scanCatalog(TREE, "thematic");

  it("lists the abilities of every namespace with folder and description", () => {
    const byId = Object.fromEntries(cat.abilities.map((a) => [a.id, a]));
    expect(Object.keys(byId).sort()).toEqual(["bare", "flight", "hand_beam", "hive_control", "spark_pack:spark_step"]);
    expect(byId.hand_beam).toMatchObject({ folder: "shared", name: "hand_beam", description: "Hand Beam" });
    expect(byId.hive_control.folder).toBe("ultron");
    expect(byId.bare.description).toBeUndefined();
    expect(byId.flight.description).toBe("Flight by jets");
    expect(byId["spark_pack:spark_step"]).toMatchObject({ ns: "spark_pack", description: "Spark Step: a short hop." });
  });

  it("sorts abilities by folder (top level first) then id", () => {
    expect(cat.abilities.map((a) => a.id)).toEqual(["bare", "flight", "spark_pack:spark_step", "hand_beam", "hive_control"]);
  });

  it("counts keybinds from lang files and suits, and picks the most common keybind per ability", () => {
    expect(cat.keybinds).toEqual(expect.arrayContaining(["key.thematic.ability_0", "key.thematic.cosmetic", "key.thematic.spark", "key.thematic.passive", "key.thematic.ultimate"]));
    expect(cat.keybinds.filter((k) => k.startsWith("key.thematic."))).toEqual([...cat.keybinds].filter((k) => k.startsWith("key.thematic.")));
    expect(cat.keybinds).not.toContain("thematic.x");
    expect(cat.keybinds).toContain("key.thematic.spark"); // another namespace's lang file counts too
    expect(cat.abilityKeybinds.hand_beam).toEqual({ "key.thematic.ability_0": 1, "key.thematic.ability_1": 2, "key.thematic.ability_2": 1 });
    expect(defaultKeybind(cat, "hand_beam")).toBe("key.thematic.ability_1");
    expect(defaultKeybind(cat, "unknown_ability")).toBe("key.thematic.passive");
  });

  it("collects stats, attributes and enum values, with the documented ones", () => {
    expect(cat.stats["thematic:base_combat"]).toBe(1);
    expect(cat.stats["thematic:base_custom"]).toBe(1);
    for (const d of DOCUMENTED.stats) expect(cat.stats).toHaveProperty([d]);
    expect(cat.attributeIds).toMatchObject({ "pehkui:base": 1, "pehkui:reach": 0, jump_height: 0 });
    expect(cat.fightingTypes).toEqual(expect.arrayContaining(["DUELIST", "BRAWLER", "UTILITY", "MAGIC"]));
    expect(cat.fightingTypes).toEqual(["BRAWLER", "DUELIST", "UTILITY", "MAGIC"]); // seen values first (by use, then name), then the documented ones
    expect(cat.flightTypes).toEqual(expect.arrayContaining(["JETPACK", "one_hand_left", "NO_HANDS"]));
    expect(cat.jetGroups).toEqual(["both", "arms", "legs"]);
    expect(cat.tags).toEqual(["auto_reload", "lantern"]);
  });

  it("lists the flight profiles and suit ids of the namespace only", () => {
    expect(cat.flightProfiles).toEqual(["thematic:jetpack", "thematic:repulsor"]);
    expect(cat.suits).toEqual(["batman", "iron_man", "iron_man_b", "spider"]);
  });

  it("tolerates broken files", () => {
    expect(() => scanCatalog([...TREE, { path: "/x/data/thematic/armors/a.json", text: "{" }], "thematic")).not.toThrow();
  });
});

describe("filterAbilities", () => {
  const cat = scanCatalog(TREE, "thematic");
  it("ranks id matches first, then folder and description", () => {
    expect(filterAbilities(cat.abilities, "hand").map((a) => a.id)).toEqual(["hand_beam"]);
    expect(filterAbilities(cat.abilities, "ultron").map((a) => a.id)).toEqual(["hive_control"]);
    expect(filterAbilities(cat.abilities, "jets").map((a) => a.id)).toEqual(["flight"]);
    expect(filterAbilities(cat.abilities, "zzz")).toEqual([]);
    expect(filterAbilities(cat.abilities, "").length).toBe(cat.abilities.length);
    expect(filterAbilities(cat.abilities, "", 2)).toHaveLength(2);
  });
});
