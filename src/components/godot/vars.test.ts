import { describe as d, expect, it } from "vitest";
import { describe, inspectProps, text } from "./vars";

d("vars", () => {
  it("scalars with type ids", () => {
    expect(describe(41, 2)).toEqual({ value: "41", type: "int" });
    expect(describe(2, 3)).toEqual({ value: "2.0", type: "float" });
    expect(describe("hi", 4)).toEqual({ value: '"hi"', type: "String" });
    expect(describe(null, 0)).toEqual({ value: "null", type: "Nil" });
  });
  it("containers", () => {
    const a = describe([10, 20], 28);
    expect(a.value).toBe("[10, 20]");
    expect(a.kids).toEqual([{ name: "[0]", v: 10 }, { name: "[1]", v: 20 }]);
    const dict = describe({ $: "Dictionary", v: [["a", 1], ["b", [1, 2, 3]]] }, 27);
    expect(dict.value).toBe('{ "a": 1, "b": [1, 2, 3] }');
    expect(dict.type).toBe("Dictionary (2)");
    expect(dict.kids?.[1]).toEqual({ name: '"b"', v: [1, 2, 3] });
  });
  it("vectors, objects", () => {
    const v = describe({ $: "Vector2", v: [1.5, -2] }, 5);
    expect(v.value).toBe("(1.5, -2.0)");
    expect(v.kids?.map((k) => k.name)).toEqual(["x", "y"]);
    expect(describe({ $: "Object", id: "26709" }, 24)).toEqual({ value: "<Object#26709>", type: "Object", objId: "26709" });
    expect(text({ $: "NodePath", v: "/root/Main" })).toBe('^"/root/Main"');
  });
  it("inspect_objects members first", () => {
    const e = [1, "Node2D", [["Members/counter", 2, 0, "", 4100, 3], ["name", 21, 0, "", 0, { $: "StringName", v: "Main" }], ["Node2D", 0, 0, "", 128, null], ["position", 5, 1, "", 6, { $: "Vector2", v: [0, 0] }]]];
    expect(inspectProps(e).map((p) => p.name)).toEqual(["counter", "position"]);
  });
});
