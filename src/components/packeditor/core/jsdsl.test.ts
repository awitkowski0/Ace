import { describe, expect, it } from "vitest";
import { applyEdits, callsOn, fnArg, num, objArg, plain, scanCalls, setProp, str, strArg, tokenize } from "./jsdsl";

const HUD = `// ammo
hud(hud => {
    hud.text("{ammo} / {capacity}", {
        anchor: "BOTTOM_RIGHT",
        x: -12,
        y: -22, // inset
        scale: 1.5,
        when: "notAiming",
    });
    hud.bar("reloadProgress", { anchor: "BOTTOM_CENTER", x: 0, y: -46, width: 62, height: 3 });
});
`;

describe("tokenize", () => {
  it("skips comments, keeps strings with escapes, regex vs division", () => {
    const t = tokenize(`a = "x\\"y" // c\n/* d */ b = c / 2; r = /a\\/b/g;`);
    expect(t.map((x) => x.v)).toEqual(["a", "=", '"x\\"y"', "b", "=", "c", "/", "2", ";", "r", "=", "/a\\/b/g", ";"]);
  });
  it("template literals with nested expressions are one token", () => {
    const t = tokenize("x(`a ${b + `c`} d`, 1)");
    expect(t[2].k).toBe("tpl");
    expect(t[4].v).toBe("1");
  });
});

describe("scanCalls", () => {
  it("finds builder calls with object args and offsets", () => {
    const calls = scanCalls(HUD);
    const root = calls.find((c) => c.method === "hud" && !c.recv)!;
    const els = callsOn(calls, fnArg(root));
    expect(els.map((c) => c.method)).toEqual(["text", "bar"]);
    expect(strArg(els[0])).toBe("{ammo} / {capacity}");
    const o = objArg(els[0])!;
    expect(num(o, "x")).toBe(-12);
    expect(num(o, "scale")).toBe(1.5);
    expect(str(o, "when")).toBe("notAiming");
    expect(HUD.slice(o.s, o.e)).toMatch(/^\{[\s\S]*\}$/);
  });
  it("an expression-bodied arrow is one call on its parameter", () => {
    const calls = scanCalls(`c.press(p => p.then("go"));`);
    expect(callsOn(calls, fnArg(calls.find((c) => c.method === "press")!)).map((c) => c.method)).toEqual(["then"]);
  });
  it("opaque values survive; nested callbacks are not mistaken for siblings", () => {
    const src = `c.console({ group: GROUP }, con => {
  con.page("p", { label: "l" }, page => {
    page.window("w", { x: 0.04, y: 0.08, w: 0.3, h: 0.6 }, win => {
      win.button("b", { label: "k", enabledWhen: { flag: HIVE_ON } }, a => { a.setFlag(HIVE_ON); a.sound("s", { volume: 0.8 }); });
    });
  });
});`;
    const calls = scanCalls(src);
    const con = calls.find((c) => c.method === "console")!;
    expect(plain(objArg(con))).toEqual({ group: undefined });
    const pages = callsOn(calls, fnArg(con));
    expect(pages.map((p) => p.method)).toEqual(["page"]);
    const wins = callsOn(calls, fnArg(pages[0]));
    const widgets = callsOn(calls, fnArg(wins[0]));
    expect(widgets.map((w) => w.method)).toEqual(["button"]);
    expect(plain(objArg(widgets[0]))).toEqual({ label: "k", enabledWhen: { flag: undefined } });
  });
});

describe("setProp", () => {
  const edit = (src: string, find: (s: string) => ReturnType<typeof objArg>, key: string, v: unknown) => {
    const o = find(src)!;
    return applyEdits(src, [setProp(src, o, key, v)]);
  };
  const firstObj = (s: string) => objArg(scanCalls(s).find((c) => c.method === "text")!);

  it("replaces only the value span, keeping comments and layout", () => {
    const out = edit(HUD, firstObj, "y", -30);
    expect(out).toBe(HUD.replace("y: -22, // inset", "y: -30, // inset"));
  });
  it("inserts into a multi-line object with a trailing comma", () => {
    const out = edit(HUD, firstObj, "color", "#FFAA00");
    expect(out).toContain(`        when: "notAiming",\n        color: "#FFAA00",\n    });`);
  });
  it("inserts into a one-line object and an empty one", () => {
    const one = `x.text("a", { x: 1 });`;
    expect(edit(one, firstObj, "y", 2)).toBe(`x.text("a", { x: 1, y: 2 });`);
    const empty = `x.text("a", {});`;
    expect(edit(empty, firstObj, "y", 2)).toBe(`x.text("a", { y: 2 });`);
  });
  it("removes an entry with its comma", () => {
    const one = `x.text("a", { x: 1, y: 2, z: 3 });`;
    expect(edit(one, firstObj, "y", undefined)).toBe(`x.text("a", { x: 1, z: 3 });`);
    expect(edit(one, firstObj, "z", undefined)).toBe(`x.text("a", { x: 1, y: 2 });`);
  });
  it("writes arrays and nested objects, rounding numbers", () => {
    const one = `x.text("a", { x: 1 });`;
    expect(edit(one, firstObj, "offset", [0.123456, -0, 2])).toBe(`x.text("a", { x: 1, offset: [0.1235, 0, 2] });`);
    expect(edit(one, firstObj, "from", { point: "eyes", offset: [0, 0.2, 0] })).toBe(`x.text("a", { x: 1, from: { point: "eyes", offset: [0, 0.2, 0] } });`);
  });
});
