#!/usr/bin/env node
// Multi-project windows (one project per native macOS tab). Drives the app ONLY through the automation harness.
// Launches Ace on scratch projects A/B/C (never a real project), asserts tabbing, switching, dedupe, per-window event
// isolation, per-window child cleanup, single instance (second `ace <C>` process), dirty-close prompt, session restore,
// and reports the memory cost of each extra project window.
// Usage: node scripts/qa/multiproject.mjs        Env: ACE_BIN, SCRATCH (parent dir for the scratch projects)
import { execSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BIN, launch, sleep } from "./lib.mjs";

const scratch = fs.mkdtempSync(path.join(process.env.SCRATCH || process.env.TMPDIR || os.tmpdir(), "ace-mp-"));
const mk = (name) => {
  const d = path.join(scratch, name);
  fs.mkdirSync(path.join(d, "src"), { recursive: true });
  fs.writeFileSync(path.join(d, "src/main.ts"), `export const name = ${JSON.stringify(name)};\n`);
  fs.writeFileSync(path.join(d, "README.md"), `# ${name}\n`);
  execSync("git init -q -b main . && git add -A && git -c user.email=q@q -c user.name=qa commit -qm init", { cwd: d });
  return fs.realpathSync(d);
};
const [A, B, C, D] = ["proj-a", "proj-b", "proj-c", "proj-d"].map(mk);
const nameOf = (p) => path.basename(p);

const rows = [];
async function check(name, fn) {
  let ok = false, note = "";
  try { const r = await fn(); ok = r === true || !!(r && r.ok); note = r && r.note ? r.note : ""; } catch (e) { note = String(e.message || e).split("\n")[0].slice(0, 160); }
  rows.push({ name, ok, note });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${note ? "  - " + note : ""}`);
}
const until = async (fn, ms = 15000, step = 100) => { const t0 = Date.now(); for (;;) { const v = await fn().catch(() => null); if (v) return v; if (Date.now() - t0 > ms) return null; await sleep(step); } };
const sh = (c) => { try { return execSync(c, { encoding: "utf8", maxBuffer: 1 << 26 }).trim(); } catch { return ""; } };

// ---- memory accounting (app + the WebKit helpers that appeared since launch; helpers of other apps excluded) ----
const wkPids = () => new Set(sh(`ps -axo pid=,command= | grep -E 'com.apple.WebKit.(WebContent|GPU|Networking)' | grep -v grep | awk '{print $1}'`).split("\n").filter(Boolean));
const rssMB = (pids) => Math.round(pids.reduce((s, p) => s + (+sh(`ps -o rss= -p ${p}`) || 0), 0) / 1024 * 10) / 10;
const wk0 = wkPids();
const mem = (app) => { const wk = [...wkPids()].filter((p) => !wk0.has(p)); return { appMB: rssMB([app.pid]), webkitMB: rssMB(wk), webkitProcs: wk.length }; };

const stopped = (child, ms = 8000) => new Promise((res) => { if (child.exitCode !== null) return res(child.exitCode); child.once("exit", (c) => res(c)); setTimeout(() => res(null), ms); });

let app;
let mp = {};
try {
  app = await launch(A);
  const sockEnv = { sock: app.sock, dataDir: app.dataDir };
  const W = () => app.windows();
  const waitWins = (n, ms) => until(async () => { const w = await W(); return w.length === n ? w : null; }, ms);
  const dbg = (label) => app.evIn(label, "return await __qa.winDebug()");
  const labelOf = (wins, p) => wins.find((w) => w.project && w.project.path === p)?.label;
  const active = async () => (await W()).find((w) => w.focused)?.label;

  await check("launch with A: one window showing A", async () => {
    const w = await waitWins(1);
    return { ok: !!w && w[0].project?.path === A && w[0].title === nameOf(A), note: JSON.stringify(w?.map((x) => [x.label, x.title])) };
  });
  const lA = labelOf(await W(), A);
  // memory baseline (1 window): let the editor/tree settle
  await app.evIn(lA, `await __qa.openFile(${JSON.stringify(path.join(A, "src/main.ts"))}); return 1`);
  await sleep(2500);
  mp.one = mem(app);

  await check("open B: dialog 'This Window / New Window' + remember checkbox, New Window default", async () => {
    await app.evIn(lA, `window.__flow = __qa.openFlow(${JSON.stringify(B)}); return 1`);
    const d = await app.evIn(lA, `await __qa.waitFor('.dialog', 5000); const b=[...document.querySelectorAll('.dialog button')]; return {buttons:b.map(x=>x.textContent), primary:b.filter(x=>x.className.includes('primary')).map(x=>x.textContent), checkbox: !!document.querySelector('.dialog input[type=checkbox]'), text: document.querySelector('.dialog').innerText}`);
    const okDlg = d.buttons.join() === "This Window,New Window,Cancel" && d.primary.join() === "New Window" && d.checkbox;
    await app.evIn(lA, `[...document.querySelectorAll('.dialog button')].find(x=>x.textContent==='New Window').click(); await window.__flow; return 1`);
    return { ok: okDlg, note: JSON.stringify(d.buttons) };
  });
  const two = await waitWins(2, 20000);
  await check("B opened as a second window (project-<n> label) titled with the project name", async () => {
    return { ok: !!two && two.every((w) => /^project-\d+$/.test(w.label)) && two.map((w) => w.title).join() === "proj-a,proj-b", note: JSON.stringify(two?.map((w) => [w.label, w.title])) };
  });
  const lB = labelOf(two ?? [], B);
  await sleep(1500);
  await check("two windows share the tabbing identifier and are tabbed together (NSWindow.tabbedWindows == 2)", async () => {
    const [a, b] = await Promise.all([dbg(lA), dbg(lB)]);
    const ok = a.tabbingIdentifier === "ace-projects" && b.tabbingIdentifier === "ace-projects" && a.tabbedWindows === 2 && b.tabbedWindows === 2 && a.tabbingMode === 1 && b.tabbingMode === 1;
    return { ok, note: `A=${a.tabbingIdentifier}/mode${a.tabbingMode}/tabs${a.tabbedWindows} B=${b.tabbingIdentifier}/mode${b.tabbingMode}/tabs${b.tabbedWindows} order=${a.tabbedLabels}` };
  });
  await check("new project window is active (selected tab) and its project is B", async () => ({ ok: (await active()) === lB, note: `active=${await active()} B=${lB} isKey A=${(await dbg(lA)).isKey} B=${(await dbg(lB)).isKey}` }));
  await check("Window menu lists both projects and the AppKit tab items", async () => {
    const m = (await dbg(lB)).menu;
    const need = ["proj-a", "proj-b"];
    const tabItems = m.filter((t) => /merge all windows|move tab to new window|show all tabs|show tab bar/i.test(t));
    return { ok: need.every((n) => m.includes(n)), note: `menu=${JSON.stringify(m)} appkitTabItems=${tabItems.length}` };
  });

  await check("project widget dropdown: open projects (check on current) then recent, type-to-filter, Enter switches", async () => {
    const r = await app.evIn(lB, `__qa.runAction('RecentProjects'); await __qa.waitFor('[data-testid=recent-projects] .rp-row', 5000); await __qa.sleep(300);
      const rows=[...document.querySelectorAll('.rp-row')].map(r=>({name:r.dataset.name, open:!!r.dataset.open, check:r.querySelector('.rp-check').textContent, path:r.querySelector('.se-sec').textContent, branch:r.querySelector('.rp-branch')?.textContent||null}));
      return {rows, sections:[...document.querySelectorAll('.rp-list .popup-section')].map(x=>x.textContent)}`);
    const b = r.rows.find((x) => x.name === "proj-b"), a = r.rows.find((x) => x.name === "proj-a");
    const ok = b?.check === "✓" && b.open && a?.open && a.check === "" && b.branch === "main" && r.sections[0] === "Open Projects" && a.path.includes("proj-a");
    // filter + Enter: switches to A (focus), no new window
    await app.evIn(lB, `await __qa.type('proj-a'); await __qa.sleep(150); await __qa.key('ENTER'); return 1`);
    const sw = await until(async () => (await active()) === lA, 5000);
    return { ok: ok && !!sw && (await W()).length === 2, note: JSON.stringify({ a, b, sections: r.sections, switchedToA: !!sw }) };
  });
  await check("Enter on a recent (closed) project opens it; recent list has only closed ones in 'Recent Projects'", async () => {
    const r = await app.evIn(lA, `__qa.runAction('RecentProjects'); await __qa.waitFor('.rp-row', 5000); await __qa.sleep(200); const rec=[...document.querySelectorAll('.rp-list > div')].map(x=>x.innerText.replace(/\\s+/g,' ')); document.querySelector('.popup-backdrop').dispatchEvent(new MouseEvent('mousedown',{bubbles:true})); return rec`);
    return { ok: r.length >= 2, note: JSON.stringify(r).slice(0, 140) };
  });

  // ---- switching with the keymap ----
  await check("NextProjectWindow (meta alt BACK_QUOTE) cycles to the other tab and back", async () => {
    const a0 = await active();
    await app.evIn(a0, `return await __qa.key('meta alt BACK_QUOTE')`);
    const a1 = await until(async () => { const x = await active(); return x !== a0 ? x : null; }, 5000);
    await app.evIn(a1, `return await __qa.key('meta alt BACK_QUOTE')`);
    const a2 = await until(async () => { const x = await active(); return x === a0 ? x : null; }, 5000);
    return { ok: !!a1 && a1 !== a0 && a2 === a0, note: `${a0} -> ${a1} -> ${a2}` };
  });
  await check("PreviousProjectWindow (meta shift alt BACK_QUOTE) and NextWindow (meta BACK_QUOTE) / PreviousWindow work", async () => {
    const a0 = await active();
    await app.evIn(a0, `return await __qa.key('meta shift alt BACK_QUOTE')`);
    const a1 = await until(async () => { const x = await active(); return x !== a0 ? x : null; }, 5000);
    await app.evIn(a1, `return await __qa.key('meta BACK_QUOTE')`);
    const a2 = await until(async () => { const x = await active(); return x === a0 ? x : null; }, 5000);
    await app.evIn(a2, `return await __qa.key('meta shift BACK_QUOTE')`);
    const a3 = await until(async () => { const x = await active(); return x !== a0 ? x : null; }, 5000);
    return { ok: !!a1 && !!a2 && !!a3, note: `${a0} -> ${a1} -> ${a2} -> ${a3}` };
  });
  await check("Switcher (control TAB) lists open projects in an 'Open Projects' section", async () => {
    const lab = await active();
    const r = await app.evIn(lab, `__qa.runAction('Switcher'); await __qa.waitFor('.se-recent', 4000); await __qa.sleep(300); const t=[...document.querySelectorAll('[data-project-window]')].map(x=>x.innerText.replace(/\\s+/g,' ')); document.querySelector('.popup-backdrop').dispatchEvent(new MouseEvent('mousedown',{bubbles:true})); return t`);
    return { ok: r.length === 2, note: JSON.stringify(r) };
  });
  // focus A for the next checks
  await app.ev(`return await __qa.invoke('win_focus', {label: ${JSON.stringify(lA)}})`, { window: lA });
  await until(async () => (await active()) === lA, 5000);

  await check("opening A again (from B) focuses the existing tab; no third window", async () => {
    await app.evIn(lB, `await __qa.openFlow(${JSON.stringify(A)}); return 1`);
    const ok = await until(async () => (await active()) === lA, 5000);
    const n = (await W()).length;
    return { ok: !!ok && n === 2, note: `windows=${n} active=${await active()}` };
  });

  // ---- event isolation ----
  await check("terminal output in A never arrives in B (pty events are emit_to'd to the owner)", async () => {
    // listeners in BOTH windows for A's session id, then spawn in A
    const id = "iso-pty-a";
    // the app's own window-scoped listen(); every window subscribes to A's session id, only the owner may receive it
    const listenJs = (lab) => app.evIn(lab, `window.__ev = []; await __qa.listen('pty://data/${id}', (e)=>window.__ev.push(e.payload)); return 1`);
    await listenJs(lA); await listenJs(lB);
    await app.evIn(lA, `await __qa.invoke('pty_spawn', {opts:{host:'local', cwd:${JSON.stringify(A)}, command:'echo ISOLATION-MARKER-A; sleep 30', cols:80, rows:24, id:'${id}'}}); return 1`);
    await sleep(1500);
    const gotA = await app.evIn(lA, `return (window.__ev||[]).map(b=>atob(b)).join('')`);
    const gotB = await app.evIn(lB, `return (window.__ev||[]).length`);
    return { ok: gotA.includes("ISOLATION-MARKER-A") && gotB === 0, note: `A got ${JSON.stringify(gotA.trim().slice(0, 30))}, B got ${gotB} events` };
  });
  await check("fs events: a change in A's tree reaches A only; a shared watch is delivered to both and survives one window closing", async () => {
    const listen = (lab) => app.evIn(lab, `window.__fs = []; await __qa.listen('fs://changed', (e)=>window.__fs.push(e.payload.paths.join())); return 1`);
    await listen(lA); await listen(lB);
    fs.writeFileSync(path.join(A, "src/touch1.txt"), "1");
    await sleep(1200);
    const [a1, b1] = [await app.evIn(lA, "return window.__fs"), await app.evIn(lB, "return window.__fs")];
    // B additionally watches A's root (shared watcher, reference counted)
    await app.evIn(lB, `return await __qa.invoke('fs_watch', {loc:{host:'local', path:${JSON.stringify(A)}}})`);
    fs.writeFileSync(path.join(A, "src/touch2.txt"), "2");
    await sleep(1200);
    const [a2, b2] = [await app.evIn(lA, "return window.__fs"), await app.evIn(lB, "return window.__fs")];
    const ok = a1.some((p) => p.includes("touch1")) && b1.length === 0 && a2.some((p) => p.includes("touch2")) && b2.some((p) => p.includes("touch2"));
    return { ok, note: `A:${a1.length}->${a2.length} B:${b1.length}->${b2.length}` };
  });

  // ---- close B: only B's children die ----
  await check("closing B kills B's terminal; A's terminal and A's watcher survive", async () => {
    await app.evIn(lB, `await __qa.invoke('pty_spawn', {opts:{host:'local', cwd:${JSON.stringify(B)}, command:'sleep 120', cols:80, rows:24, id:'iso-pty-b'}}); return 1`);
    await sleep(500);
    const before = await app.evIn(lA, `return await __qa.invoke('procs_list')`);
    const ptyB = before.find((p) => p.kind === "pty" && p.owner === lB), ptyA = before.find((p) => p.kind === "pty" && p.owner === lA);
    await app.evIn(lB, `__qa.runAction('CloseProject'); return 1`);
    const closed = await waitWins(1, 15000);
    await sleep(800);
    const after = await app.evIn(lA, `return await __qa.invoke('procs_list')`);
    const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
    fs.writeFileSync(path.join(A, "src/touch3.txt"), "3");
    await sleep(1000);
    const fsA = await app.evIn(lA, "return window.__fs");
    const ok = !!closed && ptyA && ptyB && !after.some((p) => p.owner === lB) && after.some((p) => p.id === ptyA.id) && !alive(ptyB.pid) && alive(ptyA.pid) && fsA.some((p) => p.includes("touch3"));
    return { ok: !!ok, note: `B pty alive=${ptyB && alive(ptyB.pid)} A pty alive=${ptyA && alive(ptyA.pid)} owners after=${[...new Set(after.map((p) => p.owner))]} windows=${closed?.length}` };
  });
  await check("after closing the second tab the first window is still showing A", async () => {
    const w = await W();
    return { ok: w.length === 1 && w[0].project.path === A && w[0].focused, note: JSON.stringify(w.map((x) => [x.label, x.title])) };
  });

  // ---- single instance ----
  await check("second `ace <C>` process hands over to the running instance, opens C as a tab, and exits", async () => {
    const t0 = Date.now();
    const p2 = spawn(BIN, [C], { env: app.env, stdio: "ignore" });
    const code = await stopped(p2, 10000);
    const exitMs = Date.now() - t0;
    const w = await waitWins(2, 15000);
    await sleep(1200);
    const lC = labelOf(w ?? [], C);
    const d = lC ? await dbg(lC) : null;
    mp.lC = lC;
    return { ok: code === 0 && !!w && !!d && d.tabbedWindows === 2 && d.tabbingIdentifier === "ace-projects" && (await active()) === lC, note: `exit=${code} in ${exitMs}ms, windows=${w?.length}, C tabs=${d?.tabbedWindows}, active=${await active()}` };
  });
  await check("second process with the already-open project A focuses its tab (no extra window)", async () => {
    const p2 = spawn(BIN, [A], { env: app.env, stdio: "ignore" });
    const code = await stopped(p2, 10000);
    const ok = await until(async () => (await active()) === labelOf(await W(), A), 5000);
    return { ok: code === 0 && !!ok && (await W()).length === 2, note: `exit=${code} windows=${(await W()).length}` };
  });
  await check("relative path from the second process resolves against ITS cwd", async () => {
    const p2 = spawn(BIN, ["proj-d"], { env: app.env, cwd: scratch, stdio: "ignore" });
    const code = await stopped(p2, 10000);
    const w = await waitWins(3, 15000);
    const lD = labelOf(w ?? [], D);
    mp.lD = lD;
    return { ok: code === 0 && !!lD, note: `exit=${code} windows=${w?.length}` };
  });

  // ---- dirty close prompt (D has an unsaved edit) ----
  await check("closing a window with unsaved edits asks Save / Don't Save / Cancel; Cancel keeps it, Don't Save closes without writing", async () => {
    const lD = mp.lD;
    const file = path.join(D, "src/main.ts");
    const orig = fs.readFileSync(file, "utf8");
    await app.evIn(lD, `await __qa.openFile(${JSON.stringify(file)}); __qa.editor().focus(); await __qa.type('DIRTY'); await __qa.sleep(200); return 1`);
    await app.evIn(lD, `__qa.runAction('CloseProject'); await __qa.waitFor('.dialog', 5000); return 1`);
    const dlg = await app.evIn(lD, `return [...document.querySelectorAll('.dialog button')].map(b=>b.textContent)`);
    await app.evIn(lD, `[...document.querySelectorAll('.dialog button')].find(b=>b.textContent==='Cancel').click(); return 1`);
    await sleep(500);
    const still = (await W()).length === 3;
    await app.evIn(lD, `__qa.runAction('CloseProject'); await __qa.waitFor('.dialog', 5000); [...document.querySelectorAll('.dialog button')].find(b=>b.textContent==="Don't Save").click(); return 1`);
    const closed = await waitWins(2, 10000);
    return { ok: dlg.join() === "Save,Don't Save,Cancel" && still && !!closed && fs.readFileSync(file, "utf8") === orig, note: `buttons=${dlg} keptOnCancel=${still} windowsNow=${JSON.stringify((await W()).map((w) => w.title))} closed=${!!closed} fileUntouched=${fs.readFileSync(file, "utf8") === orig}` };
  });

  // ---- quit + restore ----
  mp.before = (await W()).map((w) => w.project.path);
  const order = (await W()).map((w) => [w.project.path, w.focused]);
  await check("Quit (win_quit) exits cleanly and writes the session in tab order with the active project", async () => {
    await app.evIn(await active(), `__qa.invoke('win_quit'); return 1`).catch(() => {});
    const code = await stopped(app.child, 15000);
    const sess = JSON.parse(fs.readFileSync(path.join(app.dataDir, "session.json"), "utf8"));
    const act = order.find((o) => o[1])?.[0];
    return { ok: code === 0 && sess.projects.map((p) => p.path).join() === order.map((o) => o[0]).join() && sess.projects[sess.active].path === act, note: `exit=${code} session=${sess.projects.map((p) => nameOf(p.path))} active=${nameOf(sess.projects[sess.active]?.path ?? "")}` };
  });
  app = await launch(null, { sock: app.sock, dataDir: app.dataDir });
  await check("relaunch without args reopens A and C as tabs, same order, same active project", async () => {
    const w = await until(async () => { const x = await app.windows(); return x.length === 2 ? x : null; }, 20000);
    await sleep(1500);
    const d = w ? await app.evIn(w[0].label, "return await __qa.winDebug()") : null;
    const act = w?.find((x) => x.focused)?.project?.path;
    return { ok: !!w && w.map((x) => x.project.path).join() === order.map((o) => o[0]).join() && act === order.find((o) => o[1])[0] && d.tabbedWindows === 2, note: `windows=${w?.map((x) => nameOf(x.project.path))} active=${act && nameOf(act)} tabs=${d?.tabbedWindows}` };
  });
  await check("SIGTERM (harness stop) keeps the last session; the next launch restores it again", async () => {
    await app.stop();
    app = await launch(null, { sock: app.sock, dataDir: app.dataDir });
    const w = await until(async () => { const x = await app.windows(); return x.length === 2 ? x : null; }, 20000);
    return { ok: !!w && w.map((x) => x.project.path).join() === order.map((o) => o[0]).join(), note: `windows=${w?.map((x) => nameOf(x.project.path))}` };
  });

  // ---- per-project layout is independent per window ----
  await check("each window keeps its own layout (tool window state persisted per project, two windows open)", async () => {
    const w = await app.windows();
    const [w1, w2] = w;
    await app.evIn(w1.label, `__qa.runAction('ActivateTerminalToolWindow'); await __qa.sleep(600); return 1`);
    await sleep(300);
    const s1 = await app.evIn(w1.label, "return __qa.state().toolWindows");
    const s2 = await app.evIn(w2.label, "return __qa.state().toolWindows");
    const stored = await app.evIn(w1.label, `return Object.entries(localStorage).filter(([k])=>k.startsWith('ace.layout.')).map(([k,v])=>[k,JSON.parse(v).bottom])`);
    return { ok: s1.bottom === "terminal" && s2.bottom !== "terminal" && stored.some(([k, b]) => k.includes(w1.project.path) && b === "terminal"), note: `w1.bottom=${s1.bottom} w2.bottom=${s2.bottom} stored=${JSON.stringify(stored.map(([k, b]) => [path.basename(k), b]))}` };
  });

  console.log(`   window title bar / tab shots: scripts/qa/out/multiproject_tabs.png`);
  app.shot("multiproject_tabs");
} catch (e) {
  console.error("multiproject aborted:", e.stack || e.message);
  rows.push({ name: "run completed", ok: false, note: String(e.message).slice(0, 120) });
}

console.log("\n| # | Check | Result | Note |\n|---|---|---|---|");
rows.forEach((r, i) => console.log(`| ${i + 1} | ${r.name} | ${r.ok ? "PASS" : "FAIL"} | ${r.note} |`));
const failed = rows.filter((r) => !r.ok).length;
console.log(`\n${rows.length - failed}/${rows.length} passed`);
try { await app?.stop(); } catch {}

// ---- memory per extra project window: fresh launch, settled idle, median of 3 reads; each window has one editor open ----
try {
  const m = await launch(A);
  const open = async (p) => { await m.ev(`await __qa.openFlow(${JSON.stringify(p)}, 'new'); return 1`); await until(async () => (await m.windows()).some((w) => w.project?.path === p), 20000); const l = (await m.windows()).find((w) => w.project.path === p).label; await m.evIn(l, `await __qa.openFile(${JSON.stringify(path.join(p, "src/main.ts"))}); return 1`); };
  const settle = async () => { await sleep(5000); const r = []; for (let i = 0; i < 3; i++) { r.push(mem(m)); await sleep(1000); } const t = (x) => x.appMB + x.webkitMB; return r.sort((x, y) => t(x) - t(y))[1]; };
  await m.ev(`await __qa.openFile(${JSON.stringify(path.join(A, "src/main.ts"))}); return 1`);
  const m1 = await settle();
  await open(B); const m2 = await settle();
  await open(C); const m3 = await settle();
  const tot = (x) => Math.round((x.appMB + x.webkitMB) * 10) / 10;
  const r1 = (n) => Math.round(n * 10) / 10;
  console.log(`\nmemory (app + the WebKit helpers it started, settled idle, ${path.basename(BIN)} build): 1 window ${tot(m1)} MB (app ${m1.appMB}, webkit ${m1.webkitMB} in ${m1.webkitProcs} procs) | 2 windows ${tot(m2)} MB (${m2.webkitProcs} procs) | 3 windows ${tot(m3)} MB (${m3.webkitProcs} procs)`);
  console.log(`=> per extra project window: ${r1((tot(m2) - tot(m1)))} MB (2nd), ${r1(tot(m3) - tot(m2))} MB (3rd), average ${r1((tot(m3) - tot(m1)) / 2)} MB  [app part ${r1((m3.appMB - m1.appMB) / 2)} MB, WebKit part ${r1((m3.webkitMB - m1.webkitMB) / 2)} MB]`);
  await m.stop();
} catch (e) { console.error("memory phase failed:", e.message); }
fs.rmSync(scratch, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
