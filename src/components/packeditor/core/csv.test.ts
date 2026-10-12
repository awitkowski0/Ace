import { describe, expect, it } from "vitest";
import { appendRow, csvNum, parseCsv, setCell } from "./csv";

const SHEET = `ability_id,cooldown,duration,range,damage,amplifier,disabled
# a comment, with a comma
thematic:aerial_charge,18,6,3,20,-1,FALSE

thematic:unibeam,12,2.5,32,7.2,-1,FALSE
thematic:last,1,1,1,1,1,FALSE
`;

describe("parseCsv", () => {
  it("reads the header, skips comments and blanks, keeps line numbers", () => {
    const c = parseCsv(SHEET);
    expect(c.header).toEqual(["ability_id", "cooldown", "duration", "range", "damage", "amplifier", "disabled"]);
    expect(c.rows.map((r) => [r.line, r.cells[0].text])).toEqual([[2, "thematic:aerial_charge"], [4, "thematic:unibeam"], [5, "thematic:last"]]);
    expect(c.endsWithNewline).toBe(true);
    expect(c.eol).toBe("\n");
  });
  it("cell spans point at the exact text", () => {
    const c = parseCsv(SHEET);
    const r = c.rows[1];
    expect(SHEET.slice(r.cells[2].s, r.cells[2].e)).toBe("2.5");
    expect(SHEET.slice(r.s, r.e)).toBe("thematic:unibeam,12,2.5,32,7.2,-1,FALSE");
  });
  it("quoted cells may hold commas", () => {
    const t = `ability,key,value\nx,"a,b",3\n`;
    const c = parseCsv(t);
    expect(c.rows[0].cells.map((x) => x.text)).toEqual(["x", "a,b", "3"]);
  });
});

describe("setCell", () => {
  it("changes only that cell, every other byte stays", () => {
    const c = parseCsv(SHEET);
    const out = setCell(SHEET, c.rows[1], 2, "3");
    expect(out).toBe(SHEET.replace("thematic:unibeam,12,2.5,", "thematic:unibeam,12,3,"));
    expect(out.length).toBe(SHEET.length - 2);
  });
  it("keeps CRLF line endings, padding and a missing final newline", () => {
    const t = "ability,key,value\r\nunibeam , charge , 0.6 \r\nother,x,1";
    const c = parseCsv(t);
    expect(c.eol).toBe("\r\n");
    const out = setCell(t, c.rows[0], 2, "0.8");
    expect(out).toBe("ability,key,value\r\nunibeam , charge , 0.8 \r\nother,x,1");
  });
  it("pads a short row up to the column", () => {
    const t = "ability_id,cooldown,duration,range,damage,amplifier,disabled\nx,1,2,3,4,5\n";
    const c = parseCsv(t);
    expect(setCell(t, c.rows[0], 6, "TRUE")).toBe("ability_id,cooldown,duration,range,damage,amplifier,disabled\nx,1,2,3,4,5,TRUE\n");
  });
  it("fills an empty cell", () => {
    const t = "a,b,c\n1,,3\n";
    const c = parseCsv(t);
    expect(setCell(t, c.rows[0], 1, "2")).toBe("a,b,c\n1,2,3\n");
  });
});

describe("appendRow", () => {
  it("adds a line in the file's style", () => {
    expect(appendRow("h\nr1\n", ["a", "b"])).toBe("h\nr1\na,b\n");
    expect(appendRow("h\r\nr1\r\n", ["a", "b"])).toBe("h\r\nr1\r\na,b\r\n");
    expect(appendRow("h\nr1", ["a", "b"])).toBe("h\nr1\na,b");
    expect(appendRow("", ["a"])).toBe("a\n");
  });
});

describe("csvNum", () => {
  it("prints plain numbers", () => {
    expect([csvNum(2.5), csvNum(3), csvNum(-1), csvNum(0.1 + 0.2), csvNum(NaN)]).toEqual(["2.5", "3", "-1", "0.3", "-1"]);
  });
});
