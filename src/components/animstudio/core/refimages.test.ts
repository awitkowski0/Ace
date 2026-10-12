import { describe, expect, it } from "vitest";
import { makeRef, parseDoc, readBbReferenceImages, refFromJson, refToJson, serialize, setBbReferenceImages, REF_DEFAULTS } from "./index";

const bb = JSON.stringify({ meta: { format_version: "4.10", model_format: "bedrock" }, name: "m", elements: [], outliner: [], textures: [] }, null, 2) + "\n";
const PX = "data:image/png;base64,iVBORw0KGgo=";

describe("reference images (bbmodel reference_images key)", () => {
  it("defaults match Blockbench's property defaults", () => {
    expect(REF_DEFAULTS).toMatchObject({ name: "Reference", layer: "background", view_mode: "flat_image", position: [0, 0], size: [400, 300], rotation: 0, opacity: 1, visibility: true, flip_x: false, flip_y: false, clear_mode: false, cull_backface: false, attached_side: "north" });
  });
  it("writes only non-default properties, round-trips and leaves the rest of the file byte-identical", () => {
    const doc = parseDoc(bb, "bbmodel");
    const r = makeRef(PX, { name: "front.png", layer: "viewport", opacity: 0.5, position: [10, -4] });
    const next = setBbReferenceImages(doc, [r]);
    const text = serialize(next);
    expect(text.startsWith(bb.trimEnd().slice(0, -2))).toBe(true);
    const j = JSON.parse(text);
    expect(j.reference_images).toHaveLength(1);
    expect(j.reference_images[0]).toMatchObject({ name: "front.png", layer: "viewport", opacity: 0.5, position: [10, -4], source: PX, size: [400, 300] });
    expect(j.reference_images[0]).not.toHaveProperty("rotation");
    expect(j.reference_images[0]).not.toHaveProperty("visibility");
    const back = readBbReferenceImages(parseDoc(text, "bbmodel"));
    expect(back).toHaveLength(1);
    expect(refToJson(back[0])).toEqual(refToJson(r));
  });
  it("unchanged entries keep their text; an edit rewrites only the references key; removing the last one removes the key", () => {
    let doc = setBbReferenceImages(parseDoc(bb, "bbmodel"), [makeRef(PX, { name: "a" }), makeRef(PX, { name: "b" })]);
    const t1 = serialize(doc);
    doc = parseDoc(t1, "bbmodel");
    const refs = readBbReferenceImages(doc);
    expect(setBbReferenceImages(doc, refs)).toBe(doc);
    const t2 = serialize(setBbReferenceImages(doc, [refs[0], { ...refs[1], opacity: 0.25 }]));
    expect(t2.slice(0, t2.indexOf('"opacity"') - 10)).toBe(t1.slice(0, t2.indexOf('"opacity"') - 10));
    const t3 = serialize(setBbReferenceImages(parseDoc(t2, "bbmodel"), []));
    expect(JSON.parse(t3)).not.toHaveProperty("reference_images");
    expect(t3).toBe(bb);
  });
  it("tolerates junk", () => {
    expect(refFromJson({ name: 3 })).toBeNull();
    expect(refFromJson({ source: "x", opacity: 9, layer: "nope" })).toMatchObject({ opacity: 1, layer: "background" });
  });
});
