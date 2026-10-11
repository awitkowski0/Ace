import { describe, expect, it } from "vitest";
import { contrast } from "./color";
import { cssVars, monacoRules, monacoTheme, parseTok, termTheme } from "./build";
import { SCHEMES, schemeById } from "./schemes";
import { SEM_LEGEND_TYPES } from "./semanticRoles";

// "Nord" is the original muted scheme kept as is (comments 2.8:1 by design); every other scheme must meet the thresholds.
const checked = SCHEMES.filter((s) => !s.verbatimMonaco);

describe("scheme registry", () => {
  it("has unique ids, all required themes and a default", () => {
    expect(new Set(SCHEMES.map((s) => s.id)).size).toBe(SCHEMES.length);
    for (const n of ["Nord Vivid", "Nord", "Darcula", "IntelliJ Dark (New UI)", "One Dark Vivid", "Gradianto Deep Ocean", "Gradianto Nature Green", "Dracula", "Tokyo Night", "Catppuccin Mocha", "IntelliJ Light"]) {
      expect(SCHEMES.map((s) => s.name)).toContain(n);
    }
    expect(schemeById("nope").id).toBe("nord-vivid");
  });
  it("every scheme defines 16 slots and all css variables", () => {
    for (const s of SCHEMES) {
      expect(s.slots).toHaveLength(16);
      const v = cssVars(s);
      for (const k of ["--bg-editor", "--bg-chrome", "--fg", "--fg-dim", "--accent", "--nord0", "--nord15"]) expect(v[k], `${s.id} ${k}`).toMatch(/^#[0-9a-f]{6}$/);
    }
  });
});

describe("WCAG contrast", () => {
  for (const s of checked) {
    describe(s.name, () => {
      it("body text >= 7:1 on the editor background", () => {
        expect(contrast(s.ui.fg, s.ui.bg), "ui.fg").toBeGreaterThanOrEqual(7);
        expect(contrast(parseTok(s.syn.text).fg, s.ui.bg), "syn.text").toBeGreaterThanOrEqual(7);
        expect(contrast(s.ui.fg, s.ui.chrome), "ui.fg on chrome").toBeGreaterThanOrEqual(7);
        expect(contrast(s.ui.fgDim, s.ui.chrome), "fgDim on chrome").toBeGreaterThanOrEqual(4.5);
      });
      it("every syntax colour >= 4.5:1", () => {
        const bad = Object.entries(s.syn).map(([k, t]) => [k, contrast(parseTok(t).fg, s.ui.bg)] as const).filter(([, c]) => c < 4.5);
        expect(bad.map(([k, c]) => `${k}=${c.toFixed(2)}`)).toEqual([]);
      });
      it("every generated Monaco token + semantic rule >= 4.5:1", () => {
        const bg = monacoTheme(s).colors["editor.background"];
        const bad = monacoRules(s.syn).filter((r) => r.token !== "" && contrast(r.foreground!, bg) < 4.5).map((r) => r.token);
        expect(bad).toEqual([]);
      });
      it("terminal palette is readable", () => {
        const t = termTheme(s);
        for (const k of ["red", "green", "yellow", "blue", "magenta", "cyan", "white", "brightRed", "brightGreen", "brightYellow", "brightBlue", "brightMagenta", "brightCyan"]) {
          expect(contrast(t[k], t.background), k).toBeGreaterThanOrEqual(4.5);
        }
        expect(contrast(t.foreground, t.background)).toBeGreaterThanOrEqual(7);
      });
    });
  }
  it("Nord keeps its original Monaco theme verbatim (plus semantic rules)", () => {
    const n = schemeById("nord");
    const t = monacoTheme(n);
    expect(t.rules.find((r) => r.token === "keyword")?.foreground).toBe("81a1c1");
    expect(t.rules.some((r) => r.token.startsWith("sem."))).toBe(true);
  });
});

describe("distinct token roles (Nord Vivid)", () => {
  const s = schemeById("nord-vivid").syn;
  const col = (k: keyof typeof s) => parseTok(s[k]).fg;
  it("keyword, control flow, operator, type, fn declaration, call, field, parameter, constant, number, string, annotation all differ", () => {
    const keys = ["keyword", "control", "operator", "type", "fnDecl", "call", "field", "param", "constant", "number", "string", "annotation", "comment"] as const;
    expect(new Set(keys.map(col)).size).toBe(keys.length);
  });
});

describe("semantic legend", () => {
  it("has rules for every legend entry", () => {
    const rules = new Set(monacoRules(schemeById("nord-vivid").syn).map((r) => r.token));
    for (const t of SEM_LEGEND_TYPES) expect(rules.has(t), t).toBe(true);
  });
  it("static is italic, deprecated is struck through, function declaration has its own colour", () => {
    const r = monacoRules(schemeById("darcula").syn);
    const get = (t: string) => r.find((x) => x.token === t)!;
    expect(get("sem.property.static").fontStyle).toContain("italic");
    expect(get("sem.method.deprecated").fontStyle).toContain("strikethrough");
    expect(get("sem.function.declaration").foreground).not.toBe(get("sem.function").foreground);
  });
});
