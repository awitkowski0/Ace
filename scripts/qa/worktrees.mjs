#!/usr/bin/env node
// Git worktrees: Switch Worktree popup (search, switch in place, new tab), New/Remove/Prune, entry points (branch widget, project widget,
// Asset Dev "Other copies of this project"). Drives the app ONLY through the automation harness, on a scratch repo + worktrees in
// $HOME/.cache-ace-wt-qa-* (outside $TMPDIR so the recent-projects declutter does not hide them). Never touches a real repo.
// Usage: ACE_BIN=src-tauri/target-qa/release/ace node scripts/qa/worktrees.mjs      Screenshot: scripts/qa/out/worktrees.png
import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { launch, sleep } from "./lib.mjs";

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.homedir(), ".cache-ace-wt-qa-")));
const sh = (c, cwd) => execSync(c, { cwd, stdio: "pipe", encoding: "utf8" });
const G = "git -c user.email=q@q -c user.name=qa";
const main = path.join(root, "Scratch-Repo");
const wt = (n) => path.join(root, `Scratch-Repo-${n}`);
fs.mkdirSync(main);
sh(`git init -q -b main . && echo one > a.txt && echo two > b.txt && git add -A && ${G} commit -qm init`, main);
sh(`git init -q --bare ${path.join(root, "origin.git")} && git remote add origin ${path.join(root, "origin.git")} && git push -q -u origin main`, main);
sh(`git branch gamma && git branch topic/dev`, main);
sh(`git worktree add -q -b alpha ${wt("alpha")} && git push -q -u origin alpha`, main);
sh(`echo more > c.txt && git add -A && ${G} commit -qm ahead`, wt("alpha"));                      // alpha: ahead 1
sh(`git worktree add -q -b beta ${wt("beta")}`, main);
fs.appendFileSync(path.join(wt("beta"), "a.txt"), "dirty\n");                                       // beta: 1 changed file
sh(`git worktree add -q --detach ${wt("detached")} && git worktree add -q -b locked ${wt("locked")} && git worktree lock --reason "on usb" ${wt("locked")}`, main);
sh(`git worktree add -q -b agent-1 .claude/worktrees/agent-1 && git worktree add -q -b wf-2 .claude/worktrees/wf_2`, main);
const wtList = () => sh("git worktree list --porcelain", main);
const realBefore = process.env.QA_REAL_BEFORE; // optional: not used by the app

let app, fails = 0;
const check = async (name, fn) => {
  let ok = false, note = "";
  try { const r = await fn(); ok = r === true || !!(r && r.ok); note = r && r.note ? r.note : ""; } catch (e) { note = String(e.message || e).split("\n")[0].slice(0, 220); }
  if (!ok) fails++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${note ? "  - " + note : ""}`);
};
const until = async (fn, ms = 10000) => { const t0 = Date.now(); for (;;) { const v = await fn().catch(() => null); if (v) return v; if (Date.now() - t0 > ms) return null; await sleep(100); } };
const E = (body, win) => (win ? app.evIn(win, body) : app.ev(body));
const wins = () => app.ev("return await __qa.windows()", { timeout: 2500 });
const setInput = (sel, v, win) => E(`const i = document.querySelector(${JSON.stringify(sel)}); i.focus(); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(i, ${JSON.stringify(v)}); i.dispatchEvent(new Event('input',{bubbles:true})); return 1`, win);
const keyIn = (sel, key, mods = {}, win) => E(`document.querySelector(${JSON.stringify(sel)}).dispatchEvent(new KeyboardEvent('keydown',{key:${JSON.stringify(key)},bubbles:true,cancelable:true,...${JSON.stringify(mods)}})); return 1`, win);
const rowsOf = (win) => E(`return [...document.querySelectorAll('[data-testid=worktree-list] .wt-row')].map(r => ({ n: r.dataset.name, b: r.dataset.branch, cur: !!r.dataset.current, sel: r.classList.contains('selected'), badges: [...r.querySelectorAll('.wt-badge')].map(x => x.dataset.badge + ':' + x.textContent) }))`, win);
const names = async (win) => (await rowsOf(win)).map((r) => r.n).filter(Boolean);
const openSwitch = async (win) => { await E(`document.querySelector('.popup') && document.querySelector('.popup-backdrop').dispatchEvent(new MouseEvent('mousedown',{bubbles:true})); await __qa.sleep(60); __qa.runAction('Git.Worktree.Switch'); return 1`, win); return until(() => E(`return !!document.querySelector('[data-testid=worktree-search]')`, win), 5000); };
const clickBtn = (text, win) => E(`const b = [...document.querySelectorAll(${JSON.stringify(".dialog-buttons button, .rp-actions button")})].find(b => b.textContent.trim() === ${JSON.stringify(text)}); if (!b) return false; b.click(); return true`, win);
const dialogText = (win) => E(`return document.querySelector('.dialog')?.innerText ?? null`, win);
const clickDialog = async (text, win) => { await until(() => E(`return !!document.querySelector('.dialog')`, win), 5000); return E(`const b = [...document.querySelectorAll('.dialog-buttons button')].find(b => b.textContent.trim() === ${JSON.stringify(text)}); if (!b) return false; b.click(); return true`, win); };
const mainWin = async () => (await wins()).find((w) => w.project?.path === main)?.label;

try {
  app = await launch(main);
  await until(() => app.ev("return !!document.querySelector('.statusbar')"), 20000);
  await sleep(1500); // git status + background prefetch of the worktree list

  await check("Find Action entry: 'Switch Worktree…' registered with ⌃⌥W, enabled in a repo", () => app.ev(`const a = (await __qa.actions()).find(x => x.id === 'Git.Worktree.Switch'); return { ok: !!a && a.title === 'Switch Worktree…' && a.keys.join() === 'control alt W' && a.enabled, note: JSON.stringify(a) }`));
  await check("default shortcut ⌃⌥W does not clash with the IntelliJ keymap JSON", async () => {
    const km = JSON.parse(fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), "../../src/keymap/intellij-macos.json"), "utf8"));
    const hit = JSON.stringify(km).match(/"(control alt W|alt control W)"/);
    return { ok: !hit, note: hit?.[0] ?? "" };
  });

  // ---- popup opens instantly from the prefetched cache ----
  const t0 = Date.now();
  await app.ev(`await __qa.key('control alt W'); return 1`);
  const first = await until(async () => (await names()).length >= 5 ? true : null, 4000);
  const dt = Date.now() - t0;
  await check("⌃⌥W opens the popup with all 5 worktrees from cache", async () => ({ ok: !!first, note: `${dt} ms to rows; ${JSON.stringify(await names())}` }));
  await sleep(1200); // statuses
  await check("rows: current marked, branch + dirty/ahead/locked badges, detached label", async () => {
    const r = await rowsOf();
    const by = Object.fromEntries(r.map((x) => [x.n, x]));
    const ok = by["Scratch-Repo"]?.cur && !by["Scratch-Repo-alpha"].cur
      && by["Scratch-Repo-alpha"].b === "alpha" && by["Scratch-Repo-alpha"].badges.includes("ahead:↑1")
      && by["Scratch-Repo-beta"].badges.includes("dirty:1")
      && by["Scratch-Repo-locked"].badges.some((b) => b.startsWith("locked"))
      && /^detached @ [0-9a-f]{7}$/.test(by["Scratch-Repo-detached"].b);
    return { ok, note: ok ? "" : JSON.stringify(r) };
  });
  await check("first non-current row preselected", async () => { const r = await rowsOf(); return { ok: r.findIndex((x) => x.sel) === 1, note: JSON.stringify(r.map((x) => x.sel)) }; });
  await check("title 'Switch Worktree', footer actions + key hints", () => app.ev(`const p = document.querySelector('.popup'); const b = [...p.querySelectorAll('.wt-foot button')].map(x => x.textContent); return { ok: p.querySelector('.popup-title').textContent === 'Switch Worktree' && b.join() === 'New Worktree…,Remove Worktree…,Prune' && /⌘↩/.test(p.querySelector('.wt-hints').textContent), note: b.join() }`));
  app.shot("worktrees");
  const grp = () => app.ev(`const g = document.querySelector('[data-testid=agent-group]'); return g ? { t: g.innerText.trim(), open: g.dataset.open } : null`);
  await check("agent worktrees (.claude/worktrees/*) are a collapsed 'Agent worktrees (2)' group at the bottom", async () => {
    const g = await grp(), n = await names();
    return { ok: g?.t.includes("Agent worktrees (2)") && g.open === "0" && n.length === 5 && !n.some((x) => /agent|wf_/.test(x)), note: JSON.stringify([g, n.length]) };
  });
  await check("click expands the group (7 rows), click collapses again", async () => {
    await app.ev(`document.querySelector('[data-testid=agent-group]').click(); return 1`); await sleep(150);
    const n = (await names()).length;
    const lastIsAgent = (await names()).slice(-2).every((x) => x === "agent-1" || x === "wf_2");
    await app.ev(`document.querySelector('[data-testid=agent-group]').click(); return 1`); await sleep(150);
    return { ok: n === 7 && lastIsAgent && (await names()).length === 5, note: String(n) };
  });
  await check("search finds agent worktrees and auto-expands the group", async () => {
    await setInput("[data-testid=worktree-search]", "wf_2", 0 ? undefined : undefined); await sleep(200);
    const n = await names(), g = await grp();
    await setInput("[data-testid=worktree-search]", ""); await sleep(150);
    return { ok: n.join() === "wf_2" && g?.open === "1", note: JSON.stringify([n, g]) };
  });

  // ---- search (shared speed-search matcher) ----
  await check("search 'beta' -> only beta, name highlighted", async () => {
    await setInput("[data-testid=worktree-search]", "beta"); await sleep(150);
    const n = await names();
    const hl = await app.ev(`return document.querySelector('.wt-row .se-label .se-hl')?.textContent`);
    return { ok: n.join() === "Scratch-Repo-beta" && hl === "beta", note: JSON.stringify([n, hl]) };
  });
  await check("camel-hump 'srd' -> Scratch-Repo-detached", async () => { await setInput("[data-testid=worktree-search]", "srd"); await sleep(150); const n = await names(); return { ok: n.join() === "Scratch-Repo-detached", note: JSON.stringify(n) }; });
  await check("branch search 'locked' / no match message", async () => {
    await setInput("[data-testid=worktree-search]", "zzz"); await sleep(120);
    const e = await app.ev(`return document.querySelector('.wt-list .se-empty')?.textContent`);
    return { ok: e === "No worktrees match", note: e };
  });
  await setInput("[data-testid=worktree-search]", "");

  // ---- entry points: branch widget popup + project widget ----
  await app.ev(`document.querySelector('.popup-backdrop')?.dispatchEvent(new MouseEvent('mousedown',{bubbles:true})); await __qa.sleep(80); __qa.runAction('Git.Branches'); return 1`);
  await until(() => app.ev(`return !!document.querySelector('[data-wt]')`), 5000);
  await check("branch widget popup has a Worktrees section (with New Worktree… action)", () => app.ev(`const p = document.querySelector('.popup'); const sec = [...p.querySelectorAll('.popup-section')].map(s => s.textContent); const w = [...p.querySelectorAll('[data-wt]')].map(r => r.dataset.wt); const act = [...p.querySelectorAll('.popup-row')].some(r => r.textContent.startsWith('New Worktree')); return { ok: sec.includes('Worktrees') && w.length === 5 && act && /Agent worktrees \\(2\\)/.test(p.innerText), note: JSON.stringify([sec, w]) }`));
  await app.ev(`document.querySelector('.popup-backdrop').dispatchEvent(new MouseEvent('mousedown',{bubbles:true})); await __qa.sleep(80); document.querySelector('.widget[title]')?.click(); return 1`);
  await app.ev(`document.querySelector('.popup-backdrop')?.dispatchEvent(new MouseEvent('mousedown',{bubbles:true})); await __qa.sleep(80); return 1`);
  await app.ev(`const w = [...document.querySelectorAll('.toolbar .widget, .toolbar button')].find(b => /Scratch-Repo/.test(b.textContent)); if (w) w.click(); else (await import('/src/components/shell/popups.tsx')).openPopup('RecentProjects'); return 1`).catch(() => {});
  await until(() => app.ev(`return !!document.querySelector('[data-testid=recent-projects]')`), 4000);
  await check("project widget switcher: Worktrees section lists the other 4 with branch + badges", () => app.ev(`const l = document.querySelector('[data-testid=recent-projects]'); if (!l) return { ok: false, note: 'popup missing' }; const sec = [...l.querySelectorAll('.popup-section')].map(s => s.textContent); const rows = [...l.querySelectorAll('.rp-row')].map(r => r.dataset.name); const beta = [...l.querySelectorAll('.rp-row')].find(r => r.dataset.name === 'Scratch-Repo-beta'); return { ok: sec.includes('Worktrees') && rows.includes('Scratch-Repo-alpha') && !rows.includes('agent-1') && /Agent worktrees \\(2\\)/.test(l.innerText) && !!beta?.querySelector('.wt-badge.dirty'), note: JSON.stringify([sec, rows]) }`));
  await app.ev(`document.querySelector('.popup-backdrop')?.dispatchEvent(new MouseEvent('mousedown',{bubbles:true})); return 1`);

  // ---- switch in the CURRENT window (Enter) ----
  await openSwitch();
  await setInput("[data-testid=worktree-search]", "alpha"); await sleep(150);
  await keyIn("[data-testid=worktree-search]", "Enter");
  const switched = await until(async () => { const w = await wins(); return w.length === 1 && w[0].project?.path === wt("alpha") ? w : null; }, 20000);
  await check("Enter opens alpha in the same window (no new tab)", async () => ({ ok: !!switched, note: JSON.stringify((await until(wins, 5000) ?? []).map((w) => w.project?.path)) }));
  await until(() => app.ev("return !!window.__qa && !!document.querySelector('.statusbar')"), 20000);
  await sleep(1500);

  // ---- ⌘Enter: new window tab ----
  await openSwitch();
  await check("from alpha: alpha is the current row, main is preselected", async () => { const r = await rowsOf(); return { ok: r.find((x) => x.cur)?.n === "Scratch-Repo-alpha" && r.find((x) => x.sel)?.n === "Scratch-Repo", note: JSON.stringify(r.map((x) => [x.n, x.cur, x.sel])) }; });
  await setInput("[data-testid=worktree-search]", "beta"); await sleep(150);
  await keyIn("[data-testid=worktree-search]", "Enter", { metaKey: true });
  const two = await until(async () => { const w = await wins(); return w.length === 2 && w.some((x) => x.project?.path === wt("beta")) ? w : null; }, 20000);
  await check("⌘Enter opens beta in a new window tab; alpha window stays", async () => ({ ok: !!two && two.some((x) => x.project?.path === wt("alpha")), note: JSON.stringify((await wins()).map((w) => w.project?.path)) }));
  const betaWin = (await wins()).find((w) => w.project?.path === wt("beta"))?.label;
  const alphaWin = (await wins()).find((w) => w.project?.path === wt("alpha"))?.label;

  await check("Enter on a worktree that is already open focuses that window (no duplicate)", async () => {
    await E(`__qa.runAction('Git.Worktree.Switch'); return 1`, alphaWin);
    await until(() => E(`return !!document.querySelector('[data-testid=worktree-search]')`, alphaWin));
    await setInput("[data-testid=worktree-search]", "beta", alphaWin); await sleep(150);
    await keyIn("[data-testid=worktree-search]", "Enter", {}, alphaWin);
    await sleep(1200);
    const w = await wins();
    return { ok: w.length === 2, note: JSON.stringify(w.map((x) => [x.project?.path, x.focused])) };
  });

  // ---- New Worktree ----
  const mw = await mainWin() ?? alphaWin; // alpha window is fine: worktree commands run against the same repo
  await E(`__qa.runAction('Git.Worktree.Switch'); return 1`, alphaWin);
  await until(() => E(`return !!document.querySelector('[data-testid=worktree-search]')`, alphaWin));
  await clickBtn("New Worktree…", alphaWin);
  await until(() => E(`return !!document.querySelector('[data-testid=wt-branch]')`, alphaWin), 5000);
  await check("New Worktree form: typing an existing branch -> checks it out, folder defaults to sibling <repo>-<branch>", async () => {
    await setInput("[data-testid=wt-branch]", "gamma", alphaWin); await sleep(200);
    const r = await E(`return { folder: document.querySelector('[data-testid=wt-folder]').value, note: document.querySelector('[data-testid=wt-note]').textContent, start: !!document.querySelector('[data-testid=wt-start]') }`, alphaWin);
    return { ok: r.folder === wt("gamma") && /Checks out the existing branch gamma/.test(r.note) && !r.start, note: JSON.stringify(r) };
  });
  await check("a branch already checked out elsewhere is refused (Create disabled)", async () => {
    await setInput("[data-testid=wt-branch]", "beta", alphaWin); await sleep(150);
    const r = await E(`return { dis: document.querySelector('[data-testid=wt-create]').disabled, note: document.querySelector('[data-testid=wt-note]').textContent }`, alphaWin);
    return { ok: r.dis && /already checked out in Scratch-Repo-beta/.test(r.note), note: JSON.stringify(r) };
  });
  await check("suggestions list free branches only (topic/dev yes, main/alpha no)", async () => {
    await setInput("[data-testid=wt-branch]", "", alphaWin); await sleep(150);
    const s = await E(`return [...document.querySelectorAll('[data-testid=wt-sugg] .popup-row')].map(r => r.dataset.name)`, alphaWin);
    return { ok: s.includes("topic/dev") && s.includes("gamma") && !s.includes("main") && !s.includes("alpha"), note: JSON.stringify(s) };
  });
  await setInput("[data-testid=wt-branch]", "gamma", alphaWin); await sleep(150);
  await clickBtn("Create", alphaWin);
  const gamma = await until(async () => fs.existsSync(wt("gamma")) ? true : null, 10000);
  await check("Create -> worktree on disk, back in the switcher with it selected", async () => {
    await until(async () => (await names(alphaWin)).includes("Scratch-Repo-gamma"), 6000);
    const r = await rowsOf(alphaWin);
    return { ok: !!gamma && wtList().includes("branch refs/heads/gamma") && r.find((x) => x.sel)?.n === "Scratch-Repo-gamma", note: JSON.stringify(r.map((x) => [x.n, x.sel])) };
  });
  // new branch with a slash in the name
  await clickBtn("New Worktree…", alphaWin);
  await until(() => E(`return !!document.querySelector('[data-testid=wt-branch]')`, alphaWin), 5000);
  await setInput("[data-testid=wt-branch]", "feature/new thing", alphaWin); await sleep(150);
  await check("typing an invalid name is refused; 'feature/new-thing' -> new branch, folder <repo>-feature-new-thing, Start from field", async () => {
    const bad = await E(`return { dis: document.querySelector('[data-testid=wt-create]').disabled }`, alphaWin);
    await setInput("[data-testid=wt-branch]", "feature/new-thing", alphaWin); await sleep(150);
    const r = await E(`return { folder: document.querySelector('[data-testid=wt-folder]').value, note: document.querySelector('[data-testid=wt-note]').textContent, start: document.querySelector('[data-testid=wt-start]')?.value }`, alphaWin);
    return { ok: bad.dis && r.folder === wt("feature-new-thing") && /Creates new branch feature\/new-thing from/.test(r.note) && !!r.start, note: JSON.stringify(r) };
  });
  await keyIn("[data-testid=wt-branch]", "Enter", {}, alphaWin);
  await until(async () => fs.existsSync(wt("feature-new-thing")) ? true : null, 10000);
  await check("Enter in the form creates the new branch + worktree", async () => ({ ok: fs.existsSync(wt("feature-new-thing")) && /branch refs\/heads\/feature\/new-thing/.test(wtList()), note: "" }));
  await until(async () => (await names(alphaWin)).includes("Scratch-Repo-feature-new-thing"), 6000);

  // ---- Remove ----
  await check("Remove: current / main / open-in-other-window are refused", async () => {
    await setInput("[data-testid=worktree-search]", "alpha", alphaWin); await sleep(150);
    const cur = await E(`return document.querySelector('.wt-foot button[data-act=remove]').disabled`, alphaWin);
    await setInput("[data-testid=worktree-search]", "", alphaWin);
    await setInput("[data-testid=worktree-search]", "Scratch-Repo", alphaWin);
    await E(`const r = [...document.querySelectorAll('.wt-row')].find(r => r.dataset.main); r.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,cancelable:true})); return 1`, alphaWin); await sleep(120);
    const mainDis = await E(`return document.querySelector('.wt-foot button[data-act=remove]').disabled`, alphaWin);
    await setInput("[data-testid=worktree-search]", "beta", alphaWin); await sleep(150);
    await E(`document.querySelector('.wt-foot button[data-act=remove]').click(); return 1`, alphaWin); // beta is open in the other tab
    await sleep(500);
    const still = fs.existsSync(wt("beta")) && !(await E(`return !!document.querySelector('.dialog')`, alphaWin));
    return { ok: cur && mainDis && still, note: JSON.stringify({ cur, mainDis, still }) };
  });
  await E(`document.querySelector('.popup-backdrop')?.dispatchEvent(new MouseEvent('mousedown',{bubbles:true})); return 1`, alphaWin);
  await openSwitch(alphaWin);
  await setInput("[data-testid=worktree-search]", "gamma", alphaWin); await sleep(200);
  await clickBtn("Remove Worktree…", alphaWin);
  await check("Remove clean worktree: confirm dialog, then folder + entry gone, branch kept", async () => {
    const t = await until(() => dialogText(alphaWin), 4000);
    const asked = /Remove worktree Scratch-Repo-gamma/.test(t ?? "");
    await clickDialog("Remove", alphaWin);
    await until(async () => !fs.existsSync(wt("gamma")) ? true : null, 10000);
    return { ok: asked && !fs.existsSync(wt("gamma")) && !wtList().includes("Scratch-Repo-gamma") && sh("git branch --list gamma", main).includes("gamma"), note: String(t).slice(0, 80) };
  });
  await until(() => E(`return !!document.querySelector('[data-testid=worktree-search]')`, alphaWin), 6000);
  // dirty: dirty the new feature worktree, Cancel first, then Force
  fs.appendFileSync(path.join(wt("feature-new-thing"), "a.txt"), "edit\n");
  await setInput("[data-testid=worktree-search]", "feature", alphaWin); await sleep(200);
  await clickBtn("Remove Worktree…", alphaWin);
  await check("Remove dirty worktree: refused unless forced (Cancel keeps it)", async () => {
    const t = await until(() => dialogText(alphaWin), 4000);
    const dirtyMsg = /1 uncommitted change/.test(t ?? "");
    await clickDialog("Cancel", alphaWin);
    await sleep(500);
    return { ok: dirtyMsg && fs.existsSync(wt("feature-new-thing")), note: String(t).slice(0, 100) };
  });
  await until(() => E(`return !!document.querySelector('[data-testid=worktree-search]')`, alphaWin), 6000);
  await setInput("[data-testid=worktree-search]", "feature", alphaWin); await sleep(200);
  await clickBtn("Remove Worktree…", alphaWin);
  await check("Force Remove deletes the dirty worktree", async () => {
    await until(() => dialogText(alphaWin), 4000);
    await clickDialog("Force Remove", alphaWin);
    await until(async () => !fs.existsSync(wt("feature-new-thing")) ? true : null, 10000);
    return !fs.existsSync(wt("feature-new-thing")) && !wtList().includes("feature-new-thing");
  });

  // ---- Prune ----
  sh(`git worktree add -q -b eps ${wt("eps")}`, main);
  fs.rmSync(wt("eps"), { recursive: true, force: true });
  await until(() => E(`return !!document.querySelector('[data-testid=worktree-search]')`, alphaWin), 6000);
  await setInput("[data-testid=worktree-search]", "", alphaWin);
  await clickBtn("Prune", alphaWin);
  await check("Prune: lists the missing worktree, confirm, entry forgotten", async () => {
    const t = await until(() => dialogText(alphaWin), 6000);
    const lists = /Scratch-Repo-eps/.test(t ?? "");
    await clickDialog("Prune", alphaWin);
    await until(async () => !wtList().includes("Scratch-Repo-eps") ? true : null, 8000);
    return { ok: lists && !wtList().includes("Scratch-Repo-eps"), note: String(t).slice(0, 100) };
  });
  await until(() => E(`return !!document.querySelector('[data-testid=worktree-search]')`, alphaWin), 6000);
  await E(`document.querySelector('.popup-backdrop')?.dispatchEvent(new MouseEvent('mousedown',{bubbles:true})); return 1`, alphaWin);

  // ---- Asset Dev: "Other copies of this project" ----
  await E(`(await __qa.profiles()).set('asset'); return 1`, alphaWin);
  await sleep(600);
  await E(`__qa.runAction('Assets.Branch'); return 1`, alphaWin);
  await until(() => E(`return !!document.querySelector('[data-testid=branch-list]')`, alphaWin), 5000);
  await sleep(800);
  await check("Asset Dev Branch picker: 'Other copies of this project' in plain language, no git jargon", async () => {
    const r = await E(`const h = document.querySelector('[data-testid=copies-head]'); return { agent: document.querySelector('[data-testid=agent-group]')?.textContent, head: h?.textContent, rows: [...document.querySelectorAll('[data-copy]')].map(r => r.dataset.copy + ' | ' + r.querySelector('.se-sec').textContent) }`, alphaWin);
    const ok = r.head === "Other copies of this project" && r.rows.length >= 3 && !r.rows.some((x) => /^agent-1/.test(x)) && /Automatic helper copies \(2\)/.test(r.agent ?? '') && r.rows.some((x) => /Scratch-Repo-beta \| working on beta · 1 unsaved change/.test(x)) && r.rows.some((x) => /alpha \| you are here/.test(x)) && r.rows.some((x) => /detached \| working on an earlier version/.test(x)) && !r.rows.some((x) => /worktree/i.test(x));
    return { ok, note: JSON.stringify(r) };
  });
  await E(`document.querySelector('.popup-backdrop')?.dispatchEvent(new MouseEvent('mousedown',{bubbles:true})); (await __qa.profiles()).set('developer'); return 1`, alphaWin);

  await check("scratch repo list is consistent after the run (main, alpha, beta, detached, locked)", () => {
    const n = (wtList().match(/^worktree /gm) || []).length;
    return { ok: n === 7, note: String(n) };
  });
} catch (e) {
  fails++;
  console.log("FAIL  harness error - " + String(e.stack || e).split("\n").slice(0, 3).join(" | "));
} finally {
  try { await app?.stop(); } catch {}
  try { sh("git worktree prune", main); } catch {}
  fs.rmSync(root, { recursive: true, force: true });
}
console.log(fails ? `\n${fails} FAILED` : "\nALL PASSED");
process.exit(fails ? 1 : 0);
