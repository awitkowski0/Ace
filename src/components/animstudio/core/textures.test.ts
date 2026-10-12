import { describe, expect, it } from "vitest";
import { parseDoc, serialize, minimalEdit, getBb } from "./doc";
import { addBbTexture, bbTextureInfos, bytesToDataUrl, dataUrlToBytes, discoverVariants, faceTextureOf, mergeGeoTextures, pngSize, removeBbTexture, setBbFaceTexture, setBbTexture, visibleLayers } from "./textures";
import { setBbBoxUv, setBbFaces } from "./bbedit";

// 2x1 RGBA png (hand-built IHDR is enough for pngSize / data URL round trips)
const PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 32, 0, 0, 0, 16, 8, 6, 0, 0, 0, 0, 0, 0, 0]);
const URL1 = bytesToDataUrl(PNG);

const face = (u: number[], t: number | null = 0) => ({ uv: u, texture: t });
const bb = (extra: Record<string, unknown> = {}) => JSON.stringify({
  meta: { format_version: "4.10", model_format: "bedrock", box_uv: false },
  name: "m", resolution: { width: 16, height: 16 },
  elements: [
    { name: "a", uuid: "e1", from: [0, 0, 0], to: [4, 4, 4], origin: [0, 0, 0], faces: { north: face([0, 0, 4, 4]), east: face([4, 0, 8, 4]), south: face([8, 0, 12, 4], null), west: face([0, 4, 4, 8], 1), up: face([4, 4, 8, 8]), down: face([8, 4, 12, 8]) } },
    { name: "b", uuid: "e2", from: [4, 0, 0], to: [8, 4, 4], origin: [0, 0, 0], box_uv: true, uv_offset: [0, 0], faces: { north: face([4, 4, 8, 8], 1) } },
  ],
  outliner: [{ name: "g", uuid: "g1", origin: [0, 0, 0], children: ["e1", "e2"] }],
  textures: [
    { name: "a.png", id: "0", width: 32, height: 16, uv_width: 16, uv_height: 16, particle: true, visible: true, uuid: "t0", source: URL1 },
    { name: "b.png", id: "1", width: 32, height: 16, uv_width: 16, uv_height: 16, particle: false, visible: true, uuid: "t1", source: URL1 },
  ],
  ...extra,
}, null, 2) + "\n";

const load = (t = bb()) => parseDoc(t, "bbmodel");

describe("png helpers", () => {
  it("reads the size and round-trips data URLs", () => {
    expect(pngSize(PNG)).toEqual({ w: 32, h: 16 });
    expect(pngSize(new Uint8Array(30))).toBeNull();
    expect(Array.from(dataUrlToBytes(URL1)!)).toEqual(Array.from(PNG));
  });
});

describe("bbmodel texture commands", () => {
  it("lists textures with their flags", () => {
    const t = bbTextureInfos(load());
    expect(t.map((x) => [x.name, x.visible, x.particle, x.width, x.height])).toEqual([["a.png", true, true, 32, 16], ["b.png", true, false, 32, 16]]);
  });
  it("adds an embedded texture after the last one, copying its layout, touching nothing else", () => {
    const d = load();
    const before = serialize(d);
    const n = addBbTexture(d, { name: "c.png", source: URL1 });
    const infos = bbTextureInfos(n);
    expect(infos).toHaveLength(3);
    expect(infos[2]).toMatchObject({ name: "c.png", width: 32, height: 16, visible: true, particle: false });
    const after = serialize(n);
    const e = minimalEdit(before, after);
    expect(before.slice(0, e.start)).toBe(after.slice(0, e.start));
    expect(before.slice(e.end)).toBe(after.slice(after.length - (before.length - e.end)));
    const raw = JSON.parse(after).textures[2];
    expect(raw.id).toBe("2");
    expect(raw.source.startsWith("data:image/png;base64,")).toBe(true);
    expect(Object.keys(raw)).toEqual(Object.keys(JSON.parse(before).textures[1]));
  });
  it("adds to a model without textures using Blockbench's key layout", () => {
    const d = load(bb({ textures: undefined }));
    const n = addBbTexture(d, { name: "x.png", source: URL1 });
    const raw = JSON.parse(serialize(n)).textures[0];
    expect(raw).toMatchObject({ name: "x.png", id: "0", file_format: "png", render_mode: "default", visible: true, internal: true, saved: true, width: 32, height: 16, uv_width: 16 });
  });
  it("removes a texture: its faces become untextured, later indices shift down", () => {
    const n = removeBbTexture(load(), { index: 0 });
    const j = JSON.parse(serialize(n));
    expect(j.textures).toHaveLength(1);
    expect(j.textures[0].id).toBe("0");
    expect(j.elements[0].faces.north.texture).toBeUndefined();
    expect(j.elements[0].faces.west.texture).toBe(0); // was 1
    expect(j.elements[0].faces.south.texture).toBeNull(); // disabled faces stay disabled
    expect(j.elements[1].faces.north.texture).toBe(0);
  });
  it("edits visibility / name in place", () => {
    const n = setBbTexture(load(), { index: 1, patch: { visible: false, name: "skin2.png" } });
    expect(bbTextureInfos(n)[1]).toMatchObject({ visible: false, name: "skin2.png" });
    expect(serialize(setBbTexture(load(), { index: 1, patch: { visible: true } }))).toBe(bb());
  });
  it("assigns a texture to chosen faces of several cubes", () => {
    const d = setBbFaceTexture(load(), { cubes: [{ group: "g", index: 0 }, { group: "g", index: 1 }], faces: ["north", "up"], texture: 1 });
    const j = JSON.parse(serialize(d));
    expect(j.elements[0].faces.north.texture).toBe(1);
    expect(j.elements[0].faces.up.texture).toBe(1);
    expect(j.elements[0].faces.east.texture).toBe(0);
    expect(j.elements[1].faces.up.texture).toBe(1);
    const none = JSON.parse(serialize(setBbFaceTexture(load(), { cubes: [{ group: "g", index: 0 }], faces: ["north"], texture: false })));
    expect(none.elements[0].faces.north.texture).toBeUndefined();
    expect(faceTextureOf(null)).toBeNull();
    expect(faceTextureOf(undefined)).toBe(-1);
    expect(faceTextureOf(2)).toBe(2);
  });
});

describe("setBbFaces / setBbBoxUv", () => {
  it("a face rect edit changes exactly that uv array in the text", () => {
    const d = load();
    const before = serialize(d);
    const n = setBbFaces(d, { group: "g", index: 0, faces: { east: { uv: [5, 0, 9, 4] } } });
    const after = serialize(n);
    const x = before.split("\n"), y = after.split("\n");
    expect(x.length).toBe(y.length);
    const diff = x.map((l, i) => (l === y[i] ? 0 : 1)).reduce<number>((a, b) => a + b, 0);
    expect(diff).toBeLessThanOrEqual(5); // the 4 numbers of the pretty-printed array, nothing else
    expect(JSON.parse(after).elements[0].faces.east.uv).toEqual([5, 0, 9, 4]);
    expect(JSON.parse(after).elements[0].faces.north.uv).toEqual([0, 0, 4, 4]);
    expect(serialize(setBbFaces(d, { group: "g", index: 0, faces: { east: { uv: [4, 0, 8, 4] } } }))).toBe(before);
  });
  it("keeps a disabled face disabled and its uv untouched", () => {
    const n = setBbFaces(load(), { group: "g", index: 0, faces: { north: { uv: [1, 1, 2, 2] } } });
    const j = JSON.parse(serialize(n));
    expect(j.elements[0].faces.south).toEqual({ uv: [8, 0, 12, 4], texture: null });
  });
  it("writes a face rotation and drops it at 0", () => {
    const r = setBbFaces(load(), { group: "g", index: 0, faces: { up: { rotation: 90 } } });
    expect(JSON.parse(serialize(r)).elements[0].faces.up.rotation).toBe(90);
    expect("rotation" in JSON.parse(serialize(setBbFaces(r, { group: "g", index: 0, faces: { up: { rotation: 0 } } }))).elements[0].faces.up).toBe(false);
  });
  it("toggles box UV <-> per-face and back", () => {
    const d = load();
    const box = setBbBoxUv(d, { group: "g", index: 0, box: true });
    expect(JSON.parse(serialize(box)).elements[0].box_uv).toBe(true);
    const faces = setBbBoxUv(box, { group: "g", index: 0, box: false });
    const j = JSON.parse(serialize(faces));
    expect(j.elements[0].box_uv).toBe(false);
    expect(Object.keys(j.elements[0].faces)).toHaveLength(6);
    expect(getBb(faces).elements[0].boxUv).toBe(false);
  });
});

describe("geo texture layers", () => {
  const dir = "/p/assets/ns/textures/entity";
  it("discovers <stem>_*.png variants next to the default, sorted", () => {
    const v = discoverVariants(`${dir}/golem.png`, ["golem.png", "golem_glow.png", "golem_2.png", "golem_10.png", "other.png", "golemite.png", "golem.mcmeta"]);
    expect(v).toEqual([`${dir}/golem_2.png`, `${dir}/golem_10.png`, `${dir}/golem_glow.png`]);
  });
  it("merges saved state with disk: keeps order/visibility, drops missing, appends new variants hidden, default first", () => {
    const s = mergeGeoTextures(
      { layers: [{ path: `${dir}/golem_glow.png`, visible: true, blend: "add" }, { path: `${dir}/gone.png`, visible: true }], active: 5 },
      `${dir}/golem.png`, [`${dir}/golem_2.png`], (p) => !p.endsWith("gone.png"),
    );
    expect(s.layers.map((l) => [l.path.split("/").pop(), l.visible])).toEqual([["golem.png", true], ["golem_glow.png", true], ["golem_2.png", false]]);
    expect(s.layers[1].blend).toBe("add");
    expect(s.active).toBe(2);
    expect(visibleLayers(s)).toHaveLength(2);
  });
  it("starts with just the default texture", () => {
    expect(mergeGeoTextures(undefined, `${dir}/golem.png`, [])).toEqual({ layers: [{ path: `${dir}/golem.png`, visible: true }], active: 0 });
    expect(mergeGeoTextures(undefined, null, [])).toEqual({ layers: [], active: 0 });
  });
});
