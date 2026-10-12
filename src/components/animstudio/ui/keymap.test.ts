import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { STUDIO_KEYMAP, conflicts, keymapMarkdown, registeredEntries } from "./keymap";
import { DEFS, toolAvailable } from "./tools/actions";
import { nudgeStep, nudgeVector } from "./tools/nudge";
import { parseKeystroke } from "../../../actions/keystroke";
import { intellijKeymap } from "../../../actions/keymap";

const repo = path.resolve(__dirname, "../../../..");
const parity = fs.readFileSync(path.join(repo, "docs/BLOCKBENCH-PARITY.md"), "utf8");

/** Blockbench action ids with a default key, straight from the extracted table in docs/BLOCKBENCH-PARITY.md section 1.1. */
function parityDefaults(): Array<{ id: string; def: string }> {
  const a = parity.indexOf("### 1.1 Default keybind table");
  const b = parity.indexOf("### 1.2");
  const out: Array<{ id: string; def: string }> = [];
  for (const line of parity.slice(a, b).split("\n")) {
    const cells = line.split("|").map((c) => c.trim());
    if (cells.length < 6 || !cells[1] || cells[1].startsWith("---") || cells[1] === "Action id") continue;
    const def = cells[4];
    if (!def || def === "—") continue;
    out.push({ id: cells[1], def });
  }
  return out;
}

describe("studio keymap table", () => {
  it("has no duplicate Blockbench ids", () => {
    const ids = STUDIO_KEYMAP.map((e) => e.id);
    expect(ids.filter((x, i) => ids.indexOf(x) !== i)).toEqual([]);
  });

  it("binds no key twice within a mode", () => {
    expect(conflicts()).toEqual([]);
  });

  it("every Blockbench default of the parity doc (1.1) is present: implemented, host or skipped with a reason", () => {
    const defaults = parityDefaults();
    expect(defaults.length).toBeGreaterThanOrEqual(90);
    const have = new Map(STUDIO_KEYMAP.map((e) => [e.id, e]));
    const missing = defaults.filter((d) => !have.has(d.id)).map((d) => d.id);
    expect(missing).toEqual([]);
    for (const d of defaults) {
      const e = have.get(d.id)!;
      if (e.status === "skipped" || e.status === "host") expect(e.note, `${d.id} needs a reason`).toBeTruthy();
    }
  });

  it("the timeline keys of section 1.5 are covered", () => {
    for (const id of ["play_animation", "jump_to_timeline_start", "jump_to_timeline_end", "set_animation_end", "timeline_frame_back", "timeline_frame_forth", "move_keyframe_back", "move_keyframe_forth", "move_graph_keyframes_up", "move_graph_keyframes_down", "add_keyframe", "timeline_graph_editor", "add_marker", "create_collection"]) {
      expect(STUDIO_KEYMAP.some((e) => e.id === id), id).toBe(true);
    }
  });

  it("every key parses in Ace's keystroke syntax", () => {
    for (const e of STUDIO_KEYMAP) for (const k of e.keys) expect(parseKeystroke(k), `${e.id}: ${k}`).toBeTruthy();
  });

  it("macOS mapping: no Ctrl/control in a Studio key (Ctrl -> meta), as Blockbench does", () => {
    for (const e of STUDIO_KEYMAP) for (const k of e.keys) expect(/\b(control|ctrl)\b/i.test(k), `${e.id}: ${k}`).toBe(false);
  });

  it("Ace-only moved keys do not collide with any Blockbench default key", () => {
    const bbKeys = new Set(STUDIO_KEYMAP.filter((e) => e.status !== "ace" && e.input === "key").flatMap((e) => e.keys.map((k) => parseKeystroke(k))));
    for (const e of STUDIO_KEYMAP.filter((x) => x.status === "ace")) for (const k of e.keys) expect(bbKeys.has(parseKeystroke(k)), `${e.id} ${k}`).toBe(false);
  });

  it("every registered entry has a handler in tools/actions.ts, and every key-bound handler has a table entry", () => {
    const ids = new Set(DEFS.map((d) => d.id));
    for (const e of registeredEntries()) expect(ids.has(e.action!), `${e.id} -> ${e.action}`).toBe(true);
    const inTable = new Set(STUDIO_KEYMAP.map((e) => e.action).filter(Boolean));
    expect(DEFS.filter((d) => /^Studio\.(Move|Tool|View|Key|Graph|Jump|Frame)/.test(d.id) && d.id !== "Studio.Frame").every((d) => inTable.has(d.id))).toBe(true);
    expect(new Set(DEFS.map((d) => d.id)).size).toBe(DEFS.length);
  });

  it("generated docs/STUDIO-KEYMAP.md is up to date (UPDATE_KEYMAP_DOC=1 regenerates)", () => {
    const file = path.join(repo, "docs/STUDIO-KEYMAP.md");
    const md = keymapMarkdown();
    if (process.env.UPDATE_KEYMAP_DOC || !fs.existsSync(file)) fs.writeFileSync(file, md);
    expect(fs.readFileSync(file, "utf8")).toBe(md);
  });

  it("documents which IntelliJ keys the Studio shadows (informational: all other IntelliJ keys stay live outside the Studio)", () => {
    const studio = new Set(STUDIO_KEYMAP.flatMap((e) => (e.status === "skipped" || e.status === "host" ? [] : e.keys)).map((k) => parseKeystroke(k)));
    let shadowed = 0;
    for (const keys of Object.values(intellijKeymap)) if (Array.isArray(keys)) for (const k of keys) if (studio.has(parseKeystroke(k))) shadowed++;
    expect(shadowed).toBeGreaterThan(0);
  });
});

describe("tool availability", () => {
  const doc = (kind: string) => ({ kind }) as never;
  it("edit tools need an editable document", () => {
    expect(toolAvailable({ mode: "edit", doc: doc("geo") }, "move")).toBe(true);
    expect(toolAvailable({ mode: "edit", doc: doc("bbmodel") }, "pivot")).toBe(true);
    expect(toolAvailable({ mode: "edit", doc: doc("animation") }, "move")).toBe(false);
    expect(toolAvailable({ mode: "edit", doc: null }, "rotate")).toBe(false);
  });
  it("pivot is edit-only, resize is not available in pose mode", () => {
    expect(toolAvailable({ mode: "animate", doc: doc("animation") }, "pivot")).toBe(false);
    expect(toolAvailable({ mode: "pose", doc: doc("animation") }, "resize")).toBe(false);
    expect(toolAvailable({ mode: "animate", doc: doc("animation") }, "resize")).toBe(true);
  });
});

describe("arrow nudges", () => {
  it("step sizes follow the snap table (1, 0.25 with shift, 0.1 with ctrl/cmd, 0.025 with both)", () => {
    expect([nudgeStep(false, false), nudgeStep(true, false), nudgeStep(false, true), nudgeStep(true, true)]).toEqual([1, 0.25, 0.1, 0.025]);
  });
  it("directions are camera relative and snap to an axis; file space has x negated", () => {
    // camera facing +z: screen-right is -x in scene space = +x in file space
    expect(nudgeVector("right", 0, 1)).toEqual([1, 0, 0]);
    expect(nudgeVector("left", 0, 1)).toEqual([-1, 0, 0]);
    expect(nudgeVector("forth", 0, 1)).toEqual([0, 0, 1]);
    expect(nudgeVector("back", 0, 2)).toEqual([0, 0, -2]);
    expect(nudgeVector("up", 0, 0.25)).toEqual([0, 0.25, 0]);
    // camera facing +x: forth moves along scene +x = file -x
    expect(nudgeVector("forth", Math.PI / 2, 1)).toEqual([-1, 0, 0]);
  });
});
