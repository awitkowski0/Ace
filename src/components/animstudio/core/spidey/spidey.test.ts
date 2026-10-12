import { describe, expect, it } from "vitest";
import { webKitCopy } from "../testutil";
import { getAnimations, parseDoc, serialize } from "../doc";
import { parsePoseSet } from "./poseSet";
import { clipInfos } from "./clips";
import { validateSpidey } from "./validate";
import { findPoseSets, armorAnimLocation, type FsLike } from "./discovery";


describe("pose set parser", () => {
  it("parses modes/clips and ignores _ keys", () => {
    const s = parsePoseSet(JSON.stringify({ _comment: "x", default: true, modes: [{ mode: "swing", when: "line", right: "a_r", left: "a_l", _comment: "q" }, { mode: "bad" }], clips: { _doc: { role: "x" }, a_r: { role: "r", playback: "loop", aimed: ["right_arm"], mirrored: true, spin: { axis: "front_flip" } } } }), "web");
    expect(s.isDefault).toBe(true);
    expect(s.modes).toHaveLength(1);
    expect(s.errors).toHaveLength(1);
    expect(Object.keys(s.clips)).toEqual(["a_r"]);
    expect(s.clips.a_r.spin).toEqual({ axis: "front_flip", turns: 1, ticks: 0 });
    expect(parsePoseSet("{nope").errors.length).toBe(1);
  });
});

describe("discovery", () => {
  it("finds pose sets in sibling resource roots", async () => {
    const tree: Record<string, string[] | string> = {
      "/p/src": ["common", "packs", "build"],
      "/p/src/common": ["resources"], "/p/src/common/resources": ["assets"], "/p/src/common/resources/assets": ["thematic"],
      "/p/src/packs": ["heroes"], "/p/src/packs/heroes": ["resources"], "/p/src/packs/heroes/resources": ["assets"],
      "/p/src/packs/heroes/resources/assets": ["thematic", "other"], "/p/src/packs/heroes/resources/assets/thematic": ["poses", "geo"],
      "/p/src/packs/heroes/resources/assets/thematic/poses": ["web.json", "readme.txt"],
      "/p/src/packs/heroes/resources/assets/other": ["poses"], "/p/src/packs/heroes/resources/assets/other/poses": ["x.json"],
      "/p/src/packs/heroes/resources/assets/thematic/poses/web.json": '{"modes":[],"clips":{}}',
    };
    const fs: FsLike = {
      async listDir(p) {
        const e = tree[p];
        if (!Array.isArray(e)) throw new Error("ENOENT " + p);
        return e.map((name) => ({ name, isDir: Array.isArray(tree[p + "/" + name]) }));
      },
      async readFile(p) {
        const t = tree[p];
        if (typeof t !== "string") throw new Error("ENOENT");
        return t;
      },
    };
    const found = await findPoseSets("/p/src/common/resources/assets/thematic/animations/armor/web_sling.animation.json", fs);
    expect(found.map((f) => f.path)).toEqual(["/p/src/packs/heroes/resources/assets/thematic/poses/web.json"]);
    expect(await findPoseSets("/p/src/common/resources/assets/thematic/animations/item/x.animation.json", fs)).toEqual([]);
    expect(armorAnimLocation("/a/b/assets/ns/animations/armor/x.animation.json")?.namespace).toBe("ns");
  });
});

describe("validators vs the real web kit (read-only temp copy of the MAIN checkout)", async () => {
  const kit = await webKitCopy();
  const have = !!kit;
  const ANIM = kit?.anim ?? "", POSES = kit?.poses ?? "";
  const fs = { readFileSync: (f: string, _e: string) => (f === ANIM ? kit!.animText : kit!.posesText) };
  it.skipIf(!have)("web_sling.animation.json + poses/web.json: only the Java test's own failures are errors (see javaparity.test.ts)", () => {
    const doc = parseDoc(fs.readFileSync(ANIM, "utf8"), "animation");
    const set = parsePoseSet(fs.readFileSync(POSES, "utf8"), "web", POSES);
    expect(set.errors).toEqual([]);
    const problems = validateSpidey(doc, [set]);
    const errors = problems.filter((p) => p.severity === "error");
    console.log(`web_sling: ${getAnimations(doc).length} clips, ${problems.length} problems (${errors.length} errors)`, problems.slice(0, 8).map((p) => `${p.severity}:${p.code}:${p.anim}:${p.message}`));
    // the main checkout is edited live; loops that do not close are exactly what WebSlingAnimationsJsonTest.loopsCloseOnThemselves would fail on
    expect(errors.filter((p) => p.code !== "loop-open").map((p) => `${p.code} ${p.anim} ${p.message}`)).toEqual([]);
    const info = clipInfos(getAnimations(doc), [set]);
    expect(info.get("web_land")).toMatchObject({ poseOnly: true, mirrored: true, playback: "one_shot" });
    expect(info.get("web_sling_right")).toMatchObject({ playback: "loop", poseOnly: false, aimed: ["right_arm"] });
    expect(info.get("web_sling_right")!.usedByStates).toEqual(["line"]);
    expect(serialize(doc)).toBe(fs.readFileSync(ANIM, "utf8"));
  });

  it.skipIf(!have)("detects deliberate breakage and offers fixes", async () => {
    const { setKeyValue, addKeyframe, deleteKeyframes } = await import("../doc");
    const text = fs.readFileSync(ANIM, "utf8");
    const set = parsePoseSet(fs.readFileSync(POSES, "utf8"), "web");
    let doc = parseDoc(text, "animation");
    doc = addKeyframe(doc, { anim: "web_tuck", bone: "armorBody", channel: "rotation", time: 0.05, value: [1, 0, 0] });
    doc = addKeyframe(doc, { anim: "web_run", bone: "armorHead", channel: "rotation", time: 0.0833, value: [1, 0, 0] });
    doc = setKeyValue(doc, { anim: "web_climb", bone: "swing_pivot", channel: "position", time: 0, value: [0, 0, 0] });
    doc = deleteKeyframes(doc, { anim: "web_cling", keys: [{ bone: "swing_pivot", channel: "position", time: 0 }] });
    const ps = validateSpidey(doc, [set]);
    const codes = new Set(ps.map((p) => p.code));
    for (const c of ["trick-body", "off-grid", "wrong-hinge", "no-swing-pivot"]) expect(codes.has(c), c).toBe(true);
    // applying the quick fixes clears those problems
    let fixed = doc;
    for (const p of ps.filter((p) => ["off-grid", "wrong-hinge", "no-swing-pivot"].includes(p.code) && p.fix)) fixed = p.fix!.apply(fixed);
    const after = new Set(validateSpidey(fixed, [set]).map((p) => p.code));
    expect(after.has("wrong-hinge")).toBe(false);
    expect(after.has("no-swing-pivot")).toBe(false);
    expect(after.has("off-grid")).toBe(false);
  });
});
