import { describe, expect, it } from "vitest";
import { addTimingRow, buildTimeline, findStatRows, findTuneRows, packDefaultsCsv, readPhases, resolveLasts, setLastsLiteral, setStatCell, setTuneCell, tunedValue, type CsvIn, type TimingCtx } from "./timing";
import { applyEdits } from "./jsdsl";

// The shape of Thematic's unibeam.js, reproduced here, never read from the repo.
const UNI = `component(component => {
    component.cooldown();
    component.press(press => {
        press.sound("thematic:laser_charge", { world: true });
        press.then("charging");
    });
    component.phase("charging", charging => {
        charging.lasts(tuned("charge"));
        charging.then("firing");
    });
    component.phase("firing", firing => {
        firing.lasts("duration");
        firing.every(every => {
            every.beam({ range: tuned("radius") });
        });
        firing.then("cooldown");
    });
});
`;
const DEFAULTS = `ability_id,cooldown,duration,range,damage,amplifier,disabled
thematic:other,1,1,1,1,1,FALSE
thematic:unibeam,12,2.5,32,7.2,-1,FALSE
`;
const TUNING = `ability,key,value
all,charge,9
unibeam,charge,0.6
unibeam,push_strength,1.5
other,charge,4
`;
const files: CsvIn[] = [{ path: "/p/ability_defaults/heroes.csv", text: DEFAULTS }, { path: "/p/ability_defaults/tuning/iron_man.csv", text: TUNING }];
const ctxOf = (fs = files, name = "unibeam", suitOptions?: Record<string, unknown>): TimingCtx => ({ stat: findStatRows(fs, name)[0], tune: findTuneRows(fs, name), suitOptions });

describe("finding rows", () => {
  it("the defaults row is found by the id's name alone", () => {
    const r = findStatRows(files, "unibeam");
    expect(r).toHaveLength(1);
    expect(r[0].values).toEqual({ cooldown: "12", duration: "2.5", range: "32", damage: "7.2", amplifier: "-1", disabled: "FALSE" });
    expect(findStatRows([{ path: "x.csv", text: DEFAULTS.replace("thematic:unibeam", "my_pack:unibeam") }], "unibeam")).toHaveLength(1);
    expect(findStatRows(files, "nope")).toEqual([]);
  });
  it("tuning rows: the ability's own and the shared `all` ones, not another ability's", () => {
    const t = findTuneRows(files, "unibeam");
    expect(t.map((r) => [r.owner, r.key, r.own])).toEqual([["all", "charge", false], ["unibeam", "charge", true], ["unibeam", "push_strength", true]]);
  });
});

describe("tunedValue", () => {
  it("duration/damage/radius/amplifier read the row's columns; radius is the range column", () => {
    const c = ctxOf();
    expect(tunedValue(c, "duration")).toMatchObject({ value: 2.5, from: "column" });
    expect(tunedValue(c, "radius")).toMatchObject({ value: 32, from: "column", col: "range" });
    expect(tunedValue(c, "radius", 0.5).value).toBe(16);
    expect(tunedValue(c, "damage").value).toBe(7.2);
    expect(tunedValue(c, "amplifier")).toMatchObject({ value: null, from: "unset" }); // -1: not set
    expect(tunedValue(c, "range").from).toBe("error");
  });
  it("another key: the ability's own row beats `all`, times scales, then suit option, then otherwise", () => {
    const c = ctxOf(files, "unibeam", { shield: 4 });
    expect(tunedValue(c, "charge")).toMatchObject({ value: 0.6, from: "tuning" });
    expect(tunedValue(c, "charge", 2).value).toBe(1.2);
    const noOwn = ctxOf([files[0], { path: "t.csv", text: "ability,key,value\nall,charge,9\n" }]);
    expect(tunedValue(noOwn, "charge")).toMatchObject({ value: 9, from: "all" });
    expect(tunedValue(c, "shield")).toMatchObject({ value: 4, from: "suit option" });
    expect(tunedValue(c, "missing", 1, 3)).toMatchObject({ value: 3, from: "otherwise" });
    expect(tunedValue(c, "missing")).toMatchObject({ value: null, from: "unset" });
    // a suit option is not consulted when a row has the key
    expect(tunedValue(ctxOf(files, "unibeam", { charge: 99 }), "charge").value).toBe(0.6);
  });
  it("a missing defaults row leaves the columns unset", () => {
    expect(tunedValue({ tune: [] }, "duration")).toMatchObject({ value: null, from: "unset" });
  });
});

describe("readPhases", () => {
  it("phases with their lasts, then, and the phase the press leads to", () => {
    const r = readPhases(UNI);
    expect(r.entry).toBe("charging");
    expect(r.phases.map((p) => [p.name, p.lasts.kind, p.then])).toEqual([["charging", "tuned", "firing"], ["firing", "duration", "cooldown"]]);
    expect(r.phases[0].lasts).toMatchObject({ key: "charge" });
    expect(r.phases[0].line).toBe(7);
  });
  it("reads literals, the file form of tuned, scaled tuned and expressions", () => {
    const r = readPhases(`c.phase("a", a => { a.lasts(1.5); });
c.phase("b", b => { b.lasts(tuned("x", 2, 5)); });
c.phase("c", c => { c.lasts({ tuned: "y", times: 0.5 }); });
c.phase("d", d => { d.lasts(tuned("x") + 1); });
c.phase("e", e => { e.then("a"); });`);
    expect(r.phases.map((p) => p.lasts.kind)).toEqual(["literal", "tuned", "tuned", "other", "none"]);
    expect(r.phases[1].lasts).toMatchObject({ key: "x", times: 2, otherwise: 5 });
    expect(r.phases[2].lasts).toMatchObject({ key: "y", times: 0.5 });
    expect(r.phases[3].lasts.raw).toBe('tuned("x") + 1');
  });
  it("a hold leads to its phase too", () => {
    expect(readPhases(`c.hold(hold => hold.then("firing")); c.phase("firing", f => { f.lasts(2); });`).entry).toBe("firing");
  });
});

describe("resolveLasts", () => {
  it("says where each number came from and what edits it", () => {
    const c = ctxOf();
    const [charging, firing] = readPhases(UNI).phases;
    expect(resolveLasts(charging.lasts, c)).toMatchObject({ seconds: 0.6, from: "tuning", edit: { kind: "tuning", key: "charge" } });
    expect(resolveLasts(firing.lasts, c)).toMatchObject({ seconds: 2.5, from: "duration column", edit: { kind: "stat", col: "duration" } });
    expect(resolveLasts({ kind: "literal", value: 3 }, c)).toMatchObject({ seconds: 3, from: "literal", edit: { kind: "literal" } });
    expect(resolveLasts({ kind: "other", raw: "x" }, c)).toMatchObject({ seconds: null, from: "expression", edit: null });
    expect(resolveLasts({ kind: "none" }, c).from).toBe("no lasts");
  });
  it("tuned(\"duration\") edits the duration column; a missing row has nothing to edit", () => {
    expect(resolveLasts({ kind: "tuned", key: "duration", times: 2 }, ctxOf())).toMatchObject({ seconds: 5, edit: { kind: "stat", col: "duration" } });
    expect(resolveLasts({ kind: "duration" }, { tune: [] })).toMatchObject({ seconds: null, from: "unset", edit: null });
  });
});

describe("buildTimeline", () => {
  it("press -> phases in then() order -> cooldown, with seconds", () => {
    const t = buildTimeline(UNI, ctxOf());
    expect(t.steps.map((s) => [s.kind, s.name, s.seconds, s.start])).toEqual([["press", "press", 0, 0], ["phase", "charging", 0.6, 0], ["phase", "firing", 2.5, 0.6], ["cooldown", "cooldown", 12, 3.1]]);
    expect(t.total).toBeCloseTo(15.1);
    expect(t.orphans).toEqual([]);
  });
  it("follows then() across declaration order and lists unreachable phases", () => {
    const t = buildTimeline(`c.press(p => p.then("b"));
c.phase("a", a => { a.lasts(1); });
c.phase("b", b => { b.lasts(2); b.then("a"); });
c.phase("z", z => { z.lasts(9); });`, { tune: [] });
    expect(t.steps.map((s) => s.name)).toEqual(["press", "b", "a", "cooldown"]);
    expect(t.orphans.map((p) => p.name)).toEqual(["z"]);
    expect(t.total).toBeNull(); // no cooldown row
  });
  it("an unresolved or open-ended phase makes later starts unknown", () => {
    const t = buildTimeline(`c.press(p => p.then("a")); c.phase("a", a => { a.then("b"); }); c.phase("b", b => { b.lasts(1); });`, ctxOf());
    expect(t.steps.map((s) => [s.name, s.seconds, s.start])).toEqual([["press", 0, 0], ["a", null, 0], ["b", 1, null], ["cooldown", 12, null]]);
    expect(t.total).toBeNull();
  });
  it("a phase that never says where it goes ends the chain with a note; cycles stop", () => {
    expect(buildTimeline(`c.press(p => p.then("a")); c.phase("a", a => { a.hold(); });`, ctxOf()).notes[0]).toMatch(/"a" has no lasts/);
    const cyc = buildTimeline(`c.press(p => p.then("a")); c.phase("a", a => { a.lasts(1); a.then("a"); });`, ctxOf());
    expect(cyc.steps.map((s) => s.name)).toEqual(["press", "a"]);
  });
  it("a script with no phases is press -> cooldown; then(ready) skips the cooldown", () => {
    expect(buildTimeline(`c.cooldown();`, ctxOf()).steps.map((s) => s.name)).toEqual(["press", "cooldown"]);
    expect(buildTimeline(`c.press(p => p.then("a")); c.phase("a", a => { a.lasts(1); a.then("ready"); });`, ctxOf()).steps.map((s) => s.name)).toEqual(["press", "a", "ready"]);
  });
});

describe("edits", () => {
  it("lasts(n) in place", () => {
    const src = `c.phase("a", a => { a.lasts(1.5, { steady: false }); });`;
    const e = setLastsLiteral(src, "a", 3)!;
    expect(applyEdits(src, [e])).toBe(`c.phase("a", a => { a.lasts(3, { steady: false }); });`);
    expect(setLastsLiteral(UNI, "charging", 1)).toBeNull();
    expect(setLastsLiteral(UNI, "nope", 1)).toBeNull();
  });
  it("one defaults cell, found by name; the rest of the file is byte-identical", () => {
    const out = setStatCell(DEFAULTS, "unibeam", "duration", 3.5)!;
    expect(out).toBe(DEFAULTS.replace("thematic:unibeam,12,2.5,", "thematic:unibeam,12,3.5,"));
    expect(setStatCell(DEFAULTS, "nope", "duration", 1)).toBeNull();
    expect(setStatCell(TUNING, "unibeam", "duration", 1)).toBeNull();
  });
  it("one tuning value: the ability's own row, or the shared one when asked", () => {
    expect(setTuneCell(TUNING, "unibeam", "charge", 0.8)).toBe(TUNING.replace("unibeam,charge,0.6", "unibeam,charge,0.8"));
    expect(setTuneCell(TUNING, "unibeam", "charge", 7, "all")).toBe(TUNING.replace("all,charge,9", "all,charge,7"));
    expect(setTuneCell(TUNING, "unibeam", "nope", 1)).toBeNull();
  });
  it("Add timing row appends zeros and -1 in the file's style", () => {
    expect(addTimingRow(DEFAULTS, "thematic", "frost")).toBe(DEFAULTS + "thematic:frost,0,0,-1,-1,-1,FALSE\n");
    expect(addTimingRow("", "my_pack", "x")).toBe("ability_id,cooldown,duration,range,damage,amplifier,disabled\nmy_pack:x,0,0,-1,-1,-1,FALSE\n");
  });
});

describe("packDefaultsCsv", () => {
  const dir = "/r/src/packs/heroes/resources/data/thematic/ability_defaults";
  const root = "/r/src/packs/heroes/resources";
  it("the csv named after the pack, else the only one, else a new one", () => {
    expect(packDefaultsCsv([`${dir}/chucky.csv`, `${dir}/heroes.csv`], dir, root)).toBe(`${dir}/heroes.csv`);
    expect(packDefaultsCsv([`${dir}/only.csv`], dir, root)).toBe(`${dir}/only.csv`);
    expect(packDefaultsCsv([`${dir}/a.csv`, `${dir}/b.csv`], dir, root)).toBe(`${dir}/heroes.csv`);
    expect(packDefaultsCsv([], dir, root)).toBe(`${dir}/heroes.csv`);
  });
});
