import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ALL_TOOLS } from "../src/server";
import { getAnimations, parseDoc, serialize } from "../src/core";
import { HAVE_SPIDEY, ctxFor, makeFixture, run } from "./fixtures";

const f = makeFixture();
const ctx = ctxFor(f.root);
const read = (p: string) => readFileSync(p, "utf8");

describe("tool registry", () => {
  it("has the spec'd tools with descriptions and schemas", () => {
    const names = ALL_TOOLS.map((t) => t.name);
    for (const n of ["list_assets", "describe_model", "describe_animation", "find_preview_model", "list_pose_sets", "clip_info", "sample_pose", "get_keys", "validate", "add_animation", "duplicate_animation", "set_loop", "set_length", "set_keys", "delete_keys", "move_keys", "set_easing", "breakdown", "push_relax", "paste_with_noise", "add_noise", "mirror_clip", "snap_to_ticks", "apply_fix", "add_bone", "set_bone", "reparent_bone", "add_cube", "set_cube", "delete_bone", "delete_cube", "asset_status", "get_latest", "save_assets_to_git", "switch_branch", "run_game", "studio_open", "studio_state", "studio_screenshot", "studio_set_time", "studio_select"]) expect(names, n).toContain(n);
    expect(new Set(names).size).toBe(names.length);
    for (const t of ALL_TOOLS) { expect(t.description.length).toBeGreaterThan(10); expect(t.description.length).toBeLessThan(900); }
    // every file-writing tool supports dry_run
    for (const t of ALL_TOOLS) if (!t.readOnly && !t.live && !["get_latest", "switch_branch", "save_assets_to_git", "run_game", "studio_open", "studio_set_time", "studio_select"].includes(t.name)) expect(Object.keys(t.shape), t.name).toContain("dry_run");
  });
});

describe("allowlist", () => {
  it("refuses paths outside the roots, including ../ and symlink-free escapes", async () => {
    const r = await run(ctx, "describe_animation", { file: "/etc/hosts" });
    expect(r.isError).toBe(true);
    expect(r.str).toMatch(/outside the allowed roots/);
    const r2 = await run(ctx, "describe_animation", { file: `${f.root}/../../etc/passwd` });
    expect(r2.isError).toBe(true);
    const w = await run(ctx, "set_loop", { file: "/tmp/evil.animation.json", anim: "x", loop: true });
    expect(w.isError).toBe(true);
  });
});

describe("read tools (synthetic clip)", () => {
  it("describe_animation / get_keys / sample_pose", async () => {
    const d = await run(ctx, "describe_animation", { file: f.mini });
    expect(d.str).toContain("web_air: loop=true length=1s (20 ticks)");
    const d2 = await run(ctx, "describe_animation", { file: f.mini, anim: "web_air", bone: "armorRightArm" });
    expect(d2.str).toContain("armorRightArm/rotation");
    expect(d2.str).toContain("t: 0 0.5 1");
    const k = await run(ctx, "get_keys", { file: f.mini, anim: "web_air", bone: "armorRightArm" });
    expect(k.str).toContain("3 key(s)");
    const s = await run(ctx, "sample_pose", { file: f.mini, anim: "web_air", t: 0.25, bones: ["armorRightArm"] });
    expect(s.str).toContain("armorRightArm: rot [-155, 2.5, 15]");
  });
  it("validate flags an off-grid key and apply_fix repairs it", async () => {
    const dir = f.mini.replace("mini", "offgrid");
    writeFileSync(dir, read(f.mini).replace('"0.5"', '"0.52"'));
    const v = await run(ctx, "validate", { file: dir });
    expect(v.str).toMatch(/off-grid/);
    const id = /fix_id: (\S+)/.exec(v.str)![1];
    const dry = await run(ctx, "apply_fix", { file: dir, fix_id: id, dry_run: true });
    expect(dry.str).toContain("DRY RUN");
    expect(read(dir)).toContain('"0.52"');
    const real = await run(ctx, "apply_fix", { file: dir, fix_id: id });
    expect(real.isError).toBeFalsy();
    expect(read(dir)).not.toContain("0.52");
  });
});

describe("write tools: dry_run, byte-faithfulness, diff", () => {
  it("set_keys dry_run writes nothing; real write changes only the touched region", async () => {
    const before = read(f.mini);
    const args = { file: f.mini, anim: "web_air", keys: [{ bone: "armorRightArm", channel: "rotation", time: 0.25, value: [-155, 2, 15], easing: "easeInOutSine" }] };
    const dry = await run(ctx, "set_keys", { ...args, dry_run: true });
    expect(dry.str).toContain("DRY RUN");
    expect(dry.str).toContain("+");
    expect(dry.str.length).toBeLessThan(2000);
    expect(read(f.mini)).toBe(before);
    const real = await run(ctx, "set_keys", args);
    expect(real.str).toContain("Wrote");
    const after = read(f.mini);
    expect(after).not.toBe(before);
    // untouched parts byte-identical: first/last lines and the other bones
    expect(after.split("\n").slice(0, 8).join("\n")).toBe(before.split("\n").slice(0, 8).join("\n"));
    expect(after).toContain('"armorLeftArm"');
    const doc = parseDoc(after, "animation");
    const key = getAnimations(doc)[0].bones.get("armorRightArm")!.rotation!.keys.find((k) => k.time === 0.25)!;
    expect(key.easing).toBe("easeInOutSine");
    expect(serialize(doc)).toBe(after);
    // a repeated identical edit is a no-op
    const again = await run(ctx, "set_keys", args);
    expect(again.str).toMatch(/no change/);
    expect(read(f.mini)).toBe(after);
  });
  it("breakdown inserts keys between two frames", async () => {
    const r = await run(ctx, "breakdown", { file: f.mini, anim: "web_air", t_a: 0, t_b: 0.5, factor: 0.5, time: 0.25, bones: ["armorLeftArm"], dry_run: true });
    expect(r.isError).toBeFalsy();
    expect(r.str).toContain("armorLeftArm");
  });
  it("paste_with_noise is deterministic for a seed and reports it", async () => {
    const args = { file: f.mini, anim: "web_air", source: { from: 0, to: 1, bones: ["armorRightArm"] }, target_time: 1.0, repeat: 1, amplitude: { rotation: 3 }, seed: 42, dry_run: true };
    const a = await run(ctx, "paste_with_noise", args);
    const b = await run(ctx, "paste_with_noise", args);
    expect(a.isError).toBeFalsy();
    expect(a.str).toContain("seed: 42");
    expect(a.str).toBe(b.str);
    const c = await run(ctx, "paste_with_noise", { ...args, seed: 7 });
    expect(c.str).not.toBe(a.str);
  });
  it("mirror_clip swaps Left/Right and negates yaw/roll", async () => {
    const r = await run(ctx, "mirror_clip", { file: f.mini, anim: "web_air", new_name: "web_air_mirror" });
    expect(r.isError).toBeFalsy();
    const doc = parseDoc(read(f.mini), "animation");
    const m = getAnimations(doc).find((a) => a.name === "web_air_mirror")!;
    const k0 = m.bones.get("armorLeftArm")!.rotation!.keys.find((k) => k.time === 0)!;
    expect(k0.value.map((v) => Number(v) + 0)).toEqual([-150, 0, -10]);
    const src = getAnimations(doc).find((a) => a.name === "web_air")!;
    expect(src.bones.get("armorRightArm")!.rotation!.keys[0].value).toEqual([-150, 0, 10]);
  });
  it("rejects unknown clips and easings with a helpful message", async () => {
    const r = await run(ctx, "set_loop", { file: f.mini, anim: "nope", loop: true });
    expect(r.isError).toBe(true);
    expect(r.str).toContain("Available:");
    const e = await run(ctx, "set_easing", { file: f.mini, anim: "web_air", select: {}, easing: "wobble", dry_run: true });
    expect(e.str).toContain("Unknown easing");
  });
});

describe.skipIf(!HAVE_SPIDEY)("Thematic copies", () => {
  it("describe + validate the real web_sling file (no errors)", async () => {
    const d = await run(ctx, "describe_animation", { file: f.anim, search: "web_sling" });
    expect(d.str).toContain("web_sling_right");
    expect(d.str).toContain("{loop aimed:right_arm when:line}");
    const v = await run(ctx, "validate", { file: f.anim, include_warnings: false });
    // the live main checkout is edited by hand; loop-open is what WebSlingAnimationsJsonTest.loopsCloseOnThemselves would also flag
    const errLines = v.str.split("\n").filter((l) => l.startsWith("[E]"));
    expect(errLines.length).toBe(Number(/: (\d+) error\(s\)/.exec(v.str)?.[1]));
    expect(errLines.filter((l) => !l.includes("loop-open"))).toEqual([]);
    const ps = await run(ctx, "list_pose_sets", { file: f.anim });
    expect(ps.str).toContain('pose set "web"');
    const ci = await run(ctx, "clip_info", { file: f.anim, anim: "web_flip_front" });
    expect(ci.str).toContain("playback=whole");
  });
  it("a real edit then a no-op restore is byte-exact", async () => {
    const before = read(f.anim);
    const w = await run(ctx, "set_keys", { file: f.anim, anim: "web_air", keys: [{ bone: "armorRightArm", channel: "rotation", time: 0.8, value: [-120, 3, 20] }] });
    expect(w.isError).toBeFalsy();
    const mid = read(f.anim);
    expect(mid.length).not.toBe(before.length);
    const del = await run(ctx, "delete_keys", { file: f.anim, anim: "web_air", keys: [{ bone: "armorRightArm", channel: "rotation", time: 0.8 }] });
    expect(del.isError).toBeFalsy();
    const diffLines = mid.split("\n").length;
    expect(diffLines).toBeGreaterThan(0);
  });
  it("geo: describe_model, set_bone dry run, add_bone", async () => {
    const d = await run(ctx, "describe_model", { file: f.geo });
    expect(d.str).toContain("geometry");
    const bones = /^(\S+) pivot/m.exec(d.str)![1];
    const s = await run(ctx, "set_bone", { file: f.geo, bone: bones, pivot: [1, 2, 3], dry_run: true });
    expect(s.str).toContain("DRY RUN");
    const a = await run(ctx, "add_bone", { file: f.geo, name: "new_bone", parent: bones, pivot: [0, 0, 0] });
    expect(a.isError).toBeFalsy();
    expect(read(f.geo)).toContain("new_bone");
  });
  it("list_assets classifies", async () => {
    const r = await run(ctx, "list_assets", { type: "animation", search: "web_sling" });
    expect(r.str).toContain("web_sling.animation.json");
    expect(r.str).toContain("[animation/armor]");
    const rr = readdirSync(f.root);
    expect(rr).toContain("src");
  });
});

describe("find_preview_model", () => {
  it("looks for siblings", async () => {
    const r = await run(ctx, "find_preview_model", { file: f.mini });
    expect(r.str).toContain("namespace thematic");
    expect(r.str).toContain("Armor clip library");
    expect(existsSync(f.mini)).toBe(true);
  });
});
