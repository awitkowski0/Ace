import { describe, expect, it } from "vitest";
import { decodeAce, mapToken, remapSemanticTokens } from "./semantic";

const legend = { tokenTypes: ["class", "function", "method", "parameter", "variable", "property", "operator", "keyword"], tokenModifiers: ["declaration", "static", "readonly", "deprecated", "controlFlow"] };
// helper: [dLine, dStart, len, type, mods]
const t = (...a: number[]) => a;

describe("mapToken", () => {
  it("maps standard types and drops punctuation/operators", () => {
    expect(mapToken("class", new Set())?.role).toBe("class");
    expect(mapToken("operator", new Set())).toBeNull();
    expect(mapToken("unresolvedReference", new Set())).toBeNull();
  });
  it("modifiers: declaration / static / deprecated", () => {
    expect(mapToken("function", new Set(["declaration"]))).toMatchObject({ role: "function", decl: true });
    expect(mapToken("method", new Set(["static", "deprecated"]))).toMatchObject({ stat: true, deprecated: true });
  });
  it("readonly variable and ALL_CAPS are constants; self is self; controlFlow keyword is control", () => {
    expect(mapToken("variable", new Set(["readonly"]))?.role).toBe("constant");
    expect(mapToken("variable", new Set(), "MAX_SIZE")?.role).toBe("constant");
    expect(mapToken("variable", new Set(), "total")?.role).toBe("variable");
    expect(mapToken("parameter", new Set(), "self")?.role).toBe("self");
    expect(mapToken("keyword", new Set(["controlFlow"]))?.role).toBe("control");
  });
});

describe("remapSemanticTokens", () => {
  it("re-encodes relative positions after dropping unmapped tokens", () => {
    // line0: `class` @0 len5 (keyword), `Box` @6 len3 (class decl), `+` @10 len1 (operator, dropped); line2: `size` @4 len4 (method)
    const data = [...t(0, 0, 5, 7, 0), ...t(0, 6, 3, 0, 1), ...t(0, 4, 1, 6, 0), ...t(2, 4, 4, 2, 0)];
    const out = decodeAce(remapSemanticTokens(data, legend));
    expect(out).toEqual([
      { line: 0, start: 0, len: 5, type: "sem.keyword" },
      { line: 0, start: 6, len: 3, type: "sem.class.declaration" },
      { line: 2, start: 4, len: 4, type: "sem.method" },
    ]);
  });
  it("uses source text to refine self/constants", () => {
    const lines = ["def f(self, N):"];
    const data = [...t(0, 6, 4, 3, 0), ...t(0, 6, 1, 4, 0)];
    const out = decodeAce(remapSemanticTokens(data, legend, { text: (l, s, n) => lines[l].substr(s, n) }));
    expect(out.map((x) => x.type)).toEqual(["sem.self", "sem.variable"]);
  });
});
