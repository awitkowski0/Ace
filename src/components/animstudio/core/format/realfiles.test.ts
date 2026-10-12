import { describe, expect, it } from "vitest";
import { BB_ROOTS, THEMATIC_ROOTS, nodeFs, walk } from "../testutil";
import { detectStyle, derive, emitJson, parseJson, type JNode } from "./json";
import { getAnimations, getBb, getGeo, minimalEdit, moveCube, parseDoc, serialize, setKeyValue, deleteKeyframes, addKeyframe, type DocKind } from "../doc";
import { sampleChannelRaw } from "../sample";
import { CHANNELS } from "./animation";

function relayout(n: JNode): JNode {
  if (n.t === "o") return derive(n, n.entries.map((e) => ({ ...e, value: relayout(e.value) })));
  if (n.t === "a") return derive(n, n.items.map(relayout));
  return n;
}

describe("bbmodel files", async () => {
  const fs = await nodeFs();
  const files: string[] = [];
  for (const r of BB_ROOTS) files.push(...(await walk(r, [".bbmodel"])));
  const uniq = [...new Set(files)];
  it.skipIf(uniq.length === 0)("round-trip byte-identically (verbatim + full re-layout) and parse", () => {
    const re: string[] = [];
    for (const f of uniq) {
      const text: string = fs.readFileSync(f, "utf8");
      const doc = parseDoc(text, "bbmodel");
      expect(serialize(doc), f).toBe(text);
      const p = parseJson(text);
      const st = detectStyle(text, p.start, p.end);
      if (st.head + emitJson(relayout(p.root), st) + st.tail !== text) re.push(f);
      const m = getBb(doc);
      expect(m.elements.length, f).toBeGreaterThan(0);
      for (const a of getAnimations(doc)) for (const b of a.bones.values()) for (const ch of CHANNELS) if (b[ch]) sampleChannelRaw(b[ch]!, 0.1);
    }
    console.log(`bbmodel files=${uniq.length} relayoutMismatch=${re.length}`, re);
  });
  it.skipIf(uniq.length === 0)("editing a bbmodel keyframe is local and re-parses", () => {
    const f = uniq.find((x) => x.endsWith("manhunter.bbmodel"));
    if (!f) return;
    const text: string = fs.readFileSync(f, "utf8");
    const doc = parseDoc(text, "bbmodel");
    const a = getAnimations(doc).find((x) => [...x.bones.values()].some((b) => b.rotation))!;
    const bone = [...a.bones.values()].find((b) => b.rotation)!;
    const t = bone.rotation!.keys[1].time;
    const out = serialize(setKeyValue(doc, { anim: a.name, bone: bone.name, channel: "rotation", time: t, value: [12.5, 0, 0] }));
    const e = minimalEdit(text, out);
    expect(e.end - e.start).toBeLessThan(40);
    const re = getAnimations(parseDoc(out, "bbmodel")).find((x) => x.name === a.name)!;
    expect(re.bones.get(bone.name)!.rotation!.keys.find((k) => k.time === t)!.value).toEqual([12.5, 0, 0]);
    const added = serialize(addKeyframe(doc, { anim: a.name, bone: bone.name, channel: "rotation", time: t + 0.01, value: [1, 2, 3] }));
    const re2 = getAnimations(parseDoc(added, "bbmodel")).find((x) => x.name === a.name)!;
    expect(re2.bones.get(bone.name)!.rotation!.keys.length).toBe(bone.rotation!.keys.length + 1);
    const del = serialize(deleteKeyframes(doc, { anim: a.name, keys: [{ bone: bone.name, channel: "rotation", time: t }] }));
    expect(getAnimations(parseDoc(del, "bbmodel")).find((x) => x.name === a.name)!.bones.get(bone.name)!.rotation!.keys.length).toBe(bone.rotation!.keys.length - 1);
  });
});

describe("local edits on real files", async () => {
  const fs = await nodeFs();
  const anim: string[] = [];
  const geo: string[] = [];
  for (const r of THEMATIC_ROOTS) {
    anim.push(...(await walk(r, [".animation.json"])));
    geo.push(...(await walk(r, [".geo.json"])));
  }
  it.skipIf(anim.length === 0)("setKeyValue on a real keyframe changes only that region", () => {
    let tested = 0;
    const wide: string[] = [];
    for (const f of anim.filter((_, i) => i % 3 === 0)) {
      const text: string = fs.readFileSync(f, "utf8");
      const doc = parseDoc(text, "animation");
      const a = getAnimations(doc).find((x) => [...x.bones.values()].some((b) => b.rotation?.shape === "keys" && b.rotation.keys.length > 1));
      if (!a) continue;
      const b = [...a.bones.values()].find((x) => x.rotation?.shape === "keys" && x.rotation.keys.length > 1)!;
      const k = b.rotation!.keys[1];
      const out = serialize(setKeyValue(doc, { anim: a.name, bone: b.name, channel: "rotation", time: k.time, value: [k.value[0] as number, (k.value[1] as number) + 1.5, 7] }));
      const e = minimalEdit(text, out);
      tested++;
      if (e.end - e.start > 120 || e.text.length > 160) wide.push(f);
      const back = getAnimations(parseDoc(out, "animation")).find((x) => x.name === a.name)!;
      expect(back.bones.get(b.name)!.rotation!.keys.find((q) => Math.abs(q.time - k.time) < 1e-6)!.value[2]).toBe(7);
    }
    console.log(`edited ${tested} animation files, wide diffs: ${wide.length}`, wide.slice(0, 5));
    expect(wide.length).toBeLessThanOrEqual(Math.ceil(tested * 0.02));
  }, 120000);

  it.skipIf(geo.length === 0)("moveCube on real geo files changes only that region", () => {
    let tested = 0;
    const wide: string[] = [];
    for (const f of geo.filter((_, i) => i % 40 === 0)) {
      const text: string = fs.readFileSync(f, "utf8");
      const doc = parseDoc(text, "geo");
      const g = getGeo(doc).geometries[0];
      const b = g?.bones.find((x) => x.cubes.length);
      if (!b) continue;
      const out = serialize(moveCube(doc, { bone: b.name, index: 0, delta: [1, 0, 0] }));
      const e = minimalEdit(text, out);
      tested++;
      if (e.end - e.start > 250 || e.text.length > 250) wide.push(f);
    }
    console.log(`edited ${tested} geo files, wide diffs: ${wide.length}`, wide.slice(0, 5));
    expect(wide.length).toBeLessThanOrEqual(Math.ceil(tested * 0.02));
  }, 120000);
});

describe("parse performance", async () => {
  const fs = await nodeFs();
  const big = "/Users/alexw/IdeaProjects/Thematic-Collections/src/packs/heroes/resources/assets/thematic/geo/armor/punisher_2099.geo.json";
  it.skipIf(!fs.existsSync(big))("parses the largest Thematic geo in < 300 ms", () => {
    const text: string = fs.readFileSync(big, "utf8");
    parseDoc(text, "geo"); // warm
    const t0 = performance.now();
    const doc = parseDoc(text, "geo");
    const t1 = performance.now();
    const geo = getGeo(doc);
    const t2 = performance.now();
    const cubes = geo.geometries[0].bones.reduce((n, b) => n + b.cubes.length, 0);
    console.log(`punisher_2099.geo.json ${(text.length / 1024).toFixed(0)} KiB: parse ${(t1 - t0).toFixed(1)} ms, typed ${(t2 - t1).toFixed(1)} ms (${geo.geometries[0].bones.length} bones, ${cubes} cubes)`);
    expect(t2 - t0).toBeLessThan(300);
  });
});
