#!/usr/bin/env node
// File tree QA: multi-select, Cut/Copy/Paste/Duplicate (Finder-style names), Finder pasteboard interop, context menu, drag-and-drop, Trash.
// Works ONLY in a scratch dir under the session scratchpad, driven through the automation harness (synthetic events, no OS input).
// The file pasteboard is a private NSPasteboard under ACE_AUTOMATION, so the real clipboard is never touched.
// Usage: ACE_BIN=src-tauri/target-qa/release/ace node scripts/qa/filetree.mjs
import fs from "node:fs";
import path from "node:path";
import { launch, sleep } from "./lib.mjs";

const base = process.env.QA_SCRATCH || "/private/tmp/claude-501/-Users-alexw/35ea4777-b70f-4143-9644-0b77d2838b7c/scratchpad/filetree-qa";
fs.rmSync(base, { recursive: true, force: true });
const proj = path.join(base, "proj");
const w = (rel, c = rel) => { const f = path.join(proj, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, c); };
for (const f of ["a.txt", "b.txt", "c.md", "d.kt", "docs/readme.md", "docs/deep/x.txt", "dest/.keep", "trashme.txt", "other/o.txt"]) w(f);
const ext = path.join(base, "outside"); fs.mkdirSync(ext, { recursive: true }); fs.writeFileSync(path.join(ext, "finder.txt"), "from finder");
const ls = (rel = "") => fs.readdirSync(path.join(proj, rel)).sort();
const has = (rel) => fs.existsSync(path.join(proj, rel));

const app = await launch(proj);
const rows = [];
const key = (k) => app.ev(`return await __qa.key(${JSON.stringify(k)})`);
const focusTree = () => app.ev(`await __qa.reset(); document.activeElement?.blur?.(); await __qa.sleep(50); document.querySelector('.tree[data-autofocus]').focus(); await __qa.sleep(150); return 1`);
const names = () => app.ev(`return [...document.querySelectorAll('.tree-row')].map((r) => r.querySelector('.tree-name').textContent)`);
const selected = () => app.ev(`return [...document.querySelectorAll('.tree-row.selected .tree-name')].map((n) => n.textContent)`);
const click = (name, mods = {}) => app.ev(`const r = [...document.querySelectorAll('.tree-row')].find((r) => (${JSON.stringify(name)}.includes('/') ? r.dataset.path.endsWith('/' + ${JSON.stringify(name)}) : r.querySelector('.tree-name').textContent === ${JSON.stringify(name)})); if (!r) throw new Error('no row ' + ${JSON.stringify(name)}); r.dispatchEvent(new MouseEvent('click', { bubbles: true, ...${JSON.stringify(mods)} })); await __qa.sleep(120); return 1`);
// expand a directory row (click toggles, so only click when its child rows are not showing)
const expand = (name) => app.ev(`const rs = [...document.querySelectorAll('.tree-row')]; const i = rs.findIndex((r) => ${JSON.stringify(name)}.includes('/') ? r.dataset.path.endsWith('/' + ${JSON.stringify(name)}) : r.querySelector('.tree-name').textContent === ${JSON.stringify(name)}); const pad = (r) => parseInt(r.style.paddingLeft); if (!(rs[i + 1] && pad(rs[i + 1]) > pad(rs[i]))) { rs[i].dispatchEvent(new MouseEvent('click', { bubbles: true })); await __qa.sleep(300); } return 1`);
const menuLabels = () => app.ev(`return [...document.querySelectorAll('.menu .menu-item, .menu .menu-sep')].map((n) => n.classList.contains('menu-sep') ? '-' : n.querySelector('span').textContent + (n.querySelector('.menu-shortcut') ? ' ' + n.querySelector('.menu-shortcut').textContent : '') + (n.classList.contains('disabled') ? ' (disabled)' : ''))`);
const rightClick = (name) => app.ev(`const r = [...document.querySelectorAll('.tree-row')].find((r) => r.querySelector('.tree-name').textContent === ${JSON.stringify(name)}); r.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 200, clientY: 100 })); await __qa.sleep(100); return 1`);
const dialogText = () => app.ev(`return document.querySelector('.dialog')?.innerText ?? null`);
const settle = () => sleep(600);
async function check(name, fn) {
  let ok = false, note = "";
  try { await focusTree(); const r = await fn(); ok = r === true || (r && r.ok); note = r && r.note ? r.note : ""; } catch (e) { note = String(e.message || e).split("\n")[0].slice(0, 200); }
  rows.push({ name, ok, note });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${note ? "  - " + note : ""}`);
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

try {
await sleep(800);
await check("meta-click toggles, shift-click selects a range, shift-down extends", async () => {
  await click("a.txt"); await click("c.md", { metaKey: true }); const a = await selected();
  await click("c.md", { metaKey: true }); const b = await selected();
  await click("a.txt"); await click("c.md", { shiftKey: true }); const c = await selected();
  await click("a.txt"); await key("shift DOWN"); await key("shift DOWN"); const d = await selected();
  await key("shift UP"); const e = await selected();
  return { ok: eq(a, ["a.txt", "c.md"]) && eq(b, ["a.txt"]) && eq(c, ["a.txt", "b.txt", "c.md"]) && eq(d, ["a.txt", "b.txt", "c.md"]) && eq(e, ["a.txt", "b.txt"]), note: JSON.stringify({ a, b, c, d, e }) };
});
await check("meta+A selects all rows below the root", async () => {
  await click("a.txt"); await key("meta A"); const s = await selected(); const all = await names();
  return { ok: s.length === all.length - 1 && !s.includes(all[0]), note: `${s.length}/${all.length}` };
});
await check("context menu: IntelliJ order, labels and shortcuts", async () => {
  await click("a.txt"); await rightClick("a.txt"); const m = await menuLabels(); await key("ESCAPE");
  const want = ["New File…", "New Directory…", "-", "Cut ⌘X", "Copy ⌘C", "Paste ⌘V", "Duplicate ⌘D", "-", "Copy Absolute Path ⇧⌘C", "Copy Path From Project Root ⌥⇧⌘C", "Copy File Name", "-", "Rename… ⇧F6", "Move to Trash… ⌫", "-", "Reveal in Finder ⌥⇧R", "Open in Terminal", "Open With Default App", "-", "Refresh"];
  return { ok: eq(m, want), note: eq(m, want) ? "" : JSON.stringify(m) };
});
await check("right-click inside a multi-selection keeps it", async () => {
  await click("a.txt"); await click("b.txt", { metaKey: true }); await rightClick("b.txt"); await key("ESCAPE"); const s = await selected();
  return { ok: eq(s, ["a.txt", "b.txt"]), note: JSON.stringify(s) };
});
await check("copy file + paste into a selected dir; selection moves to the pasted file", async () => {
  await click("a.txt"); await key("meta C"); await click("dest"); await key("meta V"); await settle();
  const s = await selected();
  return { ok: has("dest/a.txt") && has("a.txt") && eq(s, ["a.txt"]) && ls("dest").includes("a.txt"), note: `dest=${ls("dest")} sel=${s}` };
});
await check("paste again: never overwrites ('a copy.txt'), then 'a copy 2.txt'", async () => {
  await click("dest"); await key("meta V"); await settle(); await click("dest"); await key("meta V"); await settle();
  return { ok: eq(ls("dest"), [".keep", "a copy 2.txt", "a copy.txt", "a.txt"].sort()), note: String(ls("dest")) };
});
await check("paste with a FILE selected lands in its parent dir", async () => {
  await expand("docs"); await click("b.txt"); await key("meta C"); await click("readme.md"); await key("meta V"); await settle();
  return { ok: has("docs/b.txt"), note: String(ls("docs")) };
});
await check("multi-select copy/paste (two files + a folder, recursive)", async () => {
  await expand("docs"); await expand("docs/deep"); await click("c.md"); await click("docs/deep", { metaKey: true }); await key("meta C"); await click("dest"); await key("meta V"); await settle();
  const s = await selected();
  return { ok: has("dest/c.md") && has("dest/deep/x.txt") && s.length === 2, note: `${ls("dest")} sel=${s}` };
});
await check("duplicate file => 'name copy.ext', again => 'copy 2'", async () => {
  await click("d.kt"); await key("meta D"); await settle(); await click("d.kt"); await key("meta D"); await settle();
  return { ok: has("d copy.kt") && has("d copy 2.kt") && fs.readFileSync(path.join(proj, "d copy.kt"), "utf8") === "d.kt", note: String(ls()) };
});
await check("duplicate folder copies recursively ('docs copy')", async () => {
  await click("docs"); await key("meta D"); await settle();
  return { ok: has("docs copy/readme.md") && has("docs copy/deep/x.txt") && has("docs/readme.md"), note: String(ls()) };
});
await check("cut + paste moves (source removed) and clears the clipboard", async () => {
  await expand("other"); await click("o.txt"); await key("meta X"); await click("dest"); await key("meta V"); await settle();
  const moved = has("dest/o.txt") && !has("other/o.txt");
  await click("dest"); await key("meta V"); await settle();
  return { ok: moved && !has("dest/o copy.txt"), note: String(ls("dest")) };
});
await check("pasting a folder into itself / a descendant shows an error and changes nothing", async () => {
  const before = JSON.stringify(ls()) + JSON.stringify(ls("docs"));
  await expand("docs"); await expand("docs/deep"); await click("docs"); await key("meta C"); await expand("docs"); await click("docs/deep"); await key("meta V"); await sleep(500);
  const d = await dialogText(); await key("ESCAPE"); await sleep(150);
  return { ok: /itself|subfolder/i.test(d ?? "") && before === JSON.stringify(ls()) + JSON.stringify(ls("docs")), note: String(d).slice(0, 100) };
});
await check("Finder pasteboard interop: file URLs from outside are pasted; our copy is readable back as URLs", async () => {
  await app.ev(`await __qa.invoke('files_clipboard_write', { paths: [${JSON.stringify(path.join(ext, "finder.txt"))}] }); return 1`);
  await click("dest"); await key("meta V"); await settle();
  const pasted = has("dest/finder.txt") && fs.readFileSync(path.join(proj, "dest/finder.txt"), "utf8") === "from finder";
  await click("trashme.txt"); await key("meta C"); await sleep(200);
  const back = await app.ev(`return await __qa.invoke('files_clipboard_read')`);
  return { ok: pasted && eq(back, [path.join(proj, "trashme.txt")]), note: JSON.stringify(back) };
});
await check("drag a file onto a folder moves it; alt-drag copies", async () => {
  const dnd = (from, to, alt) => app.ev(`
    const row = (n) => [...document.querySelectorAll('.tree-row')].find((r) => r.querySelector('.tree-name').textContent === n);
    const dt = new DataTransfer();
    const f = (t, el) => el.dispatchEvent(new DragEvent(t, { bubbles: true, cancelable: true, dataTransfer: dt, altKey: ${!!alt} }));
    window.__dndErr = []; window.addEventListener('error', (e) => window.__dndErr.push(e.message), { once: true });
    f('dragstart', row(${JSON.stringify(from)})); f('dragover', row(${JSON.stringify(to)})); f('drop', row(${JSON.stringify(to)})); f('dragend', row(${JSON.stringify(from)}));
    await __qa.sleep(600); return window.__dndErr`);
  w("m1.txt"); w("m2.txt"); await sleep(400);
  const errs = await dnd("m1.txt", "other"); const moved = has("other/m1.txt") && !has("m1.txt");
  await dnd("m2.txt", "other", true); const copied = has("other/m2.txt") && has("m2.txt");
  return { ok: moved && copied, note: `other=${ls("other")} err=${JSON.stringify(errs)}` };
});
await check("delete (multi) confirms 'N items' and moves to Trash", async () => {
  w("qa-trash-1.txt", "t"); w("qa-trash-2.txt", "t"); await sleep(500);
  await click("qa-trash-1.txt"); await click("qa-trash-2.txt", { metaKey: true }); await key("BACK_SPACE"); await sleep(300);
  const d = await dialogText();
  await key("ENTER"); await sleep(900);
  return { ok: /2 items/.test(d ?? "") && /Trash/.test(d ?? "") && !has("qa-trash-1.txt") && !has("qa-trash-2.txt"), note: String(d).replace(/\s+/g, " ").slice(0, 120) };
});
await check("Reveal in Finder shortcut (alt+shift+R) is accepted without error", async () => {
  await click("c.md"); const handled = await key("meta alt shift R"); return { ok: handled === true, note: String(handled) };
});
console.log(app.shot("filetree"));
} catch (e) { console.error("filetree aborted:", e.message); rows.push({ name: "script ran to completion", ok: false, note: e.message }); }

console.log("\n| # | Check | Result | Note |\n|---|---|---|---|");
rows.forEach((r, i) => console.log(`| ${i + 1} | ${r.name} | ${r.ok ? "PASS" : "FAIL"} | ${r.note} |`));
const failed = rows.filter((r) => !r.ok).length;
console.log(`\n${rows.length - failed}/${rows.length} passed`);
await app.stop();
if (!failed) fs.rmSync(base, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
