import { describe, expect, it } from "vitest";
import { getAnimation, parseDoc } from "./doc";
import { clipSemantics, javaEaseName, playerDrops, serializerTick } from "./playersample";
import { breakdownAnim } from "./breakdown";
import { clipTime, sampleChannel, samplePose } from "./sample";
import type { ClipSemantics } from "./format/animation";
import parity from "./fixtures/player-parity.json";
import { THEMATIC_MAIN, WEB_ANIM_REL, nodeFs } from "./testutil";

const load = (json: string, name: string, sem: ClipSemantics) => getAnimation(parseDoc(json, "animation", sem), name)!;
const mk = (bones: string, sem: ClipSemantics, extra = '"animation_length": 2,') =>
  load(`{"format_version":"1.8.0","animations":{"t":{${extra}"bones":{${bones}}}}}`, "t", sem);
const at = (a: ReturnType<typeof mk>, bone: string, ch: "rotation" | "position" | "scale", sec: number) => sampleChannel(a, bone, ch, sec);

describe("clipSemantics(path)", () => {
  it("armor folder files are player, everything else geo", () => {
    const base = "/w/src/assets/thematic/animations";
    expect(clipSemantics(`${base}/armor/web_sling.animation.json`)).toBe("player");
    expect(clipSemantics(`${base}/armor/sub/dir/x.animation.json`)).toBe("player");
    expect(clipSemantics(`C:\\w\\assets\\thematic\\animations\\armor\\x.animation.json`)).toBe("player");
    expect(clipSemantics(`${base}/entity/gun.animation.json`)).toBe("geo");
    expect(clipSemantics(`${base}/armor_x/gun.animation.json`)).toBe("geo");
    expect(clipSemantics("/tmp/anything.animation.json")).toBe("geo");
    expect(clipSemantics(undefined)).toBe("geo");
  });
  it("resolves ease names like Easing.easeFromString (file names or enum names, any case, unknown = linear)", () => {
    expect(javaEaseName("easeInOutSine")).toBe("INOUTSINE");
    expect(javaEaseName("EASEINOUTSINE")).toBe("INOUTSINE");
    expect(javaEaseName("INOUTSINE")).toBe("INOUTSINE");
    expect(javaEaseName("inquad")).toBe("INQUAD");
    expect(javaEaseName("linear")).toBe("LINEAR");
    expect(javaEaseName("step")).toBe("STEP");
    expect(javaEaseName("constant")).toBe("CONSTANT");
    expect(javaEaseName("nonsense")).toBe("LINEAR");
    expect(javaEaseName(undefined)).toBe("LINEAR");
  });
  it("floors key times in float32 like (int)(Float.parseFloat(k) * 20)", () => {
    expect(serializerTick(0.0417)).toBe(0);
    expect(serializerTick(0.15)).toBe(3);
    expect(serializerTick(0.2083)).toBe(4);
    for (let t = 0; t < 400; t++) expect(serializerTick(t / 20)).toBe(t);
  });
});

describe("player vs geo semantics on hand-built channels", () => {
  const pos = '"b":{"position":{"0":{"vector":[0,0,0],"easing":"LINEAR"},"1":{"vector":[100,0,0],"easing":"INQUAD"},"2":{"vector":[0,0,0],"easing":"LINEAR"}}}';
  it("the EARLIER key's easing governs the span leaving it (geo: the arriving key's)", () => {
    const p = mk(pos, "player");
    expect(at(p, "b", "position", 0.5)![0]).toBeCloseTo(50, 3); // key0 LINEAR
    expect(at(p, "b", "position", 1.5)![0]).toBeCloseTo(75, 3); // key1 INQUAD: 100 * (1 - 0.25)
    const g = mk(pos.replace(/INQUAD/, "easeInQuad"), "geo");
    expect(at(g, "b", "position", 0.5)![0]).toBeCloseTo(25, 3); // arriving key1 easeInQuad
    expect(at(g, "b", "position", 1.5)![0]).toBeCloseTo(50, 3);
  });
  it("lerp_mode catmullrom: position -> INOUTSINE, rotation -> LINEAR", () => {
    const k = (ch: string) => `"b":{"${ch}":{"0":{"vector":[0,0,0],"lerp_mode":"catmullrom"},"1":{"vector":[10,0,0]}}}`;
    const p = mk(k("position"), "player");
    expect(at(p, "b", "position", 0.25)![0]).toBeCloseTo(10 * ((1 - Math.cos(Math.PI / 4)) / 2), 4);
    const r = mk(k("rotation"), "player");
    expect(at(r, "b", "rotation", 0.25)![0]).toBeCloseTo(2.5, 4);
  });
  it("`easing` overrides lerp_mode, easingArgs are ignored", () => {
    const a = mk('"b":{"position":{"0":{"vector":[0,0,0],"lerp_mode":"catmullrom","easing":"INQUAD","easingArgs":[3]},"1":[8,0,0]}}', "player");
    expect(at(a, "b", "position", 0.5)![0]).toBeCloseTo(2, 4); // 8 * 0.25
    const back = mk('"b":{"position":{"0":{"vector":[0,0,0],"easing":"INBACK","easingArgs":[5]},"1":[1,0,0]}}', "player");
    const t = 0.5, n = 1.70158; // default back, not the arg
    expect(at(back, "b", "position", 0.5)![0]).toBeCloseTo(t * t * ((n + 1) * t - n), 4);
  });
  it("key times are floored to ticks", () => {
    const a = mk('"b":{"position":{"0.0417":[10,0,0],"1":[20,0,0]}}', "player");
    expect(at(a, "b", "position", 0.5)![0]).toBeCloseTo(15, 4); // tick 0 -> 20
    const g = mk('"b":{"position":{"0.0417":[10,0,0],"1":[20,0,0]}}', "geo");
    expect(at(g, "b", "position", 0.5)![0]).not.toBeCloseTo(15, 2);
  });
  it("eases from rest to a first key that is not at tick 0 (geo holds the first value)", () => {
    const j = '"b":{"position":{"1":[40,0,0],"2":[10,0,0]}}';
    expect(at(mk(j, "player"), "b", "position", 0.5)![0]).toBeCloseTo(20, 4); // 40 * inOutSine(0.5)
    expect(at(mk(j, "geo"), "b", "position", 0.5)![0]).toBeCloseTo(40, 4);
  });
  it("rotation takes the short way round (lerpAngle); position does not", () => {
    const j = (ch: string) => `"b":{"${ch}":{"0":[0,0,0],"1":[350,0,0],"2":[0,0,0]}}`;
    expect(at(mk(j("rotation"), "player"), "b", "rotation", 0.5)![0]).toBeCloseTo(-5, 3);
    expect(at(mk(j("rotation"), "geo"), "b", "rotation", 0.5)![0]).toBeCloseTo(175, 3);
    expect(at(mk(j("position"), "player"), "b", "position", 0.5)![0]).toBeCloseTo(175, 3);
  });
  it("scale is not read by the player serializer", () => {
    const a = mk('"b":{"scale":{"0":[1,1,1],"1":[2,2,2]},"rotation":[1,2,3]}', "player");
    expect(at(a, "b", "scale", 0.5)).toBeUndefined();
    expect(samplePose(a, 0.5).b.scale).toBeUndefined();
    expect(samplePose(a, 0.5).b.rotation).toEqual([1, 2, 3]);
    expect(samplePose(mk('"b":{"scale":{"0":[1,1,1],"1":[2,2,2]}}', "geo"), 0.5).b.scale![0]).toBeCloseTo(1.5);
  });
  it("Blockbench ease names work on the player path; unknown names are linear (nothing is dropped)", () => {
    const j = (e: string) => `"b":{"position":{"0":{"vector":[0,0,0],"easing":"${e}"},"1":[8,0,0]}}`;
    expect(at(mk(j("easeInQuad"), "player"), "b", "position", 0.5)![0]).toBeCloseTo(2, 4);
    expect(at(mk(j("EASEINQUAD"), "player"), "b", "position", 0.5)![0]).toBeCloseTo(2, 4);
    expect(at(mk(j("linear"), "player"), "b", "position", 0.5)![0]).toBeCloseTo(4, 4);
    expect(at(mk(j("bogus"), "player"), "b", "position", 0.5)![0]).toBeCloseTo(4, 4);
    const a = mk('"b":{"rotation":{"0":[5,0,0],"1":{"vector":[10,0,0],"easing":"easeInOutSine"},"2":[20,0,0]},"position":{"0":[1,0,0],"1":[2,0,0]}}', "player");
    expect(at(a, "b", "rotation", 1.5)![0]).toBeCloseTo(15, 4);
    expect(at(a, "b", "position", 0.5)![0]).toBeCloseTo(1.5, 4);
    expect(playerDrops(a)).toEqual([]);
  });
  it("reports what the serializer still ignores: scale channels and non-numeric components", () => {
    const a = mk('"b":{"scale":[2,2,2],"position":{"0":[1,0,0],"1":["math.sin(1)",0,0]}}', "player");
    expect(playerDrops(a).map((d) => `${d.bone}.${d.channel}`).sort()).toEqual(["b.position", "b.scale"]);
    expect(playerDrops(mk('"b":{"rotation":[1,2,3]}', "player"))).toEqual([]);
  });
  it("loops are endTick+1 ticks long and blend the last key toward the first", () => {
    const a = mk('"b":{"position":{"0":{"vector":[0,0,0]},"0.5":{"vector":[10,0,0]}}}', "player", '"animation_length": 1, "loop": true,');
    expect(clipTime(a, 1.05)).toBeCloseTo(0, 6);
    expect(clipTime(a, 1.0)).toBeCloseTo(1.0, 6);
    expect(at(a, "b", "position", 0.75)![0]).toBeCloseTo(10 * (1 - 5 / 11), 4); // tick 15 on 10 -> 21
  });
  it("breakdown followCurve uses the earlier key's ease for player clips (arriving key's for geo)", () => {
    const j = '"b":{"position":{"0":{"vector":[0,0,0],"easing":"INQUAD"},"1":{"vector":[100,0,0],"easing":"LINEAR"}}}';
    const o = { tA: 0, tB: 1, factor: 0.5, followCurve: true, channels: ["position" as const] };
    expect(breakdownAnim(mk(j, "player"), o).b.position![0]).toBeCloseTo(25, 3);
    expect(breakdownAnim(mk(j.replace("INQUAD", "easeInQuad").replace("LINEAR", "easeInQuad"), "geo"), o).b.position![0]).toBeCloseTo(25, 3);
    expect(breakdownAnim(mk(j.replace("INQUAD", "easeInQuad").replace("LINEAR", "linear"), "geo"), o).b.position![0]).toBeCloseTo(50, 3);
  });
  it("geo behaviour is unchanged for docs without semantics", () => {
    const a = load('{"animations":{"t":{"animation_length":1,"bones":{"b":{"position":{"0":[0,0,0],"1":{"vector":[10,0,0],"easing":"easeInQuad"}}}}}}}', "t", "geo");
    expect(a.semantics).toBe("geo");
    expect(sampleChannel(a, "b", "position", 0.5)![0]).toBeCloseTo(2.5, 6);
  });
});

describe("parity with the game's own GeckoLibSerializer + KeyframeAnimationPlayer", () => {
  const text = JSON.stringify(parity.cases);
  const mix = load(text, "mix", "player");
  const lp = load(text, "lp", "player");
  const rotIdx = 0; // pitch
  it("matches Java samples (hand-built mixed easing, wrap, catmullrom, first key > 0, Blockbench ease names on head, loop)", () => {
    let n = 0;
    for (const [name, part, tick, delta, rotX, posX] of parity.expected as [string, string, number, number, number, number | null][]) {
      const a = name === "mix" ? mix : lp;
      const t = (tick + delta) / 20;
      const rot = (sampleChannel(a, part, "rotation", t)?.[rotIdx] ?? 0) * (part === "head" ? -1 : 1); // the serializer negates X/Y of head/torso
      expect(rot, `${name} ${part} rot @${tick}+${delta}`).toBeCloseTo(rotX, 2);
      if (posX !== null) expect(sampleChannel(a, part, "position", t)![0], `${name} ${part} pos @${tick}+${delta}`).toBeCloseTo(posX, 2);
      n++;
    }
    expect(n).toBeGreaterThan(150);
  });
});

describe("real web_sling.animation.json (read-only)", async () => {
  const fs = await nodeFs();
  const file = `${THEMATIC_MAIN}/${WEB_ANIM_REL}`;
  const have = fs.existsSync(file);
  it.skipIf(!have)("web_sling_right matches Java samples; web_air keeps its armor bones", () => {
    const text = fs.readFileSync(file, "utf8");
    const a = load(text, "web_sling_right", "player");
    // [bone, channel, tick, delta, x, y, z] from the game's KeyframeAnimationPlayer (2026-10-12); loop period 25 ticks
    const rows: [string, "rotation" | "position", number, number, [number, number, number]][] = [
      ["armorRightLeg", "rotation", 0, 0, [10, -2, 5]],
      ["armorRightLeg", "rotation", 0, 0.5, [10.825, -2, 5.2357]],
      ["armorRightLeg", "rotation", 4, 0.5, [15.975, -2, 6.707]],
      ["armorRightLeg", "rotation", 13, 0, [8.35, -2, 4.5287]],
      ["armorRightLeg", "position", 4, 0.5, [0, 0, 0.488]],
      ["armorRightLeg", "position", 9, 0.5, [0, 0, 0.6467]],
      ["armorLeftArm", "rotation", 4, 0.5, [48.8285, 0, -17.414]],
      ["armorLeftArm", "rotation", 13, 0.5, [39.1715, 0, -12.586]],
      ["armorLeftArm", "rotation", 25, 0.5, [42.9428, 0, -19.8047]],
    ];
    let checked = 0;
    for (const [bone, ch, tick, d, want] of rows) {
      const got = sampleChannel(a, bone, ch, (tick + d) / 20);
      if (!got) continue; // a bone/axis naming mismatch must not hide as a pass: counted below
      checked++;
      if (ch === "position") expect(got[2], `${bone} ${ch} @${tick}+${d}`).toBeCloseTo(want[2], 2);
      else want.forEach((w, i) => expect(got[i], `${bone} ${ch}[${i}] @${tick}+${d}`).toBeCloseTo(w, 2));
    }
    expect(checked).toBe(rows.length);
    const air = load(text, "web_air", "player");
    expect(samplePose(air, 0.3).armorRightLeg?.rotation).toBeDefined();
    const airGeo = load(text, "web_air", "geo");
    expect(samplePose(airGeo, 0.3).armorRightLeg?.rotation).toBeDefined();
  });
});
