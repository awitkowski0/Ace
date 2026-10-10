import { describe, expect, it } from "vitest";
import { cycle, equalize, layoutRects, leaf, leaves, neighbor, removeLeaf, resizePane, splitLeaf, setRatio, type Node } from "./splitTree";

// +-----+-----+
// |  a  |  b  |
// |     +-----+
// |     |  c  |
// +-----+-----+
const grid = (): Node => splitLeaf(splitLeaf(leaf("a"), "a", "b", "row"), "b", "c", "col");

describe("split tree", () => {
  it("splits and lists leaves in reading order", () => {
    expect(leaves(grid())).toEqual(["a", "b", "c"]);
  });
  it("directional focus follows geometry", () => {
    const t = grid();
    expect(neighbor(t, "a", "right")).toBe("b");
    expect(neighbor(t, "b", "down")).toBe("c");
    expect(neighbor(t, "c", "up")).toBe("b");
    expect(neighbor(t, "c", "left")).toBe("a");
    expect(neighbor(t, "a", "left")).toBeNull();
    expect(neighbor(t, "a", "down")).toBeNull();
  });
  it("next / previous wrap", () => {
    const t = grid();
    expect(cycle(t, "c", 1)).toBe("a");
    expect(cycle(t, "a", -1)).toBe("c");
  });
  it("closing a pane hands its space to the sibling", () => {
    const t = removeLeaf(grid(), "b")!;
    expect(leaves(t)).toEqual(["a", "c"]);
    expect(layoutRects(t).get("c")).toEqual({ x: 0.5, y: 0, w: 0.5, h: 1 });
    expect(removeLeaf(leaf("a"), "a")).toBeNull();
  });
  it("equalize gives a same-direction run equal shares", () => {
    let t: Node = leaf("a");
    t = splitLeaf(t, "a", "b", "row");
    t = splitLeaf(t, "b", "c", "row");
    t = equalize(t);
    const r = layoutRects(t);
    for (const id of ["a", "b", "c"]) expect(r.get(id)!.w).toBeCloseTo(1 / 3, 5);
  });
  it("resize moves the nearest divider on the axis and clamps", () => {
    const t = grid();
    const r = layoutRects(resizePane(t, "a", "right", 0.1));
    expect(r.get("a")!.w).toBeCloseTo(0.6, 5);
    expect(layoutRects(resizePane(t, "c", "down", 0.1)).get("b")!.h).toBeCloseTo(0.6, 5);
    expect(layoutRects(resizePane(t, "a", "up", 0.1)).get("a")!.h).toBe(1); // no vertical divider next to a
    const root = t as Extract<Node, { t: "split" }>;
    expect(layoutRects(setRatio(t, root.id, 5)).get("a")!.w).toBeCloseTo(0.9, 5);
  });
});
