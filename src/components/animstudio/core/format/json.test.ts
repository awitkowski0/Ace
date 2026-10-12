import { describe, expect, it } from "vitest";
import { detectStyle, derive, emitJson, jarr, jnum, jobj, parseJson, serializeParsed, setIn, type JNode } from "./json";
import { THEMATIC_ROOTS, walk, nodeFs } from "../testutil";

/** Drop every container's verbatim `src` (keeping `like`) so the emitter must re-lay-out the whole tree. */
function relayout(n: JNode): JNode {
  if (n.t === "o") return derive(n, n.entries.map((e) => ({ ...e, value: relayout(e.value) })));
  if (n.t === "a") return derive(n, n.items.map(relayout));
  return n;
}

describe("json format preservation", () => {
  it("round-trips small samples byte-identically", () => {
    const samples = [
      '{"a":1,"b":[1,2,3]}',
      '{\n  "a": 1,\n  "b": [1, 2, 3]\n}\n',
      '{\r\n\t"a": {\r\n\t\t"x": [\r\n\t\t\t1,\r\n\t\t\t2\r\n\t\t]\r\n\t}\r\n}',
      '{ "a" : [ ] , "b" : { } }',
    ];
    for (const s of samples) {
      const p = parseJson(s);
      const st = detectStyle(s, p.start, p.end);
      expect(serializeParsed(p.root, st, s, p.start, p.end)).toBe(s);
      if (!s.includes(" ,")) expect(st.head + emitJson(relayout(p.root), st) + st.tail).toBe(s);
    }
  });

  it("an edit changes only its own region", () => {
    const s = '{\n\t"a": {\n\t\t"0.0": [1, 2, 3],\n\t\t"1.0": [4, 5, 6]\n\t},\n\t"b": [0, 0, 0]\n}\n';
    const p = parseJson(s);
    const st = detectStyle(s, p.start, p.end);
    const root = setIn(p.root, ["a", "1.0"], jarr([jnum(4), jnum(9.5), jnum(6)], (p.root as any).entries[0].value.entries[1].value));
    const out = serializeParsed(root, st, s, p.start, p.end);
    expect(out).toBe(s.replace("[4, 5, 6]", "[4, 9.5, 6]"));
  });

  it("new containers adopt the file style", () => {
    const s = '{\n    "a": [1, 2]\n}\n';
    const p = parseJson(s);
    const st = detectStyle(s, p.start, p.end);
    const root = setIn(p.root, ["b"], jobj([["c", jarr([jnum(1), jnum(2)])]]));
    expect(serializeParsed(root, st, s, p.start, p.end)).toBe('{\n    "a": [1, 2],\n    "b": {\n        "c": [1, 2]\n    }\n}\n');
  });
});

describe("json round-trip on Thematic files", async () => {
  const files: string[] = [];
  for (const r of THEMATIC_ROOTS) files.push(...(await walk(r, [".geo.json", ".animation.json"])));
  const fs = await nodeFs();
  it.skipIf(files.length === 0)("every geo/animation file is byte-identical (verbatim and full re-layout)", () => {
    let relayoutMismatch = 0;
    const bad: string[] = [];
    for (const f of files) {
      const text: string = fs.readFileSync(f, "utf8");
      const p = parseJson(text);
      const st = detectStyle(text, p.start, p.end);
      if (serializeParsed(p.root, st, text, p.start, p.end) !== text) bad.push("verbatim " + f);
      const re = st.head + emitJson(relayout(p.root), st) + st.tail;
      if (re !== text) {
        relayoutMismatch++;
        if (relayoutMismatch <= 5) console.log("relayout differs:", f);
      }
    }
    console.log(`files=${files.length} relayoutMismatch=${relayoutMismatch}`);
    expect(bad).toEqual([]);
  }, 600000);
});
