import { describe, expect, it } from "vitest";
import { MAX_LINES, OutBuffer } from "./outbuf";

const texts = (b: OutBuffer) => b.lines.map((l) => b.lineText(l));

describe("OutBuffer", () => {
  it("splits lines and keeps stderr kind", () => {
    const b = new OutBuffer();
    b.push("out", "a\nb");
    b.push("err", "c\n");
    expect(texts(b)).toEqual(["a", "bc", ""]);
    expect(b.lines[1].spans.map((s) => s.k)).toEqual([undefined, "err"]);
  });
  it("parses SGR colours incl. 256 and truecolor, strips other CSI", () => {
    const b = new OutBuffer();
    b.push("out", "\x1b[31mred\x1b[0m plain \x1b[1;38;5;196mx\x1b[0m\x1b[38;2;1;2;3my\x1b[K\x1b[?25l");
    const sp = b.lines[0].spans;
    expect(sp[0]).toMatchObject({ t: "red", fg: "#bf616a" });
    expect(sp[1].fg).toBeUndefined();
    expect(sp[2]).toMatchObject({ t: "x", b: true, fg: "rgb(255,0,0)" });
    expect(sp[3]).toMatchObject({ t: "y", fg: "rgb(1,2,3)" });
  });
  it("handles split escape sequences", () => {
    const b = new OutBuffer();
    b.push("out", "a\x1b[3");
    b.push("out", "2mb");
    expect(b.lines[0].spans.map((s) => s.t + (s.fg ? "*" : ""))).toEqual(["a", "b*"]);
  });
  it("carriage return overwrites the line, CRLF is a newline", () => {
    const b = new OutBuffer();
    b.push("out", "10%\r50%\r100%\nnext\r\nz");
    expect(texts(b)).toEqual(["100%", "next", "z"]);
    const c = new OutBuffer();
    c.push("out", "abc\r");
    c.push("out", "\ndef");
    expect(texts(c)).toEqual(["abc", "def"]);
  });
  it("strips control lines, even mid-line and split across chunks", () => {
    const b = new OutBuffer();
    const ev: unknown[] = [];
    b.onControl = (e) => ev.push(e);
    b.push("out", 'before\x1e##ace:{"k":"start","id":"a"}\nafter\n\x1e##ace:{"k":"re');
    b.push("out", 'sult","id":"a"}\nend');
    b.push("out", "\x1e##a");
    b.push("out", 'ce:{"k":"done"}\n');
    expect(texts(b)).toEqual(["beforeafter", "end"]);
    expect(ev).toEqual([{ k: "start", id: "a" }, { k: "result", id: "a" }, { k: "done" }]);
  });
  it("is bounded", () => {
    const b = new OutBuffer();
    for (let i = 0; i < 5; i++) b.push("out", Array.from({ length: 10000 }, (_, j) => `line ${i}-${j}`).join("\n") + "\n");
    expect(b.lines.length).toBeLessThanOrEqual(MAX_LINES + 2001);
    expect(b.dropped).toBeGreaterThan(0);
    expect(texts(b)[b.lines.length - 2]).toBe("line 4-9999");
  });
  it("breaks absurdly long lines", () => {
    const b = new OutBuffer();
    b.push("out", "x".repeat(50000));
    expect(b.lines.length).toBe(3);
  });
});
