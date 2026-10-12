#!/usr/bin/env node
// Animation Studio suite (docs/ANIMSTUDIO.md). Fixtures live in a scratch temp dir; the web clip + pose set are READ-ONLY copies from
// the MAIN Thematic-Collections checkout (another session edits it live: never asserted on, never written). Everything goes through the ATELIER_AUTOMATION harness (__qa.anim(), __qa.key) - never the real keyboard/mouse.
// Usage: ATELIER_BIN=src-tauri/target-qa/release/atelier node scripts/qa/animstudio.mjs
// Sections: A viewing/opening · B editing + text sync + undo · C viewport (pick/gizmo) · D spidey · T Thematic game preview (kinds, aim, spin, stride) · E timeline/tools · V viewport parity (camera/mouse/snap/face-resize/reference images) · G keymap (Blockbench defaults) · K limb links (constraints) + all-keys-selected badge · F Asset Dev
import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { launch, sleep, repo } from "./lib.mjs";

const home = os.homedir();
// git-status md5 is only asserted on the stale -spidey worktree (never written by us); the MAIN checkout is edited by another session
const real = fs.readdirSync(path.join(home, "IdeaProjects")).filter((n) => n === "Thematic-Collections-spidey").map((n) => path.join(home, "IdeaProjects", n));
const snap = (d) => { try { return execSync("git status --porcelain | md5", { cwd: d, encoding: "utf8", shell: "/bin/zsh" }).trim(); } catch { return "n/a"; } };
const before = Object.fromEntries(real.map((d) => [d, snap(d)]));
const out = path.join(repo, "scripts/qa/out");
fs.mkdirSync(out, { recursive: true });

// ---------------------------------------------------------------- fixtures
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ace-qa-anim-"));
const proj = path.join(tmp, "proj");
const crc = (() => { const t = new Int32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c; }); return (b) => { let c = -1; for (const x of b) c = t[(c ^ x) & 255] ^ (c >>> 8); return (c ^ -1) >>> 0; }; })();
function png(w, h, px) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const [r, g, b, a] = px(x, y); const o = y * (w * 4 + 1) + 1 + x * 4; raw[o] = r; raw[o + 1] = g; raw[o + 2] = b; raw[o + 3] = a; }
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}
// 64x64 test skin: coloured regions so UV mistakes are visible
const skin = png(64, 64, (x, y) => {
  const cell = ((x >> 3) + (y >> 3)) & 1;
  const hue = [[136, 192, 208], [163, 190, 140], [235, 203, 139], [208, 135, 112], [180, 142, 173], [129, 161, 193]][((x >> 4) + (y >> 4) * 4) % 6];
  return [hue[0] - cell * 40, hue[1] - cell * 40, hue[2] - cell * 40, 255];
});
const w = (rel, content) => { const f = path.join(proj, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, content); return f; };
const A = "src/common/resources/assets/test";
const cube = (o, s, uv, extra = {}) => ({ origin: o, size: s, uv, ...extra });
const geoJson = JSON.stringify({
  format_version: "1.12.0",
  "minecraft:geometry": [{
    description: { identifier: "geometry.golem", texture_width: 64, texture_height: 64, visible_bounds_width: 3, visible_bounds_height: 3, visible_bounds_offset: [0, 1, 0] },
    bones: [
      { name: "root", pivot: [0, 0, 0] },
      { name: "body", parent: "root", pivot: [0, 12, 0], cubes: [cube([-4, 12, -2], [8, 12, 4], [16, 16])] },
      { name: "head", parent: "body", pivot: [0, 24, 0], cubes: [cube([-4, 24, -4], [8, 8, 8], [0, 0]), { origin: [-5, 28, -5], size: [10, 0, 10], uv: { up: { uv: [40, 0], uv_size: [10, 10] }, down: { uv: [50, 10], uv_size: [-10, -10] } } }] },
      { name: "arm_l", parent: "body", pivot: [5, 22, 0], rotation: [0, 0, -10], cubes: [cube([4, 12, -2], [4, 12, 4], [32, 48])] },
      { name: "arm_r", parent: "body", pivot: [-5, 22, 0], cubes: [cube([-8, 12, -2], [4, 12, 4], [40, 16], { mirror: true })] },
    ],
  }],
}, null, 2) + "\n";
const animJson = JSON.stringify({
  format_version: "1.8.0",
  animations: {
    "animation.golem.wave": { loop: true, animation_length: 1, bones: { arm_l: { rotation: { "0.0": [0, 0, 0], "0.5": [0, 0, -90], "1.0": [0, 0, 0] } }, head: { rotation: { "0.0": [0, 0, 0], "1.0": [0, 20, 0] } } } },
    "animation.golem.idle": { loop: true, animation_length: 2, bones: { body: { position: { "0.0": [0, 0, 0], "1.0": [0, 1, 0], "2.0": [0, 0, 0] } } } },
  },
}, null, 2) + "\n";
const bb = JSON.stringify({
  meta: { format_version: "4.10", model_format: "bedrock", box_uv: false },
  name: "crate", resolution: { width: 16, height: 16 },
  elements: [
    { name: "lid", uuid: "11111111-0000-0000-0000-000000000001", from: [-4, 8, -4], to: [4, 10, 4], origin: [0, 8, 0], rotation: [0, 0, 0], faces: Object.fromEntries(["north", "east", "south", "west", "up", "down"].map((f) => [f, { uv: [0, 0, 8, 8], texture: 0 }])) },
    { name: "box", uuid: "11111111-0000-0000-0000-000000000002", from: [-4, 0, -4], to: [4, 8, 4], origin: [0, 0, 0], rotation: [0, 45, 0], faces: Object.fromEntries(["north", "east", "south", "west", "up", "down"].map((f) => [f, { uv: [8, 8, 16, 16], texture: 0 }])) },
  ],
  outliner: [{ name: "lid_bone", uuid: "22222222-0000-0000-0000-000000000001", origin: [0, 8, 0], rotation: [0, 0, 0], children: ["11111111-0000-0000-0000-000000000001"] }, { name: "base", uuid: "22222222-0000-0000-0000-000000000002", origin: [0, 0, 0], rotation: [0, 0, 0], children: ["11111111-0000-0000-0000-000000000002"] }],
  textures: [{ name: "crate.png", source: "data:image/png;base64," + skin.toString("base64"), uv_width: 16, uv_height: 16 }],
  animations: [{ uuid: "33333333-0000-0000-0000-000000000001", name: "open", loop: "once", length: 1, animators: { "22222222-0000-0000-0000-000000000001": { name: "lid_bone", type: "bone", keyframes: [{ channel: "rotation", data_points: [{ x: -90, y: 0, z: 0 }], uuid: "44444444-0000-0000-0000-000000000001", time: 1, interpolation: "linear" }] } } }],
}, null, 2) + "\n";
// second texture (a different pattern) for the multi-texture checks: a skin variant next to the geo's default texture, and a 2-texture bbmodel
const skin2 = png(64, 64, (x, y) => ((x + y) & 8 ? [250, 250, 120, 255] : [20, 20, 60, 255]));
const bb2 = JSON.stringify({
  meta: { format_version: "4.10", model_format: "bedrock", box_uv: false },
  name: "crate2", resolution: { width: 16, height: 16 },
  elements: [
    { name: "lid", uuid: "11111111-0000-0000-0000-000000000011", from: [-4, 8, -4], to: [4, 10, 4], origin: [0, 8, 0], rotation: [0, 0, 0], faces: Object.fromEntries(["north", "east", "south", "west", "up", "down"].map((f) => [f, { uv: [0, 0, 8, 8], texture: 0 }])) },
    { name: "box", uuid: "11111111-0000-0000-0000-000000000012", from: [-4, 0, -4], to: [4, 8, 4], origin: [0, 0, 0], rotation: [0, 0, 0], faces: Object.fromEntries(["north", "east", "south", "west", "up", "down"].map((f, i) => [f, { uv: [8, 8, 16, 16], texture: i === 0 ? 1 : 0 }])) },
  ],
  outliner: [{ name: "lid_bone", uuid: "22222222-0000-0000-0000-000000000011", origin: [0, 8, 0], rotation: [0, 0, 0], children: ["11111111-0000-0000-0000-000000000011"] }, { name: "base", uuid: "22222222-0000-0000-0000-000000000012", origin: [0, 0, 0], rotation: [0, 0, 0], children: ["11111111-0000-0000-0000-000000000012"] }],
  textures: [
    { name: "crate.png", id: "0", width: 64, height: 64, uv_width: 16, uv_height: 16, particle: true, visible: true, internal: true, saved: true, uuid: "55555555-0000-0000-0000-000000000001", source: "data:image/png;base64," + skin.toString("base64") },
    { name: "crate_alt.png", id: "1", width: 64, height: 64, uv_width: 16, uv_height: 16, particle: false, visible: true, internal: true, saved: true, uuid: "55555555-0000-0000-0000-000000000002", source: "data:image/png;base64," + skin2.toString("base64") },
  ],
}, null, 2) + "\n";
const files = {
  geo: w(`${A}/geo/entity/golem.geo.json`, geoJson),
  tex: w(`${A}/textures/entity/golem.png`, skin),
  anim: w(`${A}/animations/entity/golem.animation.json`, animJson),
  bb: w(`models/crate.bbmodel`, bb),
  bb2: w(`models/crate2.bbmodel`, bb2),
  glow: w(`${A}/textures/entity/golem_glow.png`, skin2),
};
const SPIDEY = path.join(home, "IdeaProjects/Thematic-Collections");
const spSwing = path.join(SPIDEY, "src/common/resources/assets/thematic/animations/armor/web_sling.animation.json");
const spPose = path.join(SPIDEY, "src/packs/heroes/resources/assets/thematic/poses/web.json");
const haveSpidey = fs.existsSync(spSwing) && fs.existsSync(spPose);
const T = "src/common/resources/assets/thematic";
if (haveSpidey) {
  files.swing = w(`${T}/animations/armor/web_sling.animation.json`, fs.readFileSync(spSwing));
  w(`src/packs/heroes/resources/assets/thematic/poses/web.json`, fs.readFileSync(spPose));
}
files.off = w(`${T}/animations/armor/offtick.animation.json`, JSON.stringify({
  format_version: "1.8.0",
  animations: { "web_sling_right": { loop: true, animation_length: 1, bones: { armorHead: { rotation: { "0.0": [0, 0, 0], "0.03": [10, 0, 0], "1.0": [0, 0, 0] } }, armorRightArm: { rotation: { "0.0": [0, 0, 0], "0.5": [-60, 0, 0], "1.0": [0, 0, 0] } } } } },
}, null, 2) + "\n");
// T: a pose-only clip with position keys the game never plays, a crawl clip with a body position, and a broadcast clip with a leg position
files.pos = w(`${T}/animations/armor/ignored_pos.animation.json`, JSON.stringify({
  format_version: "1.8.0",
  animations: {
    web_land: { animation_length: 0.5, bones: { armorRightArm: { rotation: { "0.0": [0, 0, 0], "0.5": [10, 0, 0] }, position: { "0.0": [1, 2, 3], "0.5": [1, 3, 3] } }, swing_pivot: { position: [0, 0, 0] } } },
    web_crawl: { loop: true, animation_length: 0.8, bones: { armorRightLeg: { position: { "0.0": [0, 0, 0], "0.8": [0, 0, 0] } }, armorBody: { position: { "0.0": [0, 1, 0], "0.8": [0, 1, 0] } }, swing_pivot: { position: [0, 6.4, 0] } } },
    web_sling_right: { loop: true, animation_length: 1, bones: { armorRightLeg: { position: { "0.0": [0, 0, 0], "1.0": [0, 0, 0] } }, swing_pivot: { position: [0, 0, 0] } } },
  },
}, null, 2) + "\n");
const asset = fs.mkdtempSync(path.join(os.tmpdir(), "ace-qa-anim-asset-"));
fs.cpSync(proj, path.join(asset, "p"), { recursive: true });
fs.mkdirSync(path.join(asset, "p/.ace"), { recursive: true });
fs.writeFileSync(path.join(asset, "p/.ace/config.json"), JSON.stringify({ version: 1, profile: "asset" }, null, 2) + "\n");

// ---------------------------------------------------------------- harness
const rows = [];
async function check(name, fn) {
  if (process.env.ONLY && !new RegExp(process.env.ONLY).test(name)) return;   // ONLY='^(L|U|X|S)\d' runs just those checks (state-dependent ones may then differ)
  let ok = false, note = "";
  try { const r = await fn(); ok = r === true || (r && r.ok); note = r && r.note ? r.note : ""; } catch (e) { note = String(e.message || e).split("\n")[0].slice(0, 260); }
  rows.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${note ? "  - " + note : ""}`);
}
const dataDir = fs.mkdtempSync(path.join(tmp, "data-"));
let app = await launch(proj, { dataDir });
const E = (body, o) => app.ev(`const A = await __qa.anim(); ${body}`, o);
const open = (f, mode) => E(`return await A.open(${JSON.stringify(f)}, ${JSON.stringify({ mode })})`);
const snapS = () => E(`return A.snapshot()`);
const key = (k) => E(`A.focus(); await __qa.key(${JSON.stringify(k)}); await A.sleep(120); return 1`);
const waitFor = async (expr, ms = 6000) => { const t0 = Date.now(); for (;;) { const r = await E(`return (${expr})`).catch(() => null); if (r) return r; if (Date.now() - t0 > ms) throw new Error("timeout: " + expr); await sleep(100); } };
const diffLines = (a, b) => { const x = a.split("\n"), y = b.split("\n"); let n = Math.abs(x.length - y.length); for (let i = 0; i < Math.min(x.length, y.length); i++) if (x[i] !== y[i]) n++; return n; };

try {
  await app.ev(`await __qa.waitFor(() => document.querySelector('.statusbar'), 20000); return 1`);

  // ============ A. opening each type ============
  await check("A1 .geo.json opens in the Studio (dual preview), rig + canvas + outliner", async () => {
    const s = await open(files.geo);
    const rows = await app.ev(`return document.querySelectorAll('.as-row-t').length`);
    await sleep(600);
    const s2 = await snapS();
    return { ok: s.docKind === "geo" && s.viewport?.canvas && s2.viewport.boneCount === 5 && s2.viewport.cubeCount === 5 && rows >= 5, note: `bones=${s2.viewport?.boneCount} cubes=${s2.viewport?.cubeCount} rows=${rows} tex=${s2.texture} loaded=${s2.viewport?.textureLoaded}` };
  });
  await check("A2 geo texture resolved from textures/<kind>/<stem>.png and loaded", async () => {
    await waitFor(`(async () => (await A.snapshot()).viewport.textureLoaded === 1)()`);
    return true;
  });
  await check("A3 geo lists the same-stem animation for preview", async () => {
    const s = await snapS();
    return { ok: s.siblings.anims.length === 1 && /golem\.animation\.json$/.test(s.siblings.anims[0]), note: JSON.stringify(s.siblings) };
  });
  await sleep(400);
  await sleep(500); app.shot("animstudio-geo");
  await check("A4 .animation.json opens in Animate mode on the built-in rig, animations listed", async () => {
    const s = await open(files.anim);
    return { ok: s.docKind === "animation" && s.mode === "animate" && s.anims.length === 2 && s.viewport.boneCount >= 5, note: `anims=${s.anims} bones=${s.viewport?.boneCount} rig=${JSON.stringify(s.rig)}` };
  });
  await check("A5 animation file previews on the same-stem geo (auto) with its texture", async () => {
    const s = await waitFor(`(async () => { const s = A.snapshot(); return s.rig?.path && s.viewport?.rig === "geo" && s.viewport.textureLoaded ? s : null; })()`).catch(() => null);
    const s2 = await snapS();
    return { ok: /golem\.geo\.json$/.test(s2.rig?.path ?? "") && s2.viewport.boneCount === 5, note: JSON.stringify(s2.rig) };
  });
  await check("A6 scrub: time 0.5 poses arm_l (-90° roll) in the viewport", async () => {
    await E(`A.set({ time: 0.5, anim: "animation.golem.wave" }); await A.sleep(200); return 1`);
    const s = await snapS();
    const z = s.viewport.bones.arm_l?.rot?.[2];
    return { ok: Math.abs(z - (-100)) < 6 || Math.abs(Math.abs(z) - 100) < 6, note: `arm_l rot=${JSON.stringify(s.viewport.bones.arm_l?.rot)}` };
  });
  await E(`A.set({ time: 0.5 }); return 1`);
  await sleep(300);
  await sleep(700); app.shot("animstudio-anim");
  await check("A7 .bbmodel opens in the Studio with embedded texture", async () => {
    const s = await open(files.bb);
    await sleep(700);
    const s2 = await snapS();
    return { ok: s.docKind === "bbmodel" && s2.viewport.cubeCount === 2 && s2.viewport.textureLoaded === 1 && s2.anims.includes("open"), note: `cubes=${s2.viewport?.cubeCount} tex=${s2.viewport?.textureLoaded} anims=${s2.anims}` };
  });
  await sleep(700); app.shot("animstudio-bbmodel");

  // ============ B. editing + text sync + undo ============
  const geoOnDisk = () => fs.readFileSync(files.geo, "utf8");
  let t0txt = "";
  await check("B1 edit cube via API changes the text minimally (<= 2 lines)", async () => {
    await open(files.geo);
    t0txt = await E(`return A.text()`);
    await E(`await A.call("run", "setCube", { bone: "body", index: 0, patch: { size: [10, 12, 4] } }, "Resize Cube"); return 1`);
    const t1 = await E(`return A.text()`);
    const d = diffLines(t0txt, t1);
    return { ok: d >= 1 && d <= 2 && t1.includes("10"), note: `diff lines=${d} dirty=${await E(`return A.dirty()`)}` };
  });
  await check("B2 Studio edit marks the tab dirty; ⌘S (harness) writes the fixture", async () => {
    const dirty = await E(`return A.dirty()`);
    await app.ev(`await __qa.key("meta S"); await __qa.sleep(500); return 1`);
    const disk = geoOnDisk();
    return { ok: dirty === true && disk !== t0txt && /"size": \[\s*10,\s*12,\s*4\s*\]/.test(disk), note: `dirty=${dirty}` };
  });
  await check("B3 ⌘Z with Studio focus restores the text (one undo stop)", async () => {
    await key("meta Z");
    const t = await E(`return A.text()`);
    return { ok: t === t0txt, note: `len ${t.length} vs ${t0txt.length}` };
  });
  await check("B4 ⌘⇧Z redoes", async () => {
    await key("meta shift Z");
    const t = await E(`return A.text()`);
    return t.includes("10, 12, 4") || /\[\s*10,\s*12,\s*4\s*\]/.test(t);
  });
  await check("B5 drag gesture (beginGesture + 3 commits + endGesture) is ONE undo step", async () => {
    await E(`await A.call("undo"); return 1`);
    await E(`await A.call("beginGesture"); for (const x of [1,2,3]) await A.call("run", "moveCube", { bone: "head", index: 0, delta: [x, 0, 0] }, "Move Cube"); await A.call("endGesture"); return 1`);
    const moved = await E(`return A.text()`);
    await E(`await A.call("undo"); return 1`);
    const back = await E(`return A.text()`);
    return { ok: moved !== t0txt && back === t0txt, note: `moved differs=${moved !== t0txt} back=${back === t0txt}` };
  });
  await check("B6 toggle Editor <-> Studio keeps text/selection; text edits reach the Studio", async () => {
    await E(`A.set({ bones: ["head"] }); return 1`);
    await app.ev(`document.querySelector('.dual-bar [data-mode=editor]').click(); await __qa.sleep(300); return 1`);
    const inText = await app.ev(`return !!document.querySelector('.monaco-editor') && !!document.querySelector('.ed-code:not(.hidden)')`);
    await app.ev(`document.querySelector('.dual-bar [data-mode=preview]').click(); await __qa.sleep(400); return 1`);
    const s = await snapS();
    return { ok: inText && s.bones[0] === "head" && s.viewport.boneCount === 5, note: `inText=${inText} bones=${s.bones}` };
  });
  await check("B7 text mode: ⌘Z still reaches Monaco (Studio actions inert)", async () => {
    await app.ev(`document.querySelector('.dual-bar [data-mode=editor]').click(); await __qa.sleep(300); const ed = __qa.editor(); ed.focus(); ed.setPosition({lineNumber:1,column:1}); await __qa.type("  "); await __qa.sleep(100); await __qa.key("meta Z"); await __qa.sleep(200); return 1`);
    const t = await app.ev(`return __qa.editor().getModel().getValue()`);
    await app.ev(`document.querySelector('.dual-bar [data-mode=preview]').click(); await __qa.sleep(300); return 1`);
    return { ok: t === t0txt, note: `restored=${t === t0txt}` };
  });
  await check("B8 invalid JSON keeps the last good view + banner", async () => {
    await E(`A.rawEdit("{{"); await A.sleep(600); return 1`);
    const s = await snapS();
    const banner = await app.ev(`return !!document.querySelector('[data-testid=parse-error]')`);
    await E(`A.rawUndo(); await A.sleep(500); return 1`);
    const s2 = await snapS();
    return { ok: !!s.parseError && banner && s.viewport.boneCount === 5 && !s2.parseError, note: `err=${!!s.parseError} banner=${banner} after=${s2.parseError}` };
  });

  // ============ C. viewport ============
  let cBase = "";
  await check("C1 picking a cube in the viewport selects it (project -> pick)", async () => {
    await open(files.geo);
    cBase = await E(`return A.text()`);
    const p = await E(`return await A.call("project", "head")`);
    await E(`await A.call("pick", ${p.x}, ${p.y}, false); return 1`);
    const s = await snapS();
    return { ok: s.bones[0] === "head" && s.cube?.bone === "head", note: `proj=${JSON.stringify(p)} bones=${s.bones} cube=${JSON.stringify(s.cube)}` };
  });
  await check("C2 gizmo move (nudge) commits one minimal edit and moves the cube", async () => {
    const t = await E(`return A.text()`);
    const ok = await E(`return await A.call("nudge", "move", [2, 0, 0])`);
    const t2 = await E(`return A.text()`);
    return { ok: ok && diffLines(t, t2) <= 3 && t !== t2, note: `diff=${diffLines(t, t2)}` };
  });
  await check("C3 gizmo rotate on a cube writes `rotation`", async () => {
    await E(`await A.call("nudge", "rotate", [0, 22.5, 0]); return 1`);
    const t = await E(`return A.text()`);
    return /"rotation": \[\s*0,\s*-?22\.5,\s*0\s*\]/.test(t);
  });
  await check("C4 undo x2 restores the original", async () => {
    await E(`await A.call("undo"); await A.call("undo"); return 1`);
    return (await E(`return A.text()`)) === cBase;
  });
  await check("C5 view presets + frame + wire/xray do not rebuild the scene", async () => {
    const r0 = (await snapS()).viewport.rebuilt;
    await E(`await A.call("setView", "front"); A.set({ wire: true }); await A.sleep(100); A.set({ wire: false, xray: true }); await A.sleep(100); A.set({ xray: false }); return 1`);
    const s = await snapS();
    return { ok: s.view === "front" && s.viewport.rebuilt === r0, note: `rebuilt ${r0} -> ${s.viewport.rebuilt}` };
  });
  await check("C6 incremental update: editing one cube rebuilds exactly one mesh", async () => {
    const r0 = (await snapS()).viewport.rebuilt;
    await E(`await A.call("run", "setCube", { bone: "arm_r", index: 0, patch: { size: [5, 12, 4] } }, "Resize Cube"); await A.sleep(200); return 1`);
    const s = await snapS();
    await E(`await A.call("undo"); return 1`);
    return { ok: s.viewport.rebuilt - r0 === 1, note: `rebuilt +${s.viewport.rebuilt - r0}` };
  });
  await check("C7 Edit mode keys: V/S/R/P switch tools; Studio keeps them from Monaco", async () => {
    const seq = [];
    for (const [k, tool] of [["R", "rotate"], ["V", "move"], ["P", "pivot"], ["S", "resize"]]) { await key(k); seq.push((await snapS()).tool === tool); }
    return { ok: seq.every(Boolean), note: seq.join() };
  });
  await check("C8 ⌘D duplicates the selected cube, ⌫ deletes it (Edit mode)", async () => {
    await E(`A.call("select", ["body"], { bone: "body", index: 0 }); return 1`);
    const n0 = (await snapS()).geo.bones.find((b) => b.name === "body").cubes;
    await key("meta D");
    const n1 = (await snapS()).geo.bones.find((b) => b.name === "body").cubes;
    await key("BACK_SPACE");
    const n2 = (await snapS()).geo.bones.find((b) => b.name === "body").cubes;
    await E(`await A.call("undo"); await A.call("undo"); return 1`);
    return { ok: n1 === n0 + 1 && n2 === n0, note: `${n0} -> ${n1} -> ${n2}` };
  });
  await check("C9 outliner: rename + reparent + add bone are single undo steps", async () => {
    const t0 = await E(`return A.text()`);
    await app.ev(`document.querySelector('[data-id=add-bone]').click(); await __qa.sleep(250); return 1`);
    const s = await snapS();
    const added = s.geo.bones.length === 6;
    await E(`await A.call("undo"); return 1`);
    return { ok: added && (await E(`return A.text()`)) === t0, note: `bones after add=${s.geo.bones.length}` };
  });
  await sleep(300);
  app.shot("animstudio-geo-edit");

  // ============ D. spidey ============
  if (haveSpidey) {
    await check("D1 spidey: pose set discovered for armor animation file, clips informed, zero ERRORS on real web_sling", async () => {
      await open(files.swing);
      await waitFor(`(async () => (await A.snapshot()).poseSets.length > 0 && (await A.snapshot()).clips > 5)()`, 10000);
      const s = await snapS();
      const errs = await E(`return A.state().problems.filter((p) => p.severity === "error" && p.code !== "loop-open").map((p) => p.code + ":" + p.anim)`);
      // loop-open on the live main checkout is exactly what WebSlingAnimationsJsonTest would fail on (javaparity.test.ts compares them); not asserted here
      return { ok: s.poseSets.includes("web") && !errs.length, note: `sets=${s.poseSets} clips=${s.clips} problems=${s.problems} errors=${errs.slice(0, 5)}` };
    });
    await check("D2 'As game applies' toggle ghosts procedural limbs / spin transform (mirrored + trick clips)", async () => {
      const names = await E(`return A.snapshot().anims.filter((n) => /flip_front|twist|swing_left/.test(n)).slice(0, 4)`);
      await E(`A.set({ asGameApplies: true, anim: ${JSON.stringify(names[0] ?? null)}, time: 0.2 }); await A.sleep(300); return 1`);
      const s = await snapS();
      return { ok: s.asGameApplies && !!s.viewport.game, note: `anim=${names[0]} game=${JSON.stringify(s.viewport.game)} trick=${s.viewport.trick}` };
    });
    await sleep(800); app.shot("animstudio-spidey");
    await check("D3 off-tick key shows a warning with a quick fix; fix is one undo step", async () => {
      await open(files.off);
      await waitFor(`(async () => (await A.snapshot()).problems > 0)()`, 8000);
      const codes = (await snapS()).problemCodes;
      const t0 = await E(`return A.text()`);
      const idx = await E(`return A.state().problems.findIndex((p) => p.fix)`);
      await E(`return A.applyFix(${idx})`);
      const t1 = await E(`return A.text()`);
      await E(`await A.call("undo"); return 1`);
      return { ok: t1 !== t0 && (await E(`return A.text()`)) === t0 && idx >= 0, note: `codes=${codes} fixIdx=${idx}` };
    });
  }

  // ============ E. timeline / tools (the timeline agent's half) ============
  await check("E1 Timeline mounted in Animate mode (dope sheet + inspector + animations list)", async () => {
    await open(files.anim);
    const dom = await app.ev(`return ["as-timeline","as-dopesheet","as-animations","as-keyframe","as-problems","as-problems-chip"].map((t) => t + "=" + !!document.querySelector('[data-testid=' + t + ']'))`);
    // the Problems chip / list are hidden entirely while a clip has no problems; Animations + keyframe inspector sit in the LEFT column, Outliner on the RIGHT
    const side = await app.ev(`const r = (s) => document.querySelector(s)?.getBoundingClientRect(); const a = r('[data-testid=as-animations]'), o = r('.as-row-t'), v = r('[data-testid=studio] canvas'); return !!(a && o && v) && a.right <= v.left + 1 && o.left >= v.right - 1`);
    return { ok: dom.slice(0, 4).every((x) => x.endsWith("true")) && dom.slice(4).every((x) => x.endsWith("false")) && side, note: dom.join(" ") + " flip=" + side };
  });
  await check("E2 'Q' inserts a key at the playhead for the selected bone (undo label Set/Insert)", async () => {
    await E(`A.set({ anim: "animation.golem.wave", time: 0.25, bones: ["arm_l"], keys: [] }); return 1`);
    const n0 = await E(`return A.state().doc && A.snapshot().commits`);
    await key("Q");
    const t = await E(`return A.text()`);
    const n1 = await E(`return A.snapshot().commits`);
    return { ok: n1 > n0 && /"0\.25"/.test(t), note: `commits ${n0}->${n1}` };
  });
  await check("E3 gizmo rotate in Animate mode auto-keys at the playhead", async () => {
    await E(`A.set({ anim: "animation.golem.wave", time: 0.75, bones: ["head"], cube: null, tool: "rotate", autoKey: true }); await A.sleep(150); return 1`);
    const ok = await E(`return await A.call("nudge", "rotate", [0, 0, 30])`);
    const t = await E(`return A.text()`);
    return { ok: ok && /"0\.75"/.test(t), note: `nudged=${ok}` };
  });
  await check("E4 Pose mode: breakdown commit via ⌥B -> Commit writes a key, label 'Pose Between Frames'", async () => {
    await E(`A.set({ mode: "pose", anim: "animation.golem.wave", time: 0.25, bones: ["arm_l"] }); await A.sleep(200); return 1`);
    await key("alt B");
    await waitFor(`!!document.querySelector('[data-testid=as-bd-commit]')`).catch(() => {});
    await app.ev(`const b = document.querySelector('[data-testid=as-bd-commit]'); if (b) b.click(); await __qa.sleep(250); return !!b`);
    const s = await snapS();
    return { ok: s.lastLabel === "Pose Between Frames", note: `label=${s.lastLabel}` };
  });
  await check("E5 noise paste (⌘C then ⌘⌥V, Enter) is deterministic for a seed", async () => {
    const run = async () => {
      await E(`A.set({ mode: "animate", anim: "animation.golem.wave", time: 0.25 }); return 1`);
      await E(`const ks = [{ bone: "arm_l", channel: "rotation", time: 0.5 }]; A.set({ keys: ks }); return 1`);
      await key("meta C");
      await E(`A.set({ time: 0.75 }); return 1`);
      await key("meta alt V");
      await waitFor(`!!document.querySelector('[data-testid=as-noise]')`);
      await app.ev(`const i = document.querySelector('[data-testid=as-n-seed] input, input[data-testid=as-n-seed]'); const c = document.querySelector('[data-testid=as-n-commit]'); c && c.click(); await __qa.sleep(300); return 1`);
      const t = await E(`return A.text()`);
      await E(`await A.call("undo"); return 1`);
      return t;
    };
    const a = await run(), b = await run();
    return { ok: a === b && a.includes("0.75"), note: `same=${a === b}` };
  });
  await check("E6 Space toggles playback (Animate), playhead advances", async () => {
    await E(`A.set({ time: 0, playing: false }); return 1`);
    await key("SPACE");
    // The hidden QA webview may not run requestAnimationFrame at all, so don't wait on rAF. What matters (Alex hit a
    // freeze: rAF chains doubling every frame) is that playback turns on and the page stays responsive while playing.
    await new Promise((r) => setTimeout(r, 1000));
    const t0 = Date.now();
    const s = await snapS();
    const latency = Date.now() - t0;
    await key("SPACE");
    const after = await snapS();
    return { ok: s.playing && latency < 1000 && !after.playing, note: `playing=${s.playing} time=${s.time} eval latency while playing=${latency}ms paused after 2nd Space=${!after.playing} (single rAF chain: playback.test.ts)` };
  });
  // Alex: "when I make an edit to just a rotation on the bone, it makes all of them that" - a collapsed bone row selects the
  // keys of every channel at that time; typing a rotation must not overwrite the position/scale keys selected with it.
  await check("E7 inspector: editing Rotation with rotation+position keys selected leaves the position key alone", async () => {
    await open(files.swing);
    const pick = await E(`const a = JSON.parse(A.text()).animations; const name = Object.keys(a).find((n) => { const b = a[n].bones?.armorBody; return b && typeof b.rotation === "object" && !Array.isArray(b.rotation) && typeof b.position === "object" && !Array.isArray(b.position) && Object.keys(b.rotation).some((t) => t in b.position); }); if (!name) return null; const b = a[name].bones.armorBody; const t = Object.keys(b.rotation).find((t) => t in b.position); return { name, t, pos: JSON.stringify(b.position[t]) };`);
    if (!pick) return { ok: false, note: "no clip with armorBody rotation+position keys at the same time" };
    const time = Number(pick.t);
    await E(`A.set({ mode: "animate", anim: ${JSON.stringify(pick.name)}, time: ${time}, bones: ["armorBody"], keys: [{ bone: "armorBody", channel: "rotation", time: ${time} }, { bone: "armorBody", channel: "position", time: ${time} }] }); await A.sleep(250); return 1`);
    const typed = await app.ev(`const inp = document.querySelector('[data-testid=as-insp-rotation] input'); if (!inp) return "no rotation field"; inp.focus(); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set; set.call(inp, "12.5"); inp.dispatchEvent(new Event("input", { bubbles: true })); inp.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); inp.blur(); await __qa.sleep(250); return "ok"`);
    const after = await E(`const b = JSON.parse(A.text()).animations[${JSON.stringify(pick.name)}].bones.armorBody; const r = b.rotation[${JSON.stringify(pick.t)}]; return { rot: JSON.stringify(r), pos: JSON.stringify(b.position[${JSON.stringify(pick.t)}]) }`);
    const rotX = JSON.parse(after.rot);
    const rx = Array.isArray(rotX) ? rotX[0] : (rotX.post ?? rotX.vector)[0];
    await key("meta Z");
    return { ok: typed === "ok" && rx === 12.5 && after.pos === pick.pos, note: `${pick.name}@${pick.t} typed=${typed} rot=${after.rot} pos ${pick.pos} -> ${after.pos}` };
  });


  // ============ G. keymap: Blockbench defaults inside the Studio ============
  const geoJ = async () => JSON.parse(await E(`return A.text()`))["minecraft:geometry"][0];
  const boneJ = async (n) => (await geoJ()).bones.find((b) => b.name === n);
  const undoAll = async (base) => { for (let i = 0; i < 14 && (await E(`return A.text()`)) !== base; i++) await key("meta Z"); return (await E(`return A.text()`)) === base; };
  await open(files.geo);
  const gBase = await E(`return A.text()`);
  const near = (a, b) => Math.abs(a - b) < 1e-3;

  await check("G1 registry: Blockbench keys are bound (⌘C/⌘V/⌘Y/⌘⇧Z, V S R P, arrows with optional ⇧/⌘, Q, F2, F3, F4, ⌘G, ⌘⇧G, ⌘M ...)", async () => {
    const acts = await app.ev(`return __qa.actions().filter((a) => a.id.startsWith("Studio."))`);
    const keys = (id) => acts.find((a) => a.id === id)?.keys ?? [];
    const need = { "Studio.Copy": ["meta C"], "Studio.Redo": ["meta Y", "shift meta Z"], "Studio.Tool.Resize": ["S"], "Studio.Move.Up": ["UP", "shift UP", "meta UP", "shift meta UP"], "Studio.AddKeyframe": ["Q"], "Studio.Rename": ["F2"], "Studio.ToggleGraph": ["F3"], "Studio.OutlinerOptions": ["F4"], "Studio.AddGroup": ["meta G"], "Studio.GroupElements": ["shift meta G"], "Studio.AddMarker": ["meta M"], "Studio.SetAnimationEnd": ["meta END"], "Studio.ActionControl": ["F"], "Studio.FrameBack": ["COMMA"], "Studio.Breakdown": ["alt B"], "Studio.PasteWithNoise": ["alt meta V"] };
    const bad = Object.entries(need).filter(([id, ks]) => !ks.every((k) => keys(id).includes(k))).map(([id]) => id);
    return { ok: !bad.length && acts.length >= 60, note: `studio actions=${acts.length} bad=${bad}` };
  });
  await check("G2 Edit tools V/S/R/P switch the gizmo tool; Space swaps back to the previous tool", async () => {
    await E(`A.set({ mode: "edit", tool: "move" }); return 1`);
    const seq = [];
    for (const k of ["R", "S", "P", "V"]) { await key(k); seq.push((await snapS()).tool); }
    await key("R"); await key("SPACE");
    const swapped = (await snapS()).tool;
    return { ok: seq.join() === "rotate,resize,pivot,move" && swapped === "move", note: `${seq} swap=${swapped}` };
  });
  await check("G3 bare keys are inert in text inputs (R in the outliner search does not switch the tool)", async () => {
    await E(`A.set({ tool: "move" }); return 1`);
    await app.ev(`document.querySelector('.as-search input').focus(); await __qa.key("R"); await __qa.sleep(100); return 1`);
    const t = (await snapS()).tool;
    await E(`A.focus(); return 1`);
    return { ok: t === "move", note: `tool=${t}` };
  });
  await check("G4 arrow nudges: step 1 / ⇧0.25 / ⌘0.1 / ⌘⇧0.025 (up = +y), camera-relative horizontal", async () => {
    await E(`A.set({ mode: "edit", bones: ["head"], cube: { bone: "head", index: 0 } }); return 1`);
    const y0 = (await boneJ("head")).cubes[0].origin;
    const ys = [];
    for (const k of ["UP", "shift UP", "meta UP", "meta shift UP"]) { await key(k); ys.push((await boneJ("head")).cubes[0].origin[1] - y0[1]); }
    await key("RIGHT");
    const o = (await boneJ("head")).cubes[0].origin;
    const horiz = Math.abs(o[0] - y0[0]) + Math.abs(o[2] - y0[2]);
    return { ok: near(ys[0], 1) && near(ys[1], 1.25) && near(ys[2], 1.35) && near(ys[3], 1.375) && near(horiz, 1), note: `dy=${ys} horiz=${horiz}` };
  });
  await check("G5 ⌘Z x N restores the file after the nudges (one undo stop each)", async () => ({ ok: await undoAll(gBase) }));
  await check("G6 ⌘D duplicates the bone, ⌘Z removes it; ⌘C then ⌘V pastes a copy; ⌫ deletes", async () => {
    const n0 = (await geoJ()).bones.length;
    await E(`A.set({ mode: "edit", bones: ["arm_l"], cube: null }); return 1`);
    await key("meta D"); const n1 = (await geoJ()).bones.length;
    await key("meta Z");
    await E(`A.set({ bones: ["arm_l"], cube: null }); return 1`);
    await key("meta C"); await key("meta V"); const n2 = (await geoJ()).bones.length;
    await key("meta Z");
    await E(`A.set({ bones: ["arm_r"], cube: null }); return 1`);
    await key("BACK_SPACE"); const n3 = (await geoJ()).bones.length;
    await key("meta Z");
    return { ok: n1 === n0 + 1 && n2 === n0 + 1 && n3 === n0 - 1 && (await E(`return A.text()`)) === gBase, note: `${n0} dup=${n1} paste=${n2} del=${n3}` };
  });
  await check("G7 ⌘⇧G groups the selection under a new bone; ⌘G adds an empty group", async () => {
    const nb = (await geoJ()).bones.length;
    await E(`A.set({ bones: ["arm_l"], cube: null }); return 1`);
    await key("meta shift G");
    const g = await geoJ();
    const arm = g.bones.find((b) => b.name === "arm_l");
    const grouped = !!arm.parent && arm.parent !== "body" && g.bones.some((b) => b.name === arm.parent) && g.bones.length === nb + 1;
    await key("meta Z");
    await key("meta G");
    const n1 = (await geoJ()).bones.length;
    await key("meta Z");
    return { ok: grouped && n1 === nb + 1 && (await E(`return A.text()`)) === gBase, note: `parent=${arm.parent} nb=${nb} n1=${n1}` };
  });
  await check("G8 ⌘A selects all bones, ⌘I inverts, I hides everything except the selection (again restores)", async () => {
    await key("meta A"); const all = (await snapS()).bones.length;
    await key("meta I"); const none = (await snapS()).bones.length;
    await E(`A.set({ bones: ["head"], cube: null, hidden: [] }); return 1`);
    await key("I"); const h1 = (await snapS()).hidden.length;
    await key("I"); const h2 = (await snapS()).hidden.length;
    return { ok: all === 5 && none === 0 && h1 === 2 && h2 === 0, note: `all=${all} inv=${none} hidden=${h1}->${h2}` };
  });
  await check("G9 F2 starts the inline rename of the selected bone; Enter renames (one undo stop)", async () => {
    await E(`A.set({ bones: ["head"], cube: null }); return 1`);
    await key("F2");
    const has = await waitFor(`!!document.querySelector('[data-testid=as-rename]')`).catch(() => false);
    await app.ev(`const i = document.querySelector('[data-testid=as-rename]'); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set; set.call(i, "skull"); i.dispatchEvent(new Event("input", { bubbles: true })); i.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); await __qa.sleep(250); return 1`);
    const renamed = !!(await boneJ("skull"));
    await E(`A.focus(); return 1`);
    await key("meta Z");
    return { ok: !!has && renamed && (await E(`return A.text()`)) === gBase, note: `input=${!!has} renamed=${renamed}` };
  });
  await check("G10 F4 toggles the outliner option columns, ⌘B toggles the sidebars", async () => {
    await E(`A.focus(); return 1`);
    await key("F4"); const on = await app.ev(`return document.querySelectorAll('.as-tog.opt').length`);
    await key("F4"); const off = await app.ev(`return document.querySelectorAll('.as-tog.opt').length`);
    await key("meta B"); const hid = await app.ev(`return document.querySelector('[data-testid=studio]').dataset.sidebars`);
    await key("meta B"); const shown = await app.ev(`return document.querySelector('[data-testid=studio]').dataset.sidebars ?? null`);
    return { ok: on > 0 && off === 0 && hid === "off" && shown === null, note: `opt cols ${on}->${off} sidebars=${hid}->${shown}` };
  });
  await check("G11 F opens Action Control (filter + Enter runs, Esc closes)", async () => {
    await E(`A.set({ mode: "edit", bones: ["head"], cube: null, tool: "move" }); A.focus(); return 1`);
    await key("F");
    const open1 = await waitFor(`!!document.querySelector('[data-testid=as-actioncontrol]')`).catch(() => false);
    await app.ev(`const i = document.querySelector('.as-ac-in'); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set; set.call(i, "rotate tool"); i.dispatchEvent(new Event("input", { bubbles: true })); await __qa.sleep(100); i.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); await __qa.sleep(250); return 1`);
    const tool = (await snapS()).tool;
    const closed = !(await app.ev(`return !!document.querySelector('[data-testid=as-actioncontrol]')`));
    await key("F"); await key("ESCAPE");
    const closed2 = !(await app.ev(`return !!document.querySelector('[data-testid=as-actioncontrol]')`));
    return { ok: !!open1 && tool === "rotate" && closed && closed2, note: `tool=${tool}` };
  });
  await check("G12 Edit tools are inert on an animation file (no geometry); Animate has no pivot tool", async () => {
    await open(files.anim);
    await E(`A.set({ mode: "edit", tool: "rotate" }); A.focus(); return 1`);
    await key("V"); const t1 = (await snapS()).tool;
    await E(`A.set({ mode: "animate", tool: "rotate" }); return 1`);
    await key("P"); const t2 = (await snapS()).tool;
    await key("V"); const t3 = (await snapS()).tool;
    return { ok: t1 === "rotate" && t2 === "rotate" && t3 === "move", note: `${t1} ${t2} ${t3}` };
  });
  await check("G13 Animate: Q adds a key, ⇧Q adds default values, ⌘Z undoes each", async () => {
    await E(`A.set({ mode: "animate", anim: "animation.golem.wave", bones: ["arm_l"], keys: [], time: 0.4 }); return 1`);
    const t0 = await E(`return A.text()`);
    await key("Q");
    const t1 = await E(`return A.text()`);
    await E(`A.set({ time: 0.9 }); return 1`);
    await key("shift Q");
    const t2 = await E(`return A.text()`);
    const reset = /"0\.9":\s*\[\s*0,\s*0,\s*0\s*\]/.test(t2);
    await key("meta Z"); await key("meta Z");
    return { ok: /"0\.4"/.test(t1) && reset && (await E(`return A.text()`)) === t0, note: `q=${/"0\.4"/.test(t1)} reset=${reset}` };
  });
  await check("G14 ←/→ move the selected keys one tick, ↑/↓ change their value, Home/End/,/. move the playhead", async () => {
    const sel = { bone: "arm_l", channel: "rotation", time: 0.5 };
    await E(`A.set({ keys: [${JSON.stringify(sel)}], time: 0 }); A.focus(); return 1`);
    const t0 = await E(`return A.text()`);
    await key("RIGHT"); const k1 = (await snapS()).keys; const r = await E(`return A.state().keys[0].time`);
    await key("LEFT"); const l = await E(`return A.state().keys[0].time`);
    await key("UP"); const up = /-89/.test(await E(`return A.text()`));
    await key("DOWN");
    const same = (await E(`return A.text()`)) === t0;
    await key("END"); const end = (await snapS()).time;
    await key("HOME"); const home = (await snapS()).time;
    await key("PERIOD"); const p = (await snapS()).time;
    await key("COMMA"); const c = (await snapS()).time;
    return { ok: near(r, 0.55) && near(l, 0.5) && up && same && near(end, 1) && home === 0 && near(p, 0.05) && c === 0, note: `right=${r} left=${l} up=${up} same=${same} end=${end} home=${home} .=${p} ,=${c}` };
  });
  await check("G15 ⌘End sets the animation length to the playhead; F3 toggles the graph editor; Space plays", async () => {
    await E(`A.set({ time: 0.8 }); return 1`);
    await key("meta END");
    const len = /"animation_length":\s*0\.8\b/.test(await E(`return A.text()`));
    await key("meta Z");
    const graphOn = () => app.ev(`return document.querySelector('[data-testid=as-tl-graph]')?.classList.contains('on') ?? null`);
    await key("F3"); const g1 = await graphOn();
    await key("F3"); const g2 = await graphOn();
    return { ok: len && g1 === true && g2 === false, note: `len=${len} graphOn=${g1}/${g2}` };
  });
  await check("G16 ⌘A selects all keys, ⌘I inverts, ⌘C/⌘V copy + paste at the playhead, ⌫ deletes the selection", async () => {
    await key("meta A"); const all = (await snapS()).keys; await key("meta I"); const inv = (await snapS()).keys;
    const t0 = await E(`return A.text()`);
    await E(`A.set({ keys: [{ bone: "arm_l", channel: "rotation", time: 0.5 }], time: 0.4 }); return 1`);
    await key("meta C"); await key("meta V");
    const pasted = /"0\.4"/.test(await E(`return A.text()`));
    await key("BACK_SPACE");
    const deleted = !/"0\.4"/.test(await E(`return A.text()`));
    await key("meta Z"); await key("meta Z");
    return { ok: all > 3 && inv === 0 && pasted && deleted && (await E(`return A.text()`)) === t0, note: `all=${all} inv=${inv} pasted=${pasted} deleted=${deleted}` };
  });
  await check("G17 .bbmodel geometry is editable: ⌘⇧G groups, NewCube adds an element, size edit keeps from/to consistent, ⌘Z restores byte-for-byte", async () => {
    await open(files.bb);
    await E(`A.set({ mode: "edit", bones: ["base"], cube: null }); A.focus(); return 1`);
    const t0 = await E(`return A.text()`);
    await key("meta shift G");
    const t1 = await E(`return A.text()`);
    const grouped = JSON.parse(t1).outliner.length >= 1 && t1 !== t0 && /group/.test(t1);
    await key("meta Z");
    await E(`A.focus(); await A.action("Studio.NewCube"); await A.sleep(200); return 1`);
    const j = JSON.parse(await E(`return A.text()`));
    const added = j.elements.length === 3;
    await key("meta Z");
    await E(`await A.call("run", "setBbCube", { group: "lid_bone", index: 0, patch: { size: [9, 2, 8] } }, "Resize Cube"); return 1`);
    const e = JSON.parse(await E(`return A.text()`)).elements[0];
    const ok2 = e.from[0] === -5 && e.to[0] === 4 && e.to[1] === 10;
    await key("meta Z");
    return { ok: grouped && added && ok2 && (await E(`return A.text()`)) === t0, note: `grouped=${grouped} added=${added} from.x=${e.from[0]} to.x=${e.to[0]}` };
  });
  await check("G18 .bbmodel Animate: ⌘M stores a marker in the animation, ⌘Z removes it", async () => {
    await E(`A.set({ mode: "animate", anim: "open", time: 0.5 }); A.focus(); return 1`);
    const t0 = await E(`return A.text()`);
    await key("meta M");
    const m = JSON.parse(await E(`return A.text()`)).animations[0].markers;
    await key("meta Z");
    return { ok: Array.isArray(m) && m.length === 1 && Math.abs(m[0].time - 0.5) < 1e-6 && (await E(`return A.text()`)) === t0, note: `markers=${JSON.stringify(m)}` };
  });
  await check("G19 outside the Studio the keys fall through: Studio actions are disabled while Monaco has focus", async () => {
    await open(files.geo);
    await app.ev(`document.querySelector('.dual-bar [data-mode=editor]')?.click(); await __qa.sleep(300); __qa.editor().focus(); return 1`);
    const r = await app.ev(`const ids = ["Studio.Undo", "Studio.Copy", "Studio.Tool.Move", "Studio.PlayPause", "Studio.Delete"]; const acts = __qa.actions(); return ids.map((id) => acts.find((a) => a.id === id)?.enabled)`);
    await app.ev(`document.querySelector('.dual-bar [data-mode=preview]')?.click(); await __qa.sleep(300); return 1`);
    return { ok: r.every((x) => x === false), note: `enabled=${r}` };
  });
  await check("G20 viewport keys call the viewport API (numpad views / projection / view mode) without throwing; stubs are logged", async () => {
    await open(files.geo);
    await E(`A.focus(); return 1`);
    const before = await snapS();
    for (const k of ["1", "8", "4", "5", "Z", "T"]) await key(k);
    const s = await snapS();
    return { ok: !!s && s.docKind === "geo" && !s.parseError, note: `view=${before.view}->${s.view}` };
  });

  // ============ V. viewport parity with Blockbench (camera, mouse, snapping, face resize, multi-select, reference images) ============
  // viewport owner's section: synthetic pointer events dispatched into the canvas (A.ptr / A.drag / A.wheel), never the real mouse.
  const vcam = async () => (await snapS()).viewport.camera;
  const vnear = (a, b, t = 0.6) => a.length === b.length && a.every((v, i) => Math.abs(v - b[i]) <= t);
  const vdist = (a, b) => Math.hypot(...a.map((v, i) => v - b[i]));
  const vvsize = async () => (await snapS()).viewport.canvasSize;
  const vgeoCube = async (bone, i = 0) => { const j = JSON.parse(await E(`return A.text()`)); return j["minecraft:geometry"][0].bones.find((b) => b.name === bone).cubes[i]; };
  await open(files.geo);
  await sleep(500);
  // NB: pointer coordinates stay >= 12px inside the canvas: react-resizable-panels grabs pointerdowns within a few px of a panel edge
  // normalise: other sections (keymap toggles, hide/lock) leave view state behind on this open file
  await E(`A.set({ mode: "edit", tool: "move", bones: [], cube: null, cubes: [], wire: false, xray: false, hidden: [], locked: [], checker: true, shading: true, grid: true, ground: false, viewMode: "textured", reference: false, refEdit: false, refsHidden: false, snap: true, space: "local" }); A.vp("resetCamera"); await A.sleep(300); return 1`);
  const vBase = await E(`return A.text()`);
  await check("V1 default camera = Blockbench: perspective FOV 45, near 1, far 30000, at [-40,32,-40] looking at [0,12,0]", async () => {
    const c = await vcam();
    return { ok: c.type === "perspective" && c.fov === 45 && c.near === 1 && c.far === 30000 && vnear(c.pos, [-40, 32, -40]) && vnear(c.target, [0, 12, 0]) && !c.locked, note: JSON.stringify(c) };
  });
  await sleep(300); await E(`A.renderNow(); return 1`); app.shot("animstudio-bb-persp");
  await check("V2 numpad presets are TRUE orthographic, locked, zoom 0.5, 512 away (front/back/left/right/top/bottom)", async () => {
    const want = { front: [0, 0, -512], back: [0, 0, 512], right: [512, 0, 0], left: [-512, 0, 0], top: [0, 512, 0], bottom: [0, -512, 0] };
    const bad = [];
    for (const [v, p] of Object.entries(want)) {
      await E(`await A.call("setView", ${JSON.stringify(v)}); await A.sleep(120); return 1`);
      const c = await vcam(), s = await snapS();
      if (!(c.type === "orthographic" && c.locked && c.zoom === 0.5 && vnear(c.pos, p, 1.5) && c.view === v && s.view === v && c.near === -8000 && c.far === 12000)) bad.push(v + ":" + JSON.stringify(c));
    }
    return { ok: !bad.length, note: bad.join(" | ") };
  });
  await check("V3 'Front' renders orthographic (no perspective convergence): cubes on the same axis project to the same screen x", async () => {
    await E(`await A.call("setView", "front"); await A.sleep(150); return 1`);
    const a = await E(`return [A.vp("projectCube", "head", 0), A.vp("projectCube", "body", 0)]`);
    const c = await vcam();
    return { ok: c.type === "orthographic" && Math.abs(a[0].x - a[1].x) < 0.6, note: `head.x=${a[0].x.toFixed(2)} body.x=${a[1].x.toFixed(2)}` };
  });
  await sleep(250); await E(`A.renderNow(); return 1`); app.shot("animstudio-bb-front");
  await check("V4 Num5 toggles projection at the current angle (unlocks a preset)", async () => {
    await E(`A.vp("toggleOrtho"); await A.sleep(100); return 1`);
    const c1 = await vcam(); const s1 = await snapS();
    await E(`A.vp("toggleOrtho"); await A.sleep(100); return 1`);
    const c2 = await vcam();
    await E(`A.vp("resetCamera"); await A.sleep(100); A.vp("toggleOrtho"); await A.sleep(100); return 1`);
    const c3 = await vcam();
    await E(`A.vp("resetCamera"); await A.sleep(100); return 1`);
    return { ok: c1.type === "perspective" && !c1.locked && s1.view === "persp" && c2.type === "orthographic" && !c2.locked && c3.type === "orthographic", note: `${c1.type}/${c2.type}/${c3.type}` };
  });
  const [vCW, vCH] = await vvsize();
  await check("V5 LMB drag on empty space orbits (distance to target constant)", async () => {
    const c0 = await vcam();
    await E(`await A.drag([14, 14], [120, 70]); return 1`);
    const c1 = await vcam();
    return { ok: vdist(c0.pos, c1.pos) > 5 && Math.abs(vdist(c0.pos, c0.target) - vdist(c1.pos, c1.target)) < 0.5 && vnear(c0.target, c1.target, 0.01), note: `moved ${vdist(c0.pos, c1.pos).toFixed(1)}` };
  });
  await check("V6 RMB drag pans (target moves, view direction unchanged)", async () => {
    const c0 = await vcam();
    await E(`await A.drag([${vCW - 60}, ${vCH - 60}], [${vCW - 120}, ${vCH - 100}], { button: 2 }); return 1`);
    const c1 = await vcam();
    return { ok: vdist(c0.target, c1.target) > 3 && vnear(c0.dir, c1.dir, 0.01), note: `target moved ${vdist(c0.target, c1.target).toFixed(1)}` };
  });
  await check("V7 Shift+LMB drag zooms (drag-zoom) and the wheel zooms; neither orbits", async () => {
    const c0 = await vcam();
    await E(`await A.drag([${vCW - 40}, 40], [${vCW - 40}, 120], { shift: true }); return 1`);
    const c1 = await vcam();
    await E(`A.wheel(300, 300, -240); await A.sleep(120); return 1`);
    const c2 = await vcam();
    return { ok: vdist(c1.pos, c1.target) > vdist(c0.pos, c0.target) + 1 && vdist(c2.pos, c2.target) < vdist(c1.pos, c1.target) - 1 && vnear(c0.dir, c1.dir, 0.01) && vnear(c1.dir, c2.dir, 0.01), note: `${vdist(c0.pos, c0.target).toFixed(1)} -> ${vdist(c1.pos, c1.target).toFixed(1)} -> ${vdist(c2.pos, c2.target).toFixed(1)}` };
  });
  await check("V8 arrow keys do NOT pan/orbit the viewport (Blockbench: enableKeys = false)", async () => {
    const c0 = await vcam();
    await E(`for (const k of ["ArrowLeft","ArrowRight","ArrowUp","ArrowDown"]) { window.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true })); window.dispatchEvent(new KeyboardEvent("keyup", { key: k, bubbles: true })); } await A.sleep(100); return 1`);
    const c1 = await vcam();
    return vnear(c0.pos, c1.pos, 0.001) && vnear(c0.target, c1.target, 0.001);
  });
  await check("V9 locked ortho preset ignores LMB orbit but still pans/zooms", async () => {
    await E(`await A.call("setView", "front"); await A.sleep(100); return 1`);
    const c0 = await vcam();
    await E(`await A.drag([14, 14], [120, 70]); return 1`);
    const c1 = await vcam();
    await E(`A.wheel(300, 300, -240); await A.sleep(100); return 1`);
    const c2 = await vcam();
    await E(`await A.drag([${vCW - 60}, ${vCH - 60}], [${vCW - 120}, ${vCH - 100}], { button: 2 }); return 1`);
    const c3 = await vcam();
    return { ok: vnear(c0.pos, c1.pos, 0.001) && c2.zoom > c1.zoom && vdist(c2.target, c3.target) > 1 && c3.view === "front", note: `zoom ${c1.zoom} -> ${c2.zoom}` };
  });
  await E(`A.vp("resetCamera"); await A.sleep(100); return 1`);
  await check("V10 Ctrl+LMB drag = area select; Edit-mode multi-select move moves ALL selected cubes in one undo step", async () => {
    await E(`A.set({ tool: "move", bones: [], cube: null, cubes: [] }); await A.sleep(100); await A.drag([14, 14], [${vCW - 14}, ${vCH - 14}], { ctrl: true }); return 1`);
    const st = await E(`const s = A.state(); return { n: s.cubes.length, cube: s.cube }`);
    const t0 = await E(`return A.text()`);
    await E(`return await A.call("nudge", "move", [2, 0, 0])`);
    const t1 = await E(`return A.text()`);
    const cs = (j) => j["minecraft:geometry"][0].bones.flatMap((b) => b.cubes ?? []);
    const c0 = cs(JSON.parse(t0)), c1 = cs(JSON.parse(t1));
    const moved = c1.filter((c, i) => c.origin.some((v, k) => v !== c0[i].origin[k])).length;
    const exact = c1.filter((c, i) => Math.abs(c.origin[0] - c0[i].origin[0] - 2) < 1e-6).length;  // arm_l sits in a rotated bone: same world delta, different file-space delta
    await E(`await A.call("undo"); return 1`);
    const restored = (await E(`return A.text()`)) === t0;
    return { ok: st.n === 5 && moved === 5 && exact >= 4 && restored, note: `selected=${st.n} moved=${moved}/5 exact(+2)=${exact} diffLines=${diffLines(t0, t1)} undoRestores=${restored}` };
  });
  await check("V11 click selects a CUBE in Edit mode (press on geometry); Ctrl-click adds; Shift-click selects the GROUP; empty click clears", async () => {
    await E(`A.set({ bones: [], cube: null, cubes: [] }); await A.sleep(80); return 1`);
    const ph = await E(`return A.vp("projectCube", "head", 0)`), pb = await E(`return A.vp("projectCube", "body", 0)`);
    await E(`A.ptr("pointerdown", ${ph.x}, ${ph.y}); A.ptr("pointerup", ${ph.x}, ${ph.y}); await A.sleep(80); return 1`);
    const a = await E(`const s = A.state(); return { cube: s.cube, cubes: s.cubes.length, bones: s.bones }`);
    await E(`A.ptr("pointerdown", ${pb.x}, ${pb.y}, { ctrl: true }); A.ptr("pointerup", ${pb.x}, ${pb.y}, { ctrl: true }); await A.sleep(80); return 1`);
    const b = await E(`const s = A.state(); return { cubes: s.cubes.length, bones: s.bones }`);
    // Blockbench: Shift-click ADDS the clicked cube's group to the selection; from an empty selection that is just the group
    await E(`A.ptr("pointerdown", 16, 16); A.ptr("pointerup", 16, 16); await A.sleep(80); A.ptr("pointerdown", ${ph.x}, ${ph.y}, { shift: true }); A.ptr("pointerup", ${ph.x}, ${ph.y}, { shift: true }); await A.sleep(80); return 1`);
    const c = await E(`const s = A.state(); return { cube: s.cube, bones: s.bones }`);
    await E(`A.ptr("pointerdown", 16, 16); A.ptr("pointerup", 16, 16); await A.sleep(80); return 1`);
    const d = await E(`const s = A.state(); return { cube: s.cube, bones: s.bones, cubes: s.cubes.length }`);
    return { ok: a.cube?.bone === "head" && a.cubes === 1 && b.cubes === 2 && c.cube === null && c.bones[0] === "head" && d.cube === null && d.bones.length === 0, note: JSON.stringify({ a, b, c, d }) };
  });
  await check("V12 selection outline: 2px #3e90ff fat line on the selected cube; Pivot tool shows AxesHelper markers", async () => {
    await E(`A.set({ tool: "move" }); await A.call("select", ["head"], { bone: "head", index: 0 }); await A.sleep(150); return 1`);
    const a = (await snapS()).viewport.selection;
    await E(`A.set({ tool: "pivot" }); await A.sleep(150); return 1`);
    const b = (await snapS()).viewport.selection;
    await E(`A.set({ tool: "move" }); return 1`);
    return { ok: a.outlines === 1 && a.width === 2 && a.color === "#3e90ff" && a.fat && a.pivots === 0 && b.pivots >= 1, note: JSON.stringify({ a, b }) };
  });
  await check("V13 snap steps by modifier: move 1 / .25 / .1 / .025 and rotate 2.5 / 22.5 / 1 / .25", async () => {
    const out = [];
    for (const [mods, mv, rt] of [[{}, 1, 2.5], [{ shift: true }, 0.25, 22.5], [{ ctrl: true }, 0.1, 1], [{ shift: true, ctrl: true }, 0.025, 0.25]]) {
      await E(`window.dispatchEvent(new KeyboardEvent("keydown", { key: "x", shiftKey: ${!!mods.shift}, ctrlKey: ${!!mods.ctrl}, bubbles: true })); await A.sleep(60); return 1`);
      const s = (await snapS()).viewport;
      out.push(s.tcSnap.t === mv && s.tcSnap.r === rt);
    }
    await E(`window.dispatchEvent(new KeyboardEvent("keyup", { key: "x", bubbles: true })); return 1`);
    return { ok: out.every(Boolean), note: out.join() };
  });
  await check("V14 lighting = Blockbench rig (ambient 0.5 + 6 directional); shading off = ambient 1.0 only", async () => {
    const a = (await snapS()).viewport.stage;
    await E(`A.set({ shading: false }); await A.sleep(100); return 1`);
    const b = (await snapS()).viewport.stage;
    await E(`A.set({ shading: true }); await A.sleep(60); return 1`);
    return { ok: a.directional === 6 && a.ambient === 1 && Math.abs(a.ambientIntensity - 0.5) < 1e-3 && b.directional === 0 && Math.abs(b.ambientIntensity - 1) < 1e-3, note: JSON.stringify({ a, b }) };
  });
  await check("V15 background: checkerboard #14171b/30px by default, solid #101316 when toggled; grid on, ground plane off", async () => {
    const q = () => app.ev(`const e = document.querySelector('.as-vp-bgfx'); const cs = getComputedStyle(e); return { checker: e.classList.contains('checker'), bg: cs.backgroundColor, size: cs.backgroundSize }`);
    const a = await q();
    await E(`A.set({ checker: false }); await A.sleep(80); return 1`);
    const b = await q();
    await E(`A.set({ checker: true }); return 1`);
    const st = (await snapS()).viewport.stage;
    return { ok: a.checker && a.bg === "rgb(20, 23, 27)" && /30px/.test(a.size) && !b.checker && b.bg === "rgb(16, 19, 22)" && st.grid && !st.ground, note: JSON.stringify({ a, b }) };
  });
  // ---- face-drag resize (Blockbench Resize tool): ortho front, 8 px per unit
  await E(`await A.call("setView", "front"); A.set({ tool: "resize" }); await A.call("select", ["head"], { bone: "head", index: 0 }); await A.sleep(200); return 1`);
  const gHead0 = await vgeoCube("head", 0);
  const gText0 = await E(`return A.text()`);
  await check("V16 Resize tool shows per-face handles (not the centre scale gizmo)", async () => {
    const s = await snapS();
    const p = await E(`return A.vp("faceHandleScreen", 1, 1)`);
    return { ok: s.viewport.gizmo?.kind === "face-handles" && !!p, note: JSON.stringify(s.viewport.gizmo) + " tip=" + JSON.stringify(p) };
  });
  await check("V17 drag the +Y face handle 24px (= 3 units at 8px/unit): ONLY that cube's size.y changes (minimal text), origin untouched", async () => {
    const p = await E(`return A.vp("faceHandleScreen", 1, 1)`);
    await E(`await A.drag([${p.x}, ${p.y}], [${p.x}, ${p.y - 24}]); return 1`);
    const h = await vgeoCube("head", 0), t = await E(`return A.text()`);
    const lines = diffLines(gText0, t);
    return { ok: h.size[1] === gHead0.size[1] + 3 && h.size[0] === gHead0.size[0] && h.size[2] === gHead0.size[2] && h.origin.every((v, i) => v === gHead0.origin[i]) && lines <= 2, note: `size ${gHead0.size} -> ${h.size} origin ${h.origin} diffLines=${lines}` };
  });
  await check("V18 drag the -Y face handle down 16px: size.y +2 and origin.y -2 (the min face moves)", async () => {
    const before = await vgeoCube("head", 0);
    const p = await E(`return A.vp("faceHandleScreen", 1, -1)`);
    await E(`await A.drag([${p.x}, ${p.y}], [${p.x}, ${p.y + 16}]); return 1`);
    const h = await vgeoCube("head", 0);
    return { ok: h.size[1] === before.size[1] + 2 && h.origin[1] === before.origin[1] - 2, note: `size.y ${before.size[1]} -> ${h.size[1]}, origin.y ${before.origin[1]} -> ${h.origin[1]}` };
  });
  await check("V19 modifier steps while resizing: Ctrl = 0.1 (11px = 1.375 units -> 1.4), Shift = 0.25 (10px -> 1.25)", async () => {
    const before = await vgeoCube("head", 0);
    const px = await E(`return A.vp("faceHandleScreen", 0, 1)`);   // scene +X = screen LEFT in the front view
    await E(`await A.drag([${px.x}, ${px.y}], [${px.x - 11}, ${px.y}], { ctrl: true }); return 1`);
    const h = await vgeoCube("head", 0);
    const dx = h.size[0] - before.size[0];
    const py = await E(`return A.vp("faceHandleScreen", 1, 1)`);
    await E(`await A.drag([${py.x}, ${py.y}], [${py.x}, ${py.y - 10}], { shift: true }); return 1`);
    const h2 = await vgeoCube("head", 0);
    const dy = h2.size[1] - h.size[1];
    return { ok: Math.abs(dx - 1.4) < 1e-6 && Math.abs(h.origin[0] - (before.origin[0] - 1.4)) < 1e-6 && Math.abs(dy - 1.25) < 1e-6, note: `dx=${dx} dy=${dy}` };
  });
  await check("V20 Esc during a face drag cancels (no text change)", async () => {
    const t0 = await E(`return A.text()`);
    const p = await E(`return A.vp("faceHandleScreen", 1, 1)`);
    await E(`A.ptr("pointerdown", ${p.x}, ${p.y}); A.ptr("pointermove", ${p.x}, ${p.y - 30}); await A.sleep(60); window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); A.ptr("pointerup", ${p.x}, ${p.y - 30}); await A.sleep(150); return 1`);
    return (await E(`return A.text()`)) === t0;
  });
  await check("V21 undo restores the file after the four resizes (one undo stop each)", async () => {
    await E(`for (let i = 0; i < 4; i++) await A.call("undo"); await A.sleep(100); return 1`);
    return (await E(`return A.text()`)) === gText0;
  });
  await E(`A.set({ tool: "move", bones: [], cube: null, cubes: [] }); A.vp("resetCamera"); await A.sleep(200); return 1`);

  // ---- reference images
  const vRefPng = png(96, 48, (x, y) => (((x >> 3) + (y >> 3)) & 1 ? [235, 203, 139, 255] : x < 3 || y < 3 || x > 92 || y > 44 ? [191, 97, 106, 255] : [94, 129, 172, 255]));
  const vRefUrl = "data:image/png;base64," + vRefPng.toString("base64");
  const vProjFiles = () => { const out = []; const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else out.push(p); } }; walk(proj); return out.sort().join("\n"); };
  const vProjBefore = vProjFiles();
  const vPstore = (name) => { const root = path.join(dataDir, "projects"); if (!fs.existsSync(root)) return []; return fs.readdirSync(root).map((d) => ({ d, f: path.join(root, d, name), who: fs.existsSync(path.join(root, d, "project.txt")) ? fs.readFileSync(path.join(root, d, "project.txt"), "utf8").trim() : "" })).filter((x) => fs.existsSync(x.f)); };
  let vRefId = "";
  await check("R1 add a reference image (generated PNG): Blockbench defaults (flat image, Behind Model, scope project, opacity 1), drawn in the Behind layer", async () => {
    vRefId = await E(`const r = await A.refs.add(${JSON.stringify(vRefUrl)}, { name: "front.png" }); await A.sleep(300); return r.uuid`);
    const r = (await E(`return A.refs.list()`))[0];
    const dom = await app.ev(`return { behind: document.querySelectorAll('.as-ref-layer.behind [data-ref]').length, above: document.querySelectorAll('.as-ref-layer.above [data-ref]').length }`);
    return { ok: r.layer === "background" && r.view_mode === "flat_image" && r.scope === "project" && r.opacity === 1 && r.rotation === 0 && r.size[0] === 400 && r.size[1] === 200 && dom.behind === 1 && dom.above === 0, note: JSON.stringify({ size: r.size, dom }) };
  });
  await check("R2 layers: Above Model / Above Interface move the image into the other DOM layers; opacity/flip/rotation apply", async () => {
    const q = () => app.ev(`const c = (s) => document.querySelectorAll('.as-ref-layer.' + s + ' [data-ref]').length; const e = document.querySelector('[data-ref]'); return { behind: c('behind'), above: c('above'), float: c('float'), opacity: e && e.style.opacity, tf: e && e.style.transform, flip: e && e.querySelector('img').style.transform }`);
    await E(`A.refs.update(${JSON.stringify(vRefId)}, { layer: "viewport", opacity: 0.5, rotation: 15, flip_x: true }); await A.sleep(200); return 1`);
    const a = await q();
    await E(`A.refs.update(${JSON.stringify(vRefId)}, { layer: "float" }); await A.sleep(150); return 1`);
    const b = await q();
    await E(`A.refs.update(${JSON.stringify(vRefId)}, { layer: "background", opacity: 1, rotation: 0, flip_x: false }); await A.sleep(150); return 1`);
    return { ok: a.above === 1 && a.opacity === "0.5" && /15deg/.test(a.tf) && /scale\(-1, 1\)/.test(a.flip) && b.float === 1 && b.above === 0, note: JSON.stringify({ a, b }) };
  });
  await check("R3 geo project scope persisted OUTSIDE the repo: app data pstore (properties + image copy), nothing new in the project tree", async () => {
    await sleep(300);
    const props = vPstore("refimages.json").find((x) => x.who.endsWith(files.geo));
    const j = props ? JSON.parse(fs.readFileSync(props.f, "utf8")) : null;
    const img = props ? fs.readdirSync(path.dirname(props.f)).filter((f) => f.startsWith("refimg_")) : [];
    const stored = j?.reference_images?.[0];
    return { ok: !!stored && stored.name === "front.png" && /^img:/.test(stored.source) && img.length === 1 && vProjFiles() === vProjBefore, note: `pstore=${!!props} img=${img.length} source=${stored?.source} treeUnchanged=${vProjFiles() === vProjBefore}` };
  });
  await check("R4 the Delete-key hook removes the selected reference (not the model selection); persisted", async () => {
    await E(`A.refs.select(${JSON.stringify(vRefId)}); await A.sleep(100); return 1`);
    const sel = await E(`const s = A.state(); return { edit: s.refEdit, sel: s.refSel, cube: s.cube, bones: s.bones }`);
    const hit = await E(`return A.refs.deleteSelected()`);
    await sleep(300);
    const n = (await E(`return A.refs.list()`)).length;
    const props = vPstore("refimages.json").find((x) => x.who.endsWith(files.geo));
    const j = JSON.parse(fs.readFileSync(props.f, "utf8"));
    return { ok: sel.edit && sel.sel === vRefId && sel.cube === null && hit && n === 0 && j.reference_images.length === 0, note: JSON.stringify({ sel, hit, n }) };
  });
  await check("R5 blueprint: a reference added inside an ortho view attaches to that view and only shows there", async () => {
    await E(`await A.call("setView", "front"); await A.sleep(150); return 1`);
    const id = await E(`const r = await A.refs.add(${JSON.stringify(vRefUrl)}, { name: "bp.png", position: [0, -150], size: [256, 128], opacity: 0.6 }); await A.sleep(250); return r.uuid`);
    const r = (await E(`return A.refs.list()`)).find((x) => x.uuid === id);
    const vis = () => app.ev(`return document.querySelectorAll('.as-ref-layer.behind [data-ref]').length`);
    const a = await vis();
    await E(`await A.call("setView", "top"); await A.sleep(150); return 1`);
    const b = await vis();
    await E(`await A.call("setView", "front"); await A.sleep(150); return 1`);
    return { ok: r.view_mode === "blueprint" && r.attached_side === "north" && a === 1 && b === 0, note: `mode=${r.view_mode} side=${r.attached_side} front=${a} top=${b}` };
  });
  await sleep(400); await E(`A.renderNow(); return 1`); app.shot("animstudio-bb-refimage");
  await check("R6 blueprint follows the ortho camera zoom (size scales with zoom)", async () => {
    const w = () => app.ev(`return document.querySelector('.as-ref-layer.behind [data-ref]').getBoundingClientRect().width`);
    const w0 = await w();
    await E(`A.wheel(300, 300, -240); await A.sleep(200); return 1`);
    const w1 = await w();
    await E(`A.vp("setView", "front"); await A.sleep(150); return 1`);
    return { ok: w1 > w0 * 1.1, note: `${w0.toFixed(0)} -> ${w1.toFixed(0)}` };
  });
  await check("R7 drop an image file on the viewport -> import dialog (View Mode / Layer / Add globally) -> confirm adds it", async () => {
    const shown = await E(`return await A.refs.drop("dropped.png", ${JSON.stringify(vRefPng.toString("base64"))})`);
    const fields = await app.ev(`return ['imp-mode','imp-layer','imp-global','imp-ok'].map((i) => !!document.querySelector('[data-id=' + i + ']'))`);
    const id = await E(`return await A.refs.confirmImport()`);
    const r = (await E(`return A.refs.list()`)).find((x) => x.uuid === id);
    return { ok: shown && fields.every(Boolean) && !!r && r.name === "dropped", note: JSON.stringify({ shown, fields, name: r?.name }) };
  });
  await check("R8 properties panel: edit size (linked ratio) and Flip through the real controls", async () => {
    const id = (await E(`return A.refs.list()`)).find((x) => x.name === "dropped").uuid;
    await E(`A.refs.select(${JSON.stringify(id)}); await A.sleep(150); return 1`);
    await app.ev(`const i = document.querySelector('[data-id=ref-w]'); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; i.focus(); set.call(i, '200'); i.dispatchEvent(new Event('input', { bubbles: true })); i.blur(); await __qa.sleep(250); document.querySelector('[data-id=ref-flipx]').click(); await __qa.sleep(150); return 1`);
    const r = (await E(`return A.refs.list()`)).find((x) => x.uuid === id);
    return { ok: r.size[0] === 200 && r.size[1] === 100 && r.flip_x === true, note: JSON.stringify({ size: r.size, flip: r.flip_x }) };
  });
  await check("R9 global scope ('All projects') is stored once in app data and shows up in another file", async () => {
    const id = (await E(`return A.refs.list()`)).find((x) => x.name === "dropped").uuid;
    await E(`A.refs.update(${JSON.stringify(id)}, { scope: "global" }); await A.sleep(400); return 1`);
    const g = vPstore("refimages.json").find((x) => x.who.includes("global-reference-images"));
    await open(files.anim);
    await sleep(600);
    const names = (await E(`return A.refs.list()`)).map((r) => r.name + ":" + r.scope);
    await open(files.geo);
    await sleep(400);
    return { ok: !!g && names.includes("dropped:global"), note: `global store=${!!g} animFile refs=${names}` };
  });
  // ---- .bbmodel: reference_images key (Blockbench-compatible), undo, save
  await check("R10 .bbmodel: project reference lands in `reference_images` (Blockbench keys), one undo step, rest of the file untouched", async () => {
    await open(files.bb);
    await sleep(500);
    const t0 = await E(`return A.text()`);
    await E(`const r = await A.refs.add(${JSON.stringify(vRefUrl)}, { name: "bb-ref.png", layer: "viewport", opacity: 0.75, position: [12, -8] }); await A.sleep(400); return r.uuid`);
    const t1 = await E(`return A.text()`);
    const e = JSON.parse(t1).reference_images?.[0];
    const keep = t1.startsWith(t0.trimEnd().slice(0, -2));
    const dirty = await E(`return A.dirty()`);
    await E(`await A.call("undo"); await A.sleep(300); return 1`);
    const back = await E(`return A.text()`);
    const n = (await E(`return A.refs.list()`)).filter((r) => r.scope === "project").length;
    await E(`await A.call("redo"); await A.sleep(300); return 1`);
    const n2 = (await E(`return A.refs.list()`)).filter((r) => r.scope === "project").length;
    return { ok: !!e && e.name === "bb-ref.png" && e.layer === "viewport" && e.opacity === 0.75 && JSON.stringify(e.position) === "[12,-8]" && /^data:image\/png/.test(e.source) && dirty === true && back === t0 && n === 0 && n2 === 1 && keep, note: `keys=${e && Object.keys(e)} undoRestores=${back === t0} refsAfterUndo=${n}/${n2} prefixKept=${keep}` };
  });
  await check("R11 ⌘S writes the .bbmodel with reference_images; no pstore properties file for the bbmodel", async () => {
    await app.ev(`await __qa.key("meta S"); await __qa.sleep(500); return 1`);
    const disk = JSON.parse(fs.readFileSync(files.bb, "utf8"));
    const props = vPstore("refimages.json").find((x) => x.who.endsWith(files.bb));
    return { ok: disk.reference_images?.length === 1 && !props, note: `onDisk=${disk.reference_images?.length} pstoreForBb=${!!props}` };
  });
  await check("R12 survives an app restart: geo (app data) + bbmodel (file) + global reference images come back", async () => {
    await open(files.geo);
    await E(`await A.refs.add(${JSON.stringify(vRefUrl)}, { name: "persist-geo.png" }); await A.sleep(400); return 1`);
    await app.stop();
    app = await launch(proj, { dataDir });
    await app.ev(`await __qa.waitFor(() => document.querySelector('.statusbar'), 20000); return 1`);
    await open(files.geo);
    await waitFor(`A.refs.list().length >= 1`);
    const geoRefs = (await E(`return A.refs.list()`)).map((r) => r.name + ":" + r.scope);
    await open(files.bb);
    await waitFor(`A.refs.list().length >= 1`);
    const bbRefs = (await E(`return A.refs.list()`)).map((r) => r.name + ":" + r.scope);
    return { ok: geoRefs.includes("persist-geo.png:project") && geoRefs.includes("dropped:global") && bbRefs.includes("bb-ref.png:project") && bbRefs.includes("dropped:global"), note: `geo=${geoRefs} bb=${bbRefs}` };
  });
  await check("R13 repo-side hygiene: the fixture project tree gained no image files from any of this", async () => ({ ok: vProjFiles().split("\n").every((f) => !/\.(png|jpe?g)$/.test(f) || vProjBefore.includes(f)), note: "" }));
  await open(files.geo);
  await E(`A.set({ tool: "move" }); A.vp("resetCamera"); await A.sleep(200); return 1`);

  // ===== H. multi-key gizmo (fork B) =====
  const rotAt = async (t) => { const r = JSON.parse(await E(`return A.text()`)).animations["animation.golem.wave"].bones.arm_l.rotation[t]; return Array.isArray(r) ? r : (r.post ?? r.vector); };
  await open(files.anim);
  const hBase = await E(`return A.text()`);
  const hKeyCount = JSON.parse(hBase).animations["animation.golem.wave"].bones.arm_l.rotation ? Object.keys(JSON.parse(hBase).animations["animation.golem.wave"].bones.arm_l.rotation).length : 0;
  await check("H1 gizmo rotate with 2 keys selected and the playhead on one applies the same delta to both (one undo step)", async () => {
    await E(`A.set({ mode: "animate", anim: "animation.golem.wave", time: 0.5, bones: ["arm_l"], cube: null, tool: "rotate", autoKey: true, keys: [{ bone: "arm_l", channel: "rotation", time: 0 }, { bone: "arm_l", channel: "rotation", time: 0.5 }] }); await A.sleep(200); return 1`);
    const a0 = await rotAt("0.0"), b0 = await rotAt("0.5");
    const ok = await E(`return await A.call("nudge", "rotate", [0, 0, 10])`);
    const a1 = await rotAt("0.0"), b1 = await rotAt("0.5");
    const n = (await E(`return Object.keys(JSON.parse(A.text()).animations["animation.golem.wave"].bones.arm_l.rotation).length`));
    await key("meta Z");
    const restored = (await E(`return A.text()`)) === hBase;
    return { ok: ok && Math.abs(a1[2] - a0[2] - 10) < 0.02 && Math.abs(b1[2] - b0[2] - 10) < 0.02 && n === hKeyCount && restored, note: `0.0: ${a0[2]}->${a1[2]} 0.5: ${b0[2]}->${b1[2]} keys=${n} undoRestores=${restored}` };
  });
  await check("H2 without a multi-key selection the drag still auto-keys exactly one new key", async () => {
    await E(`A.set({ mode: "animate", anim: "animation.golem.wave", time: 0.75, bones: ["arm_l"], tool: "rotate", autoKey: true, keys: [] }); await A.sleep(150); return 1`);
    const ok = await E(`return await A.call("nudge", "rotate", [0, 0, 10])`);
    const keys = await E(`return Object.keys(JSON.parse(A.text()).animations["animation.golem.wave"].bones.arm_l.rotation)`);
    await key("meta Z");
    return { ok: ok && keys.includes("0.75") && keys.length === hKeyCount + 1 && (await E(`return A.text()`)) === hBase, note: `keys=${keys}` };
  });
  await check("H3 playhead NOT on a selected key -> the old single auto-key path (selected keys untouched)", async () => {
    await E(`A.set({ time: 0.25, keys: [{ bone: "arm_l", channel: "rotation", time: 0 }, { bone: "arm_l", channel: "rotation", time: 0.5 }] }); await A.sleep(150); return 1`);
    const a0 = await rotAt("0.0"), b0 = await rotAt("0.5");
    await E(`return await A.call("nudge", "rotate", [0, 0, 10])`);
    const a1 = await rotAt("0.0"), b1 = await rotAt("0.5");
    await key("meta Z");
    return { ok: a1[2] === a0[2] && b1[2] === b0[2] && (await E(`return A.text()`)) === hBase, note: `${a0[2]}/${b0[2]}` };
  });
  await check("H4 two selected bones follow the gizmo: both get a key at the playhead (one undo step)", async () => {
    await E(`A.set({ time: 0.25, bones: ["arm_l", "head"], keys: [] }); await A.sleep(150); return 1`);
    await E(`return await A.call("nudge", "rotate", [0, 0, 10])`);
    const t = JSON.parse(await E(`return A.text()`)).animations["animation.golem.wave"].bones;
    const both = "0.25" in t.arm_l.rotation && "0.25" in t.head.rotation;
    await key("meta Z");
    return { ok: both && (await E(`return A.text()`)) === hBase, note: `both=${both}` };
  });

  // ===== A. preview model resolution (fork A) =====
  // armor clip -> per-file pick > same-stem geo > project default (app data) > spiderman.geo.json of the project > built-in player rig
  const pmGeo = (arm) => JSON.stringify({ format_version: "1.12.0", "minecraft:geometry": [{ description: { identifier: "geometry.pm", texture_width: 64, texture_height: 64 }, bones: [
    { name: "armorBody", pivot: [0, 24, 0], cubes: [cube([-4, 12, -2], [8, 12, 4], [16, 16])] },
    { name: "armorRightArm", pivot: [-arm, 22, 0], cubes: [cube([-arm - 4, 12, -2], [4, 12, 4], [40, 16])] },
    { name: "armorLeftArm", pivot: [arm, 22, 0], cubes: [cube([arm, 12, -2], [4, 12, 4], [32, 48])] },
  ] }] }, null, 2) + "\n";
  const pmSpidey = w(`src/packs/heroes/resources/assets/thematic/geo/armor/spiderman.geo.json`, pmGeo(4));
  const pmOther = w(`${T}/geo/armor/vanilla_like.geo.json`, pmGeo(5));
  const pmAnim = w(`${T}/animations/armor/pm_qa.animation.json`, JSON.stringify({ format_version: "1.8.0", animations: { pm_clip: { loop: true, animation_length: 1, bones: { armorRightArm: { rotation: { "0.0": [0, 0, 0], "1.0": [-90, 0, 0] } } } } } }, null, 2) + "\n");
  const armPos = async () => (await snapS()).viewport?.bones?.armorRightArm?.pos?.join(",");
  const chip = () => app.ev(`return document.querySelector('[data-testid=rig-chip]')?.textContent ?? null`);
  await check("A-pm1 armor clip with no model of its own previews on the project's spiderman.geo.json (pivots +-4), badge shows its name", async () => {
    await open(pmAnim);
    await waitFor(`(async () => (await A.snapshot()).rig?.path?.endsWith("spiderman.geo.json"))()`);
    await sleep(400);
    const pos = await armPos(), c = await chip();
    return { ok: pos === "4,22,0" && c === "Preview: spiderman", note: `armR pos=${pos} chip=${c}` };
  });
  await check("A-pm2 a per-file choice overrides the automatic model (pivots +-5) and survives reopening", async () => {
    await E(`await A.call("pickModel", ${JSON.stringify(pmOther)}); return 1`);
    await sleep(500);
    const pos = await armPos(), c = await chip();
    await open(files.geo); await open(pmAnim);
    await waitFor(`(async () => (await A.snapshot()).rig?.path?.endsWith("vanilla_like.geo.json"))()`);
    return { ok: pos === "5,22,0" && c === "Preview: vanilla_like", note: `armR pos=${pos} chip=${c}` };
  });
  await check("A-pm3 project default is stored in app data (not the repo), survives a restart, and ranks below a per-file pick", async () => {
    await E(`await A.call("pickModel", null); await A.call("setProjectDefault", ${JSON.stringify(pmOther)}); await A.sleep(300); return 1`);
    const before = vProjFiles();
    await app.stop();
    app = await launch(proj, { dataDir });
    await app.ev(`await __qa.waitFor(() => document.querySelector('.statusbar'), 20000); return 1`);
    await open(pmAnim);
    await waitFor(`(async () => (await A.snapshot()).rig?.path?.endsWith("vanilla_like.geo.json"))()`);
    const projectWins = (await armPos()) === "5,22,0";
    await E(`await A.call("pickModel", ${JSON.stringify(pmSpidey)}); await A.sleep(400); return 1`);
    const fileWins = (await armPos()) === "4,22,0";
    await E(`await A.call("pickModel", null); await A.call("setProjectDefault", null); await A.sleep(300); return 1`);
    const after = vProjFiles();
    return { ok: projectWins && fileWins && after === before, note: `projectDefault=${projectWins} fileOverrides=${fileWins} repoUnchanged=${after === before}` };
  });
  await open(files.geo);

  // ============ M. multi-keyframe editing (select many keys, edit across all of them) ============
  {
    const mName = "animation.multi.t";
    files.multi = w(`${A}/animations/entity/multi.animation.json`, JSON.stringify({
      format_version: "1.8.0",
      animations: { [mName]: { loop: true, animation_length: 1, bones: {
        arm_l: { rotation: { "0.0": [0, 0, 0], "0.5": [10, 20, 30], "1.0": [5, 5, 5] }, position: { "0.5": [1, 2, 3] } },
        head: { rotation: { "0.0": [0, 0, 0], "0.5": [-10, 0, 0], "1.0": [0, 0, 0] } },
      } } },
    }, null, 2) + "\n");
    const mj = async () => JSON.parse(await E(`return A.text()`)).animations[mName].bones;
    const vec = (v) => (Array.isArray(v) ? v : (v.post ?? v.vector));
    const rot = async (bone, t) => vec((await mj())[bone].rotation[t]);
    const K = (bone, channel, time) => ({ bone, channel, time });
    const sel3 = [K("arm_l", "rotation", 0.5), K("head", "rotation", 0.5), K("head", "rotation", 1)];
    const pos = K("arm_l", "position", 0.5);
    const mOpen = async (keys) => { await open(files.multi); await E(`A.set({ mode: "animate", anim: ${JSON.stringify(mName)}, time: 0.25, bones: [], keys: ${JSON.stringify(keys)} }); await A.sleep(300); return 1`); };
    // type into the first (X) input of the inspector's channel section the way a user does: focus, input event, Enter -> blur -> commit
    const typeX = (ch, text) => app.ev(`const inp = document.querySelector('[data-testid=as-insp-${ch}] input[data-testid=as-comp-x]'); if (!inp) return "no field"; inp.focus(); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set; set.call(inp, ${JSON.stringify(text)}); inp.dispatchEvent(new Event("input", { bubbles: true })); inp.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); await __qa.sleep(250); return "ok"`);
    const fieldVals = (ch) => app.ev(`return [...document.querySelectorAll('[data-testid=as-insp-${ch}] input[data-testid^=as-comp-]')].map((i) => i.value + "|" + i.placeholder)`);
    const geo = () => app.ev(`const c = document.querySelector('[data-testid=as-dopesheet] canvas'); const r = c.getBoundingClientRect(); const gw = r.width - 168; const pps = Math.min(4000, Math.max(20, (gw - 40) / 1)); return { pps, t0: -12 / pps, w: r.width, h: r.height }`);
    const ptr = (target, type, x, y, o = {}) => app.ev(`const c = ${target === "ds" ? `document.querySelector('[data-testid=as-dopesheet] canvas')` : "window"}; const r = c.getBoundingClientRect ? c.getBoundingClientRect() : { left: 0, top: 0 }; c.dispatchEvent(new PointerEvent(${JSON.stringify(type)}, { bubbles: true, cancelable: true, clientX: r.left + ${x}, clientY: r.top + ${y}, button: 0, buttons: ${type === "pointerup" ? 0 : 1}, pointerId: 77, pointerType: "mouse", isPrimary: true, shiftKey: ${!!o.shift}, metaKey: ${!!o.meta}, ctrlKey: false, altKey: false })); return 1`);
    const X = (g, t) => 168 + (t - g.t0) * g.pps;
    const Y = (row) => 22 + row * 22 + 11; // RULER_H + row * ROW_H + half; bones start collapsed -> one row per bone
    const settle = () => E(`await A.sleep(200); return 1`);

    await check("M1 3 keys across 2 bones selected: inspector shows 'Keyframes (4)' with a mixed-aware Rotation section", async () => {
      await mOpen([...sel3, pos]);
      const head = await app.ev(`return document.querySelector('[data-testid=as-inspector] h4')?.textContent`);
      const fv = await fieldVals("rotation");
      // X differs (10, -10, 0) -> blank + "mixed" placeholder; Y: 20/0/0 mixed; Z: 30/0/0 mixed
      return { ok: /\(4\)/.test(head) && fv.every((v) => v === "|mixed"), note: `h4=${head} fields=${fv}` };
    });
    await check("M2 typing `+10` in Rotation X offsets each of the 3 keys by +10; position key and other axes untouched; ONE undo restores", async () => {
      const base = await E(`return A.text()`);
      const c0 = (await snapS()).commits;
      const r = await typeX("rotation", "+10");
      const a = await rot("arm_l", "0.5"), h5 = await rot("head", "0.5"), h1 = await rot("head", "1.0");
      const p = vec((await mj()).arm_l.position["0.5"]);
      const c1 = (await snapS()).commits;
      const ok = r === "ok" && a[0] === 20 && a[1] === 20 && a[2] === 30 && h5[0] === 0 && h1[0] === 10 && p.join() === "1,2,3" && c1 === c0 + 1 && (await rot("arm_l", "0.0")).join() === "0,0,0";
      await E(`await A.call("undo"); return 1`);
      return { ok: ok && (await E(`return A.text()`)) === base, note: `arm=${a} head.5=${h5} head1=${h1} pos=${p} commits+${c1 - c0}` };
    });
    await check("M3 typing `45` SETS X to 45 on every selected rotation key (not the position key); the label says so; one undo restores", async () => {
      const base = await E(`return A.text()`);
      // hint while typing
      await app.ev(`const inp = document.querySelector('[data-testid=as-insp-rotation] input[data-testid=as-comp-x]'); inp.focus(); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set; set.call(inp, "45"); inp.dispatchEvent(new Event("input", { bubbles: true })); await __qa.sleep(120); return 1`);
      const hint = await app.ev(`return document.querySelector('[data-testid=as-insp-rotation] [data-testid=as-multihint]')?.textContent`);
      await app.ev(`document.querySelector('[data-testid=as-insp-rotation] input[data-testid=as-comp-x]').blur(); await __qa.sleep(250); return 1`);
      const xs = [(await rot("arm_l", "0.5"))[0], (await rot("head", "0.5"))[0], (await rot("head", "1.0"))[0]];
      const p = vec((await mj()).arm_l.position["0.5"]);
      const shown = (await fieldVals("rotation"))[0];
      app.shot("animstudio-multikey");
      await E(`await A.call("undo"); return 1`);
      return { ok: xs.every((x) => x === 45) && p.join() === "1,2,3" && /Set X to 45 on all 3 keys/.test(hint) && shown.startsWith("45|") && (await E(`return A.text()`)) === base, note: `xs=${xs} hint=${hint} shown=${shown}` };
    });
    await check("M4 `*2` and `/2` multiply each key's own value; `=-10` sets a negative", async () => {
      const base = await E(`return A.text()`);
      await typeX("rotation", "*2");
      const a = (await rot("arm_l", "0.5"))[0], h = (await rot("head", "0.5"))[0];
      await typeX("rotation", "/2");
      const back = (await rot("arm_l", "0.5"))[0];
      await typeX("rotation", "=-10");
      const xs = [(await rot("arm_l", "0.5"))[0], (await rot("head", "0.5"))[0], (await rot("head", "1.0"))[0]];
      for (let i = 0; i < 3; i++) await E(`await A.call("undo"); return 1`);
      return { ok: a === 20 && h === -20 && back === 10 && xs.every((x) => x === -10) && (await E(`return A.text()`)) === base, note: `x2: ${a},${h} /2: ${back} =-10: ${xs}` };
    });
    await check("M5 scrubbing the X handle offsets all selected keys live by the same delta; the whole scrub is ONE undo step", async () => {
      const base = await E(`return A.text()`);
      const c0 = (await snapS()).commits;
      await app.ev(`const h = document.querySelector('[data-testid=as-insp-rotation] [data-testid=as-scrub-x]'); h.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, clientX: 100, clientY: 10, button: 0, pointerId: 5, pointerType: "mouse" })); return 1`);
      for (const x of [110, 120, 140]) { await ptr("win", "pointermove", x, 10); await E(`await A.sleep(40); return 1`); }
      const live = (await rot("arm_l", "0.5"))[0];
      await ptr("win", "pointerup", 140, 10);
      await settle();
      const xs = [(await rot("arm_l", "0.5"))[0], (await rot("head", "0.5"))[0], (await rot("head", "1.0"))[0]];
      const c1 = (await snapS()).commits;
      await E(`await A.call("undo"); return 1`);
      // 40px * 0.5 deg/px = +20 on each key's own value (10 / -10 / 0)
      return { ok: xs.join() === "30,10,20" && live === 30 && (await E(`return A.text()`)) === base, note: `after=${xs} live=${live} commits+${c1 - c0}` };
    });
    await check("M6 easing set on the selection applies to every key; Time field shifts the whole selection keeping spacing; one undo each", async () => {
      const base = await E(`return A.text()`);
      await app.ev(`const b = document.querySelector('[data-testid=as-easing]'); b.click(); await __qa.sleep(150); const it = [...document.querySelectorAll('.as-dd-item')].find((e) => e.textContent.trim() === "easeInQuad"); if (it) it.click(); await __qa.sleep(250); return !!it`);
      const bones = await mj();
      const eas = [bones.arm_l.rotation["0.5"], bones.head.rotation["0.5"], bones.head.rotation["1.0"]].map((k) => k?.easing);
      await E(`await A.call("undo"); return 1`);
      const undoEasing = (await E(`return A.text()`)) === base;
      // time: first key is at 0.5 -> `+0.25` shifts all by 0.25 (head 0.5 -> 0.75, head 1.0 -> 1.25, arm_l 0.5 -> 0.75)
      await app.ev(`const inp = document.querySelector('[data-testid=as-time-shift]'); inp.focus(); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set; set.call(inp, "+0.25"); inp.dispatchEvent(new Event("input", { bubbles: true })); inp.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); await __qa.sleep(300); return 1`);
      const b2 = await mj();
      const srt = (o) => Object.keys(o).sort((p, q) => p - q).join();
      const times = [srt(b2.arm_l.rotation), srt(b2.head.rotation)];
      const sel = (await E(`return A.state().keys.map((k) => k.bone + "@" + k.time).sort()`)).join();
      await E(`await A.call("undo"); return 1`);
      return { ok: eas.every((e) => e === "easeInQuad") && undoEasing && times[0] === "0.0,0.75,1.0" && times[1] === "0.0,0.75,1.25" && sel === "arm_l@0.75,arm_l@0.75,head@0.75,head@1.25" && (await E(`return A.text()`)) === base, note: `easing=${eas} times=${times} sel=${sel}` };
    });
    await check("M7 dope sheet: dragging ONE selected key (across 2 bones/channels) retimes the whole selection together, one undo step", async () => {
      await mOpen([...sel3, pos]);
      await E(`document.querySelector('[data-testid=as-dopesheet]')?.focus(); return 1`);
      const g = await geo();
      const base = await E(`return A.text()`);
      const c0 = (await snapS()).commits;
      // rows (collapsed): 0 = arm_l, 1 = head. Grab head@1.0 and drag +0.2s (4 ticks) left? keep inside: -0.25 (5 ticks)
      const from = [X(g, 1), Y(1)], to = [X(g, 0.75), Y(1)];
      await ptr("ds", "pointerdown", ...from);
      for (let i = 1; i <= 5; i++) { await ptr("ds", "pointermove", from[0] + ((to[0] - from[0]) * i) / 5, from[1]); await E(`await A.sleep(20); return 1`); }
      await ptr("ds", "pointerup", ...to);
      await settle();
      const b = await mj();
      const kt = (bone, ch) => Object.keys(b[bone][ch]).sort((p, q) => p - q).join();
      const c1 = (await snapS()).commits;
      const sel = (await E(`return A.state().keys.length`));
      await E(`await A.call("undo"); return 1`);
      return { ok: kt("arm_l", "rotation") === "0.0,0.25,1.0" && kt("arm_l", "position") === "0.25" && kt("head", "rotation") === "0.0,0.25,0.75" && sel === 4 && (await E(`return A.text()`)) === base, note: `arm_l.rot=${kt("arm_l", "rotation")} arm_l.pos=${kt("arm_l", "position")} head.rot=${kt("head", "rotation")} sel=${sel} commits+${c1 - c0}` };
    });
    await check("M8 selection: bone label selects all its keys, ⌘A all, ⇧-drag in the ruler selects a time range, box select spans bones in collapsed rows", async () => {
      await mOpen([]);
      const g = await geo();
      const n = () => E(`return A.state().keys.length`);
      await ptr("ds", "pointerdown", 100, Y(0)); await ptr("ds", "pointerup", 100, Y(0)); await settle();
      const boneKeys = await n(); // arm_l: 3 rotation + 1 position
      await E(`A.set({ keys: [] }); return 1`);
      await key("meta A");
      const all = await n(); // 4 + 3
      await E(`A.set({ keys: [] }); return 1`);
      await ptr("ds", "pointerdown", X(g, 0.4), 11, { shift: true }); await ptr("ds", "pointermove", X(g, 0.6), 11, { shift: true }); await ptr("ds", "pointerup", X(g, 0.6), 11, { shift: true }); await settle();
      const range = await n(); // everything at 0.5: arm_l rot + pos, head rot
      await E(`A.set({ keys: [] }); return 1`);
      await ptr("ds", "pointerdown", X(g, 0.35), 22 + 3); await ptr("ds", "pointermove", X(g, 0.8), 22 + 44 - 3); await ptr("ds", "pointerup", X(g, 0.8), 22 + 44 - 3); await settle();
      const box = await n(); // same 3 keys by rectangle across both collapsed bone rows
      // ⌘-click toggles a key out of the selection
      await ptr("ds", "pointerdown", X(g, 0.5), Y(1), { meta: true }); await ptr("ds", "pointerup", X(g, 0.5), Y(1), { meta: true }); await settle();
      const toggled = await n();
      return { ok: boneKeys === 4 && all === 7 && range === 3 && box === 3 && toggled === 2, note: `bone=${boneKeys} all=${all} range=${range} box=${box} cmd-click=${toggled}` };
    });
    await check("M9 ⌘C/⌘V copy+paste and ⌫ delete work on the whole multi-selection (one undo step each)", async () => {
      await mOpen([...sel3, pos]);
      const base = await E(`return A.text()`);
      await key("meta C");
      await E(`A.set({ time: 0.25 }); return 1`);
      await key("meta V");
      const pasted = await mj();
      const ok1 = Object.keys(pasted.head.rotation).length === 5 && Object.keys(pasted.arm_l.rotation).length === 4;
      await E(`await A.call("undo"); return 1`);
      const ok2 = (await E(`return A.text()`)) === base;
      await E(`A.set({ keys: ${JSON.stringify([...sel3, pos])} }); return 1`);
      await key("BACK_SPACE");
      const left = await mj();
      const cnt = (v) => (Array.isArray(v) ? 1 : Object.keys(v).length);
      const ok3 = cnt(left.head.rotation) === 1 && cnt(left.arm_l.rotation) === 2 && !left.arm_l.position;
      await E(`await A.call("undo"); return 1`);
      return { ok: ok1 && ok2 && ok3 && (await E(`return A.text()`)) === base, note: `paste=${ok1} undo=${ok2} delete=${ok3}` };
    });
  }

  // ============ L. Edit-mode layout = Blockbench Edit mode (UV editor + Textures left, Element + Outliner right, tool row above the viewport) ============
  const rect = (sel) => app.ev(`const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null; const r = e.getBoundingClientRect(); return { l: r.left, t: r.top, r: r.right, b: r.bottom, w: r.width, h: r.height }`);
  const gJ = async () => JSON.parse(await E(`return A.text()`));
  const geoC = async (bone, i = 0) => (await gJ())["minecraft:geometry"][0].bones.find((b) => b.name === bone).cubes[i];
  await open(files.geo);
  await sleep(500);
  await E(`A.set({ mode: "edit", tool: "move", bones: [], cube: null, cubes: [], uvFaces: ["north"], hidden: [], locked: [] }); A.vp("resetCamera"); await A.sleep(300); return 1`);
  await check("L1 Edit layout: UV editor (top) + Textures (below) in the left sidebar, Element fields above the Outliner on the right, tool row above the viewport", async () => {
    const uv = await rect("[data-testid=as-uv]"), tx = await rect("[data-testid=as-textures-col]"), vp = await rect("[data-testid=as-viewport]");
    const pr = await rect("[data-testid=as-props]"), ol = await rect("[data-testid=as-tree]"), tb = await rect("[data-testid=as-toolbar]"), mb = await rect("[data-testid=as-modebar]");
    const lay = await app.ev(`return document.querySelector('[data-testid=studio]').dataset.layout`);
    const okL = uv && tx && vp && pr && ol && tb && mb && uv.r <= vp.l + 3 && vp.r <= pr.l + 3 && vp.r <= ol.l + 3 && uv.b <= tx.t + 3 && uv.l === tx.l && pr.b <= ol.t + 3 && tb.b <= vp.t + 2 && mb.b <= tb.t + 2 && tb.l >= uv.r - 2;
    return { ok: !!okL && lay === "edit", note: JSON.stringify({ uv, tx, vp, pr, ol, tb, mb, lay }) };
  });
  await sleep(300); await E(`A.renderNow(); return 1`);
  await check("L2 Animate keeps its layout (Animations + Keyframe left, Outliner above the bone fields on the right, no UV editor)", async () => {
    await open(files.anim);
    await E(`A.set({ mode: "animate" }); await A.sleep(400); return 1`);
    const an = await rect("[data-testid=as-animations]"), kf = await rect("[data-testid=as-keyframe]"), uv = await rect("[data-testid=as-uv]");
    const ol = await rect("[data-testid=as-tree]"), pr = await rect("[data-testid=as-props]"), vp = await rect("[data-testid=as-viewport]");
    const lay = await app.ev(`return document.querySelector('[data-testid=studio]').dataset.layout`);
    return { ok: !!(an && kf && ol && pr && !uv && an.r <= vp.l + 3 && ol.t < pr.t && lay === "animate"), note: JSON.stringify({ an: !!an, kf: !!kf, uv: !!uv, olTop: ol?.t, prTop: pr?.t, lay }) };
  });
  await check("L3 panel sizes are remembered per mode (resizing the Edit sidebar does not change Animate's, and Edit comes back as left)", async () => {
    await open(files.geo);
    await E(`A.set({ mode: "edit" }); await A.sleep(400); return 1`);
    const w0 = (await rect("[data-testid=as-uv]")).w;
    // drag the left/centre resize handle (react-resizable-panels listens to pointer events on the handle)
    const dir = w0 > 400 ? -1 : 1;   // panel sizes persist across runs: drag toward the side that has room
    const hdl = await app.ev(`const hs = [...document.querySelectorAll('[data-testid=studio] [data-panel-resize-handle-id]')].filter((x) => x.dataset.panelGroupDirection === 'horizontal'); if (!hs[0]) return null; const r = hs[0].getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }`);
    if (!hdl) return { ok: false, note: "no resize handle" };
    await app.ev(`const h = [...document.querySelectorAll('[data-testid=studio] [data-panel-resize-handle-id]')].filter((x) => x.dataset.panelGroupDirection === 'horizontal')[0]; const mk = (t, x) => new PointerEvent(t, { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: ${hdl.y}, button: 0, buttons: t === 'pointerup' ? 0 : 1, pointerId: 5, isPrimary: true, pointerType: 'mouse' }); h.dispatchEvent(mk('pointerdown', ${hdl.x})); for (let i = 1; i <= 6; i++) { h.dispatchEvent(mk('pointermove', ${hdl.x} + ${dir} * i * 12)); await __qa.sleep(30); } h.dispatchEvent(mk('pointerup', ${hdl.x} + ${dir} * 72)); await __qa.sleep(300); return 1`);
    const w1 = (await rect("[data-testid=as-uv]")).w;
    const keys = await app.ev(`return Object.keys(localStorage).filter((k) => k.startsWith('react-resizable-panels:animstudio.h')).sort()`);
    // switching modes remounts the groups with their own saved layout: go to the animation file's Animate mode and back
    await open(files.anim); await E(`A.set({ mode: "animate" }); await A.sleep(400); return 1`);
    const wa = (await rect("[data-testid=as-animations]")).w;
    await open(files.geo); await E(`A.set({ mode: "edit" }); await A.sleep(500); return 1`);
    const w2 = (await rect("[data-testid=as-uv]")).w;
    const keys2 = await app.ev(`return Object.keys(localStorage).filter((k) => k.startsWith('react-resizable-panels:animstudio.h')).sort()`);
    return { ok: Math.abs(w1 - w0) > 20 && Math.abs(w2 - w1) < 4 && Math.abs(wa - w1) > 8 && keys2.some((k) => k.endsWith("animstudio.h.edit")) && keys2.some((k) => k.endsWith("animstudio.h.animate")), note: `edit ${w0.toFixed(0)}->${w1.toFixed(0)} back=${w2.toFixed(0)} animate=${wa.toFixed(0)} keys=${keys2.map((k) => k.split(":")[1])}` };
  });

  // ============ U. UV editor: drag UVs around (move / resize / snap / multi-select), numbers in sync, one undo stop ============
  const uvView = () => E(`return A.uv.view()`);
  const uvDrag = async (sel, du, dv, o = {}) => { const v = await uvView(); return E(`return await A.uv.drag(${JSON.stringify(sel)}, ${du * v.k}, ${dv * v.k}, ${JSON.stringify(o)})`); };
  const uvNum = (id) => app.ev(`const i = document.querySelector('[data-id=${id}]'); return i ? i.value : null`);
  await open(files.geo);
  await sleep(500);
  const uBase = await E(`return A.text()`);
  await E(`A.set({ mode: "edit", tool: "move", cubes: [], uvFaces: ["north"] }); await A.call("select", ["head"], { bone: "head", index: 0 }); await A.sleep(300); return 1`);
  await check("U1 UV editor shows the active texture with a pixel grid and the selected cube's box-UV island", async () => {
    const a = await app.ev(`const c = document.querySelector('[data-testid=uv-canvas]'); return { w: c.width, h: c.height, grid: !!document.querySelector('.as-uvgrid'), island: !!document.querySelector('[data-uvisland="head#0"]'), faces: document.querySelectorAll('[data-uvisland] [data-uvface]').length, res: document.querySelector('[data-testid=uv-status]').textContent }`);
    return { ok: a.w === 64 && a.h === 64 && a.island && a.faces === 6 && /64\s\S\s64/.test(a.res), note: JSON.stringify(a) };
  });
  await sleep(300); await E(`A.renderNow(); return 1`); app.shot("animstudio-uv-box");
  await check("U2 dragging the box-UV island moves uv_offset in whole pixels: minimal text, Properties numbers follow, ONE undo restores", async () => {
    await uvDrag('[data-uvisland="head#0"]', 3.2, 2.1);
    const t1 = await E(`return A.text()`);
    const c = await geoC("head", 0);
    const u = await uvNum("uv-u"), v = await uvNum("uv-v");
    const lines = diffLines(uBase, t1);
    await E(`await A.call("undo"); return 1`);
    return { ok: JSON.stringify(c.uv) === "[3,2]" && lines <= 2 && u === "3" && v === "2" && (await E(`return A.text()`)) === uBase, note: `uv=${JSON.stringify(c.uv)} diffLines=${lines} u=${u} v=${v}` };
  });
  await check("U3 per-face UV: select a face, drag it (only that face's uv changes), drag a corner handle (uv_size changes), face tabs select faces", async () => {
    await E(`await A.call("select", ["head"], { bone: "head", index: 1 }); A.set({ uvFaces: ["up"] }); await A.sleep(250); return 1`);
    const t0 = await E(`return A.text()`);
    await uvDrag('[data-cube="head#1"][data-uvface=up]', 2, 1);
    const c1 = await geoC("head", 1);
    const t1 = await E(`return A.text()`);
    await uvDrag('[data-cube="head#1"][data-uvface=up] [data-uvh=se]', 2, 3);
    const c2 = await geoC("head", 1);
    await app.ev(`document.querySelector('[data-uvtab=east]') && document.querySelector('[data-uvtab=down]').click(); return 1`);
    await sleep(120);
    const tab = (await snapS()).uvFaces;
    await E(`await A.call("undo"); await A.call("undo"); return 1`);
    const back = (await E(`return A.text()`)) === t0;
    return { ok: JSON.stringify(c1.uv.up.uv) === "[42,1]" && JSON.stringify(c1.uv.down) === JSON.stringify((await gJ0(t0)).down) && diffLines(t0, t1) <= 2 && JSON.stringify(c2.uv.up.uv_size) === "[12,13]" && JSON.stringify(tab) === '["down"]' && back, note: `up=${JSON.stringify(c1.uv.up)} size=${JSON.stringify(c2.uv.up.uv_size)} tab=${tab} undo2=${back}` };
  });
  async function gJ0(t) { return JSON.parse(t)["minecraft:geometry"][0].bones.find((b) => b.name === "head").cubes[1].uv; }
  await check("U4 snapping: 1 px by default, 0.25 with Shift, 0.1 with Cmd (Blockbench grid steps)", async () => {
    await E(`A.set({ uvFaces: ["up"] }); await A.sleep(150); return 1`);
    const r = [];
    for (const [o, du, want] of [[{}, 6.6, 7], [{ shift: true }, 6.6, 6.5], [{ meta: true }, 6.6, 6.6]]) {
      const before = (await geoC("head", 1)).uv.up.uv[0];
      await uvDrag('[data-cube="head#1"][data-uvface=up]', du, 0, { ...o, modsOnDown: false });
      const after = (await geoC("head", 1)).uv.up.uv[0];
      r.push(Math.abs(after - before - want) < 1e-6);
      await E(`await A.call("undo"); return 1`);
    }
    return { ok: r.every(Boolean) && (await E(`return A.text()`)) === uBase, note: r.join() };
  });
  await check("U5 mirror X / Y on the selected face flips uv_size; box UV <-> per-face toggle converts and undoes", async () => {
    await app.ev(`document.querySelector('[data-id=uv-mirror-x]').click(); await __qa.sleep(150); return 1`);
    const a = (await geoC("head", 1)).uv.up;
    await app.ev(`document.querySelector('[data-id=uv-mirror-y]').click(); await __qa.sleep(150); return 1`);
    const b = (await geoC("head", 1)).uv.up;
    await E(`await A.call("undo"); await A.call("undo"); await A.call("select", ["head"], { bone: "head", index: 0 }); await A.sleep(200); return 1`);
    await app.ev(`document.querySelector('[data-id=uv-box]').click(); await __qa.sleep(200); return 1`);
    const faces = (await geoC("head", 0)).uv;
    await app.ev(`document.querySelector('[data-id=uv-box]').click(); await __qa.sleep(200); return 1`);
    const box = (await geoC("head", 0)).uv;
    await E(`await A.call("undo"); await A.call("undo"); return 1`);
    return { ok: JSON.stringify(a.uv) === "[50,0]" && JSON.stringify(a.uv_size) === "[-10,10]" && JSON.stringify(b.uv) === "[50,10]" && JSON.stringify(b.uv_size) === "[-10,-10]" && !Array.isArray(faces) && Object.keys(faces).length === 6 && Array.isArray(box) && (await E(`return A.text()`)) === uBase, note: `x=${JSON.stringify(a)} y=${JSON.stringify(b)} faces=${Object.keys(faces)} box=${JSON.stringify(box)}` };
  });
  await check("U6 multiple selected cubes move together: dragging one box island moves every selected island, ONE undo", async () => {
    await E(`A.set({ cubes: [{ bone: "head", index: 0 }, { bone: "body", index: 0 }], cube: { bone: "body", index: 0 }, bones: ["head", "body"] }); await A.sleep(250); return 1`);
    await uvDrag('[data-uvisland="body#0"]', 2, 1);
    const h = (await geoC("head", 0)).uv, b = (await geoC("body", 0)).uv;
    const n = (await E(`return A.text()`)) !== uBase;
    await E(`await A.call("undo"); return 1`);
    return { ok: JSON.stringify(h) === "[2,1]" && JSON.stringify(b) === "[18,17]" && n && (await E(`return A.text()`)) === uBase, note: `head=${JSON.stringify(h)} body=${JSON.stringify(b)}` };
  });
  await check("U7 numbers: typing U in the UV panel edits every selected cube (mixed values show blank)", async () => {
    const mixed = await uvNum("uv-u");
    await app.ev(`const inp = document.querySelector('[data-id=uv-u]'); inp.focus(); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set; set.call(inp, "7"); inp.dispatchEvent(new Event("input", { bubbles: true })); inp.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); inp.blur(); await __qa.sleep(250); return 1`);
    const h = (await geoC("head", 0)).uv, b = (await geoC("body", 0)).uv;
    await E(`A.focus(); await A.call("undo"); return 1`);
    return { ok: mixed === "" && h[0] === 7 && b[0] === 7 && h[1] === 0 && b[1] === 16 && (await E(`return A.text()`)) === uBase, note: `mixed="${mixed}" head=${JSON.stringify(h)} body=${JSON.stringify(b)}` };
  });
  await check("U8 zoom / pan like Blockbench: Cmd+wheel zooms at the cursor, wheel pans, RMB drag pans, Reset restores", async () => {
    const v0 = await uvView();
    await E(`A.uv.wheel(-120, { meta: true, x: 40, y: 40 }); await A.sleep(100); return 1`);
    const v1 = await uvView();
    await E(`A.uv.wheel(80, {}); await A.sleep(100); return 1`);
    const v2 = await uvView();
    await E(`await A.uv.drag("[data-testid=uv-viewport]", 25, 15, { button: 2 }); return 1`);
    const v3 = await uvView();
    await app.ev(`document.querySelector('[data-id=uv-fit]').click(); await __qa.sleep(120); return 1`);
    const v4 = await uvView();
    return { ok: v1.zoom > v0.zoom * 1.1 && Math.abs(v2.fy - v1.fy) > 2 && Math.abs(v3.fx - v2.fx) > 5 && v4.zoom === 1, note: `zoom ${v0.zoom}->${v1.zoom} fy ${v1.fy}->${v2.fy} fx ${v2.fx}->${v3.fx} reset=${v4.zoom}` };
  });
  await check("U9 .bbmodel per-face UV: dragging one face rectangle rewrites only that face's uv array; resize via corner; one undo each", async () => {
    await open(files.bb2);
    await sleep(500);
    await E(`A.set({ mode: "edit", cubes: [], uvFaces: ["north"], texActive: 0 }); await A.call("select", ["lid_bone"], { bone: "lid_bone", index: 0 }); await A.sleep(300); return 1`);
    const t0 = await E(`return A.text()`);
    await uvDrag('[data-cube="lid_bone#0"][data-uvface=north]', 2, 1);
    const t1 = await E(`return A.text()`);
    const f1 = JSON.parse(t1).elements[0].faces;
    await uvDrag('[data-cube="lid_bone#0"][data-uvface=north] [data-uvh=se]', 3, 2);
    const f2 = JSON.parse(await E(`return A.text()`)).elements[0].faces;
    await E(`await A.call("undo"); await A.call("undo"); return 1`);
    return { ok: JSON.stringify(f1.north.uv) === "[2,1,10,9]" && JSON.stringify(f1.east.uv) === "[0,0,8,8]" && diffLines(t0, t1) <= 4 && JSON.stringify(f2.north.uv) === "[2,1,13,11]" && (await E(`return A.text()`)) === t0, note: `north=${JSON.stringify(f1.north.uv)} -> ${JSON.stringify(f2.north.uv)} diffLines=${diffLines(t0, t1)}` };
  });
  await sleep(200); await E(`A.renderNow(); return 1`); app.shot("animstudio-uv-bb");

  // ============ X. textures: several textures per model ============
  await check("X1 .bbmodel Textures panel lists every texture with a thumbnail, size and visibility; selecting one makes it the UV editor's texture", async () => {
    await open(files.bb2);
    await sleep(500);
    await E(`A.set({ mode: "edit", cubes: [], texActive: 0 }); await A.call("select", ["base"], { bone: "base", index: 0 }); await A.sleep(300); return 1`);
    const d = await app.ev(`return { rows: document.querySelectorAll('.as-texrow').length, thumbs: document.querySelectorAll('.as-texrow canvas.as-texthumb').length, names: [...document.querySelectorAll('.as-texname')].map((e) => e.textContent), subs: [...document.querySelectorAll('.as-texsub')].map((e) => e.textContent) }`);
    const faces0 = await app.ev(`return document.querySelectorAll('[data-cube="base#0"][data-uvface]').length`);
    await E(`A.click('[data-tex="1"]'); await A.sleep(200); return 1`);
    const faces1 = await app.ev(`return document.querySelectorAll('[data-cube="base#0"][data-uvface]').length`);
    const act = (await snapS()).texActive;
    return { ok: d.rows === 2 && d.thumbs === 2 && d.names[1] === "crate_alt.png" && /64/.test(d.subs[0]) && faces0 === 5 && faces1 === 1 && act === 1, note: JSON.stringify({ d, faces0, faces1, act }) };
  });
  await check("X2 per-face texture assignment (.bbmodel): Apply to selected faces / all faces writes faces.<f>.texture; one undo each", async () => {
    await E(`A.set({ uvFaces: ["north", "up"] }); await A.sleep(100); return 1`);
    const t0 = await E(`return A.text()`);
    await E(`A.tex.apply(0, "faces"); return 1`);
    const a = JSON.parse(await E(`return A.text()`)).elements[1].faces;
    await E(`await A.call("undo"); A.tex.apply(1, "all"); return 1`);
    const b = JSON.parse(await E(`return A.text()`)).elements[1].faces;
    await E(`await A.call("undo"); return 1`);
    return { ok: a.north.texture === 0 && a.up.texture === 0 && a.east.texture === 0 && Object.values(b).every((f) => f.texture === 1) && (await E(`return A.text()`)) === t0, note: `north=${a.north.texture} all=${Object.values(b).map((f) => f.texture)}` };
  });
  await check("X3 visibility toggle writes `visible` into the texture; hidden texture drops out of the viewport texture set", async () => {
    const t0 = await E(`return A.text()`);
    await app.ev(`document.querySelector('.as-texrow[data-tex="1"] [data-act=tex-eye]').click(); await __qa.sleep(200); return 1`);
    const vis = JSON.parse(await E(`return A.text()`)).textures.map((t) => t.visible);
    await E(`await A.call("undo"); return 1`);
    return { ok: vis[0] === true && vis[1] === false && (await E(`return A.text()`)) === t0, note: JSON.stringify(vis) };
  });
  await check("X4 add a texture (embedded data URL like Blockbench) is saved in the .bbmodel; remove re-indexes the faces; elsewhere byte-identical", async () => {
    const copy = path.join(proj, "models/crate3.bbmodel");
    fs.copyFileSync(files.bb2, copy);
    await open(copy);
    await sleep(500);
    const t0 = await E(`return A.text()`);
    await E(`return A.tex.addBytes("glow.png", ${JSON.stringify(skin2.toString("base64"))})`);
    const t1 = await E(`return A.text()`);
    const j1 = JSON.parse(t1);
    const sameHead = t0.slice(0, t0.indexOf('"textures"')) === t1.slice(0, t1.indexOf('"textures"'));
    await E(`await A.save(); return 1`);
    const onDisk = JSON.parse(fs.readFileSync(copy, "utf8"));
    const rows = await E(`return A.tex.rows().length`);
    await E(`A.tex.remove(0); return 1`);
    const j2 = JSON.parse(await E(`return A.text()`));
    await E(`await A.call("undo"); await A.call("undo"); return 1`);
    return { ok: j1.textures.length === 3 && j1.textures[2].name === "glow.png" && /^data:image\/png;base64,/.test(j1.textures[2].source) && j1.textures[2].id === "2" && sameHead && onDisk.textures.length === 3 && onDisk.textures[2].source === j1.textures[2].source && rows === 3 && j2.textures.length === 2 && j2.elements[1].faces.north.texture === 0 && j2.elements[0].faces.north.texture === undefined && (await E(`return A.text()`)) === t0, note: `textures=${j1.textures.length} savedOnDisk=${onDisk.textures.length} removed->${j2.textures.length} north ${j2.elements[1].faces.north.texture} head-identical=${sameHead}` };
  });
  await sleep(200);
  await check("X5 geo textures: the default texture plus <stem>_*.png variants as switchable/stackable preview layers (hidden by default)", async () => {
    await open(files.geo);
    await sleep(700);
    const st = await snapS();
    const rows = await app.ev(`return { n: document.querySelectorAll('.as-texrow').length, names: [...document.querySelectorAll('.as-texname')].map((e) => e.textContent), note: (document.querySelector('[data-testid=tex-geo-note]') || {}).textContent }`);
    const k0 = (await snapS()).viewport.textureKey;
    await E(`A.tex.toggle(1, true); await A.sleep(500); return 1`);
    const s1 = await snapS();
    await E(`A.tex.solo(1); await A.sleep(500); return 1`);
    const s2 = await snapS();
    await E(`A.tex.blend(1, "add"); A.tex.toggle(0, true); await A.sleep(500); return 1`);
    const s3 = await snapS();
    return { ok: st.geoTex.layers.length === 2 && st.geoTex.layers[0].visible && !st.geoTex.layers[1].visible && rows.n === 2 && /golem_glow/.test(rows.names[1]) && /one texture/.test(rows.note) && s1.viewport.textureKey !== k0 && /glow/.test(s1.viewport.textureKey) && s1.viewport.textureLoaded === 1 && s2.geoTex.layers.map((l) => l.visible).join() === "false,true" && s3.geoTex.layers[1].blend === "add" && s3.viewport.textureLoaded === 1, note: JSON.stringify({ layers: s3.geoTex.layers.map((l) => [l.path.split("/").pop(), l.visible, l.blend]), key: s3.viewport.textureKey.slice(-80) }) };
  });
  await check("X6 geo texture list persists in Ace app data across restart (and nothing is written into the project)", async () => {
    await E(`A.tex.toggle(0, true); A.tex.toggle(1, true); A.tex.active(1); await A.sleep(500); return 1`);
    const listing = () => execSync(`find ${JSON.stringify(proj)} -type f | sort | md5`, { encoding: "utf8", shell: "/bin/zsh" }).trim();
    const before1 = listing();
    await app.stop();
    app = await launch(proj, { dataDir });
    await app.ev(`await __qa.waitFor(() => document.querySelector('.statusbar'), 20000); return 1`);
    await open(files.geo);
    await sleep(900);
    const st = await snapS();
    return { ok: st.geoTex.layers.length === 2 && st.geoTex.layers.every((l) => l.visible) && st.texActive === 1 && listing() === before1, note: JSON.stringify(st.geoTex.layers.map((l) => [l.path.split("/").pop(), l.visible])) + ` active=${st.texActive}` };
  });
  await sleep(300); await E(`A.renderNow(); return 1`);

  await check("L4 screenshot: Edit mode with the UV editor, two textures and a multi-selection (scripts/qa/out/animstudio-edit-bb.png)", async () => {
    await open(files.bb2);
    await sleep(600);
    await E(`A.set({ mode: "edit", tool: "move", texActive: 0, uvFaces: ["north", "up"], cubes: [{ bone: "lid_bone", index: 0 }, { bone: "base", index: 0 }], cube: { bone: "base", index: 0 }, bones: ["lid_bone", "base"] }); await A.sleep(500); A.renderNow(); return 1`);
    await sleep(500);
    await E(`A.renderNow(); return 1`);
    const out = app.shot("animstudio-edit-bb");
    const st = await snapS();
    return { ok: st.cubes.length === 2 && (await E(`return A.tex.rows().length`)) === 2, note: out };
  });
  await open(files.geo); await sleep(500);
  await E(`A.set({ mode: "edit", cubes: [], bones: [], cube: null }); await A.call("select", ["head"], { bone: "head", index: 1 }); A.set({ uvFaces: ["up", "down"] }); A.tex.toggle(1, true); A.tex.active(0); await A.sleep(700); A.renderNow(); return 1`);
  app.shot("animstudio-edit-geo");

  // ============ S. multi-select exactly like Blockbench ============
  const sSel = async () => E(`const s = A.state(); return { bones: s.bones, cube: s.cube, cubes: s.cubes.map((c) => c.bone + "#" + c.index).sort() }`);
  await open(files.geo);
  await sleep(600);
  const sBase = await E(`return A.text()`);
  await E(`A.set({ mode: "edit", tool: "move", bones: [], cube: null, cubes: [], hidden: [], locked: [], uvFaces: ["north"] }); A.vp("resetCamera"); await A.sleep(300); return 1`);
  const row = (kind, id) => `.as-row-t[data-${kind}="${id}"]`;
  await check("S1 Outliner: Cmd-click toggles cubes in and out of the selection (primary = last)", async () => {
    await E(`A.click(${JSON.stringify(row("cube", "body#0"))}); A.click(${JSON.stringify(row("cube", "head#0"))}, { meta: true }); A.click(${JSON.stringify(row("cube", "arm_l#0"))}, { meta: true }); await A.sleep(150); return 1`);
    const a = await sSel();
    const hl = await app.ev(`return [...document.querySelectorAll('.as-row-t.sel[data-cube]')].map((e) => e.dataset.cube).sort()`);
    await E(`A.click(${JSON.stringify(row("cube", "head#0"))}, { meta: true }); await A.sleep(120); return 1`);
    const b = await sSel();
    return { ok: a.cubes.join() === "arm_l#0,body#0,head#0" && a.cube?.bone === "arm_l" && hl.length === 3 && b.cubes.join() === "arm_l#0,body#0", note: JSON.stringify({ a: a.cubes, hl, b: b.cubes }) };
  });
  await check("S2 Outliner: Shift-click range-selects the cubes between the last selected one and the clicked one (same group)", async () => {
    await E(`A.click(${JSON.stringify(row("cube", "head#0"))}); A.click(${JSON.stringify(row("cube", "head#1"))}, { shift: true }); await A.sleep(120); return 1`);
    const a = await sSel();
    await E(`A.click(${JSON.stringify(row("bone", "head"))}); A.click(${JSON.stringify(row("bone", "arm_r"))}, { shift: true }); await A.sleep(120); return 1`);
    const b = await sSel();
    return { ok: a.cubes.join() === "head#0,head#1" && a.cube?.index === 1 && b.cube === null && b.bones.includes("head") && b.bones.includes("arm_r"), note: JSON.stringify({ a: a.cubes, b: b.bones }) };
  });
  await check("S3 selecting a group selects everything inside it (all child cubes outlined); Cmd on a cube of a selected group dissolves the group", async () => {
    await E(`A.click(${JSON.stringify(row("bone", "body"))}); await A.sleep(250); return 1`);
    const a = await sSel();
    const outl = (await snapS()).viewport.selection.outlines;
    await E(`A.click(${JSON.stringify(row("cube", "arm_l#0"))}, { meta: true }); await A.sleep(200); return 1`);
    const b = await sSel();
    return { ok: a.bones.join() === "body" && a.cube === null && outl === 5 && b.cubes.length === 4 && !b.cubes.includes("arm_l#0"), note: JSON.stringify({ a: a.bones, outl, b: b.cubes }) };
  });
  await check("S4 viewport: Cmd-click toggles cubes, Shift-click adds the cube's group, Cmd-drag area-selects (Shift adds)", async () => {
    await E(`A.set({ bones: [], cube: null, cubes: [] }); await A.sleep(100); return 1`);
    const ph = await E(`return A.vp("projectCube", "head", 0)`), pb = await E(`return A.vp("projectCube", "body", 0)`), pa = await E(`return A.vp("projectCube", "arm_r", 0)`);
    await E(`A.ptr("pointerdown", ${ph.x}, ${ph.y}, { meta: true }); A.ptr("pointerup", ${ph.x}, ${ph.y}, { meta: true }); A.ptr("pointerdown", ${pb.x}, ${pb.y}, { meta: true }); A.ptr("pointerup", ${pb.x}, ${pb.y}, { meta: true }); await A.sleep(100); return 1`);
    const a = await sSel();
    await E(`A.ptr("pointerdown", ${ph.x}, ${ph.y}, { meta: true }); A.ptr("pointerup", ${ph.x}, ${ph.y}, { meta: true }); await A.sleep(100); return 1`);
    const b = await sSel();
    await E(`A.set({ bones: [], cube: null, cubes: [] }); A.ptr("pointerdown", ${ph.x}, ${ph.y}, { shift: true }); A.ptr("pointerup", ${ph.x}, ${ph.y}, { shift: true }); A.ptr("pointerdown", ${pb.x}, ${pb.y}, { shift: true }); A.ptr("pointerup", ${pb.x}, ${pb.y}, { shift: true }); await A.sleep(100); return 1`);
    const c = await sSel();
    const [cw, ch] = await vvsize();
    await E(`A.set({ bones: [], cube: null, cubes: [] }); await A.sleep(60); await A.drag([14, 14], [${cw - 14}, ${ch - 14}], { ctrl: true }); return 1`);
    const d = await sSel();
    const hitHead = [ph.x, ph.y];
    void hitHead;
    return { ok: a.cubes.join() === "body#0,head#0" && b.cubes.join() === "body#0" && c.cube === null && c.bones.includes("body") && c.bones.includes("head") && d.cubes.length === 5, note: JSON.stringify({ a: a.cubes, b: b.cubes, c: c.bones, d: d.cubes.length }) };
  });
  await check("S5 transforms act on the whole selection: gizmo move of two groups (and of two cubes) is ONE undo step", async () => {
    await E(`A.set({ bones: ["head", "arm_r"], cube: null, cubes: [], tool: "move" }); await A.sleep(250); return 1`);
    const t0 = await E(`return A.text()`);
    await E(`return await A.call("nudge", "move", [0, 2, 0])`);
    const j = (await gJ())["minecraft:geometry"][0].bones;
    const j0 = JSON.parse(t0)["minecraft:geometry"][0].bones;
    const moved = ["head", "arm_r"].every((n) => j.find((b) => b.name === n).pivot[1] === j0.find((b) => b.name === n).pivot[1] + 2);
    const others = ["body", "arm_l"].every((n) => j.find((b) => b.name === n).pivot[1] === j0.find((b) => b.name === n).pivot[1]);
    await E(`await A.call("undo"); return 1`);
    return { ok: moved && others && (await E(`return A.text()`)) === t0, note: `moved=${moved} others=${others}` };
  });
  await check("S6 Properties edit all selected cubes; mixed values are blank; one undo", async () => {
    await E(`A.set({ cubes: [{ bone: "head", index: 0 }, { bone: "body", index: 0 }], cube: { bone: "body", index: 0 }, bones: ["head", "body"] }); await A.sleep(300); return 1`);
    const vals = await app.ev(`const g = (id) => { const i = document.querySelector('[data-id="' + id + '"]'); return i ? i.value : null; }; return { ox: g("cube-origin-x"), oy: g("cube-origin-y"), sx: g("cube-size-x"), sy: g("cube-size-y") }`);
    await app.ev(`const inp = document.querySelector('[data-id="cube-origin-x"]'); inp.focus(); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set; set.call(inp, "1"); inp.dispatchEvent(new Event("input", { bubbles: true })); inp.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); inp.blur(); await __qa.sleep(250); return 1`);
    const h = await geoC("head", 0), b = await geoC("body", 0);
    await E(`A.focus(); await A.call("undo"); return 1`);
    return { ok: vals.ox === "-4" && vals.oy === "" && vals.sx === "8" && vals.sy === "" && h.origin.join() === "1,24,-4" && b.origin.join() === "1,12,-2" && (await E(`return A.text()`)) === sBase, note: JSON.stringify({ vals, h: h.origin, b: b.origin }) };
  });
  await check("S7 delete / duplicate / copy-paste act on the whole selection (⌘D, ⌫, ⌘C ⌘V), each one undo step", async () => {
    await E(`A.set({ cubes: [{ bone: "head", index: 0 }, { bone: "arm_r", index: 0 }], cube: { bone: "arm_r", index: 0 }, bones: ["head", "arm_r"] }); A.focus(); await A.sleep(200); return 1`);
    const count = async () => (await gJ())["minecraft:geometry"][0].bones.reduce((n, b) => n + (b.cubes?.length ?? 0), 0);
    const n0 = await count();
    await key("meta D"); const n1 = await count(); const s1 = await sSel();
    await key("meta Z");
    await E(`A.set({ cubes: [{ bone: "head", index: 0 }, { bone: "arm_r", index: 0 }], cube: { bone: "arm_r", index: 0 }, bones: ["head", "arm_r"] }); await A.sleep(150); return 1`);
    await key("BACK_SPACE"); const n2 = await count();
    await key("meta Z");
    await E(`A.set({ cubes: [{ bone: "head", index: 0 }, { bone: "arm_r", index: 0 }], cube: { bone: "arm_r", index: 0 }, bones: ["head", "arm_r"] }); await A.sleep(150); return 1`);
    await key("meta C"); await key("meta V"); const n3 = await count();
    await key("meta Z");
    return { ok: n1 === n0 + 2 && s1.cubes.length === 2 && n2 === n0 - 2 && n3 === n0 + 2 && (await E(`return A.text()`)) === sBase, note: `${n0} dup=${n1} del=${n2} paste=${n3}` };
  });
  await check("S8 Animate: Cmd-click multi-selects bones in the Outliner and Q inserts keys for every selected bone", async () => {
    await open(files.anim);
    await sleep(500);
    await E(`A.set({ mode: "animate", anim: "animation.golem.wave", time: 0.25, keys: [], bones: [] }); await A.sleep(300); return 1`);
    await E(`A.click(${JSON.stringify(row("bone", "arm_l"))}); A.click(${JSON.stringify(row("bone", "head"))}, { meta: true }); await A.sleep(150); return 1`);
    const sel = await E(`return A.state().bones`);
    await key("Q");
    const anim = JSON.parse(await E(`return A.text()`)).animations["animation.golem.wave"].bones;
    const ok = !!anim.arm_l.rotation["0.25"] && !!anim.head.rotation["0.25"];
    await key("meta Z");
    return { ok: sel.length === 2 && ok, note: `bones=${sel} keys@0.25 arm_l=${!!anim.arm_l.rotation["0.25"]} head=${!!anim.head.rotation["0.25"]}` };
  });


  // ============ T. Thematic game preview: playback kinds, aim, spin, stride, ignored positions ============
  if (haveSpidey) {
    const raw = JSON.parse(fs.readFileSync(files.swing, "utf8")).animations;
    const D2R = Math.PI / 180;
    // BodyAttitude.trickAngle (BodyAttitude.java:301-331): speed knots eased with a smoothstep, normalised to the turns
    const FLIP = [[0, 0], [0.15, 0.35], [0.3, 1.7], [0.65, 1.7], [0.8, 0.7], [1, 0]], TWIST = [[0, 0], [0.1, 0.6], [0.2, 1.5], [0.7, 1.5], [0.85, 0.6], [1, 0]];
    const area = (k, p) => { let sum = 0; for (let i = 0; i + 1 < k.length && p > k[i][0]; i++) { const len = k[i + 1][0] - k[i][0], t = Math.min(1, (p - k[i][0]) / len); sum += len * (k[i][1] * t + (k[i + 1][1] - k[i][1]) * (t ** 3 - t ** 4 / 2)); } return sum; };
    const angle = (k, turns, p) => (360 * turns * area(k, Math.min(1, p))) / area(k, 1);
    const near = (a, b, tol) => Math.abs(a - b) <= tol;
    const gameOpen = async (anim, patch = "") => { await E(`A.set({ mode: "animate", anim: ${JSON.stringify(anim)}, time: 0, keys: [], bones: [], playing: false, asGameApplies: false, liveAim: false, tool: "rotate" ${patch} }); await A.sleep(350); return 1`); };
    await open(files.swing);
    await waitFor(`(async () => (await A.snapshot()).clips > 20)()`, 10000);
    await E(`await A.call("pickModel", null); await A.sleep(500); return 1`);   // the built-in Player rig (earlier checks may have remembered a preview model)

    await check("T1 every clip is labelled drawn / pose / stride, derived from the pose set (+ positions use, stride gait)", async () => {
      const s = await snapS();
      const k = s.clipKinds;
      const rows = await app.ev(`return document.querySelectorAll('.as-arow [data-kind]').length`);
      const names = s.anims.length;
      const want = { web_flip_front: "drawn/playback", web_corkscrew_left: "drawn/playback", web_air_dive: "drawn/playback", web_tuck: "drawn/playback", web_sling_right: "pose/playback", web_land: "pose/ignored", web_run: "stride/ignored/walk", web_wall_run: "stride/ignored/walk", web_crawl: "stride/limb-driver/gait", web_ceiling_crawl: "stride/limb-driver/gait", web_climb: "stride/playback/walk" };
      const bad = Object.entries(want).filter(([n, v]) => k[n] !== v).map(([n, v]) => `${n}: ${k[n]} != ${v}`);
      return { ok: !bad.length && rows === names, note: `tags=${rows}/${names} ${bad.join("; ")}` };
    });

    await check("T2 axes: a file rotation shows as scene (-x,-y,z) in the normal view AND in 'As game applies' (the game's chain is the same map)", async () => {
      const v = raw.web_sling_right.bones.armorLeftArm.rotation;
      const first = Array.isArray(v) ? v : (Object.values(v)[0].vector ?? Object.values(v)[0]);
      await gameOpen("web_sling_right");
      const vb = (await snapS()).viewport.bones;
      if (!vb.armorLeftArm) throw new Error("no armorLeftArm in the rig: " + Object.keys(vb).join(","));
      const a = vb.armorLeftArm.rot;
      await E(`A.set({ asGameApplies: true }); await A.sleep(300); return 1`);
      const b = (await snapS()).viewport.bones.armorLeftArm.rot;
      const want = [-first[0], -first[1], first[2]];
      const eq = (x, y) => x.every((n, i) => near(n, y[i], 0.06));
      return { ok: eq(a, want) && eq(b, want), note: `file=${first} normal=${a} game=${b}` };
    });

    await check("T3 aimed limb: dope sheet/inspector grey pitch+yaw (roll stays live), gizmo offers roll only", async () => {
      await gameOpen("web_sling_right", `, bones: ["armorRightArm"]`);
      const g = (await snapS()).viewport.gizmo;
      await E(`A.set({ keys: [{ bone: "armorRightArm", channel: "rotation", time: 0 }] }); await A.sleep(350); return 1`);
      const greyed = await app.ev(`return document.querySelectorAll('.as-axf[data-aimed="1"]').length`);
      await E(`A.set({ bones: ["armorLeftArm"], keys: [{ bone: "armorLeftArm", channel: "rotation", time: 0 }] }); await A.sleep(350); return 1`);
      const g2 = (await snapS()).viewport.gizmo;
      const greyed2 = await app.ev(`return document.querySelectorAll('.as-axf[data-aimed="1"]').length`);
      return { ok: g?.rollOnly === true && g.axes.join() === "false,false,true" && greyed === 2 && g2?.rollOnly === false && g2.axes.join() === "true,true,true" && greyed2 === 0, note: `gizmo=${JSON.stringify(g)} greyed=${greyed}; left gizmo=${JSON.stringify(g2)} greyed=${greyed2}` };
    });

    await check("T4 live aim: aimed arm points at the web-anchor marker like LimbDriver.aimFrom; dragging the marker moves it", async () => {
      await gameOpen("web_sling_right", `, bones: [], asGameApplies: true, liveAim: true, webAnchor: [0, 64, -40]`);
      const s = await snapS();
      // shoulder (5,22,0); d = (-5, 42, -40): pitch = -acos(-dy/len), yaw = atan2(dx/len ... ) per LimbDriver.java:1768-1781
      const len = Math.hypot(5, 42, 40), tx = 5 / len, ty = -42 / len, tz = -40 / len;
      const pitch = -Math.acos(ty) / D2R, yaw = Math.atan2(-tx, -tz) / D2R;
      const rot = s.viewport.bones.armorRightArm.rot;
      const roll = (() => { const v = raw.web_sling_right.bones.armorRightArm.rotation; const f = Array.isArray(v) ? v : (Object.values(v)[0].vector ?? Object.values(v)[0]); return f[2]; })();
      const okRot = near(rot[0], -pitch, 0.3) && near(rot[1], -yaw, 0.3) && near(rot[2], roll, 0.3);
      const pt = await E(`return A.vp("anchorScreen")`);
      let moved = null;
      if (pt) { await E(`await A.drag([${pt.x}, ${pt.y}], [${pt.x + 40}, ${pt.y - 30}], { steps: 5 }); await A.sleep(250); return 1`); moved = (await snapS()).webAnchor; }
      const after = (await snapS()).viewport.bones.armorRightArm.rot;
      return { ok: okRot && !!pt && moved && moved.join() !== "0,64,-40" && after.join() !== rot.join() && s.viewport.game.aimed.includes("armorRightArm"), note: `want pitch=${pitch.toFixed(1)} yaw=${yaw.toFixed(1)} roll=${roll}; got ${rot}; marker=${JSON.stringify(pt)} anchor->${moved} rot->${after}` };
    });

    await check("T5 ignored position keys: warning + 'Remove ignored position keys' (one undo step); crawl limb positions and broadcast clips are not flagged", async () => {
      await open(files.pos);
      await waitFor(`(async () => (await A.snapshot()).problems > 0)()`, 8000);
      const probs = await E(`return A.state().problems.filter((p) => p.code === "position-ignored").map((p) => p.anim + ":" + p.severity + ":" + p.message.slice(0, 90))`);
      const idxs = await E(`return A.state().problems.map((p, i) => [i, p.code, p.fix?.title]).filter((x) => x[1] === "position-ignored")`);
      const t0 = await E(`return A.text()`);
      for (const [i] of idxs) await E(`return A.applyFix(${i})`);
      const t1 = await E(`return A.text()`);
      await sleep(600);   // the problem list is re-validated 250 ms after an edit
      const left = await E(`return A.state().problems.filter((p) => p.code === "position-ignored").length`);
      for (let i = 0; i < idxs.length; i++) await E(`await A.call("undo"); return 1`);   // each fix is its own undo step
      const kept = JSON.parse(t1).animations;
      const flags = { restored: (await E(`return A.text()`)) === t0, n: probs.length, warn: probs.every((m) => m.includes(":warning:")), title: idxs.every((x) => x[2] === "Remove ignored position keys"), left, land: !kept.web_land.bones.armorRightArm.position, crawlLeg: !!kept.web_crawl.bones.armorRightLeg.position, crawlBody: !kept.web_crawl.bones.armorBody?.position, swing: !!kept.web_sling_right.bones.armorRightLeg.position };
      return { ok: flags.restored && flags.n === 2 && flags.warn && flags.title && flags.left === 0 && flags.land && flags.crawlLeg && flags.crawlBody && flags.swing, note: JSON.stringify(flags) + " " + probs.map((m) => m.slice(0, 30)).join(" | ") };
    });
    await check("T6 game view drops the position keys the game never plays (pose-only clip; web_land is mirrored so they sit on the left arm) but keeps them in the normal view", async () => {
      await gameOpen("web_land", `, time: 0.25`);
      const n = (await snapS()).viewport.bones.armorRightArm.pos;
      await E(`A.set({ asGameApplies: true }); await A.sleep(300); return 1`);
      const s = await snapS();
      const g = s.viewport.bones.armorRightArm.pos;
      return { ok: n.join() !== g.join() && s.viewport.game.ignoredPositions.includes("armorLeftArm") && s.viewport.game.positions === "ignored", note: `normal=${n} game=${g} ignored=${s.viewport.game.ignoredPositions}` };
    });

    await open(files.swing);
    await waitFor(`(async () => (await A.snapshot()).clips > 20)()`, 10000);
    await check("T7 spin: smoothstepped speed profile over the spin's own length (front flip), hinge = centre of mass + swing_pivot", async () => {
      await gameOpen("web_flip_front", `, asGameApplies: true, time: 0.35`);
      const s = await snapS();
      const g = s.viewport.game;
      const want = angle(FLIP, 1, 0.5);
      return { ok: near(g.spinAngle, want, 0.2) && near(g.spinProgress, 0.5, 0.01) && g.hinge[0] > 10 && g.hinge[0] < 30 && s.viewport.trick.some((v, i) => i < 3 && Math.abs(v) > 0.05), note: `angle=${g.spinAngle} want=${want.toFixed(2)} hinge=${g.hinge} q=${s.viewport.trick}` };
    });
    await check("T8 spin volley (web_spin: 3 twists over 22 ticks) finishes at 1.1 s and the normal view has no spin", async () => {
      await gameOpen("web_spin", `, asGameApplies: true, time: 0.55`);
      const mid = (await snapS()).viewport.game;
      await E(`A.set({ time: 1.3 }); await A.sleep(300); return 1`);
      const end = (await snapS());
      await E(`A.set({ asGameApplies: false }); await A.sleep(300); return 1`);
      const off = (await snapS()).viewport;
      return { ok: near(mid.spinAngle, angle(TWIST, 3, 0.5), 0.3) && near(mid.spinProgress, 0.5, 0.01) && near(end.viewport.game.spinAngle, 1080, 0.01) && off.trick.join() === "0,0,0,1", note: `mid=${mid.spinAngle} want=${angle(TWIST, 3, 0.5).toFixed(1)} end=${end.viewport.game.spinAngle} off=${off.trick}` };
    });

    await check("T9 stride clips: pace slider (blocks/s) drives the phase by distance; absent on non-stride clips", async () => {
      await gameOpen("web_sling_right");
      const absent = await app.ev(`return !document.querySelector('[data-testid=as-stride]')`);
      await gameOpen("web_crawl");
      const present = await app.ev(`return !!document.querySelector('[data-testid=as-stride]')`);
      await app.ev(`const i = document.querySelector('[data-testid=as-stride-speed]'); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set; set.call(i, "3"); i.dispatchEvent(new Event("input", { bubbles: true })); await __qa.sleep(200); return 1`);
      const label = await app.ev(`return [document.querySelector('[data-testid=as-stride-readout]')?.textContent, document.querySelector('[data-testid=as-stride-len]')?.textContent]`);
      await E(`A.set({ time: 0, strideDist: 0, playing: true }); await A.sleep(700); A.set({ playing: false }); await A.sleep(200); return 1`);
      const st = await E(`const s = A.state(); return { time: s.time, dist: s.strideDist, speed: s.strideSpeed }`);
      const len = raw.web_crawl.animation_length, stride = Math.max(0.5 + 2.5 * (3 / 20), 4 * (3 / 20));
      const wantPhase = (st.dist / stride) % 1, gotPhase = st.time / len;
      const dphase = Math.min(Math.abs(wantPhase - gotPhase), 1 - Math.abs(wantPhase - gotPhase));
      return { ok: absent && present && st.speed === 3 && st.dist > 0.8 && dphase < 0.03 && /3\.0 b\/s/.test(label[0]) && /0\.88 blocks/.test(label[1]), note: `labels=${label} time=${st.time.toFixed(3)} dist=${st.dist.toFixed(2)} phase got=${gotPhase.toFixed(3)} want=${wantPhase.toFixed(3)}` };
    });

    await check("T10 shots: web_crawl with the stride slider, a trick mid-spin, an aimed limb greyed", async () => {
      await gameOpen("web_crawl", `, asGameApplies: true, time: 0.3, bones: ["armorRightLeg"]`);
      await sleep(500); app.shot("animstudio-game-preview");
      await gameOpen("web_corkscrew_left", `, asGameApplies: true, time: 0.45`);
      await sleep(500); app.shot("animstudio-game-spin");
      await gameOpen("web_sling_right", `, asGameApplies: true, liveAim: true, time: 0.3, bones: ["armorRightArm"], keys: [{ bone: "armorRightArm", channel: "rotation", time: 0 }]`);
      await sleep(500); app.shot("animstudio-game-aim");
      return true;
    });
  }

  // ============ K. limb links (constraints) + "all keys of a bone selected" badge ============
  {
    const kName = "animation.link.demo";
    files.link = w(`${A}/animations/misc/linkdemo.animation.json`, JSON.stringify({
      format_version: "1.8.0",
      animations: { [kName]: { loop: false, animation_length: 1, bones: {
        armorRightArm: { rotation: { "0.0": [0, 0, 0], "0.5": [-60, 10, 0], "1.0": [0, 0, 0] }, position: { "0.5": [0, 0, 0] } },
        armorLeftArm: { rotation: { "0.0": [0, 0, 0], "1.0": [0, 0, 0] } },
      } } },
    }, null, 2) + "\n");
    const kj = async () => JSON.parse(await E(`return A.text()`)).animations[kName].bones;
    const kKeys = async (bone) => Object.keys(((await kj())[bone] ?? {}).rotation ?? {});
    const kOpen = async () => { await open(files.link); await E(`A.set({ mode: "animate", anim: ${JSON.stringify(kName)}, time: 0, bones: [], keys: [], autoKey: true, tool: "rotate" }); A.vp("setView", "front"); await A.sleep(450); return 1`); };
    const dist3 = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
    const linkInfo = async () => (await E(`await A.sleep(220); return A.cons.info()`)).links[0];
    let kBase = "";
    let linkId = "";

    await check("K1 Link mode: clicking cube surfaces snaps to a contact point on each hand; a Link constraint appears", async () => {
      await kOpen();
      kBase = await E(`return A.text()`);
      const pt = (bone, x) => E(`return A.cons.project(${JSON.stringify(bone)}, [${x}, 12, -2])`);
      const pr = await pt("armorRightArm", -6), pl = await pt("armorLeftArm", 6); // clicks land 4px above the bottom edge (a ray exactly on the silhouette can miss); the snap still picks the edge midpoint
      await E(`A.cons.begin("link"); await A.sleep(200); return 1`);
      const hintA = await app.ev(`return document.querySelector('[data-testid=as-cons-hint]')?.textContent ?? null`);
      await E(`A.ptr("pointerdown", ${pr.x}, ${pr.y - 4}); A.ptr("pointerup", ${pr.x}, ${pr.y - 4}); await A.sleep(250); return 1`);
      const mid = await E(`return A.state().cons.pick`);
      await E(`A.ptr("pointerdown", ${pl.x}, ${pl.y - 4}); A.ptr("pointerup", ${pl.x}, ${pl.y - 4}); await A.sleep(300); return 1`);
      const list = await E(`return A.cons.list()`);
      const c = list[0];
      linkId = c?.id ?? "";
      const edge = (p, sx) => Math.abs(p[0] - sx * 6) < 1e-3 && Math.abs(p[1] - 12) < 1e-3 && Math.abs(Math.abs(p[2]) - 2) < 1e-3;
      return { ok: /point A/.test(hintA ?? "") && mid?.stage === "b" && list.length === 1 && c.kind === "link" && c.a.bone === "armorRightArm" && c.b.bone === "armorLeftArm" && edge(c.a.p, -1) && edge(c.b.p, 1) && c.drive === "b", note: `hint=${hintA} a=${JSON.stringify(c?.a)} b=${JSON.stringify(c?.b)}` };
    });
    await check("K2 'Both' drive: the two contact points coincide in the preview (<= 0.02 px) and the timeline says the constraints are live", async () => {
      await E(`A.cons.patch(${JSON.stringify(linkId)}, { drive: "both" }); return 1`);
      const l = await linkInfo();
      const chip = await app.ev(`return document.querySelector('[data-testid=as-livechip]')?.textContent ?? null`);
      const dots = (await E(`return A.cons.info()`)).dots;
      return { ok: l.dist !== null && l.dist < 0.02 && /Live constraints/.test(chip ?? "") && /game won't see this until baked/.test(chip ?? "") && dots === 2, note: `dist=${l.dist} chip=${chip} dots=${dots}` };
    });
    await check("K3 constraints off (Live toggle) -> the hands part again; on -> they meet", async () => {
      await E(`A.cons.set({ live: false }); return 1`);
      const off = await linkInfo();
      await E(`A.cons.set({ live: true }); return 1`);
      const on = await linkInfo();
      return { ok: off.dist > 5 && on.dist < 0.02, note: `off=${off.dist} on=${on.dist}` };
    });
    let preDrag = "";
    await check("K4 dragging the right arm moves the left arm live (mid-gizmo-drag); only the dragged bone is keyed", async () => {
      // follow semantics: only the left (B) arm is driven; with "Both" the dragged arm also settles toward the middle once released
      await E(`A.cons.patch(${JSON.stringify(linkId)}, { drive: "b" }); A.set({ time: 0.75, bones: ["armorRightArm"], keys: [], tool: "rotate", autoKey: true }); await A.sleep(300); return 1`);
      preDrag = await E(`return A.text()`);
      const before = (await snapS()).viewport.bones;
      const r = await E(`let mid; const ok = A.vp("nudge", "rotate", [-25, 0, 0], () => { mid = { info: A.cons.info(), bones: A.snapshot().viewport.bones }; }); await A.sleep(250); return { ok, mid, after: A.snapshot().viewport.bones, info: A.cons.info() }`);
      const L0 = before.armorLeftArm.rot, Lm = r.mid.bones.armorLeftArm.rot, La = r.after.armorLeftArm.rot;
      const moved = dist3(L0, Lm);
      const stays = dist3(Lm, La);
      const keysR = await kKeys("armorRightArm"), keysL = await kKeys("armorLeftArm");
      return { ok: r.ok && moved > 1 && stays < 0.1 && keysR.includes("0.75") && !keysL.includes("0.75"), note: `left moved ${moved.toFixed(1)}deg, mid->committed ${stays.toFixed(2)}, keys R@.75=${keysR.includes("0.75")} L@.75=${keysL.includes("0.75")}` };
    });
    await check("K5 one undo removes that key", async () => {
      await key("meta Z");
      return (await E(`return A.text()`)) === preDrag;
    });
    await check("K6 'Key constrained bones' keys the linked limb too; one undo step", async () => {
      await E(`A.cons.set({ keyConstrained: true }); A.set({ time: 0.75, bones: ["armorRightArm"], keys: [], autoKey: true }); await A.sleep(250); return 1`);
      await E(`A.vp("nudge", "rotate", [-25, 0, 0]); await A.sleep(250); return 1`);
      const keysR = await kKeys("armorRightArm"), keysL = await kKeys("armorLeftArm");
      await key("meta Z");
      const restored = (await E(`return A.text()`)) === preDrag;
      await E(`A.cons.set({ keyConstrained: false }); A.cons.patch(${JSON.stringify(linkId)}, { drive: "both" }); return 1`);
      return { ok: keysR.includes("0.75") && keysL.includes("0.75") && restored, note: `R=${keysR} L=${keysL} undo=${restored}` };
    });
    await check("K7 constraints persist in Ace app data across reopen (nothing written to the animation file)", async () => {
      const textBefore = await E(`return A.text()`);
      await open(files.geo);
      await sleep(500);
      await open(files.link);
      await E(`A.set({ mode: "animate", anim: ${JSON.stringify(kName)} }); await A.sleep(500); return 1`);
      const list = await waitFor(`(async () => { const l = A.cons.list(); return l.length ? l : null; })()`).catch(() => []);
      const c = list[0];
      const disk = fs.readFileSync(files.link, "utf8");
      return { ok: list.length === 1 && c.drive === "both" && c.id === linkId && !disk.includes("ace_constraints") && textBefore === (await E(`return A.text()`)), note: `list=${list.length} drive=${c?.drive}` };
    });
    await check("K8 Bake all: rotation keys appear on both driven arms (every tick), euler-continuous; ONE undo removes them", async () => {
      const before = await E(`return A.text()`);
      const c0 = (await snapS()).commits;
      await E(`A.cons.set({ sel: ${JSON.stringify(linkId)} }); await A.sleep(200); return 1`);
      await E(`return A.click("[data-testid=as-cons-bake-all]")`);
      await sleep(500);
      const kl = await kKeys("armorLeftArm"), kr = await kKeys("armorRightArm");
      const bones = await kj();
      const steps = (b) => { const ks = Object.entries(bones[b].rotation).sort((x, y) => x[0] - y[0]).map(([, v]) => (Array.isArray(v) ? v : (v.post ?? v.vector))); let m = 0; for (let i = 1; i < ks.length; i++) for (let a = 0; a < 3; a++) m = Math.max(m, Math.abs(ks[i][a] - ks[i - 1][a])); return m; };
      const c1 = (await snapS()).commits;
      const afterList = await E(`return A.cons.list()`);
      const chip = await app.ev(`return document.querySelector('[data-testid=as-livechip]') !== null`);
      await key("meta Z");
      const restored = (await E(`return A.text()`)) === before;
      return { ok: kl.length >= 21 && kr.length >= 21 && steps("armorLeftArm") < 90 && steps("armorRightArm") < 90 && c1 === c0 + 1 && afterList[0]?.enabled === false && !chip && restored, note: `L=${kl.length} R=${kr.length} maxStep=${steps("armorLeftArm").toFixed(1)}/${steps("armorRightArm").toFixed(1)} commits+${c1 - c0} enabledAfter=${afterList[0]?.enabled} chip=${chip} undo=${restored}` };
    });
    await check("K9 .bbmodel: constraints live under ace_constraints in the file (rest of the file byte-identical), undo removes them", async () => {
      await open(files.bb);
      await E(`A.set({ mode: "animate", anim: "open" }); await A.sleep(400); return 1`);
      const base = await E(`return A.text()`);
      await E(`A.cons.addFollow("lid_bone", "base"); await A.sleep(300); return 1`);
      const t = await E(`return A.text()`);
      const j = JSON.parse(t);
      const rest = { ...j }; delete rest.ace_constraints;
      await key("meta Z");
      const restored = (await E(`return A.text()`)) === base;
      return { ok: j.ace_constraints?.animations?.open?.length === 1 && JSON.stringify(rest) === JSON.stringify(JSON.parse(base)) && restored, note: `n=${j.ace_constraints?.animations?.open?.length} undo=${restored}` };
    });

    // ---- "all keys of a bone selected" badge
    await kOpen();
    const geoK = () => app.ev(`const c = document.querySelector('[data-testid=as-dopesheet] canvas'); const r = c.getBoundingClientRect(); const gw = r.width - 168; const pps = Math.min(4000, Math.max(20, (gw - 40) / 1)); return { pps, t0: -12 / pps, w: r.width, h: r.height }`);
    const ptrK = (type, x, y, o = {}) => app.ev(`const c = document.querySelector('[data-testid=as-dopesheet] canvas'); const r = c.getBoundingClientRect(); c.dispatchEvent(new PointerEvent(${JSON.stringify(type)}, { bubbles: true, cancelable: true, clientX: r.left + ${x}, clientY: r.top + ${y}, button: 0, buttons: ${type === "pointerup" ? 0 : 1}, pointerId: 91, pointerType: "mouse", isPrimary: true, metaKey: ${!!o.meta}, shiftKey: false })); await new Promise((r) => setTimeout(r, 60)); return 1`);
    const clickK = async (x, y, o) => { await ptrK("pointerdown", x, y, o); await ptrK("pointerup", x, y, o); await sleep(150); };
    const badges = () => E(`await A.sleep(120); return A.badges()`);
    await check("K10 clicking a bone label selects its keys: the row shows an 'all N' badge, the Outliner marks the bone", async () => {
      await E(`A.set({ bones: [], keys: [] }); await A.sleep(150); return 1`);
      await clickK(60, 22 + 11);                       // row 0 = armorRightArm (bones start collapsed)
      const b = await badges();
      const st = await E(`return A.boneSel("armorRightArm")`);
      const mark = await app.ev(`return document.querySelector('[data-bone=armorRightArm] [data-keymark]')?.getAttribute('data-keymark') ?? null`);
      return { ok: b.armorRightArm === "all 4" && st.state === "all" && st.total === 4 && mark === "all" && !b.armorLeftArm, note: `badges=${JSON.stringify(b)} state=${JSON.stringify(st)} outliner=${mark}` };
    });
    await check("K11 deselecting one key turns the badge into '3/4' (outlined); the Outliner marker follows", async () => {
      const g = await geoK();
      await clickK(168 + (1.0 - g.t0) * g.pps, 22 + 11, { meta: true });   // ⌘-click the key at 1.0 (rotation only)
      const b = await badges();
      const st = await E(`return A.boneSel("armorRightArm")`);
      const mark = await app.ev(`return document.querySelector('[data-bone=armorRightArm] [data-keymark]')?.textContent ?? null`);
      return { ok: b.armorRightArm === "3/4" && st.state === "partial" && st.selected === 3 && mark === "3/4", note: `badges=${JSON.stringify(b)} outliner=${mark}` };
    });
    await check("K12 clicking the badge toggles select-all / select-none for the bone", async () => {
      await clickK(150, 22 + 11);                      // inside the '3/4' pill
      const all = (await badges()).armorRightArm;
      await clickK(150, 22 + 11);                      // inside the 'all 4' pill
      const none = (await badges()).armorRightArm;
      const n = await E(`return A.state().keys.length`);
      return { ok: all === "all 4" && none === undefined && n === 0, note: `all=${all} none=${none} keys=${n}` };
    });
    await check("K13 channel rows get the same badge (expanded bone: rotation 3/3 when its keys are selected)", async () => {
      await clickK(12, 22 + 11);                       // chevron: expand armorRightArm
      await E(`A.set({ keys: [{ bone: "armorRightArm", channel: "rotation", time: 0 }, { bone: "armorRightArm", channel: "rotation", time: 0.5 }, { bone: "armorRightArm", channel: "rotation", time: 1 }] }); await A.sleep(200); return 1`);
      const b = await badges();
      await clickK(12, 22 + 11);                       // collapse again
      return { ok: b["armorRightArm:rotation"] === "all 3" && b.armorRightArm === "3/4" && !b["armorRightArm:position"], note: JSON.stringify(b) };
    });

    // ---- screenshot: a link in place, the panel open, badge visible
    await E(`A.set({ mode: "animate", time: 0.5, bones: ["armorRightArm"], tool: "rotate", keys: [] }); A.cons.set({ live: true, showPoints: true }); await A.sleep(200); return 1`);
    const shotList = await E(`return A.cons.list()`);
    if (!shotList.length) {
      // the bake in K8 left the link disabled; add a fresh visible one for the picture
      const pr = await E(`return A.cons.project("armorRightArm", [-6, 12, -2])`), pl = await E(`return A.cons.project("armorLeftArm", [6, 12, -2])`);
      await E(`A.cons.begin("link"); await A.sleep(150); A.ptr("pointerdown", ${pr.x}, ${pr.y - 4}); A.ptr("pointerup", ${pr.x}, ${pr.y - 4}); await A.sleep(200); A.ptr("pointerdown", ${pl.x}, ${pl.y - 4}); A.ptr("pointerup", ${pl.x}, ${pl.y - 4}); await A.sleep(300); return 1`);
    }
    const sl = await E(`return A.cons.list()`);
    if (sl[0]) await E(`A.cons.patch(${JSON.stringify(sl[0].id)}, { drive: "both", enabled: true }); A.cons.set({ sel: ${JSON.stringify(sl[0].id)} }); return 1`);
    await E(`A.set({ keys: [{ bone: "armorRightArm", channel: "rotation", time: 0 }, { bone: "armorRightArm", channel: "rotation", time: 0.5 }, { bone: "armorRightArm", channel: "rotation", time: 1 }] }); A.vp("setView", "persp"); await A.sleep(500); A.renderNow(); return 1`);
    await sleep(700); app.shot("animstudio-links");
    await check("K14 screenshot scripts/qa/out/animstudio-links.png written", async () => fs.existsSync(path.join(out, "animstudio-links.png")));
  }

  // ============ F. Asset Dev ============
  await app.stop();
  app = await launch(path.join(asset, "p"), { dataDir: fs.mkdtempSync(path.join(tmp, "data2-")) });
  await app.ev(`await __qa.waitFor(() => document.querySelector('.statusbar'), 20000); return 1`);
  await check("F1 Asset Dev: files open straight in the Studio, Editor|Studio toggle hidden", async () => {
    await sleep(1500);
    const s = await E(`return await A.open(${JSON.stringify(path.join(asset, "p/src/common/resources/assets/test/geo/entity/golem.geo.json"))}, {})`);
    await sleep(800);
    const bar = await app.ev(`return !!document.querySelector('.dual-bar')`);
    const vis = await app.ev(`const c = document.querySelector('.ed-code'); return !c || c.classList.contains('hidden')`);
    return { ok: s.docKind === "geo" && !bar && vis, note: `dualBar=${bar} codeHidden=${vis}` };
  });
  await sleep(500);
  app.shot("animstudio-asset-dev");
} finally {
  try { await app.stop(); } catch {}
}

await check("Real Thematic repos untouched (git status identical)", async () => {
  const bad = real.filter((d) => snap(d) !== before[d]);
  return { ok: !bad.length, note: bad.length ? "CHANGED: " + bad.join(",") : `${real.length} repos compared` };
});
const failed = rows.filter((r) => !r.ok);
console.log(`\n${rows.length - failed.length}/${rows.length} passed` + (failed.length ? `; FAILED: ${failed.map((r) => r.name).join(" | ")}` : ""));
if (!process.env.KEEP) { fs.rmSync(tmp, { recursive: true, force: true }); fs.rmSync(asset, { recursive: true, force: true }); } else console.log("kept", tmp);
process.exit(failed.length ? 1 : 0);
