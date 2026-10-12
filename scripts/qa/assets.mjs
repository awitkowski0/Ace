#!/usr/bin/env node
// File-editor (viewer) suite: images, mcmeta animation, markdown, audio, glTF, Blockbench, CSV, NBT, fonts, archives, video,
// binary/too-large placeholders, syntax, splits/⌘W/Recent Files, external reload, remote (mc) image + md, and read-only opens of
// real repo files with screenshots. Driven only through the automation harness (no OS-level input).
// Usage: node scripts/qa/assets.mjs [--keep] [--no-real] [--no-remote]    Env: ACE_BIN
import { execFileSync, execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { launch, sleep, here } from "./lib.mjs";
import { makeFixtures, png, PIXEL } from "./assets-fixtures.mjs";

const scratch = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), "ace-assets-"));
const proj0 = path.join(scratch, "proj");
fs.mkdirSync(proj0, { recursive: true });
const proj = fs.realpathSync(proj0); // /var -> /private/var: the fs watcher reports real paths
makeFixtures(proj);
const home = os.homedir();
const REPOS = [path.join(home, "IdeaProjects/Thematic-Collections"), path.join(home, "thematic-kyf")];
const gitState = () => REPOS.map((r) => { try { return execSync("git status --porcelain", { cwd: r, encoding: "utf8" }); } catch { return "n/a"; } });
const gitBefore = gitState();
const P = (f) => JSON.stringify(path.join(proj, f));
const ffprobe = (f) => JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_streams", "-show_format", "-of", "json", path.join(proj, f)], { encoding: "utf8" }));

const app = await launch(proj);
const rows = [];
const S = () => app.ev("return __qa.state()");
const key = (k) => app.ev(`return await __qa.key(${JSON.stringify(k)})`);
const open = (rel) => app.ev(`await __qa.openFile(${P(rel)}); await __qa.sleep(120); return 1`);
const snap = () => app.ev("return await __qa.viewer()");
const vcall = (cmd, ...a) => app.ev(`return await __qa.viewer(${JSON.stringify(cmd)}, ...${JSON.stringify(a)})`);
const dom = (js) => app.ev(`return (${js})`);
const kind = () => dom(`document.querySelector('.editor-group.active .viewer-host [data-viewer], .editor-group.active .ed-prev [data-viewer]')?.dataset.viewer ?? null`);
const until = async (fn, ms = 8000, step = 100) => { const t0 = Date.now(); let last; for (;;) { try { last = await fn(); if (last) return last; } catch (e) { last = String(e.message).slice(0, 80); } if (Date.now() - t0 > ms) throw new Error("timeout: " + JSON.stringify(last)); await sleep(step); } };
const untilSnap = (pred, ms) => until(async () => { const s = await snap(); return s && pred(s) ? s : null; }, ms);
const reset = async () => { for (let i = 0; ; i++) { try { return await app.ev(`await __qa.reset(${P("notes.txt")}); return 1`, { timeout: 15000 }); } catch (e) { if (i) throw e; await sleep(500); } } };
async function check(name, fn, { shotName } = {}) {
  let ok = false, note = "";
  try { await reset(); const r = await fn(); ok = r === true || (r && r.ok); note = r && r.note ? r.note : ""; } catch (e) { note = String(e.message || e).split("\n")[0].slice(0, 160); }
  if (shotName !== false) app.shot("assets_" + name.replace(/[^a-z0-9]+/gi, "_").toLowerCase().slice(0, 40));
  rows.push({ name, ok, note });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${note ? "  - " + note : ""}`);
}
const near = (a, b, eps) => Math.abs(a - b) <= eps;
const rgbaEq = (a, b) => a && a.length === 4 && a.every((v, i) => v === b[i]);
const clickBtn = (sel, text) => dom(`(() => { const b = [...document.querySelectorAll(${JSON.stringify(sel)})].find((x) => ${text ? `x.textContent.trim() === ${JSON.stringify(text)}` : "true"}); if (!b) return false; b.click(); return true; })()`);

try {
// ---------------------------------------------------------------- viewer selection by type
const TYPES = [
  ["img/pixel.png", "image"], ["img/photo.jpg", "image"], ["img/vector.svg", "image"], ["docs/readme.md", "markdown"], ["audio/tone.wav", "audio"], ["audio/tone.ogg", "audio"],
  ["audio/tone.aiff", "audio"], ["audio/tone.mp3", "audio"], ["models/box.glb", "model"], ["models/block.bbmodel", "bbmodel"], ["data/table.csv", "csv"], ["data/struct.nbt", "nbt"],
  ["fonts/VT323-Regular.ttf", "font"], ["arc/sample.jar", "archive"], ["video/clip.mp4", "video"], ["img/anim.png.mcmeta", "image"], ["bin/unknown.xyz", "message"], ["bin/native.class", "message"], ["big/huge.log", "message"],
];
for (const [rel, want] of TYPES) await check(`viewer for ${rel} = ${want}`, async () => { await open(rel); const k = await until(kind, 8000); const s = await S(); return { ok: k === want && !s.dirty.length, note: `got ${k}` }; }, { shotName: false });

// ---------------------------------------------------------------- images
await check("png: crisp pixelated rendering + smart zoom for 16x16", async () => {
  await open("img/pixel.png"); const s = await untilSnap((s) => s.natural && s.zoom > 1);
  return { ok: s.rendering === "pixelated" && s.natural.w === 16 && Number.isInteger(s.zoom) && s.shown.w === 16 * s.zoom, note: `zoom=${s.zoom} rendering=${s.rendering} shown=${s.shown.w}` };
});
await check("png: status shows size, format, colour depth, file size", async () => {
  await open("img/pixel.png"); await untilSnap((s) => s.natural);
  const t = await dom(`document.querySelector('.iv-status').innerText`);
  const bytes = fs.statSync(path.join(proj, "img/pixel.png")).size;
  return { ok: /16 × 16 px/.test(t) && /PNG/.test(t) && /32-bit RGBA/.test(t) && t.includes(bytes < 1024 ? `${bytes} B` : (bytes / 1024).toFixed(1) + " KB"), note: t.replace(/\s+/g, " ") };
});
await check("png: colour under cursor (opaque, translucent, corner)", async () => {
  await open("img/pixel.png"); await untilSnap((s) => s.natural);
  const a = await vcall("pick", 0, 0), b = await vcall("pick", 1, 0), c = await vcall("pick", 2, 0), d = await vcall("pick", 15, 15);
  const t = await dom(`document.querySelector('[data-testid=pick]')?.innerText ?? ''`);
  await vcall("pick", 0, 0); const t0 = await dom(`document.querySelector('[data-testid=pick]')?.innerText ?? ''`);
  return { ok: rgbaEq(a, [255, 0, 0, 255]) && rgbaEq(b, [0, 255, 0, 255]) && rgbaEq(c, [0, 0, 255, 128]) && rgbaEq(d, [255, 255, 0, 255]) && /#ff0000/.test(t0) && /rgba\(255, 0, 0, 255\)/.test(t0), note: t0.replace(/\s+/g, " ") };
});
await check("png: zoom keys (meta =, meta -, meta 0 fit, meta / actual size)", async () => {
  await open("img/pixel.png"); const s0 = await untilSnap((s) => s.natural && s.zoom > 1);
  await key("meta EQUALS"); const s1 = await snap(); await key("meta MINUS"); await key("meta MINUS"); const s2 = await snap();
  await key("meta SLASH"); const s3 = await snap(); await key("meta 0"); const s4 = await snap();
  return { ok: s1.zoom > s0.zoom && s2.zoom < s1.zoom && s3.zoom === 1 && s4.mode === "fit" && s4.zoom > 1, note: `${s0.zoom} -> in ${s1.zoom} -> out2 ${s2.zoom} -> actual ${s3.zoom} -> fit ${s4.zoom}` };
});
await check("png: wheel/pinch zoom keeps the point under the cursor fixed", async () => {
  await open("img/big.png"); await untilSnap((s) => s.natural && s.mode);
  await vcall("actualSize"); await sleep(150);
  const r = await dom(`(() => { const i = document.querySelector('.iv-stage img'); const r = i.getBoundingClientRect(); const sc = document.querySelector('.iv-scroll').getBoundingClientRect(); return { cx: sc.left + 200, cy: sc.top + 150, l: r.left, t: r.top, z: ${1} }; })()`);
  const before = await dom(`(() => { const i = document.querySelector('.iv-stage img'); const r = i.getBoundingClientRect(); return { px: (${r.cx} - r.left), py: (${r.cy} - r.top) }; })()`);
  await vcall("wheel", -100, r.cx, r.cy); await sleep(250);
  const s = await snap();
  const after = await dom(`(() => { const i = document.querySelector('.iv-stage img'); const r = i.getBoundingClientRect(); return { px: (${r.cx} - r.left), py: (${r.cy} - r.top) }; })()`);
  const ix = before.px / 1, iy = before.py / 1;
  return { ok: s.zoom > 1.5 && near(after.px / s.zoom, ix, 1.5) && near(after.py / s.zoom, iy, 1.5), note: `zoom=${s.zoom.toFixed(2)} imgpx before (${ix.toFixed(1)},${iy.toFixed(1)}) after (${(after.px / s.zoom).toFixed(1)},${(after.py / s.zoom).toFixed(1)})` };
});
await check("png: background toggle + pixel grid at high zoom", async () => {
  await open("img/pixel.png"); await untilSnap((s) => s.natural);
  await clickBtn(".iv-bar button.sw", null); await clickBtn(".iv-bar button.sw.dark");
  const dark = await dom(`document.querySelector('.iv-scroll').className`);
  await key("meta QUOTE"); await sleep(150); const s = await snap();
  const grid = await dom(`!!document.querySelector('.iv-grid')`);
  await clickBtn(".iv-bar button.sw.checker"); const ch = await dom(`document.querySelector('.iv-scroll').className`);
  return { ok: /iv-dark/.test(dark) && s.grid && grid && /iv-checker/.test(ch), note: `${dark} grid=${s.grid}/${grid}` };
});
await check("png: fit to window for a large image", async () => {
  await open("img/big.png"); const s = await untilSnap((s) => s.natural && s.natural.w === 1600);
  const f = await dom(`(() => { const i = document.querySelector('.iv-stage img'); const sc = document.querySelector('.iv-scroll'); return { w: i.clientWidth, h: i.clientHeight, cw: sc.clientWidth, ch: sc.clientHeight }; })()`);
  return { ok: s.zoom < 1 && f.w <= f.cw && f.h <= f.ch && s.rendering === "auto", note: `zoom=${s.zoom.toFixed(3)} rendering=${s.rendering} ${f.w}x${f.h} in ${f.cw}x${f.ch}` };
});
await check("jpg: decodes with format info", async () => {
  await open("img/photo.jpg"); const s = await untilSnap((s) => s.natural);
  return { ok: s.natural.w === 1600 && /JPEG/.test(s.format.format), note: `${s.natural.w}x${s.natural.h} ${JSON.stringify(s.format)}` };
});
await check("svg: renders as image, toggles to text and back", async () => {
  await open("img/vector.svg"); const s = await untilSnap((s) => s.natural && s.natural.w === 64);
  const modeBtns = await dom(`[...document.querySelectorAll('.dual-bar button')].map(b => b.textContent)`);
  await clickBtn(".dual-bar button", "Editor"); await sleep(250);
  const text = await dom(`!!document.querySelector('.editor-group.active .ed-code:not(.hidden) .monaco-editor') && !document.querySelector('.ed-prev')`);
  const lang = await app.ev(`return __qa.editor()?.getModel()?.getLanguageId()`);
  await clickBtn(".dual-bar button", "Image"); await sleep(250);
  const back = await kind();
  return { ok: s.natural.h === 48 && text && back === "image" && lang === "xml" && modeBtns.length === 3, note: `buttons=${modeBtns} lang=${lang}` };
});
await check("tga: decoded to a visible image (unit-tested decoder)", async () => {
  const h = Buffer.alloc(18); h[2] = 2; h[12] = 2; h[14] = 1; h[16] = 24; h[17] = 0x20;
  fs.writeFileSync(path.join(proj, "img/two.tga"), Buffer.concat([h, Buffer.from([0, 0, 255, 255, 0, 0])]));
  await open("img/two.tga"); const s = await untilSnap((s) => s.natural);
  const a = await vcall("pick", 0, 0), b = await vcall("pick", 1, 0);
  return { ok: s.natural.w === 2 && rgbaEq(a, [255, 0, 0, 255]) && rgbaEq(b, [0, 0, 255, 255]), note: JSON.stringify([a, b]) };
});

// ---------------------------------------------------------------- mcmeta animation
await check("anim.png: Animated toggle, frames advance, pause stops, playback honours frames", async () => {
  await open("img/anim.png"); const s = await untilSnap((s) => s.natural && s.animated);
  const seen = new Set();
  for (let i = 0; i < 12; i++) { const x = await snap(); seen.add(x.frame); await sleep(40); }
  await vcall("playPause"); await sleep(150); const f1 = (await snap()).frame; await sleep(300); const f2 = (await snap()).frame; const playing = (await snap()).playing;
  const px = await vcall("pick", 3, 3);
  return { ok: s.frames === 3 && s.dims.h === 16 && seen.size >= 2 && f1 === f2 && playing === false && px && px[3] === 255, note: `frames=${s.frames} seen=${[...seen]} paused@${f1}/${f2} px=${px}` };
});
await check("anim.png: toggling Animated off shows the full sheet", async () => {
  await open("img/anim.png"); await untilSnap((s) => s.animated);
  await clickBtn(".iv-bar button", "Animated"); await sleep(250); const s = await snap();
  return { ok: !s.animated && s.dims.h === 48, note: `animated=${s.animated} dims=${JSON.stringify(s.dims)}` };
});
await check("anim.png.mcmeta: Editor and Animation split with live playback", async () => {
  await open("img/anim.png.mcmeta"); const s = await untilSnap((s) => s.animated && s.frames === 3);
  const both = await dom(`!!document.querySelector('.ed-code:not(.hidden) .monaco-editor') && !!document.querySelector('.ed-prev [data-viewer=image]')`);
  const lang = await app.ev(`return __qa.editor()?.getModel()?.getLanguageId()`);
  return { ok: both && lang === "json", note: `lang=${lang} frames=${s.frames}` };
});
await check("tex.png + .import sidecar: Godot import summary", async () => {
  await open("img/tex.png"); const s = await untilSnap((s) => s.imported);
  return { ok: s.imported.importer === "texture" && s.imported["compress/mode"] === "0" && s.imported["process/fix_alpha_border"] === "true", note: JSON.stringify(s.imported) };
});

// ---------------------------------------------------------------- markdown
await check("md: default Editor and Preview; table, task list, code highlight, relative image, sanitized", async () => {
  await open("docs/readme.md"); const s = await untilSnap((s) => s.kind === "markdown" && s.tables === 1 && s.images.length && s.images[0].ok && s.colorized >= 1, 10000);
  const both = await dom(`!!document.querySelector('.ed-code:not(.hidden) .monaco-editor') && !!document.querySelector('.ed-prev .md-preview')`);
  const pwn = await dom(`window.__pwned ?? null`);
  return { ok: both && s.tasks === 2 && s.scripts === 0 && pwn === null && s.images[0].resolved.endsWith("docs/img/pic.png"), note: `tables=${s.tables} tasks=${s.tasks} colorized=${s.colorized} img=${JSON.stringify(s.images)} scripts=${s.scripts} pwned=${pwn}` };
});
await check("md: mode switch Editor / Editor and Preview / Preview", async () => {
  await open("docs/readme.md"); await untilSnap((s) => s.kind === "markdown");
  await clickBtn(".dual-bar button", "Editor"); await sleep(250);
  const a = await dom(`({ editor: !!document.querySelector('.ed-code:not(.hidden) .monaco-editor'), prev: !!document.querySelector('.ed-prev') })`);
  await clickBtn(".dual-bar button", "Preview"); await sleep(400);
  const b = await dom(`({ editor: !!document.querySelector('.ed-code:not(.hidden)'), prev: !!document.querySelector('.ed-prev .md-preview'), w: document.querySelector('.ed-prev')?.clientWidth, full: document.querySelector('.ed-split')?.clientWidth })`);
  await clickBtn(".dual-bar button", "Editor and Preview"); await sleep(300);
  const c = await dom(`({ editor: !!document.querySelector('.ed-code:not(.hidden)'), prev: !!document.querySelector('.ed-prev') })`);
  return { ok: a.editor && !a.prev && !b.editor && b.prev && b.w >= b.full - 4 && c.editor && c.prev, note: JSON.stringify({ a, b, c }) };
});
await check("md: synced scroll editor -> preview and preview -> editor", async () => {
  await open("docs/readme.md"); const s0 = await untilSnap((s) => s.kind === "markdown" && s.blocks > 50 && s.sync);
  const maxE = s0.editorScrollHeight, maxP = s0.previewScrollHeight;
  await vcall("scrollEditor", Math.round(maxE * 0.5)); await sleep(500);
  const s1 = await snap();
  await sleep(300);
  await vcall("scrollPreview", Math.round(maxP * 0.2)); await sleep(500);
  const s2 = await snap();
  return { ok: s1.previewScrollTop > maxP * 0.15 && s2.editorScrollTop < s1.editorScrollTop * 0.8 && s2.editorScrollTop > 0, note: `editor 50% -> preview ${s1.previewScrollTop}/${maxP}; preview 20% -> editor ${s2.editorScrollTop}/${maxE}` };
});
await check("md: relative .md link opens in Ace; http link goes to opener; anchor scrolls", async () => {
  await open("docs/readme.md"); await untilSnap((s) => s.kind === "markdown" && s.tables === 1);
  await dom(`(window.__qaExternal = [], 1)`);
  await dom(`document.querySelector('.md-preview a[href="https://example.com/x"]').click()`);
  await sleep(300);
  const calls = await dom(`window.__qaExternal`);
  await dom(`document.querySelector('.md-preview a[href="#section-3"]').click()`); await sleep(300);
  const sc = await dom(`document.querySelector('.md-preview').scrollTop`);
  await dom(`document.querySelector('.md-preview a[href="other.md"]').click()`); await sleep(600);
  const st = await S();
  await dom(`(delete window.__qaExternal, 1)`);
  return { ok: calls.length >= 1 && JSON.stringify(calls).includes("example.com") && sc > 50 && st.tabs.some((g) => g.tabs.some((t) => t.name === "other.md")), note: `opener=${JSON.stringify(calls).slice(0, 90)} anchorScroll=${sc} tabs=${st.tabs.flatMap((g) => g.tabs.map((t) => t.name))}` };
});

// ---------------------------------------------------------------- audio
const AUDIO = [["audio/tone.wav", "wav"], ["audio/tone.ogg", "ogg"], ["audio/tone.aiff", "aiff"], ["audio/tone.mp3", "mp3"], ["audio/ui_click.ogg", "real ogg"]];
for (const [rel, label] of AUDIO) await check(`audio ${label}: decodes, correct duration/rate/channels, waveform drawn`, async () => {
  if (!fs.existsSync(path.join(proj, rel))) return { ok: true, note: "fixture missing (skipped)" };
  await open(rel); const s = await untilSnap((s) => s.kind === "audio" && s.waveformPixels > 0, 12000);
  const pr = ffprobe(rel), st = pr.streams[0];
  const dur = parseFloat(pr.format.duration);
  return { ok: near(s.duration, dur, 0.06) && s.sampleRate === +st.sample_rate && s.channels === st.channels && s.waveformPixels > 50, note: `${s.decoder}: ${s.duration.toFixed(3)}s/${dur.toFixed(3)} ${s.sampleRate}Hz/${st.sample_rate} ${s.channels}ch/${st.channels} waveform=${s.waveformPixels}` };
});
for (const [rel, label] of [["audio/tone.ogg", "ogg"], ["audio/tone.aiff", "aiff"], ["audio/tone.mp3", "mp3"], ["audio/tone.wav", "wav"], ["audio/ui_click.ogg", "real ogg"]]) await check(`audio ${label} via the Rust (symphonia) fallback: same duration/rate/channels`, async () => {
  await dom(`(window.__aceAudioForceRust = true, 1)`);
  try {
    await open(rel); const s = await untilSnap((s) => s.kind === "audio" && s.waveformPixels > 0, 15000);
    const pr = ffprobe(rel), st = pr.streams[0], dur = parseFloat(pr.format.duration);
    return { ok: /rust/.test(s.decoder) && near(s.duration, dur, 0.06) && s.sampleRate === +st.sample_rate && s.channels === st.channels && s.waveformPixels > 50, note: `${s.decoder}: ${s.duration.toFixed(3)}s/${dur.toFixed(3)} ${s.sampleRate}Hz/${st.sample_rate} ${s.channels}ch/${st.channels}` };
  } finally { await dom(`(delete window.__aceAudioForceRust, 1)`); }
});
await check("audio: play/pause (Space), scrub, loop", async () => {
  await open("audio/tone.wav"); await untilSnap((s) => s.kind === "audio" && s.waveformPixels > 0, 12000);
  await key("space"); await sleep(500); const a = await snap();
  await key("space"); await sleep(150); const b = await snap(); await sleep(250); const c = await snap();
  await vcall("seek", 1.0); const d = await snap();
  await vcall("setLoop", true); await vcall("playPause"); await sleep(1800); const e = await snap(); await vcall("playPause");
  return { ok: a.playing && a.position > 0.2 && !b.playing && near(b.position, c.position, 0.001) && near(d.position, 1.0, 0.01) && e.playing && e.loop, note: `play@${a.position.toFixed(2)} paused@${b.position.toFixed(2)}=${c.position.toFixed(2)} seek=${d.position.toFixed(2)} loop playing=${e.playing} pos=${e.position.toFixed(2)}` };
});

// ---------------------------------------------------------------- 3D
await check("glb: loads, mesh/triangle/texture/animation stats, orbit camera, wireframe", async () => {
  await open("models/box.glb"); const s = await untilSnap((s) => s.kind === "model" && s.meshes >= 1, 15000);
  await vcall("playPause").catch(() => {});
  const cam0 = s.camera;
  await clickBtn(".mv .iv-bar button", "Wireframe"); await sleep(200); const w = await snap();
  await dom(`(() => { const sel = document.querySelector('.mv select'); sel.value = '0'; sel.dispatchEvent(new Event('change', { bubbles: true })); return 1; })()`).catch(() => {});
  await sleep(500); const an = await snap();
  return { ok: s.meshes === 1 && s.triangles === 12 && s.textures === 1 && s.animations.length === 1 && s.animations[0] === "Spin" && s.canvas && w.wire && an.anim === 0, note: `meshes=${s.meshes} tris=${s.triangles} tex=${s.textures} anims=${s.animations} wire=${w.wire} anim=${an.anim}/${an.playing}` };
});
await check("bbmodel: cubes + embedded texture rendered; toggles to JSON text", async () => {
  await open("models/block.bbmodel"); const s = await untilSnap((s) => s.kind === "bbmodel" && s.cubes, 15000);
  await clickBtn(".dual-bar button", "Editor"); await sleep(300);
  const lang = await app.ev(`return __qa.editor()?.getModel()?.getLanguageId()`);
  return { ok: s.cubes === 2 && s.faces === 12 && s.texturesLoaded === 1 && s.canvas && lang === "json", note: `cubes=${s.cubes} faces=${s.faces} tex=${s.texturesLoaded}/${s.textures} lang=${lang}` };
});

// ---------------------------------------------------------------- data
await check("csv: table, sort numeric asc/desc, toggle to text", async () => {
  await open("data/table.csv"); const s = await untilSnap((s) => s.kind === "csv" && s.rows === 200);
  await vcall("sort", 2, 1); const a = await snap(); await vcall("sort", 2, -1); const b = await snap(); await vcall("sort", 1, 1); const c = await snap();
  const domRows = await dom(`document.querySelectorAll('.csv-row').length`);
  await clickBtn(".dual-bar button", "Editor"); await sleep(300);
  const lang = await app.ev(`return __qa.editor()?.getModel()?.getValue().split('\\n')[0]`);
  return { ok: s.cols === 3 && s.head.join() === "id,name,score" && +a.first[0][2] <= +a.first[1][2] && +b.first[0][2] >= +b.first[1][2] && +b.first[0][2] === 100 && domRows < 80 && lang === "id,name,score", note: `asc ${a.first.map((r) => r[2])} desc ${b.first.map((r) => r[2])} by name ${c.first[0][1]} domRows=${domRows}` };
});
await check("nbt: gzip tree, root + children + values", async () => {
  await open("data/struct.nbt"); const s = await untilSnap((s) => s.kind === "nbt" && s.rootChildren);
  await vcall("expandAll"); await sleep(250);
  const text = await dom(`document.querySelector('.nbt-list').innerText`);
  return { ok: s.compressed && s.endian === "big" && s.rootChildren.join() === "DataVersion,size,author,blocks" && /3465/.test(text) && /Alex/.test(text), note: `root=${s.rootChildren} compressed=${s.compressed}` };
});
await check("font: specimen loads the face", async () => {
  await open("fonts/VT323-Regular.ttf"); const s = await untilSnap((s) => s.kind === "font" && s.loaded, 8000);
  return { ok: s.loaded, note: s.family };
});
await check("jar: lists entries, previews text + image entries", async () => {
  await open("arc/sample.jar"); const s = await untilSnap((s) => s.kind === "archive" && s.entries > 0);
  await vcall("openDir", "assets/"); await vcall("openDir", "assets/mod/"); await sleep(200);
  await vcall("select", "assets/mod/lang.json"); const t = await untilSnap((x) => x.preview === "text");
  await vcall("select", "assets/mod/pixel.png"); const i = await untilSnap((x) => x.preview === "image");
  return { ok: s.files === 3 && /hello/.test(t.previewText) && i.preview === "image", note: `entries=${s.entries} files=${s.files} text=${t.previewText}` };
});
await check("mp4: <video> loads metadata", async () => {
  await open("video/clip.mp4"); const s = await untilSnap((s) => s.kind === "video" && s.duration > 0, 10000);
  return { ok: near(s.duration, 1, 0.2) && s.w === 64 && !s.error, note: JSON.stringify(s) };
});
await check("binary placeholder: size + hex preview, no Monaco model, never text", async () => {
  await open("bin/unknown.xyz"); await until(kind);
  const txt = await dom(`document.querySelector('.vw-msg').innerText`);
  const models = await app.ev("return await __qa.models()");
  return { ok: /not supported/i.test(txt) && /7f 45 4c 46/.test(txt) && !models.includes("unknown.xyz"), note: txt.split("\n").slice(0, 2).join(" | ") };
});
await check("large file guard: placeholder, no freeze, Open Anyway loads text", async () => {
  const t0 = Date.now(); await open("big/huge.log"); await until(kind); const dt = Date.now() - t0;
  const txt = await dom(`document.querySelector('.vw-msg').innerText`);
  const models = await app.ev("return await __qa.models()");
  await clickBtn(".vw-actions button", "Open Anyway");
  await until(async () => (await app.ev("return await __qa.models()")).includes("huge.log"), 20000);
  const lines = await app.ev("return __qa.editor()?.getModel()?.getLineCount()");
  return { ok: /too large/i.test(txt) && !models.includes("huge.log") && dt < 3000 && lines > 100000, note: `guard in ${dt}ms, after Open Anyway lines=${lines}` };
});

// ---------------------------------------------------------------- syntax
for (const [rel, lang] of [["shaders/test.fsh", "glsl"], ["shaders/fx.gdshader", "glsl"], ["shaders/common.gdshaderinc", "glsl"], ["data/plain.snbt", "snbt"], ["pack.mcmeta", "json"], ["scene.tscn", "ini"], ["img/tex.png.import", "ini"]])
  await check(`syntax: ${rel} -> ${lang} with tokens`, async () => {
    await open(rel); await sleep(300); const r = { lang: await app.ev("return __qa.editor()?.getModel()?.getLanguageId()") };
    const colored = await dom(`document.querySelectorAll('.editor-group.active .view-line span[class*=mtk]').length`);
    return { ok: r.lang === lang, note: `lang=${r.lang} spans=${colored}` };
  }, { shotName: false });

// ---------------------------------------------------------------- integration: splits, close, recent, history, reload
await check("viewers in splits: split right, both groups show the image; meta W closes one", async () => {
  await open("img/pixel.png"); await untilSnap((s) => s.natural);
  await app.ev(`__qa.runAction('SplitVertically'); await __qa.sleep(600); return 1`);
  const n = await dom(`document.querySelectorAll('.editor-group .iv').length`);
  const before = (await S()).tabs.length;
  await key("meta W"); await sleep(500);
  const after = await S();
  return { ok: n === 2 && before === 2 && after.tabs.length === 1, note: `viewers=${n} groups ${before} -> ${after.tabs.length}` };
});
await check("Recent Files + back/forward include viewer tabs", async () => {
  await open("img/pixel.png"); await open("docs/readme.md"); await open("audio/tone.wav"); await sleep(300);
  await key("meta E"); await sleep(400); const pop = await dom(`document.querySelector('.popup')?.innerText ?? ''`); await key("Escape");
  await key("meta OPEN_BRACKET"); await sleep(400); const back = await S();
  return { ok: /pixel\.png/.test(pop) && /readme\.md/.test(pop) && /tone\.wav/.test(pop), note: `recent=${pop.replace(/\s+/g, " ").slice(0, 80)} after back active=${back.tabs[0].active}` };
});
await check("external change reloads the image (fs watcher)", async () => {
  await open("img/pixel.png"); await untilSnap((s) => s.natural);
  const before = await vcall("pick", 0, 0);
  fs.writeFileSync(path.join(proj, "img/pixel.png"), png(16, 16, (x, y) => (x === 0 && y === 0 ? [1, 2, 3, 255] : PIXEL(x, y))));
  const after = await until(async () => { const p = await vcall("pick", 0, 0); return rgbaEq(p, [1, 2, 3, 255]) ? p : null; }, 8000, 200);
  return { ok: rgbaEq(before, [255, 0, 0, 255]) && rgbaEq(after, [1, 2, 3, 255]), note: `${before} -> ${after}` };
});
await check("external change reloads markdown + csv text", async () => {
  await open("docs/other.md"); await untilSnap((s) => s.kind === "markdown");
  fs.writeFileSync(path.join(proj, "docs/other.md"), "# Changed heading\n");
  const ok = await until(async () => (await dom(`document.querySelector('.md-body h1')?.textContent`)) === "Changed heading", 8000, 200);
  return { ok: !!ok };
});

// ---------------------------------------------------------------- remote
if (!process.argv.includes("--no-remote")) {
  let mcOk = false;
  try { execFileSync("ssh", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=8", "mc", "true"], { stdio: "ignore" }); mcOk = true; } catch {}
  if (!mcOk) console.log("mc unreachable: remote checks skipped");
  else {
    const rdir = `/tmp/ace-assets-qa-${process.pid}`;
    try {
      execFileSync("ssh", ["mc", `mkdir -p ${rdir}/docs/img`]);
      execFileSync("scp", ["-q", path.join(proj, "img/pixel.png"), path.join(proj, "audio/tone.ogg"), `mc:${rdir}/`]);
      execFileSync("scp", ["-q", path.join(proj, "docs/readme.md"), path.join(proj, "docs/other.md"), `mc:${rdir}/docs/`]);
      execFileSync("scp", ["-q", path.join(proj, "docs/img/pic.png"), `mc:${rdir}/docs/img/`]);
      const openR = (p) => app.ev(`await __qa.openFile(${JSON.stringify(rdir + "/" + p)}, "mc"); await __qa.sleep(200); return 1`);
      await check("remote (mc): png opens in the image viewer with correct pixels", async () => { await openR("docs/img/pic.png"); const s = await untilSnap((s) => s.natural, 15000); const c = await vcall("pick", 0, 0); return { ok: s.natural.w === 16 && rgbaEq(c, [255, 0, 0, 255]) && s.rendering === "pixelated", note: `zoom=${s.zoom} nat=${JSON.stringify(s.natural)} px=${c} rendering=${s.rendering}` }; });
      await check("remote (mc): md renders with table + relative image over ssh", async () => { await openR("docs/readme.md"); const s = await untilSnap((s) => s.kind === "markdown" && s.tables === 1 && s.images.length && s.images[0].ok, 20000); return { ok: true, note: JSON.stringify(s.images) }; });
      await check("remote (mc): ogg decodes (ssh bytes -> decode)", async () => { await openR("tone.ogg"); const s = await untilSnap((s) => s.kind === "audio" && s.waveformPixels > 0, 20000); return { ok: near(s.duration, 2, 0.06) && s.sampleRate === 44100, note: `${s.decoder} ${s.duration}s` }; });
    } finally { try { execFileSync("ssh", ["mc", `rm -rf ${rdir}`]); } catch {} }
  }
}

// ---------------------------------------------------------------- real repos (read-only) + screenshots
if (!process.argv.includes("--no-real")) {
  const T = path.join(home, "IdeaProjects/Thematic-Collections"), K = path.join(home, "thematic-kyf");
  const REAL = [
    ["real_tc_glb", T + "/src/common/resources/assets/thematic/gltf/atom.glb", "model"],
    ["real_tc_bbmodel", T + "/guns/fixed minigun.bbmodel", "bbmodel"],
    ["real_tc_csv", T + "/run/thematic_armors_dump.csv", "csv"],
    ["real_tc_nbt", T + "/run/config/thematic-poses.nbt", "nbt"],
    ["real_tc_md", T + "/README.md", "markdown"],
    ["real_tc_ogg", T + "/cleaned_sounds/friday_the_13th/Axe_ImpactBodyHard02_mono.ogg", "audio"],
    ["real_tc_wav", T + "/cleaned_sounds/marvel_invasion/SFX_Phoenix_Block_01.wav", "audio"],
    ["real_tc_png", T + "/docs/windows_settings.png", "image"],
    ["real_tc_fsh", T + "/src/common/resources/assets/minecraft/shaders/core/thematic_bubble.fsh", null],
    ["real_kyf_glb", K + "/assets/characters/yvette/top.glb", "model"],
    ["real_kyf_gltf", K + "/assets/models/characters/ubc/Superhero_Female_FullBody.gltf", "model"],
    ["real_kyf_png", K + "/icon.png", "image"],
    ["real_kyf_import", K + "/icon.png.import", null],
    ["real_kyf_gdshader", K + "/scripts/fx/shaders/vhs.gdshader", null],
    ["real_kyf_tres", K + "/items/glitter.tres", null],
    ["real_kyf_md", K + "/ARCHITECTURE.md", "markdown"],
    ["real_kyf_ttf", K + "/assets/fonts/VT323-Regular.ttf", "font"],
    ["real_kyf_aiff", K + "/tools/audio/_cache/say_c4d896e5ba7e0751.aiff", "audio"],
  ];
  // find a Minecraft animated texture + a mod jar if present
  try { const m = execSync(`find ${T}/src ${T}/run -name "*.png.mcmeta" 2>/dev/null | head -1`, { encoding: "utf8" }).trim(); if (m) REAL.push(["real_tc_mcmeta", m, "image"], ["real_tc_anim_png", m.replace(/\.mcmeta$/, ""), "image"]); } catch {}
  for (const [name, file, want] of REAL) {
    if (!fs.existsSync(file)) { console.log(`skip ${name}: ${file} not found`); continue; }
    await check(`real: ${name} (${path.basename(file)})`, async () => {
      await app.ev(`await __qa.openFile(${JSON.stringify(file)}); await __qa.sleep(1500); return 1`);
      if (want) await until(async () => (await kind()) === want, 20000);
      else await sleep(800);
      await sleep(1200);
      const s = await S();
      const f = app.shot(name);
      return { ok: s.dirty.length === 0 && (!want || (await kind()) === want), note: `${(await kind()) ?? "text"} shot=${path.basename(String(f))}` };
    }, { shotName: false });
  }
}
} catch (e) { console.error("assets suite aborted:", e.message); }

const gitAfter = gitState();
rows.push({ name: "real repos untouched (git status identical before/after)", ok: JSON.stringify(gitBefore) === JSON.stringify(gitAfter), note: "" });
console.log(`${rows.at(-1).ok ? "PASS" : "FAIL"}  ${rows.at(-1).name}`);
console.log("\n| # | Check | Result | Note |\n|---|---|---|---|");
rows.forEach((r, i) => console.log(`| ${i + 1} | ${r.name} | ${r.ok ? "PASS" : "FAIL"} | ${r.note} |`));
const failed = rows.filter((r) => !r.ok).length;
console.log(`\n${rows.length - failed}/${rows.length} passed; screenshots in scripts/qa/out/`);
await app.stop();
try { execSync(`pkill -f -- ${JSON.stringify("--path " + proj)} || true`); } catch {}
if (!process.argv.includes("--keep")) fs.rmSync(scratch, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
