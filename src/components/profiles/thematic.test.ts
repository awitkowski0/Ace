import { afterEach, describe, expect, it } from "vitest";
import { NO_RULES, assetPathspecs, classifyAsset, globToRegExp, groupAssets, newBranchPrefix, parseAssetRules, resolveBase, setAssetRules, suitAnimationTemplate, suitFiles, suitModelTemplate, suitRoot, targetDir, assetName } from "./assets";
import { branchVersion, pickClientTask, runOptions } from "./gate";

/** A synthetic tree with the shape of Thematic-Collections (multi-version Minecraft mod): common resources, a heroes pack, loose Blockbench sources, raw sounds. */
const C = "src/common/resources";
const H = "src/packs/heroes/resources";
const TREE = [
  // shipped assets
  `${C}/assets/thematic/geo/entity/batmobile.geo.json`, `${C}/assets/thematic/geo/entity/batmobile.bbmodel`, `${C}/assets/thematic/geo/entity/batmobile.geo.bbmodel`,
  `${C}/assets/thematic/geo/item/grapplegun.geo.json`, `${C}/assets/thematic/geo/block/suit_bench.geo.json`,
  `${C}/assets/thematic/animations/entity/batmobile.animation.json`, `${C}/assets/thematic/animations/armor/bat_slam.animation.json`,
  `${C}/assets/thematic/textures/entity/batmobile.png`, `${C}/assets/thematic/textures/gui/hud.png`, `${C}/assets/thematic/textures/armor/robin.png`,
  `${C}/assets/thematic/models/block/acacia_bench_left.json`, `${C}/assets/thematic/models/item/grapplegun.json`,
  `${C}/assets/thematic/models/animations/superhero_landing.pose`, `${C}/assets/thematic/models/animations/flight/idle/default.pose`,
  `${C}/assets/thematic/particles/smoke_particle.json`, `${C}/assets/thematic/sounds.json`, `${C}/assets/thematic/sounds/gun/shot.ogg`,
  `${C}/assets/thematic/lang/en_us.json`, `${C}/assets/thematic/blockstates/chair.json`, `${C}/assets/thematic/shaders/program/x.fsh`, `${C}/assets/thematic/guide/thematic/page.md`,
  // data that asset devs edit
  `${C}/data/thematic/anim_controllers/armor.js`, `${H}/data/thematic/anim_controllers/myers.js`, `${H}/data/thematic/anim_controllers/alt/ext.json`,
  `${H}/data/thematic/poses/walk.json`,
  // data that they do not
  `${C}/data/thematic/recipe/x.json`, `${H}/data/thematic/armors/batfamily/robin.json`, `${C}/data/thematic/loot_table/blocks/x.json`,
  // heroes pack
  `${H}/assets/thematic/geo/armor/robin.geo.json`, `${H}/assets/thematic/animations/armor/robin.animation.json`, `${H}/assets/thematic/textures/armor/robin.png`, `${H}/assets/thematic/textures/armor/robin_shiny.png`,
  `${H}/assets/thematic/poses/web.json`, `${H}/assets/thematic/sounds.json`, `${H}/assets/thematic/lang/en_us.json`,
  // loose sources + noise
  "guns/black widow gun.bbmodel", "guns/.geo/m4.geo.json", "guns/animations/alfreds_shotgun.animation.json", "guns/textures/m4.png",
  "cleaned_sounds/marvel_invasion/boom.wav", "testpacks/wilfred/assets/thematic/lang/en_us.json",
  "versions/26/common/src/main/resources/assets/thematic/geo/block/suit_bench.geo.json",
  // never assets
  "src/common/java/bond/Foo.java", "build.gradle", "docs/examples/anim_controllers/suit_controllers.full.js", "src/test/resources/content_identity/anim_controllers/armor.json",
  "versions/1.21.1/build/data-transform/common/assets/thematic/geo/entity/batmobile.bbmodel", "src/main/java/x/particles/Smoke.json", "tools/thematic-scan/poses/a.json",
];
const THEMATIC = parseAssetRules({
  suitRoot: `${H}/assets/thematic`,
  hide: ["**/assets/*/models/block/**", "**/assets/*/models/item/**", "cleaned_sounds/**", "testpacks/**", "docs/**"],
  baseBranch: { branch: "^(v\\d+(?:\\.\\d+)+)(?:-.+)?$", base: "origin/$1" },
  branchPrefix: "{base}-{user}-",
});
afterEach(() => setAssetRules(NO_RULES));
const T = (p: string, r = NO_RULES) => classifyAsset(p, r);

describe("Thematic layout: built-in classification (no config)", () => {
  it("anim_controllers and pose sets in data/ are assets", () => {
    expect(T(`${C}/data/thematic/anim_controllers/armor.js`)).toMatchObject({ type: "controller", name: "armor", inTree: true });
    expect(T(`${H}/data/thematic/anim_controllers/alt/ext.json`)).toMatchObject({ type: "controller", sub: "alt" });
    expect(T(`${H}/data/thematic/poses/walk.json`)).toMatchObject({ type: "pose", inTree: true });
    expect(T(`${H}/assets/thematic/poses/web.json`)).toMatchObject({ type: "pose" });
    expect(T(`${C}/assets/thematic/models/animations/flight/idle/default.pose`)).toMatchObject({ type: "pose", name: "default" });
  });
  it("the rest of data/ stays code", () => {
    for (const p of [`${C}/data/thematic/recipe/x.json`, `${C}/data/thematic/loot_table/blocks/x.json`, `${H}/data/thematic/abilities/ultron/hive_control.js`]) expect(T(p), p).toBeNull();
  });
  it("suits are assets (the pack editor opens them)", () => {
    expect(T(`${H}/data/thematic/armors/batfamily/robin.json`)).toMatchObject({ type: "suit", name: "robin", sub: "batfamily", inTree: true });
  });
  it("particles and sounds.json show up; .geo.bbmodel keeps a clean name", () => {
    expect(T(`${C}/assets/thematic/particles/smoke_particle.json`)).toMatchObject({ type: "particle", inTree: true, name: "smoke_particle" });
    expect(T(`${C}/assets/thematic/sounds.json`)).toMatchObject({ type: "sound", name: "sounds", inTree: true });
    expect(T(`${C}/assets/thematic/sounds/gun/shot.ogg`)).toMatchObject({ type: "sound" });
    expect(assetName("a/batmobile.geo.bbmodel")).toBe("batmobile");
    expect(T(`${C}/assets/thematic/geo/entity/batmobile.geo.bbmodel`)).toMatchObject({ type: "model", kind: "entity", name: "batmobile" });
  });
  it("lookalikes outside the data/assets trees and code are not assets", () => {
    for (const p of ["docs/examples/anim_controllers/suit_controllers.full.js", "src/test/resources/content_identity/anim_controllers/armor.json", "src/main/java/x/particles/Smoke.json",
      "versions/1.21.1/build/data-transform/common/assets/thematic/geo/entity/batmobile.bbmodel", "src/common/java/bond/Foo.java"]) expect(T(p), p).toBeNull();
    expect(T("tools/thematic-scan/poses/a.json")?.inTree).toBe(true); // pre-existing rule: a poses/ folder anywhere counts
  });
  it("groups: suits under Armor, controllers/particles/poses get their own flat groups, textures without a kind go to Other", () => {
    const g = groupAssets(TREE);
    expect(g.map((x) => x.label)).toEqual(["Suits", "Armor", "Items", "Entities", "Blocks", "Sounds", "Language", "Poses", "Particles", "Animation controllers", "Other"]);
    const armor = g[1].sections.map((s) => `${s.label}:${s.files.length}`);
    expect(armor).toEqual(["Models:1", "Animations:2", "Textures:3"]);
    expect(g.find((x) => x.label === "Animation controllers")!.count).toBe(3);
    expect(g.find((x) => x.label === "Other")!.sections.map((s) => s.label)).toEqual(["Models", "Animations", "Textures"]);
  });
  it("pathspecs cover data folders", () => {
    expect(assetPathspecs()).toContain(":(glob)**/data/*/anim_controllers/**");
  });
});

describe("assets config rules", () => {
  it("hide keeps files committable but out of the tree", () => {
    for (const p of [`${C}/assets/thematic/models/block/acacia_bench_left.json`, `${C}/assets/thematic/models/item/grapplegun.json`, "cleaned_sounds/marvel_invasion/boom.wav", "testpacks/wilfred/assets/thematic/lang/en_us.json"]) {
      expect(T(p, THEMATIC), p).toMatchObject({ inTree: false });
      expect(T(p), p).toMatchObject({ inTree: true }); // visible without the rule
    }
    expect(T(`${C}/assets/thematic/geo/item/grapplegun.geo.json`, THEMATIC)?.inTree).toBe(true);
    setAssetRules(THEMATIC);
    const names = groupAssets(TREE).flatMap((g) => g.sections.flatMap((s) => s.files.map((f) => f.path)));
    expect(names.some((p) => p.includes("models/block") || p.includes("cleaned_sounds") || p.includes("testpacks"))).toBe(false);
  });
  it("include adds files; type/kind optional; hidden files stay hidden", () => {
    const r = parseAssetRules({ include: ["**/data/*/blocks/behavior/**", { glob: "tools/art/*.psd", type: "texture" }, { glob: "x/y.txt", type: "nope" }, 5, null, { type: "model" }], hide: ["x/**"] });
    expect(r.include).toHaveLength(3);
    expect(T("src/data/thematic/blocks/behavior/a.json", r)).toMatchObject({ type: "data", inTree: true, name: "a" });
    expect(T("tools/art/web.psd", r)).toMatchObject({ type: "texture", inTree: true });
    expect(T("x/y.txt", r)).toMatchObject({ type: "data", inTree: false });
    expect(T("src/data/thematic/recipes/a.json", r)).toBeNull();
    expect(T("build/art/a.psd", parseAssetRules({ include: ["**/*.psd"] }))).toBeNull(); // excluded folders win
    expect(assetPathspecs(r)).toContain(":(glob)tools/art/*.psd");
  });
  it("garbage config never throws", () => {
    for (const v of [undefined, null, 5, "x", [], { include: "a", hide: 3, baseBranch: [{ branch: "(" , base: "x" }], suitRoot: 4 }]) expect(() => parseAssetRules(v)).not.toThrow();
    expect(parseAssetRules({ baseBranch: [{ branch: "(", base: "x" }] }).baseBranch).toEqual([]);
  });
  it("globs", () => {
    expect(globToRegExp("**/a/*.json").test("x/y/a/b.json")).toBe(true);
    expect(globToRegExp("**/a/*.json").test("a/b.json")).toBe(true);
    expect(globToRegExp("**/a/*.json").test("a/b/c.json")).toBe(false);
    expect(globToRegExp("*.psd").test("deep/er/x.psd")).toBe(true);
    expect(globToRegExp("cleaned_sounds/**").test("cleaned_sounds/a/b.wav")).toBe(true);
    expect(globToRegExp("a.b").test("axb")).toBe(false);
  });
});

describe("Thematic branches", () => {
  it("base branch from the branch name", () => {
    expect(resolveBase("v1.20.1-wolverine", THEMATIC)).toBe("origin/v1.20.1");
    expect(resolveBase("v1.20.1", THEMATIC)).toBe("origin/v1.20.1");
    expect(resolveBase("v1.21.1-alex-walk-cycle", THEMATIC)).toBe("origin/v1.21.1");
    expect(resolveBase("tab/codex", THEMATIC)).toBeNull();
    expect(resolveBase("main", THEMATIC)).toBeNull();
    expect(resolveBase(null, THEMATIC)).toBeNull();
    expect(resolveBase("v1.20.1", NO_RULES)).toBeNull();
  });
  it("new-branch prefix", () => {
    expect(newBranchPrefix("alex", "v1.20.1", THEMATIC)).toBe("v1.20.1-alex-");
    expect(newBranchPrefix("alex", "v1.20.1-alex-walk", THEMATIC)).toBe("v1.20.1-alex-");
    expect(newBranchPrefix("alex", "main", THEMATIC)).toBe("assets/alex/"); // {base} unknown: default
    expect(newBranchPrefix("alex", "v1.20.1", NO_RULES)).toBe("assets/alex/");
    expect(newBranchPrefix("alex", "x", parseAssetRules({ branchPrefix: "art/{user}/" }))).toBe("art/alex/");
  });
});

describe("Thematic Run Game", () => {
  const pinned = [
    { task: ":1.20.1:fabricRunClient", name: "1.20.1 Fabric" }, { task: ":1.20.1:forgeRunClient", name: "1.20.1 Forge" },
    { task: ":1.21.1:fabricRunClient", name: "1.21.1 Fabric" }, { task: ":1.21.1:neoforgeRunClient", name: "1.21.1 NeoForge" },
    { task: ":26.2:neoforgeRunClient", name: "26.2 NeoForge" }, { task: ":26.3:fabricRunClient", name: "26.3 Fabric (parked)" }, { task: ":build", name: "not a client" },
  ];
  it("branch -> Minecraft version", () => {
    expect(branchVersion("v1.20.1")).toBe("1.20.1");
    expect(branchVersion("v1.20.1-wolverine")).toBe("1.20.1");
    expect(branchVersion("release/1.21.1-x")).toBe("1.21.1");
    expect(branchVersion("assets/sam/walk-cycle")).toBeNull();
    expect(branchVersion("wip/mc26-hello")).toBeNull();
    expect(branchVersion("v1.20.10")).toBe("1.20.10");
    expect(branchVersion(null)).toBeNull();
  });
  it("default follows the branch: v1.20.1 -> 1.20.1 Fabric; 1.21.1 branch -> 1.21.1 Fabric", () => {
    expect(pickClientTask({ pinned, branch: "v1.20.1" })).toMatchObject({ task: ":1.20.1:fabricRunClient", source: "branch" });
    expect(pickClientTask({ pinned, branch: "v1.20.1-wolverine" })).toMatchObject({ task: ":1.20.1:fabricRunClient", source: "branch" });
    expect(pickClientTask({ pinned, branch: "v1.21.1-alex-x" })).toMatchObject({ task: ":1.21.1:fabricRunClient", source: "branch" });
  });
  it("a version with only a NeoForge task uses it; parked versions are never automatic", () => {
    expect(pickClientTask({ pinned, branch: "v26.2-x" })).toMatchObject({ task: ":26.2:neoforgeRunClient" });
    expect(pickClientTask({ pinned, branch: "v26.3-x" })).toMatchObject({ task: ":1.20.1:fabricRunClient", source: "pinned" });
  });
  it("no version in the branch -> first non-parked Fabric pinned task", () => {
    expect(pickClientTask({ pinned, branch: "tab/codex" })).toMatchObject({ task: ":1.20.1:fabricRunClient", source: "pinned" });
    expect(pickClientTask({ pinned })).toMatchObject({ task: ":1.20.1:fabricRunClient", source: "pinned" });
  });
  it("the user's pick wins, even a parked task", () => {
    expect(pickClientTask({ pinned, branch: "v1.20.1", chosen: ":1.20.1:forgeRunClient" })).toMatchObject({ task: ":1.20.1:forgeRunClient", source: "chosen", name: "1.20.1 Forge" });
    expect(pickClientTask({ pinned, branch: "v1.20.1", chosen: ":26.3:fabricRunClient" }).task).toBe(":26.3:fabricRunClient");
  });
  it("menu: client tasks only, parked last", () => {
    expect(runOptions({ pinned }).map((o) => o.name)).toEqual(["1.20.1 Fabric", "1.20.1 Forge", "1.21.1 Fabric", "1.21.1 NeoForge", "26.2 NeoForge", "26.3 Fabric (parked)"]);
  });
  it("assetRun: fixed task beats the menu; choices replace pinned; branch regex and default", () => {
    expect(pickClientTask({ pinned, branch: "v1.21.1", assetRun: { task: ":x:run", args: "--info" } })).toMatchObject({ task: ":x:run", args: "--info", source: "config" });
    const assetRun = { choices: [{ task: ":a:run", name: "A", branch: "^alpha" }, { task: ":b:run", name: "B", args: "--offline" }, { nope: 1 }], default: ":b:run" };
    expect(runOptions({ pinned, assetRun }).map((o) => o.name)).toEqual(["A", "B"]);
    expect(pickClientTask({ pinned, assetRun, branch: "alpha-1" })).toMatchObject({ task: ":a:run", source: "config" });
    expect(pickClientTask({ pinned, assetRun, branch: "v1.20.1" })).toMatchObject({ task: ":b:run", args: "--offline", source: "config" });
  });
  it("garbage branch regex in config is ignored", () => {
    expect(pickClientTask({ assetRun: { choices: [{ task: ":a:run", branch: "(" }] }, branch: "x" }).task).toBe(":a:run");
  });
});

describe("new suit template", () => {
  it("files land beside the shipped suits (geo + animation + texture + shiny)", () => {
    expect(suitFiles(`${H}/assets/thematic`, "nova")).toEqual({
      geo: `${H}/assets/thematic/geo/armor/nova.geo.json`, animation: `${H}/assets/thematic/animations/armor/nova.animation.json`,
      texture: `${H}/assets/thematic/textures/armor/nova.png`, shiny: `${H}/assets/thematic/textures/armor/nova_shiny.png`,
    });
    for (const f of Object.values(suitFiles(`${H}/assets/thematic`, "nova"))) expect(T(f), f).toBeTruthy();
    expect(T(suitFiles(`${H}/assets/thematic`, "nova").geo)).toMatchObject({ type: "model", kind: "armor", name: "nova" });
  });
  it("root: config, else the namespace with the most suits", () => {
    expect(suitRoot(TREE, THEMATIC)).toBe(`${H}/assets/thematic`);
    expect(suitRoot(TREE)).toBe(`${H}/assets/thematic`);
    expect(suitRoot([`${C}/assets/thematic/geo/armor/a.geo.json`, `${C}/assets/thematic/geo/armor/b.geo.json`, `${H}/assets/thematic/geo/armor/c.geo.json`])).toBe(`${C}/assets/thematic`);
    expect(suitRoot(["src/Foo.java"])).toBeNull();
  });
  it("targetDir honours suitRoot only for armor", () => {
    expect(targetDir(TREE, "model", "armor", THEMATIC)).toBe(`${H}/assets/thematic/geo/armor`);
    expect(targetDir(TREE, "animation", "armor", THEMATIC)).toBe(`${H}/assets/thematic/animations/armor`);
    expect(targetDir(TREE, "texture", "armor", THEMATIC)).toBe(`${H}/assets/thematic/textures/armor`);
    expect(targetDir([`${C}/assets/thematic/animations/entity/a.animation.json`], "animation", "entity", THEMATIC)).toBe(`${C}/assets/thematic/animations/entity`);
  });
  it("model has the armor rig and animation is keyed by file name", () => {
    const g = JSON.parse(suitModelTemplate("nova"))["minecraft:geometry"][0];
    expect(g.description.identifier).toBe("geometry.nova");
    const bones = g.bones.map((b: { name: string }) => b.name);
    for (const b of ["bipedHead", "armorHead", "bipedBody", "armorBody", "bipedRightArm", "armorRightArm", "bipedLeftArm", "armorLeftArm", "bipedRightLeg", "armorRightLeg", "armorRightBoot", "bipedLeftLeg", "armorLeftLeg", "armorLeftBoot"]) expect(bones).toContain(b);
    expect(g.bones.find((b: { name: string }) => b.name === "armorHead").parent).toBe("bipedHead");
    expect(Object.keys(JSON.parse(suitAnimationTemplate("nova")).animations)).toEqual(["nova"]);
  });
});
