import { describe, expect, it } from "vitest";
import { EMPTY, areaSelect, clickRow, coveredCubes, ofCubes, ofGroups, pickCube, pickGroup, selValue, targets, topGroups, type RowRef, type SelValue, type Tree } from "./selection";

// root
//  ├─ body (cubes 0,1)
//  │   ├─ head (cube 0)
//  │   └─ arm_l (cubes 0,1,2)
//  └─ arm_r (cube 0)
const kids: Record<string, string[]> = { "": ["body", "arm_r"], body: ["head", "arm_l"], head: [], arm_l: [], arm_r: [] };
const nCubes: Record<string, number> = { body: 2, head: 1, arm_l: 3, arm_r: 1 };
const parent: Record<string, string | undefined> = { body: undefined, arm_r: undefined, head: "body", arm_l: "body" };
const cubesOf = (b: string) => Array.from({ length: nCubes[b] }, (_, i) => ({ bone: b, index: i }));
const tree: Tree = {
  parentOf: (b) => parent[b],
  cubesUnder: (b) => [...cubesOf(b), ...kids[b].flatMap((k) => tree.cubesUnder(k))],
};
const rows: RowRef[] = [];
const walk = (b: string, p: string) => {
  rows.push({ t: "bone", bone: b, parent: p });
  kids[b].forEach((k) => walk(k, b));
  cubesOf(b).forEach((c) => rows.push({ t: "cube", bone: b, index: c.index, parent: b }));
};
kids[""].forEach((b) => walk(b, ""));
const row = (bone: string, index?: number): RowRef => rows.find((r) => r.bone === bone && r.index === index)!;
const none = { meta: false, shift: false };
const meta = { meta: true, shift: false };
const shift = { meta: false, shift: true };
const names = (s: SelValue) => s.cubes.map((c) => `${c.bone}#${c.index}`).sort();

describe("outliner clicks", () => {
  it("plain click selects one group / one cube", () => {
    expect(clickRow(rows, EMPTY, row("body"), none, tree).bones).toEqual(["body"]);
    const c = clickRow(rows, ofGroups(["body"]), row("arm_l", 1), none, tree);
    expect(names(c)).toEqual(["arm_l#1"]);
    expect(c.cube).toEqual({ bone: "arm_l", index: 1 });
  });
  it("Cmd toggles groups", () => {
    let s = clickRow(rows, EMPTY, row("head"), none, tree);
    s = clickRow(rows, s, row("arm_r"), meta, tree);
    expect(s.bones).toEqual(["head", "arm_r"]);
    s = clickRow(rows, s, row("head"), meta, tree);
    expect(s.bones).toEqual(["arm_r"]);
  });
  it("Cmd toggles cubes, building a multi-selection with the last as primary", () => {
    let s = clickRow(rows, EMPTY, row("arm_l", 0), none, tree);
    s = clickRow(rows, s, row("arm_l", 2), meta, tree);
    s = clickRow(rows, s, row("head", 0), meta, tree);
    expect(names(s)).toEqual(["arm_l#0", "arm_l#2", "head#0"]);
    expect(s.cube).toEqual({ bone: "head", index: 0 });
    expect(s.bones.sort()).toEqual(["arm_l", "head"]);
    s = clickRow(rows, s, row("arm_l", 0), meta, tree);
    expect(names(s)).toEqual(["arm_l#2", "head#0"]);
  });
  it("Shift range-selects among the siblings of the same group (cubes)", () => {
    let s = clickRow(rows, EMPTY, row("arm_l", 0), none, tree);
    s = clickRow(rows, s, row("arm_l", 2), shift, tree);
    expect(names(s)).toEqual(["arm_l#0", "arm_l#1", "arm_l#2"]);
    // reverse direction and adds to what is selected
    s = clickRow(rows, ofCubes([{ bone: "head", index: 0 }, { bone: "arm_l", index: 2 }]), row("arm_l", 0), shift, tree);
    expect(names(s)).toEqual(["arm_l#0", "arm_l#1", "arm_l#2", "head#0"]);
  });
  it("Shift range-selects sibling groups", () => {
    let s = clickRow(rows, EMPTY, row("head"), none, tree);
    s = clickRow(rows, s, row("arm_l"), shift, tree);
    expect(s.bones).toEqual(["head", "arm_l"]);
    // arm_r is not a sibling of head: shift adds it alone
    s = clickRow(rows, s, row("arm_r"), shift, tree);
    expect(s.bones).toEqual(["head", "arm_l", "arm_r"]);
  });
  it("Shift on a cube outside the anchor's group adds just that cube", () => {
    const s = clickRow(rows, ofCubes([{ bone: "arm_l", index: 0 }]), row("head", 0), shift, tree);
    expect(names(s)).toEqual(["arm_l#0", "head#0"]);
  });
  it("Cmd-clicking a cube of a selected group dissolves the group into its other cubes", () => {
    const s = clickRow(rows, ofGroups(["arm_l"]), row("arm_l", 1), meta, tree);
    expect(names(s)).toEqual(["arm_l#0", "arm_l#2"]);
    expect(s.bones).toEqual(["arm_l"]);
  });
  it("Cmd-clicking a group while cubes are selected adds its subtree as cubes; again removes it", () => {
    let s = clickRow(rows, ofCubes([{ bone: "arm_r", index: 0 }]), row("head"), meta, tree);
    expect(names(s)).toEqual(["arm_r#0", "head#0"]);
    s = clickRow(rows, s, row("head"), meta, tree);
    expect(names(s)).toEqual(["arm_r#0"]);
  });
  it("Animate: cube rows select their group; Cmd / Shift multi-select bones", () => {
    let s = clickRow(rows, EMPTY, row("arm_l", 1), none, tree, true);
    expect(s.bones).toEqual(["arm_l"]);
    expect(s.cube).toBeNull();
    s = clickRow(rows, s, row("head"), meta, tree, true);
    expect(s.bones).toEqual(["arm_l", "head"]);
  });
});

describe("viewport picks", () => {
  it("plain / Cmd / Shift", () => {
    const hit = { bone: "arm_l", index: 1 };
    expect(names(pickCube(EMPTY, hit, none, tree))).toEqual(["arm_l#1"]);
    const two = pickCube(ofCubes([{ bone: "head", index: 0 }]), hit, meta, tree);
    expect(names(two)).toEqual(["arm_l#1", "head#0"]);
    expect(names(pickCube(two, hit, meta, tree))).toEqual(["head#0"]);
    // shift adds the cube's group (as cubes, because a cube selection is active)
    expect(names(pickCube(ofCubes([{ bone: "head", index: 0 }]), hit, shift, tree))).toEqual(["arm_l#0", "arm_l#1", "arm_l#2", "head#0"]);
    // from nothing / group selection: adds the group
    expect(pickCube(EMPTY, hit, shift, tree).bones).toEqual(["arm_l"]);
    expect(pickCube(ofGroups(["head"]), hit, shift, tree).bones).toEqual(["head", "arm_l"]);
  });
  it("Shift on an already selected group climbs to the parent group", () => {
    expect(pickGroup(ofGroups(["arm_l"]), "arm_l", tree).bones).toEqual(["arm_l", "body"]);
    expect(pickGroup(ofGroups(["arm_l", "body"]), "arm_l", tree).bones).toEqual(["arm_l", "body"]);
  });
  it("Animate: a pick selects the group; Cmd toggles groups", () => {
    const hit = { bone: "head", index: 0 };
    expect(pickCube(EMPTY, hit, none, tree, false).bones).toEqual(["head"]);
    expect(pickCube(ofGroups(["head"]), { bone: "arm_r", index: 0 }, meta, tree, false).bones).toEqual(["head", "arm_r"]);
    expect(pickCube(ofGroups(["head", "arm_r"]), { bone: "arm_r", index: 0 }, meta, tree, false).bones).toEqual(["head"]);
  });
  it("area select replaces unless Shift adds", () => {
    const a = areaSelect(ofCubes([{ bone: "arm_r", index: 0 }]), [{ bone: "head", index: 0 }], false, tree);
    expect(names(a)).toEqual(["head#0"]);
    const b = areaSelect(ofCubes([{ bone: "arm_r", index: 0 }]), [{ bone: "head", index: 0 }], true, tree);
    expect(names(b)).toEqual(["arm_r#0", "head#0"]);
    expect(areaSelect(ofGroups(["x"]), [], false, tree).cube).toBeNull();
    const c = areaSelect(ofGroups(["arm_r"]), [{ bone: "head", index: 0 }], true, tree, false);
    expect(c.bones).toEqual(["arm_r", "head"]);
  });
});

describe("helpers", () => {
  it("selValue treats a bare cube as a single cube and ignores a stale cubes list", () => {
    expect(selValue({ bones: ["head"], cube: { bone: "head", index: 0 } }).cubes).toEqual([{ bone: "head", index: 0 }]);
    expect(selValue({ bones: [], cube: { bone: "head", index: 0 }, cubes: [{ bone: "arm_l", index: 0 }] }).cubes).toEqual([{ bone: "head", index: 0 }]);
    expect(selValue({ bones: ["a"], cube: null, cubes: [{ bone: "x", index: 0 }] }).cubes).toEqual([]);
  });
  it("coveredCubes expands groups; targets keeps only top-most unlocked groups", () => {
    expect(coveredCubes(ofGroups(["body"]), tree)).toHaveLength(2 + 1 + 3);
    expect(topGroups(["arm_l", "body", "arm_r"], tree)).toEqual(["body", "arm_r"]);
    expect(targets(ofGroups(["arm_l", "body", "arm_r"]), tree, new Set(["arm_r"])).bones).toEqual(["body"]);
    expect(targets(ofCubes([{ bone: "head", index: 0 }, { bone: "arm_r", index: 0 }]), tree, new Set(["arm_r"])).cubes).toEqual([{ bone: "head", index: 0 }]);
  });
});
