import { describe, expect, it } from "vitest";
import { applyUvDrag, boxToFaces, boxUvIsland, boxUvRects, clampMove, cubeFaceRects, facesToBox, flipUv, moveRect, resizeRect, snapDelta, uvSnapStep, uvFaces } from "./uv";
import type { CubeUv } from "./format/geo";

describe("box UV layout", () => {
  it("matches the Blockbench unwrap for an 8x8x8 head at (0,0)", () => {
    const r = boxUvRects([0, 0], [8, 8, 8]);
    expect(r.up).toEqual([8, 0, 16, 8]);
    expect(r.down).toEqual([16, 8, 24, 0]); // flipped vertically
    expect(r.east).toEqual([0, 8, 8, 16]);
    expect(r.north).toEqual([8, 8, 16, 16]);
    expect(r.west).toEqual([16, 8, 24, 16]);
    expect(r.south).toEqual([24, 8, 32, 16]);
  });
  it("uses the floored size and a (2(dx+dz)) x (dy+dz) island", () => {
    expect(boxUvIsland([4, 6], [4.9, 12, 4])).toEqual({ x: 4, y: 6, w: 16, h: 16 });
    expect(boxUvRects([0, 0], [4.9, 12, 4]).north).toEqual([4, 4, 8, 16]);
  });
  it("mirror swaps east/west and flips every face horizontally", () => {
    const m = cubeFaceRects({ kind: "box", uv: [0, 0] }, [4, 12, 4], true)!;
    const n = cubeFaceRects({ kind: "box", uv: [0, 0] }, [4, 12, 4], false)!;
    expect(m.east).toEqual([n.west![2], n.west![1], n.west![0], n.west![3]]);
    expect(m.north).toEqual([n.north![2], n.north![1], n.north![0], n.north![3]]);
  });
  it("per-face uv_size becomes a rect (negative size = flipped)", () => {
    const uv: CubeUv = { kind: "faces", faces: { down: { uv: [50, 10], uvSize: [-10, -10] } } };
    expect(cubeFaceRects(uv, [10, 0, 10], false)!.down).toEqual([50, 10, 40, 0]);
  });
});

describe("snapping", () => {
  it("steps follow the move grid: 1 / 0.25 / 0.1 / 0.025, divided by texture px per UV unit", () => {
    expect([uvSnapStep(false, false), uvSnapStep(true, false), uvSnapStep(false, true), uvSnapStep(true, true)]).toEqual([1, 0.25, 0.1, 0.025]);
    expect(uvSnapStep(false, false, 2)).toBe(0.5);
  });
  it("snapDelta rounds to the step without float noise", () => {
    expect(snapDelta(2.4, 1)).toBe(2);
    expect(snapDelta(2.6, 1)).toBe(3);
    expect(snapDelta(0.37, 0.25)).toBe(0.25);
    expect(snapDelta(0.38, 0.1)).toBe(0.4);
    expect(snapDelta(-0.0049, 0.025)).toBe(0);
  });
});

describe("rect drag / resize", () => {
  it("moves by a delta", () => expect(moveRect([8, 8, 16, 16], 2, -3)).toEqual([10, 5, 18, 13]));
  it("resizes the right/bottom corner", () => expect(resizeRect([8, 8, 16, 16], 1, 1, 2, 3)).toEqual([8, 8, 18, 19]));
  it("resizes the left side without touching the others", () => expect(resizeRect([8, 8, 16, 16], -1, 0, -2, 5)).toEqual([6, 8, 16, 16]));
  it("a flipped rect moves the other stored coordinate for the same visual side", () => {
    // down face stored [16,8,24,0]: u0<u1 normal in x, v0>v1 flipped in y. 'top' (ys=-1) visually is the smaller v = stored v1.
    expect(resizeRect([16, 8, 24, 0], 0, -1, 0, 2)).toEqual([16, 8, 24, 2]);
    expect(resizeRect([16, 8, 24, 0], 0, 1, 0, 2)).toEqual([16, 10, 24, 0]);
  });
  it("clamps resize to the texture", () => expect(resizeRect([8, 8, 16, 16], 1, 1, 100, 100, { w: 64, h: 32 })).toEqual([8, 8, 64, 32]));
  it("clampMove keeps every rect inside the texture", () => {
    expect(clampMove([[0, 0, 8, 8], [56, 56, 64, 64]], -5, 10, 64, 64)).toEqual([0, 0]);
    expect(clampMove([[10, 10, 20, 20]], 100, -100, 64, 64)).toEqual([44, -10]);
  });
});

describe("CubeUv operations", () => {
  const box: CubeUv = { kind: "box", uv: [16, 16] };
  const faces: CubeUv = { kind: "faces", faces: { north: { uv: [8, 8], uvSize: [8, 8] }, up: { uv: [8, 0], uvSize: [8, 8] }, south: { uv: [24, 8], uvSize: [8, 8] } } };
  it("dragging a box island moves the offset by whole pixels", () => {
    expect(applyUvDrag(box, { kind: "island" }, 3.2, -4.8)).toEqual({ kind: "box", uv: [19, 11] });
    expect(applyUvDrag(box, { kind: "move", faces: ["north"] }, 3, 3)).toEqual(box);
  });
  it("moving selected faces leaves the others byte-equal", () => {
    const r = applyUvDrag(faces, { kind: "move", faces: ["north"] }, 2, 1) as Extract<CubeUv, { kind: "faces" }>;
    expect(r.faces.north).toEqual({ uv: [10, 9], uvSize: [8, 8] });
    expect(r.faces.up).toBe(faces.kind === "faces" ? faces.faces.up : null);
  });
  it("move honours the clamp", () => {
    const r = applyUvDrag(faces, { kind: "move", faces: ["north", "up"] }, -50, 0, { w: 64, h: 64 }) as Extract<CubeUv, { kind: "faces" }>;
    expect(r.faces.north!.uv[0]).toBe(0);
    expect(r.faces.up!.uv[0]).toBe(0);
  });
  it("resizing a corner changes uv_size only", () => {
    const r = applyUvDrag(faces, { kind: "resize", faces: ["north"], xs: 1, ys: 1 }, 2, 3) as Extract<CubeUv, { kind: "faces" }>;
    expect(r.faces.north).toEqual({ uv: [8, 8], uvSize: [10, 11] });
  });
  it("flip X negates the width and keeps the covered pixels", () => {
    const r = flipUv(faces, ["north"], "x") as Extract<CubeUv, { kind: "faces" }>;
    expect(r.faces.north).toEqual({ uv: [16, 8], uvSize: [-8, 8] });
    expect(flipUv(r, ["north"], "x")).toEqual(faces);
  });
  it("box <-> faces round trip keeps the layout", () => {
    const f = boxToFaces(box, [8, 8, 8], false);
    expect(uvFaces(f)).toHaveLength(6);
    expect(facesToBox(f, [8, 8, 8])).toEqual(box);
  });
});
