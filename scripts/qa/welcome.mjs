#!/usr/bin/env node
// Welcome screen (no project open): declutter, worktree grouping, search, keyboard, remove-from-recent. Harness only.
// Usage: ACE_BIN=src-tauri/target-qa/release/ace node scripts/qa/welcome.mjs     Screenshot: scripts/qa/out/welcome.png
import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { launch, sleep } from "./lib.mjs";

// Fixtures live outside $TMPDIR on purpose (temp paths are filtered from the list).
const root = fs.mkdtempSync(path.join(os.homedir(), ".cache-ace-welcome-qa-"));
const sh = (c, cwd) => execSync(c, { cwd, stdio: "pipe", encoding: "utf8" });
const repo = (name) => { const d = path.join(root, name); fs.mkdirSync(d); sh("git init -q -b main . && git -c user.email=q@q -c user.name=qa commit -q --allow-empty -m init", d); return d; };
const tc = repo("Thematic-Collections");
for (const w of ["spidey", "guide-tablet", "mc26", "storage"]) sh(`git worktree add -q -b ${w} ../Thematic-Collections-${w}`, tc);
const kyf = repo("thematic-kyf"), heir = repo("HeirloomSite"), aceRepo = repo("Atelier");
fs.mkdirSync(path.join(root, "never-opened"));
const wt = (w) => path.join(root, `Thematic-Collections-${w}`);

const home = os.homedir();
const seed = [
  wt("spidey"), kyf, tc + "/", heir, wt("guide-tablet"), aceRepo, wt("mc26"), wt("storage"),
  "/private/var/folders/zz/abc123/T/ace-qa-777/proj-a", "/tmp/scratch-proj", home + "/p/.claude/worktrees/fix-1",
  path.join(root, "deleted-long-ago"), kyf, aceRepo + "/",
].map((p) => ({ host: "local", path: p })).concat([{ host: "mc", path: "/home/alexw/server-app" }]);

let app, fails = 0;
const check = async (name, fn) => {
  let ok = false, note = "";
  try { const r = await fn(); ok = r === true || !!(r && r.ok); note = r && r.note ? r.note : ""; } catch (e) { note = String(e.message || e).split("\n")[0].slice(0, 200); }
  if (!ok) fails++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${note ? "  - " + note : ""}`);
};
const until = async (fn, ms = 10000) => { const t0 = Date.now(); for (;;) { const v = await fn().catch(() => null); if (v) return v; if (Date.now() - t0 > ms) return null; await sleep(100); } };
const names = () => app.ev(`return [...document.querySelectorAll('.wl-row')].map(r => r.dataset.name + (r.dataset.kind === 'child' ? '(c)' : r.dataset.kind === 'group' ? '(g)' : ''))`);
const key = (k) => app.ev(`const l = document.querySelector('[data-testid=welcome-list]'); l.focus(); l.dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(k)}, bubbles: true })); return 1`);
const stored = () => app.ev(`return JSON.parse(localStorage.getItem('ace.recent') || '[]').map(l => l.host + ':' + l.path)`);

try {
  app = await launch(null);
  await app.ev(`localStorage.setItem('ace.recent', ${JSON.stringify(JSON.stringify(seed))}); setTimeout(() => location.reload(), 50); return 1`);
  await sleep(800);
  await until(() => app.ev("return !!window.__qa && !!document.querySelector('[data-testid=welcome-list]')"), 20000);
  await sleep(1200); // lazy fs.stat probes

  await check("no project open: Welcome with sidebar nav", () => app.ev(`return !!document.querySelector('.wl-side') && [...document.querySelectorAll('.wl-nav')].map(n => n.textContent).join() === 'Projects,Customize'`));
  await check("declutter: missing/temp/duplicate hidden, worktrees grouped, remote kept", async () => {
    const n = await names();
    const want = ["Thematic-Collections(g)", "thematic-kyf", "HeirloomSite", "Atelier", "server-app"];
    return { ok: JSON.stringify(n) === JSON.stringify(want), note: JSON.stringify(n) };
  });
  await check("group shows worktree count, collapsed by default", () => app.ev(`return document.querySelector('[data-count]').textContent === '4 worktrees'`));
  await check("remote row has host badge", () => app.ev(`return document.querySelector('.wl-row[data-name=server-app] .wl-host')?.textContent === 'mc'`));
  await check("tiles: initials + colour", () => app.ev(`const t = [...document.querySelectorAll('.wl-row')].map(r => r.querySelector('.wl-tile').textContent); return { ok: t.join() === 'TC,TK,HS,At,SA', note: t.join() }`));
  await check("paths abbreviated with ~", () => app.ev(`return document.querySelector('.wl-row[data-name=Atelier] .wl-path').textContent.startsWith('~/')`));
  await check("branch shown for git project", () => app.ev(`return await __qa.waitFor(() => document.querySelector('.wl-row[data-name=Atelier] .wl-branch')?.textContent === 'main', 5000).then(() => true, () => false)`));

  await check("expand group (Right arrow) lists worktrees", async () => {
    await key("ArrowRight"); await sleep(200);
    const n = await names();
    return { ok: n.filter((x) => x.endsWith("(c)")).length === 4, note: JSON.stringify(n) };
  });
  await check("search filters as you type (IntelliJ camel-hump)", async () => {
    await app.ev(`const i = document.querySelector('.wl-search input'); i.focus(); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set; set.call(i, 'tcs'); i.dispatchEvent(new Event('input', {bubbles:true})); return 1`);
    await sleep(200);
    const n = await names();
    return { ok: n[0] === "Thematic-Collections(g)" && n.includes("Thematic-Collections-storage(c)") && !n.includes("Atelier"), note: JSON.stringify(n) };
  });
  await app.ev(`const i = document.querySelector('.wl-search input'); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set; set.call(i, 'heir'); i.dispatchEvent(new Event('input', {bubbles:true})); return 1`);
  await sleep(200);
  await check("search 'heir' -> only HeirloomSite", async () => { const n = await names(); return { ok: n.length === 1 && n[0] === "HeirloomSite", note: JSON.stringify(n) }; });
  await app.ev(`const i = document.querySelector('.wl-search input'); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set; set.call(i, ''); i.dispatchEvent(new Event('input', {bubbles:true})); return 1`);
  await sleep(200);

  await check("typing in the list jumps into the search field", async () => {
    await key("z"); await sleep(150);
    const r = await app.ev(`const i = document.querySelector('.wl-search input'); return { v: i.value, f: document.activeElement === i }`);
    await app.ev(`const i = document.querySelector('.wl-search input'); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set; set.call(i, ''); i.dispatchEvent(new Event('input', {bubbles:true})); return 1`);
    return r.v === "z" && r.f;
  });
  await sleep(200);

  await app.ev(`document.querySelector('.wl-row[data-name=Thematic-Collections]').dispatchEvent(new MouseEvent('mousedown',{bubbles:true})); return 1`); // select group, then collapse
  await key("ArrowLeft"); await sleep(150);
  await check("Left arrow collapses the group", async () => (await names()).every((x) => !x.endsWith("(c)")));

  await check("Backspace removes the selected entry (persisted, project untouched)", async () => {
    await app.ev(`document.querySelector('.wl-row[data-name=HeirloomSite]').dispatchEvent(new MouseEvent('mousedown',{bubbles:true})); return 1`);
    await sleep(100); await key("Backspace"); await sleep(250);
    const n = await names(), st = await stored();
    return { ok: !n.includes("HeirloomSite") && !st.some((p) => p.includes("HeirloomSite")) && fs.existsSync(heir) && st.some((p) => p.includes("Atelier")), note: JSON.stringify(n) };
  });
  await check("hover x removes an entry", async () => {
    await app.ev(`document.querySelector('.wl-row[data-name=thematic-kyf] .wl-x').click(); return 1`); await sleep(250);
    return !(await names()).includes("thematic-kyf") && fs.existsSync(kyf);
  });
  await check("removal survives reload", async () => {
    await app.ev(`setTimeout(() => location.reload(), 50); return 1`); await sleep(800);
    await until(() => app.ev("return !!window.__qa && !!document.querySelector('[data-testid=welcome-list]')"), 20000); await sleep(1000);
    const n = await names();
    return { ok: !n.includes("HeirloomSite") && !n.includes("thematic-kyf") && n.includes("Atelier"), note: JSON.stringify(n) };
  });
  await check("Customize page", async () => {
    await app.ev(`document.querySelector('[data-nav=customize]').click(); return 1`); await sleep(200);
    const ok = await app.ev(`return !!document.querySelector('[data-testid=welcome-theme]')`);
    await app.ev(`document.querySelector('[data-nav=projects]').click(); return 1`); await sleep(200);
    return ok;
  });

  // restore a fresh messy list for the screenshot
  await app.ev(`localStorage.setItem('ace.recent', ${JSON.stringify(JSON.stringify(seed))}); setTimeout(() => location.reload(), 50); return 1`);
  await sleep(800);
  await until(() => app.ev("return !!document.querySelector('[data-testid=welcome-list]')"), 20000);
  await sleep(1500);
  await app.ev(`document.querySelector('.wl-row[data-kind=group] [data-chev]').click(); return 1`);
  await sleep(500);
  console.log(app.shot("welcome"));
} catch (e) {
  fails++; console.error("FATAL", e);
} finally {
  if (app) await app.stop();
  try { sh(`git worktree prune`, tc); } catch {}
  fs.rmSync(root, { recursive: true, force: true });
}
console.log(fails ? `${fails} FAILED` : "ALL PASSED");
process.exit(fails ? 1 : 0);
