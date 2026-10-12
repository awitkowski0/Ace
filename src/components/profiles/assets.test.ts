import { describe, expect, it } from "vitest";
import { animationTemplate, branchPrefix, classifyAsset, cleanBranchName, duplicateName, groupAssets, suggestMessage, targetDir, userSlug } from "./assets";

const A = "src/common/resources/assets/thematic";
describe("classifyAsset", () => {
  it("models, animations, textures by directory and kind", () => {
    expect(classifyAsset(`${A}/geo/entity/nthmace.geo.json`)).toMatchObject({ type: "model", kind: "entity", name: "nthmace", sub: "" });
    expect(classifyAsset(`${A}/animations/armor/hero/walk.animation.json`)).toMatchObject({ type: "animation", kind: "armor", name: "walk", sub: "hero" });
    expect(classifyAsset(`${A}/textures/block/stone.png`)).toMatchObject({ type: "texture", kind: "block" });
    expect(classifyAsset(`${A}/models/item/heroes/cape.json`)).toMatchObject({ type: "model", kind: "item", sub: "heroes" });
    expect(classifyAsset(`${A}/sounds/mob/hit.ogg`)).toMatchObject({ type: "sound", kind: null });
    expect(classifyAsset(`${A}/lang/en_us.json`)).toMatchObject({ type: "lang" });
    expect(classifyAsset(`${A}/models/animations/superhero_landing.pose`)).toMatchObject({ type: "pose" });
  });
  it("finds assets outside assets/ (bbmodel anywhere, .geo, textures dir)", () => {
    expect(classifyAsset("guns/black widow gun.bbmodel")).toMatchObject({ type: "model", name: "black widow gun" });
    expect(classifyAsset("guns/.geo/m4.geo.json")).toMatchObject({ type: "model" });
    expect(classifyAsset("guns/animations/alfreds_shotgun.animation.json")).toMatchObject({ type: "animation" });
    expect(classifyAsset("guns/textures/m4.png")).toMatchObject({ type: "texture" });
    expect(classifyAsset("cleaned_sounds/friday_the_13th/x.ogg")).toMatchObject({ type: "sound" });
  });
  it("rejects code, config, docs and build output", () => {
    for (const p of ["src/main/java/Foo.java", "build.gradle", "gradle.properties", "README.md", "scripts/x.py", "docs/visual-diff-block-items/a.png",
      "build/resources/assets/thematic/geo/x.geo.json", "versions/1.20.1/build/data/a.json", ".claude/worktrees/a/guns/x.bbmodel", "src/test/resources/tabula/a.json", "src/packs/heroes/meta/pack.json"])
      expect(classifyAsset(p), p).toBeNull();
  });
  it("other asset-folder files are assets but not in the tree", () => {
    const i = classifyAsset(`${A}/blockstates/acacia_chair.json`)!;
    expect(i.type).toBe("other");
    expect(i.inTree).toBe(false);
    expect(classifyAsset(`${A}/shaders/x.fsh`)?.type).toBe("other");
  });
});

describe("groupAssets", () => {
  const files = [`${A}/geo/entity/b.geo.json`, `${A}/geo/entity/a.geo.json`, `${A}/animations/entity/a.animation.json`, `${A}/animations/armor/z.animation.json`, `${A}/sounds/s.ogg`, `${A}/blockstates/x.json`, "guns/.geo/m4.geo.json"];
  it("groups by kind then type, sorted, hides other", () => {
    const g = groupAssets(files);
    expect(g.map((x) => x.label)).toEqual(["Armor", "Entities", "Sounds", "Other"]);
    const ent = g[1];
    expect(ent.sections.map((s) => s.label)).toEqual(["Models", "Animations"]);
    expect(ent.sections[0].files.map((f) => f.info.name)).toEqual(["a", "b"]);
    expect(g[2].sections[0].label).toBeNull();
  });
  it("filters by query", () => {
    expect(groupAssets(files, "m4").flatMap((g) => g.sections.flatMap((s) => s.files)).length).toBe(1);
  });
});

describe("suggestMessage", () => {
  it("single file", () => {
    expect(suggestMessage([{ path: `${A}/animations/entity/web_wall_hold.animation.json`, kind: "untracked" }])).toBe("Add web_wall_hold animation");
    expect(suggestMessage([{ path: `${A}/geo/entity/spider.geo.json`, kind: "modified" }])).toBe("Update spider model");
  });
  it("several", () => {
    const m = (n: string) => ({ path: `${A}/animations/entity/${n}.animation.json`, kind: "modified" });
    expect(suggestMessage([m("a"), m("b")])).toBe("Update a, b animations");
    expect(suggestMessage([m("a"), m("b"), m("c"), m("d")])).toBe("Update 4 animations");
    expect(suggestMessage([m("a"), { path: `${A}/textures/block/t.png`, kind: "added" }])).toBe("Update 2 assets");
  });
  it("ignores code", () => {
    expect(suggestMessage([{ path: "src/Foo.java", kind: "modified" }])).toBe("");
  });
});

describe("branches + templates", () => {
  it("slug and prefix", () => {
    expect(userSlug("Sam O'Neil", "x@y.z")).toBe("sam-o-neil");
    expect(userSlug("", "sam@x.com")).toBe("sam");
    expect(userSlug("", "")).toBe("me");
    expect(branchPrefix("sam")).toBe("assets/sam/");
  });
  it("cleanBranchName", () => {
    expect(cleanBranchName("assets/sam/", "assets/sam/Walk Cycle!")).toBe("assets/sam/walk-cycle");
    expect(cleanBranchName("assets/sam/", "  new anim ")).toBe("assets/sam/new-anim");
    expect(cleanBranchName("assets/sam/", "assets/sam/")).toBe("");
  });
  it("targetDir + names", () => {
    expect(targetDir([`${A}/animations/entity/a.animation.json`], "animation", "entity")).toBe(`${A}/animations/entity`);
    expect(targetDir([`${A}/geo/entity/a.geo.json`], "animation", "item")).toBe(`${A}/animations/item`);
    expect(targetDir(["src/Foo.java"], "model", null)).toBeNull();
    expect(duplicateName("x/walk.animation.json", "run")).toBe("x/run.animation.json");
    expect(JSON.parse(animationTemplate("run")).animations["animation.run.idle"]).toBeTruthy();
  });
});

describe("pack editor files are assets", () => {
  it("suits, HUDs, flight profiles and guide pages get their own groups", () => {
    const r = "src/packs/heroes/resources";
    expect(classifyAsset(`${r}/data/thematic/armors/avengers/iron_man.json`)).toMatchObject({ type: "suit", name: "iron_man", sub: "avengers", inTree: true });
    expect(classifyAsset(`${r}/data/thematic/huds/gun_default.js`)).toMatchObject({ type: "hud", name: "gun_default" });
    expect(classifyAsset(`${r}/data/thematic/flight_profiles/repulsor.json`)).toMatchObject({ type: "flight" });
    expect(classifyAsset(`${r}/assets/thematic/guide/thematic/en_us/entries/suits/ultron.json`)).toMatchObject({ type: "guide", name: "ultron", sub: "suits" });
    expect(classifyAsset(`${r}/data/thematic/abilities/ultron/hive_control.js`)).toBeNull();
    expect(classifyAsset(`${r}/data/thematic/armors/readme.md`)).toBeNull();
    const g = groupAssets([`${r}/data/thematic/armors/avengers/iron_man.json`, `${r}/data/thematic/huds/gun_default.js`]).map((x) => x.label);
    expect(g).toEqual(["Suits", "HUDs"]);
  });
});
