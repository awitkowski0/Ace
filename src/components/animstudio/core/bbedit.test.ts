import { describe, expect, it } from "vitest";
import {
  addBbCube, addBbGroup, allGroups, bbCubeAt, bbCubeRefs, deleteBbCube, deleteBbGroup, getBb, minimalEdit, moveBbCube, parseDoc, readBbCube,
  renameBbGroup, reparentBbGroup, serialize, setBbCube, setBbGroup, sortBbOutliner, sortGeoBones, type BbCubeSpec, type Doc,
} from "./index";
import { rigFromBb } from "../ui/model";
import { BB_ROOTS, nodeFs, walk } from "./testutil";

const cube = (uuid: string, name: string, from: number[], to: number[], extra: Record<string, unknown> = {}) => ({
  name, box_uv: false, rescale: false, locked: false, render_order: "default", allow_mirror_modeling: true, from, to, autouv: 0, color: 0,
  origin: [0, 0, 0], faces: { north: { uv: [0, 0, 1, 1], texture: 0 }, east: { uv: [0, 0, 1, 1], texture: 0 } }, type: "cube", uuid, ...extra,
});
const U = { root: "g-root", body: "g-body", head: "g-head", arm: "g-arm", a: "e-a", b: "e-b", c: "e-c", l: "e-l", m: "e-mesh" };
const elements = () => [
  cube(U.a, "zeta", [0, 0, 0], [4, 12, 2]),
  cube(U.b, "alpha", [-4, 0, 0], [0, 6, 2], { rotation: [10, 20, 30], origin: [1, 2, 3] }),
  cube(U.c, "head cube", [-2, 12, -1], [2, 16, 3], { inflate: 0.5 }),
  cube(U.l, "loose", [8, 0, 0], [9, 1, 1]),
  { name: "mesh", type: "mesh", uuid: U.m, vertices: {}, faces: {} },
];
const animations = () => [
  {
    uuid: "anim-1", name: "walk", loop: "loop", override: false, length: 1, snapping: 20,
    animators: {
      [U.body]: { name: "body", type: "bone", keyframes: [{ channel: "rotation", data_points: [{ x: "0", y: "0", z: "0" }], uuid: "k1", time: 0, color: -1, interpolation: "linear" }] },
      [U.head]: { name: "head", type: "bone", keyframes: [] },
    },
  },
];
/** 4.x: group data in the outliner node */
const bb4 = () => ({
  meta: { format_version: "4.10", model_format: "free", box_uv: false }, name: "m", resolution: { width: 16, height: 16 },
  elements: elements(),
  outliner: [
    {
      name: "root", origin: [0, 0, 0], color: 0, uuid: U.root, export: true, isOpen: true, locked: false, visibility: true, autouv: 0,
      children: [
        { name: "body", origin: [0, 12, 0], rotation: [5, 0, 0], color: 0, uuid: U.body, export: true, isOpen: true, locked: false, visibility: true, autouv: 0, children: [U.a, U.b, U.m, { name: "arm", origin: [4, 12, 0], color: 0, uuid: U.arm, export: true, isOpen: true, locked: false, visibility: true, autouv: 0, children: [] }] },
        { name: "head", origin: [0, 16, 0], color: 0, uuid: U.head, export: true, isOpen: false, locked: false, visibility: true, autouv: 0, children: [U.c] },
      ],
    },
    U.l,
  ],
  textures: [], animations: animations(),
});
/** 5.0: data in groups[], outliner nodes minimal */
const bb5 = () => {
  const def = (name: string, uuid: string, origin: number[], extra: Record<string, unknown> = {}) => ({ name, uuid, export: true, locked: false, scope: 0, origin, rotation: [0, 0, 0], color: 0, children: [], reset: false, shade: true, mirror_uv: false, visibility: true, autouv: 0, isOpen: true, ...extra });
  return {
    meta: { format_version: "5.0", model_format: "free", box_uv: false }, name: "m", resolution: { width: 16, height: 16 },
    elements: elements(),
    groups: [def("root", U.root, [0, 0, 0]), def("body", U.body, [0, 12, 0], { rotation: [5, 0, 0] }), def("head", U.head, [0, 16, 0]), def("arm", U.arm, [4, 12, 0])],
    outliner: [
      { uuid: U.root, isOpen: true, children: [{ uuid: U.body, isOpen: true, children: [U.a, U.b, U.m, { uuid: U.arm, isOpen: true, children: [] }] }, { uuid: U.head, isOpen: false, children: [U.c] }] },
      U.l,
    ],
    textures: [], animations: animations(),
  };
};

const FIXTURES: Array<[string, string]> = [
  ["4.x pretty", JSON.stringify(bb4(), null, 2) + "\n"],
  ["4.x minified", JSON.stringify(bb4())],
  ["5.0 pretty", JSON.stringify(bb5(), null, "\t")],
  ["5.0 minified", JSON.stringify(bb5())],
];

/** Everything outside `spans` (offsets in `orig`) must appear unchanged, in order, in `out`. */
function outsideUnchanged(orig: string, out: string, spans: Array<[number, number]>) {
  const sorted = spans.slice().sort((x, y) => x[0] - y[0]);
  let pos = 0;
  let at = 0;
  for (const [s, e] of sorted) {
    const seg = orig.slice(at, s);
    const found = out.indexOf(seg, pos);
    expect(found, `segment before ${s}`).toBe(pos === 0 ? 0 : found);
    expect(found).toBeGreaterThanOrEqual(pos);
    pos = found + seg.length;
    at = e;
  }
  expect(out.slice(pos).endsWith(orig.slice(at))).toBe(true);
}
const spanOf = (doc: Doc, key: string): [number, number] => {
  const n = (doc.root as { entries: Array<{ key: string; value: { src?: { start: number; end: number } } }> }).entries.find((e) => e.key === key)!.value.src!;
  return [n.start, n.end];
};

const near = (a: readonly number[] | undefined, b: readonly number[]) => {
  expect(a).toBeDefined();
  b.forEach((x, i) => expect(a![i]).toBeCloseTo(x, 4));
};
const specEq = (got: BbCubeSpec, want: BbCubeSpec) => {
  near(got.origin, want.origin);
  near(got.size, want.size);
  if (want.pivot) near(got.pivot, want.pivot);
  if (want.rotation) near(got.rotation, want.rotation);
  else expect(got.rotation).toBeUndefined();
  expect(got.inflate ?? 0).toBeCloseTo(want.inflate ?? 0, 4);
  expect(!!got.mirror).toBe(!!want.mirror);
  expect(got.uv?.kind).toBe(want.uv?.kind);
  if (want.uv?.kind === "box") expect(got.uv).toEqual(want.uv);
  if (want.uv?.kind === "faces" && got.uv?.kind === "faces") {
    for (const [f, v] of Object.entries(want.uv.faces)) {
      near(got.uv.faces[f as "north"]!.uv, v!.uv);
      near(got.uv.faces[f as "north"]!.uvSize, v!.uvSize);
    }
    expect(Object.keys(got.uv.faces).sort()).toEqual(Object.keys(want.uv.faces).sort());
  }
};

const SPEC: BbCubeSpec = { name: "new", origin: [-3, 2, 1.5], size: [2, 3, 4.25], pivot: [-2, 3, 2], rotation: [15, -20, 5], inflate: 0.25, mirror: true, uv: { kind: "box", uv: [8, 4] } };
const SPEC_FACES: BbCubeSpec = { name: "fc", origin: [1, 1, 1], size: [2, 2, 2], uv: { kind: "faces", faces: { north: { uv: [1, 2], uvSize: [3, 4] }, up: { uv: [0, 0], uvSize: [-2, 2] } } } };

describe.each(FIXTURES)("bbedit on %s", (_label, text) => {
  const d0 = () => parseDoc(text, "bbmodel");
  const five = _label.startsWith("5");

  it("addresses cubes like rigFromBb", () => {
    const refs = bbCubeRefs(getBb(d0()));
    expect(refs.map((r) => `${r.group}:${r.index}:${r.element.name}`)).toEqual(["body:0:zeta", "body:1:alpha", "head:0:head cube", "(root):0:loose"]);
    const rig = rigFromBb(d0());
    for (const r of refs) expect(rig.bones.find((b) => b.name === r.group)!.cubes[r.index].name).toBe(r.element.name);
  });

  it("add/delete group is local and invertible", () => {
    const d1 = addBbGroup(d0(), { name: "tail", parent: "body", origin: [1, 2, 3], rotation: [10, 20, 30] });
    const g = allGroups(getBb(d1)).find((x) => x.name === "tail")!;
    expect(g).toBeDefined();
    near(g.origin, [-1, 2, 3]);
    near(g.rotation, [-10, -20, 30]);
    const body = allGroups(getBb(d1)).find((x) => x.name === "body")!;
    expect(body.children[body.children.length - 1]).toBe(g);
    expect(serialize(d1).startsWith(text.slice(0, 40))).toBe(true);
    const spans: Array<[number, number]> = [spanOf(d0(), "outliner")];
    if (five) spans.push(spanOf(d0(), "groups"));
    outsideUnchanged(text, serialize(d1), spans);
    // new key style: 5.0 gets a groups[] def, 4.x holds the data in the outliner node
    expect(!!g.defNode).toBe(five);
    expect(serialize(deleteBbGroup(d1, { name: "tail" }))).toBe(text);
    const top = addBbGroup(d0(), { name: "top" });
    expect(serialize(deleteBbGroup(top, { name: "top" }))).toBe(text);
    expect(() => addBbGroup(d0(), { name: "body" })).toThrow();
    expect(() => addBbGroup(d0(), { name: "x", parent: "nope" })).toThrow();
  });

  it("add cube reads back as the spec (box + faces + loose) and delete restores the text", () => {
    for (const [group, spec] of [["body", SPEC], ["head", SPEC_FACES], [null, SPEC], ["(root)", SPEC_FACES]] as Array<[string | null, BbCubeSpec]>) {
      const d1 = addBbCube(d0(), { group, cube: spec });
      const refs = bbCubeRefs(getBb(d1)).filter((r) => r.group === (group ?? "(root)"));
      const added = refs[refs.length - 1];
      expect(added.element.name).toBe(spec.name);
      specEq(readBbCube(added.element), spec);
      outsideUnchanged(text, serialize(d1), [spanOf(d0(), "elements"), spanOf(d0(), "outliner")]);
      expect(serialize(deleteBbCube(d1, { group, index: added.index }))).toBe(text);
      // rigFromBb sees the same file-space numbers
      const rc = rigFromBb(d1).bones.find((b) => b.name === (group ?? "(root)"))!.cubes[added.index];
      near(rc.origin, spec.origin);
      near(rc.size, spec.size);
      if (spec.pivot) near(rc.pivot, spec.pivot);
      if (spec.rotation) near(rc.rotation, spec.rotation);
    }
  });

  it("add cube at an index and mimic the existing element style", () => {
    const d1 = addBbCube(d0(), { group: "body", cube: { origin: [0, 0, 0], size: [1, 1, 1], name: "mid" }, index: 1 });
    expect(bbCubeRefs(getBb(d1)).filter((r) => r.group === "body").map((r) => r.element.name)).toEqual(["zeta", "mid", "alpha"]);
    expect(serialize(deleteBbCube(d1, { group: "body", index: 1 }))).toBe(text);
    const el = getBb(d1).elements[getBb(d1).elements.length - 1];
    const keys = el.node.entries.map((e) => e.key);
    expect(keys.indexOf("from")).toBeLessThan(keys.indexOf("to"));
    expect(keys.indexOf("uuid")).toBeGreaterThan(keys.indexOf("faces"));
    expect(keys.slice(0, 4)).toEqual(["name", "box_uv", "rescale", "locked"]);
    const l1 = addBbCube(d0(), { group: null, cube: { origin: [0, 0, 0], size: [1, 1, 1], name: "first" }, index: 0 });
    expect(bbCubeRefs(getBb(l1)).filter((r) => r.group === "(root)").map((r) => r.element.name)).toEqual(["first", "loose"]);
    expect(serialize(deleteBbCube(l1, { group: null, index: 0 }))).toBe(text);
  });

  it("setBbCube patches in file space, touches only the element, no-op keeps the doc", () => {
    const base = bbCubeAt(getBb(d0()), "body", 1)!;
    const before = readBbCube(base.element);
    const d = d0();
    expect(setBbCube(d, { group: "body", index: 1, patch: {} })).toBe(d);
    expect(setBbCube(d, { group: "body", index: 1, patch: { origin: before.origin, size: before.size, rotation: before.rotation, pivot: before.pivot, inflate: before.inflate ?? null } })).toBe(d);
    const d1 = setBbCube(d, { group: "body", index: 1, patch: { origin: [-5, 1, 2], size: [3, 4, 5], pivot: [0, 0, 0], rotation: [1, 2, 3], inflate: 0.1, mirror: true, uv: { kind: "box", uv: [4, 4] }, name: "ALPHA", flags: { locked: true, visibility: false, color: 3 } } });
    const e = bbCubeAt(getBb(d1), "body", 1)!.element;
    const s = readBbCube(e);
    near(s.origin, [-5, 1, 2]);
    near(s.size, [3, 4, 5]);
    near(s.rotation, [1, 2, 3]);
    expect(s.mirror).toBe(true);
    expect(e.name).toBe("ALPHA");
    expect(getBb(d1).elements[e.index].node.entries.find((x) => x.key === "locked")!.value).toMatchObject({ value: true });
    // from/to in Blockbench space: from.x = -origin.x - size.x
    near(e.from, [5 - 3, 1, 2]);
    near(e.to, [5, 5, 7]);
    const el = getBb(d).elements[e.index].node.src!;
    const ed = minimalEdit(text, serialize(d1));
    expect(ed.start).toBeGreaterThanOrEqual(el.start);
    expect(ed.end).toBeLessThanOrEqual(el.end);
    // remove optional keys
    const d2 = setBbCube(d1, { group: "body", index: 1, patch: { rotation: null, pivot: null, inflate: null, mirror: null, uv: null } });
    const s2 = readBbCube(bbCubeAt(getBb(d2), "body", 1)!.element);
    expect(s2.rotation).toBeUndefined();
    expect(s2.pivot).toBeUndefined();
    expect(s2.uv).toBeUndefined();
    // face uv patch
    const d3 = setBbCube(d, { group: "head", index: 0, patch: { uv: SPEC_FACES.uv } });
    specEq(readBbCube(bbCubeAt(getBb(d3), "head", 0)!.element), { origin: [-2, 12, -1], size: [4, 4, 4], uv: SPEC_FACES.uv, inflate: 0.5 });
    expect(() => setBbCube(d, { group: "body", index: 9, patch: {} })).toThrow();
  });

  it("moveBbCube between groups and loose, and back", () => {
    const d1 = moveBbCube(d0(), { group: "body", index: 0, toGroup: "head" });
    expect(bbCubeRefs(getBb(d1)).filter((r) => r.group === "head").map((r) => r.element.name)).toEqual(["head cube", "zeta"]);
    expect(serialize(moveBbCube(d1, { group: "head", index: 1, toGroup: "body", toIndex: 0 }))).toBe(text);
    const d2 = moveBbCube(d0(), { group: "body", index: 1, toGroup: null, toIndex: 0 });
    expect(bbCubeRefs(getBb(d2)).filter((r) => r.group === "(root)").map((r) => r.element.name)).toEqual(["alpha", "loose"]);
    const d3 = moveBbCube(d2, { group: null, index: 0, toGroup: "body", toIndex: 1 });
    expect(bbCubeRefs(getBb(d3)).filter((r) => r.group === "body").map((r) => r.element.name)).toEqual(["zeta", "alpha"]);
    const d = d0();
    expect(moveBbCube(d, { group: "body", index: 0, toGroup: "body" })).toBe(d);
  });

  it("deleteBbGroup promotes children by default, cascade removes everything, animators go", () => {
    const d1 = deleteBbGroup(d0(), { name: "body" });
    const m1 = getBb(d1);
    expect(allGroups(m1).map((g) => g.name)).toEqual(["root", "arm", "head"]);
    const root = m1.groups[0];
    expect(root.children.map((c) => (typeof c === "string" ? c : c.name))).toEqual([U.a, U.b, U.m, "arm", "head"]);
    expect(m1.animations[0].animators.map((a) => a.key)).toEqual([U.head]);
    expect(m1.elements.length).toBe(5);
    const d2 = deleteBbGroup(d0(), { name: "body", cascade: true });
    const m2 = getBb(d2);
    expect(allGroups(m2).map((g) => g.name)).toEqual(["root", "head"]);
    expect(m2.elements.map((e) => e.uuid)).toEqual([U.c, U.l]);
    expect(m2.animations[0].animators.map((a) => a.key)).toEqual([U.head]);
    if (five) expect(((d2.root as unknown as { entries: Array<{ key: string; value: { items: unknown[] } }> }).entries.find((e) => e.key === "groups")!.value.items.length)).toBe(2);
    expect(() => deleteBbGroup(d0(), { name: "nope" })).toThrow();
    expect(() => JSON.parse(serialize(d2))).not.toThrow();
  });

  it("reparentBbGroup keeps pivots, checks cycles, no-op is the same doc", () => {
    const d = d0();
    const d1 = reparentBbGroup(d, { name: "head", parent: "body" });
    const m = getBb(d1);
    expect(m.groups[0].children.map((c) => (typeof c === "string" ? c : c.name))).toEqual(["body"]);
    near(allGroups(m).find((g) => g.name === "head")!.origin, [0, 16, 0]);
    expect(serialize(reparentBbGroup(d1, { name: "head", parent: "root", index: 1 }))).toBe(text);
    expect(() => reparentBbGroup(d, { name: "root", parent: "head" })).toThrow();
    expect(() => reparentBbGroup(d, { name: "body", parent: "body" })).toThrow();
    expect(reparentBbGroup(d, { name: "head", parent: "root" })).toBe(d);
    const top = reparentBbGroup(d, { name: "arm", parent: null, index: 0 });
    expect(getBb(top).groups.map((g) => g.name)).toEqual(["arm", "root"]);
    expect(serialize(reparentBbGroup(top, { name: "arm", parent: "body" }))).toBe(serialize(reparentBbGroup(top, { name: "arm", parent: "body" })));
  });

  it("setBbGroup: origin/rotation/flags/binding", () => {
    const d = d0();
    expect(setBbGroup(d, { group: "body", patch: { origin: [0, 12, 0], rotation: [-5, 0, 0], flags: { locked: false } } })).toBe(d);
    const d1 = setBbGroup(d, { group: "head", patch: { origin: [1, 2, 3], rotation: [10, 20, 30], flags: { locked: true, visibility: false, export: false, shade: false, mirror_uv: true, autouv: 1, color: 2 }, bedrockBinding: "q.item_slot('main_hand')" } });
    const g = allGroups(getBb(d1)).find((x) => x.name === "head")!;
    near(g.origin, [-1, 2, 3]);
    near(g.rotation, [-10, -20, 30]);
    const data = (g.defNode ?? g.outlinerNode).entries;
    const get = (k: string) => (data.find((e) => e.key === k)?.value as { value?: unknown } | undefined)?.value;
    expect(get("locked")).toBe(true);
    expect(get("visibility")).toBe(false);
    expect(get("bedrock_binding")).toBe("q.item_slot('main_hand')");
    const d2 = setBbGroup(d1, { group: "head", patch: { rotation: null, bedrockBinding: null, flags: { color: null } } });
    const g2 = allGroups(getBb(d2)).find((x) => x.name === "head")!;
    expect(g2.rotation).toBeUndefined();
    expect((g2.defNode ?? g2.outlinerNode).entries.some((e) => e.key === "bedrock_binding" || e.key === "color")).toBe(false);
    const d3 = setBbGroup(d, { group: "arm", patch: { flags: { name: "hand" } } });
    expect(allGroups(getBb(d3)).map((x) => x.name)).toContain("hand");
  });

  it("sortBbOutliner sorts case-insensitively, idempotent, recursive", () => {
    const d = d0();
    const s = sortBbOutliner(d, { group: "body" });
    expect(bbCubeRefs(getBb(s)).filter((r) => r.group === "body").map((r) => r.element.name)).toEqual(["alpha", "zeta"]);
    expect(sortBbOutliner(s, { group: "body" })).toBe(s);
    const r = sortBbOutliner(d, { group: "root" });
    expect(getBb(r).groups[0].children.map((c) => (typeof c === "string" ? c : c.name))).toEqual(["body", "head"]);
    expect(sortBbOutliner(d, { group: "root" })).toBe(d);
    const all = sortBbOutliner(d, { recursive: true });
    expect(bbCubeRefs(getBb(all)).filter((x) => x.group === "body").map((x) => x.element.name)).toEqual(["alpha", "zeta"]);
    expect(getBb(all).groups[0].children.length).toBe(2);
    expect(() => JSON.parse(serialize(all))).not.toThrow();
  });

  it("renameBbGroup still works", () => {
    const d1 = renameBbGroup(d0(), { from: "body", to: "torso" });
    expect(allGroups(getBb(d1)).map((g) => g.name)).toContain("torso");
    expect(getBb(d1).animations[0].animators[0].name).toBe("torso");
  });

  it("throws on non-bbmodel docs", () => {
    expect(() => addBbGroup(parseDoc("{}", "animation"), { name: "x" })).toThrow();
  });
});

describe("sortGeoBones", () => {
  const geo = `{
  "format_version": "1.12.0",
  "minecraft:geometry": [
    { "description": { "identifier": "geometry.x" }, "bones": [
      { "name": "c", "parent": "a" }, { "name": "a" }, { "name": "B" }
    ] }
  ]
}
`;
  it("orders bones by name and keeps parents", () => {
    const d = parseDoc(geo, "geo");
    const s = sortGeoBones(d, {});
    expect(JSON.parse(serialize(s))["minecraft:geometry"][0].bones.map((b: { name: string }) => b.name)).toEqual(["a", "B", "c"]);
    expect(sortGeoBones(s, {})).toBe(s);
    expect(() => sortGeoBones(parseDoc("{}", "bbmodel"), {})).toThrow();
  });
});

describe("real bbmodels", async () => {
  const fs = await nodeFs();
  const files: string[] = [];
  for (const r of BB_ROOTS) files.push(...(await walk(r, [".bbmodel"])));
  const uniq = [...new Set(files)].slice(0, 40);
  it.skipIf(uniq.length === 0)("add group + cube then delete them is byte-identical", () => {
    for (const f of uniq) {
      const text: string = fs.readFileSync(f, "utf8");
      const doc = parseDoc(text, "bbmodel");
      const m = getBb(doc);
      const parent = m.groups[0]?.name;
      let d = addBbGroup(doc, { name: "__ace_test_group", parent });
      const refs0 = bbCubeRefs(m);
      d = addBbCube(d, { group: "__ace_test_group", cube: { name: "__ace_cube", origin: [1, 2, 3], size: [1, 2, 3], uv: { kind: "box", uv: [0, 0] } } });
      expect(() => JSON.parse(serialize(d)), f).not.toThrow();
      const m2 = getBb(parseDoc(serialize(d), "bbmodel"));
      expect(bbCubeRefs(m2).length, f).toBe(refs0.length + 1);
      expect(bbCubeRefs(m2).find((r) => r.group === "__ace_test_group")!.element.name).toBe("__ace_cube");
      d = deleteBbCube(d, { group: "__ace_test_group", index: 0 });
      d = deleteBbGroup(d, { name: "__ace_test_group" });
      expect(serialize(d), f).toBe(text);
      // a loose cube too
      const l = addBbCube(doc, { group: null, cube: { origin: [0, 0, 0], size: [1, 1, 1] } });
      const loose = bbCubeRefs(getBb(l)).filter((r) => r.group === "(root)");
      expect(serialize(deleteBbCube(l, { group: null, index: loose.length - 1 })), f).toBe(text);
    }
  });
});
