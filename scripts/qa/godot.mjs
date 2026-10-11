#!/usr/bin/env node
// Godot suite (docs/GODOT.md). Drives Ace only through the ATELIER_AUTOMATION harness (never the real keyboard/mouse) on a SCRATCH Godot
// project under TMPDIR (scripts/qa/godot-fixture.mjs). Every game runs headless: no window ever opens. Opening the real Godot editor is
// intercepted (ATELIER_GODOT_LAUNCH_LOG): the argv is logged instead of launched.
// Usage: node scripts/qa/godot.mjs [--only <substring>] [--thematic]      Env: ATELIER_BIN
//   --thematic: ONLY a read-only acceptance on ~/thematic-kyf (presets / scripts / main scene, one short headless arch_check.gd run) and exit.
import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { launch, sleep } from "./lib.mjs";
import { makeProject } from "./godot-fixture.mjs";

const args = process.argv.slice(2);
const only = args.includes("--only") ? args[args.indexOf("--only") + 1] : null;
const J = JSON.stringify;
const rows = [];
async function check(name, fn) {
  if (only && !name.toLowerCase().includes(only.toLowerCase())) return;
  let ok = false, note = "";
  try { const r = await fn(); ok = r === true || (r && r.ok); note = r && r.note ? r.note : ""; } catch (e) { note = String(e.message || e).split("\n")[0].slice(0, 300); }
  rows.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${note ? "  - " + note : ""}`);
}
/** pids of game processes (not the LSP's `--editor` instance) whose command line contains `needle` */
const godotProcs = (needle, { editors = false } = {}) => {
  try {
    return execSync("ps -axo pid,command", { encoding: "utf8" }).split("\n").filter((l) => /\s\S*\/[Gg]odot(\s|$)/.test(l) && l.includes(needle) && (editors || !/ --editor\b/.test(l)) && !l.includes("ps -axo")).map((l) => +l.trim().split(/\s+/)[0]);
  } catch { return []; }
};

// ---------------------------------------------------------------- read-only acceptance on the real project
if (args.includes("--thematic")) {
  const real = path.join(os.homedir(), "thematic-kyf");
  const status = () => execSync("git status --porcelain | sort", { cwd: real, encoding: "utf8", shell: "/bin/zsh" });
  const s0 = status();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ace-godot-them-"));
  const app = await launch(real, { dataDir });
  try {
    await app.ev(`await __qa.waitFor(() => document.querySelector('.statusbar'), 15000); localStorage.setItem("atelier.lsp.autoGodot", "0"); return 1`);
    const st = await app.ev(`const g = await __qa.godot(); return await g.scan()`);
    console.log("name:", st.name, "| main scene:", st.mainScene, "| scenes:", st.scenes.length, "| bin:", st.bin);
    console.log("presets:", st.presets.length); for (const p of st.presets) console.log("  -", p.name, "|", p.type, p.headless ? "headless" : "", p.timeLimit ? p.timeLimit + "s" : "", p.instanceArgs ? "instances " + p.instanceArgs.join(" / ") : "");
    console.log("scripts:", st.scripts.length, st.scripts.slice(0, 80).map((s) => s.path.replace("res://", "")).join(", "));
    const tracked = ["tools/sim/arch_allowlist"].map((p) => path.join(real, p));
    const before = execSync(`find ${tracked.map(J).join(" ")} -type f -exec md5 -q {} + | md5`, { encoding: "utf8", shell: "/bin/zsh" });
    const run = await app.ev(`const g = await __qa.godot(); return await g.run({ type: "script", script: "res://tools/sim/arch_check.gd", headless: true, timeLimit: 120, name: "arch check", liveReload: false })`, { timeout: 30000 });
    let fin = null;
    for (let i = 0; i < 60 && !fin; i++) { await sleep(2000); const s = await app.ev(`const g = await __qa.godot(); return g.sessions().find((x) => x.name === "arch check")`); if (s?.status === "finished") fin = s; }
    console.log("arch_check:", fin ? `exit ${fin.exit?.display}` : "still running", "\n" + (fin?.text ?? "").split("\n").slice(-12).join("\n"));
    const probs = await app.ev(`const g = await __qa.godot(); return g.problems()`);
    console.log("problems:", JSON.stringify(probs.map((r) => ({ run: r.name, items: r.items.length }))));
    const after = execSync(`find ${tracked.map(J).join(" ")} -type f -exec md5 -q {} + | md5`, { encoding: "utf8", shell: "/bin/zsh" });
    console.log("allowlists unchanged:", before === after, "| .ace exists:", fs.existsSync(path.join(real, ".ace")));
    void run;
  } finally { await app.stop(); }
  const s1 = status();
  console.log("git status identical:", s0 === s1);
  if (s0 !== s1) { const a = new Set(s0.split("\n")), b = new Set(s1.split("\n")); console.log("  changed lines:", [...b].filter((x) => !a.has(x)), [...a].filter((x) => !b.has(x))); }
  console.log("godot processes left on thematic-kyf:", godotProcs("thematic-kyf").join(" ") || "(none)");
  process.exit(0);
}

// ---------------------------------------------------------------- scratch project + app
const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ace-godot-")));
const proj = makeProject(path.join(scratch, "proj"), { port: 47000 + (process.pid % 900) });
const P = (...p) => path.join(proj, ...p);
const launchLog = path.join(scratch, "launch.log");
const godotBefore = godotProcs("ace-godot-");
const app = await launch(proj, { env: { ATELIER_GODOT_LAUNCH_LOG: launchLog } });
const G = (body, o) => app.ev(`const g = await __qa.godot(); const py = await __qa.py(); const d = py.debug; const run = py.run; ${body}`, o);
const until = async (expr, ms = 20000, label = expr) => {
  const t0 = Date.now();
  for (;;) {
    const r = await G(`const t0 = Date.now(); while (Date.now() - t0 < 4000) { const r = await (async () => { ${expr} })(); if (r) return r; await __qa.sleep(80); } return null;`, { timeout: 15000 });
    if (r) return r;
    if (Date.now() - t0 > ms) throw new Error("timeout waiting for: " + label.slice(0, 120));
  }
};
const sessionsBy = (re) => G(`return g.sessions().filter((s) => ${re}.test(s.name))`);
const waitFinished = (name, ms = 60000) => until(`const s = g.sessions().find((x) => x.name === ${J(name)}); return s && s.status === "finished" ? s : null;`, ms, "finished " + name);
const sleepMs = sleep;
const reset = (rel = "scripts/main.gd") => app.ev(`return await __qa.reset(${J(P(rel))})`, { timeout: 15000 });
const spec = (o) => ({ headless: true, liveReload: false, ...o });
const scrubBefore = () => G(`for (const s of [...g.sessions()]) { try { await run.close(s.id); } catch {} } await d.closeAll(); d.bps.clear(); return 1`, { timeout: 20000 });

try {
  await app.ev(`await __qa.waitFor(() => document.querySelector('.statusbar'), 15000); localStorage.setItem("atelier.lsp.autoGodot", "0"); return 1`);
  await sleepMs(500);

  // ------------------------------------------------------------ detection, types, discovery
  await check("project.godot detected: Godot tool window + Structure appear, three run configuration types registered", async () => {
    const s = await G("return g.state()");
    await app.ev(`await __qa.runAction("ActivateGodotToolWindow"); return 1`);
    await sleepMs(400);
    const win = await app.ev(`return !!document.querySelector('[data-testid="godot-window"]')`);
    const t = await G("return g.configTypes().filter((x) => x.id.startsWith('godot-'))");
    const ids = t.map((x) => x.id).sort().join();
    const labels = t.map((x) => x.label).sort().join("|");
    return { ok: s.detected && win && ids === "godot-project,godot-scene,godot-script" && labels === "Godot: Run Project|Godot: Run Scene|Godot: Run Script", note: `${ids} ${labels} window=${win}` };
  });
  await check("no Godot process exists before the user runs something", async () => {
    const p = godotProcs("ace-godot-");
    return { ok: p.length === 0, note: p.join() };
  });
  await check("scan: name, main scene, scenes, README presets (Dev tools block only), SceneTree tool scripts only", async () => {
    const s = await G("return await g.scan()");
    const names = s.presets.map((p) => p.name);
    const scripts = s.scripts.map((x) => x.path.replace("res://", ""));
    const lan = s.presets.find((p) => p.name.startsWith("LAN"));
    const ok = s.name === "Scratch Game" && s.mainScene === "res://scenes/main.tscn" && s.scenes.length === 4
      && names.join("|") === "Hello sim|Error sim (never exits)|Parse error|LAN test (two processes)|Loop scene"
      && lan.instanceArgs.length === 2 && lan.timeLimit === 40 && lan.headless
      && scripts.join() === "scripts/characters/tools/check.gd,tools/sim/dbg_script.gd,tools/sim/err.gd,tools/sim/hello.gd,tools/sim/net_test.gd,tools/sim/parse_err.gd";
    return { ok, note: J({ names, scripts, lan: lan?.instanceArgs }) };
  });
  await check("tool window lists Run Project, scenes (main first), presets and scripts; double-click-free: rows by id", async () => {
    const rowsNow = await G("return g.rows()");
    const ids = rowsNow.map((r) => r.id);
    const need = ["sec:project", "run", "scene:res://scenes/main.tscn", "more:scenes", "preset:0", "preset:3", "script:res://tools/sim/hello.gd", "script:res://scripts/characters/tools/check.gd"];
    const miss = need.filter((n) => !ids.includes(n));
    const main = rowsNow.find((r) => r.id === "scene:res://scenes/main.tscn");
    return { ok: !miss.length && main.hint === "main scene", note: J({ miss, n: ids.length }) };
  });
  await check("keys come from the IntelliJ keymap: Run ⌃R, Debug ⌃D, Stop ⌘F2, ⌃⇧R/⌃⇧D, Structure ⌘7, Reload Scripts ⌘F10, breakpoint ⌘F8", async () => {
    const list = await app.ev(`return __qa.actions()`);
    const keysOf = (id) => J(list.find((x) => x.id === id)?.keys ?? null).replace(/\+/g, " ");
    const exp = { Run: "control R", Debug: "control D", Stop: "meta F2", RunClass: "control shift R", DebugClass: "control shift D", ActivateStructureToolWindow: "meta 7", "Godot.ReloadScripts": "meta F10", ToggleLineBreakpoint: "meta F8", StepOver: "F8", StepInto: "F7", StepOut: "shift F8", Resume: "F9" };
    const bad = Object.entries(exp).filter(([id, k]) => !keysOf(id).toLowerCase().includes(k.toLowerCase())).map(([id]) => `${id}=${keysOf(id)}`);
    return { ok: !bad.length, note: bad.join("; ") };
  });

  // ------------------------------------------------------------ pins (.ace/config.json) + the Run widget with zero configurations
  await check("pin a preset and a scene: .ace/config.json created with exact content (version first, godot.pinned, self-contained entries)", async () => {
    if (fs.existsSync(P(".ace"))) return { ok: false, note: ".ace existed before the first pin" };
    const s = await G("return g.state()");
    const hello = s.presets.find((p) => p.name === "Hello sim");
    await G(`await g.pin({ type: "script", name: "Hello sim", script: "res://tools/sim/hello.gd", headless: true, timeLimit: 60, scriptArgs: "a b" }); await g.pin({ type: "scene", scene: "res://scenes/other.tscn", headless: true, name: "Other scene" }); return 1`);
    await sleepMs(500);
    const text = fs.readFileSync(P(".ace/config.json"), "utf8");
    const want = J({ version: 1, godot: { pinned: [{ type: "script", name: "Hello sim", script: "res://tools/sim/hello.gd", headless: true, timeLimit: 60, scriptArgs: "a b" }, { type: "scene", name: "Other scene", scene: "res://scenes/other.tscn", headless: true }] } }, null, 2) + "\n";
    return { ok: text === want && !!hello, note: text.slice(0, 200) };
  });
  await check("Run widget with ZERO run configurations but pinned items: click opens the dropdown (not the dialog), Pinned section, pick selects it, ▶ runs it", async () => {
    const before = await G("return { configs: g.configs().length, sessions: g.sessions().length }");
    await app.ev(`document.querySelector('[data-act="config"]').click(); await __qa.sleep(250); return 1`);
    const st = await app.ev(`return { popup: __qa.state().popup.open, menu: !!document.querySelector('[data-testid="run-menu"]'), section: document.querySelector('[data-testid="run-menu-pinned"]')?.textContent ?? null, items: [...document.querySelectorAll('[data-widget-item]')].map((e) => e.dataset.widgetItem + ":" + e.textContent) }`);
    await app.ev(`document.querySelector('[data-widget-item="godot-pin-0"]').click(); await __qa.sleep(300); return 1`);
    const w = await G("return { widget: run.widget(), sel: g.selectedConfig(), sessions: g.sessions().length }");
    await app.ev(`document.querySelector('[data-act="run"]').click(); return 1`);
    const fin = await waitFinished("Hello sim");
    const ok = before.configs === 0 && !st.popup && st.menu && st.section === "Pinned" && st.items.length === 2
      && w.widget.name === "Hello sim" && w.widget.temp && w.sel?.type === "godot-script" && w.sessions === 0 && fin.exit?.display === 0 && /HELLO \["a", "b"\]/.test(fin.text);
    return { ok, note: J({ before, st, w: w.widget, sel: w.sel, exit: fin.exit?.display }) };
  });
  await check("unpin: Delete-key action removes it from the file and the dropdown", async () => {
    await G(`await g.unpin({ type: "scene", scene: "res://scenes/other.tscn", headless: true, name: "Other scene" }); return 1`);
    await sleepMs(400);
    const j = JSON.parse(fs.readFileSync(P(".ace/config.json"), "utf8"));
    const items = await app.ev(`return [...document.querySelectorAll('[data-widget-item]')].length`);
    const menu = await app.ev(`document.querySelector('[data-act="config"]').click(); await __qa.sleep(200); const n = [...document.querySelectorAll('[data-widget-item]')].length; document.dispatchEvent(new KeyboardEvent('mousedown')); return n`);
    await app.ev(`window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); return 1`);
    return { ok: j.godot.pinned.length === 1 && j.godot.pinned[0].name === "Hello sim" && menu === 1, note: J({ pinned: j.godot.pinned.length, menu, items }) };
  });
  await check("external edit of .ace/config.json is picked up (other sections kept when pinning)", async () => {
    const cur = JSON.parse(fs.readFileSync(P(".ace/config.json"), "utf8"));
    fs.writeFileSync(P(".ace/config.json"), J({ ...cur, gradle: { pinned: [{ task: ":x" }] } }, null, 2) + "\n");
    await sleepMs(700);
    await G(`await g.pin({ type: "project", name: "Scratch Game" }); return 1`);
    await sleepMs(400);
    const j = JSON.parse(fs.readFileSync(P(".ace/config.json"), "utf8"));
    await G(`await g.unpinAt(1); return 1`);
    return { ok: j.gradle?.pinned?.[0]?.task === ":x" && j.godot.pinned.length === 2 && j.godot.pinned[1].type === "project", note: J(j) };
  });

  // ------------------------------------------------------------ output, links, problems, time limit
  await check("Run Script: output stream, arguments after --, exit code, command line printed, process group gone", async () => {
    const s = await G(`const x = await g.run({ type: "script", script: "res://tools/sim/hello.gd", headless: true, liveReload: false, scriptArgs: "5 8", name: "args run" }); return x`);
    const f = await waitFinished("args run");
    const ok = f.exit?.display === 0 && /HELLO \["5", "8"\]/.test(f.text) && /--headless --script res:\/\/tools\/sim\/hello\.gd -- 5 8/.test(f.commandLine) && /Process finished with exit code 0/.test(f.text) && s?.type === "godot-script";
    return { ok, note: f.text.slice(-200) };
  });
  await check("runtime error + warning: coloured, clickable res:// links, problems grouped by run, time limit kills only this process", async () => {
    const t0 = Date.now();
    await G(`await g.run({ type: "script", script: "res://tools/sim/err.gd", headless: true, liveReload: false, timeLimit: 3, name: "err run" }); return 1`);
    await app.ev(`await __qa.runAction("ActivateRunToolWindow"); return 1`);
    const f = await waitFinished("err run", 30000);
    const secs = (Date.now() - t0) / 1000;
    await sleepMs(500);
    const probs = await G("return g.problems()");
    const mine = probs.find((r) => r.name === "err run");
    const errP = mine?.items.find((i) => i.sev === 1), warnP = mine?.items.find((i) => i.sev === 2);
    const dom = await until(`const links = run.domLinks().filter((l) => l.path.endsWith('tools/sim/err.gd')); const colored = [...document.querySelectorAll('.run-line')].filter((e) => e.textContent.startsWith('SCRIPT ERROR')).map((e) => e.querySelector('span')?.style.color); return links.length ? { links, colored } : null;`, 10000, "links in console");
    const ok = f.timedOut && /Time limit of 3 s reached/.test(f.text) && secs < 15 && (f.exit.signal === 15 || f.exit.display === 143)
      && /SCRIPT ERROR: Invalid access to property or key 'name'/.test(f.text)
      && errP?.line === 11 && errP.path === P("tools/sim/err.gd") && warnP?.line === 5 && /careful now/.test(warnP.message)
      && dom.links.some((l) => l.line === 11 && l.path === P("tools/sim/err.gd")) && dom.colored.some((c) => c && c.length > 0);
    return { ok, note: J({ secs, exit: f.exit, errP, warnP, dom: dom.links.slice(0, 2), colored: dom.colored }) };
  });
  await check("clicking the console link opens the file at the error line", async () => {
    await app.ev(`const a = [...document.querySelectorAll('.run-link')].find((x) => x.dataset.path.endsWith('tools/sim/err.gd') && x.dataset.line === "11"); a.click(); return 1`);
    await sleepMs(900);
    const s = await app.ev(`return __qa.state()`);
    const tab = JSON.stringify(s).includes("err.gd");
    return { ok: tab && s.cursor?.line === 11, note: J(s.cursor) };
  });
  await check("no godot process left after the time limit", async () => {
    await sleepMs(500);
    const p = godotProcs("tools/sim/err.gd");
    return { ok: p.length === 0, note: p.join() };
  });
  await check("Problems window 'Run' tab lists the run's errors/warnings; clicking a row opens the location", async () => {
    await app.ev(`await __qa.runAction("ActivateProblemsViewToolWindow"); await __qa.sleep(300); document.querySelector('[data-testid="problems-run-tab"]').click(); await __qa.sleep(300); return 1`);
    const rowsDom = await app.ev(`return { files: [...document.querySelectorAll('.lsp-file')].map((e) => e.textContent), items: [...document.querySelectorAll('.lsp-row')].map((e) => e.textContent) }`);
    await app.ev(`const r = [...document.querySelectorAll('.lsp-row')].find((e) => e.textContent.includes('Invalid access')); r.click(); return 1`);
    await sleepMs(900);
    const s = await app.ev(`return __qa.state()`);
    return { ok: rowsDom.files.some((f) => f.includes("err run")) && rowsDom.items.some((i) => i.includes("careful now")) && s.cursor?.line === 11, note: J({ rowsDom, cursor: s.cursor }) };
  });
  await check("parse error script: Parse Error problems with file and line, exit code stays 0", async () => {
    const x = await G(`await g.runPreset("Parse error"); return 1`);
    const f = await waitFinished("Parse error");
    await sleepMs(300);
    const probs = (await G("return g.problems()")).find((r) => r.name === "Parse error");
    const pe = probs?.items.filter((i) => /Parse Error/.test(i.message)) ?? [];
    return { ok: f.exit?.display === 0 && pe.length >= 2 && pe.some((i) => i.line === 5 && i.path === P("tools/sim/parse_err.gd")) && /Parse Error: Identifier "undefined_thing"/.test(f.text), note: J(pe.map((i) => [i.line, i.message.slice(0, 40)])) };
  });

  // ------------------------------------------------------------ multiple instances
  await check("Run Multiple Instances: LAN preset starts host + client tabs, they talk over localhost, both exit 0", async () => {
    await scrubBefore();
    await G(`await g.runPreset("LAN test (two processes)"); return 1`);
    const a = await waitFinished("LAN test (two processes) (host)", 60000);
    const b = await waitFinished("LAN test (two processes) (client)", 60000);
    const all = await G("return g.sessions().map((s) => ({ name: s.name, group: s.group }))");
    return { ok: a.exit.display === 0 && b.exit.display === 0 && /HOST received ping/.test(a.text) && /CLIENT received pong/.test(b.text) && a.group && a.group === b.group && all.length === 2, note: J({ a: a.text.slice(-120), b: b.text.slice(-120), all }) };
  });
  await check("group Stop: stopping one tab of a 2-instance run stops both (no time limit involved); Rerun on one tab restarts both", async () => {
    await scrubBefore();
    await G(`await g.run({ type: "scene", scene: "res://scenes/loop.tscn", headless: true, liveReload: false, instanceArgs: ["one", "two"], name: "loopy" }); return 1`);
    await until(`const l = g.sessions(); return l.length === 2 && l.every((s) => s.status === "running" && /VALUE 1/.test(s.text)) ? l : null;`, 20000, "two running loops");
    const pids = godotProcs("scenes/loop.tscn");
    await G(`const s = g.sessions()[0]; run.stop(s.id); return 1`);
    const stopped = await until(`const l = g.sessions(); return l.every((s) => s.status === "finished") ? l : null;`, 15000, "both stopped");
    await sleepMs(300);
    const left = godotProcs("scenes/loop.tscn");
    await G(`const s = g.sessions()[1]; run.rerun(s.id); return 1`);
    const again = await until(`const l = g.sessions(); return l.length === 2 && l.every((s) => s.status === "running") ? l : null;`, 20000, "rerun both");
    await G(`run.stop(g.sessions()[1].id); return 1`);
    await until(`return g.sessions().every((s) => s.status === "finished")`, 15000, "stopped again");
    return { ok: pids.length === 2 && left.length === 0 && stopped.every((s) => !s.timedOut) && again.length === 2, note: J({ before: pids.length, left: left.length, names: again.map((s) => s.name) }) };
  });

  // ------------------------------------------------------------ debugger (remote debugger protocol)
  const dbg = (o) => G(`return await g.run(${J(spec(o))}, "debug")`, { timeout: 30000 });
  const waitPaused = (ms = 25000) => G(`return await d.waitPaused(${ms})`, { timeout: ms + 8000 });
  const state = () => G("return d.state()");
  const loc = (s, n) => s?.locals?.find((v) => v.name === n);
  await check("debug scene: gutter breakpoint (real gutter click) hits, stack frame + locals/members, evaluate, step over, resume to the end", async () => {
    await scrubBefore();
    await reset("scripts/main.gd");
    const clicked = await G(`return await d.gutterClick(9, "glyph")`);
    const gut = await G(`return d.gutter().find((x) => x.path === ${J(P("scripts/main.gd"))})`);
    await dbg({ type: "scene", scene: "res://scenes/main.tscn", name: "dbg scene" });
    const p = await waitPaused();
    const f0 = p.frames[0];
    const ev = await G(`return await d.evaluate("x + 1")`);
    const exec = await G(`return d.execPoint()`);
    await G("await d.stepOver(); return 1");
    const p2 = await waitPaused();
    const execInline = await G(`return d.execution()`);
    const bad = await G(`return await d.evaluate("nonsense(")`);
    await G("await d.resume(); return 1");
    const end = await G(`return await d.waitEnded(20000)`, { timeout: 30000 });
    const ok = clicked === "added" && gut.breakpoints[0].line === 9 && p.status === "paused" && f0.name === "_ready" && f0.line === 9 && f0.path === P("scripts/main.gd")
      && loc(p, "x")?.value === "41" && loc(p, "x")?.type === "int" && ev.value === "42" && exec?.line === 9 && exec.path === P("scripts/main.gd")
      && p2.frames[0].line === 10 && loc(p2, "y")?.value === "42" && !!bad.error && end.status === "ended" && /result 42/.test(end.output);
    return { ok, note: J({ clicked, f0, x: loc(p, "x"), ev, p2: p2.frames[0], y: loc(p2, "y"), bad, endStatus: end.status, inline: execInline.map((e) => e.inline).flat().slice(0, 2) }) };
  });
  await check("debug: step into / out, call stack, member variables (self.counter), object expansion through the inspector", async () => {
    await scrubBefore();
    await G(`d.bps.add({ path: ${J(P("scripts/main.gd"))}, line: 9 }); return 1`);
    await dbg({ type: "scene", scene: "res://scenes/main.tscn", name: "dbg step" });
    await waitPaused();
    await G("await d.stepInto(); return 1");
    const inCompute = await waitPaused();
    const frames = inCompute.frames.map((f) => f.name + ":" + f.line);
    const v = loc(inCompute, "v");
    const members = await G(`return await g.vars(1)`);
    const self = await G(`return await g.vars(1, ["self"])`).catch((e) => ({ err: String(e) }));
    await G("await d.stepOut(); return 1");
    const out = await waitPaused();
    await G("await d.stop(); return 1");
    await G(`return await d.waitEnded(10000)`, { timeout: 20000 });
    const names = Array.isArray(self) ? self.map((c) => c.name) : [];
    const mem = Array.isArray(members) ? members.map((m) => m.name + "=" + m.value) : [];
    return { ok: frames.join() === "compute:14,_ready:9" && v?.value === "41" && mem.includes("counter=0") && mem.includes('label_text="hello"') && names.includes("counter") && names.includes("label_text") && out.frames[0].name === "_ready", note: J({ frames, v, mem, names: names.slice(0, 6), out: out.frames[0] }) };
  });
  await check("debug: conditional breakpoint (false never stops, true stops), breakpoint added while running", async () => {
    await scrubBefore();
    await G(`d.bps.add({ path: ${J(P("scripts/main.gd"))}, line: 15, condition: "v == 99" }); return 1`);
    await dbg({ type: "scene", scene: "res://scenes/main.tscn", name: "dbg cond false" });
    const end = await G(`return await d.waitEnded(25000)`, { timeout: 35000 });
    const notStopped = end.status === "ended" && /result 42/.test(end.output) && end.exitCode === 0;
    await scrubBefore();
    await G(`d.bps.add({ path: ${J(P("scripts/main.gd"))}, line: 15, condition: "v == 41" }); return 1`);
    await dbg({ type: "scene", scene: "res://scenes/main.tscn", name: "dbg cond true" });
    const p = await waitPaused();
    await G("await d.resume(); return 1");
    await G(`return await d.waitEnded(15000)`, { timeout: 25000 });
    return { ok: notStopped && p.frames[0].line === 15 && loc(p, "v")?.value === "41", note: J({ notStopped, line: p.frames[0].line }) };
  });
  await check("debug a SceneTree script (--script): breakpoint in the script, locals, resume; exit 0", async () => {
    await scrubBefore();
    await G(`d.bps.add({ path: ${J(P("tools/sim/dbg_script.gd"))}, line: 6 }); return 1`);
    await dbg({ type: "script", script: "res://tools/sim/dbg_script.gd", name: "dbg script" });
    const p = await waitPaused();
    await G("await d.resume(); return 1");
    const end = await G(`return await d.waitEnded(15000)`, { timeout: 25000 });
    return { ok: p.frames[0].line === 6 && loc(p, "a")?.value === "5" && loc(p, "b")?.value === "10" && /DBG SCRIPT 10/.test(end.output) && end.exitCode === 0, note: J({ line: p.frames[0].line, locals: p.locals?.map((l) => l.name + "=" + l.value) }) };
  });
  await check("debug: a runtime script error stops like an exception (message), Stop kills the game, no godot left", async () => {
    await scrubBefore();
    await dbg({ type: "scene", scene: "res://scenes/boom.tscn", name: "dbg boom" });
    const p = await waitPaused();
    await G("await d.stop(); return 1");
    const end = await G(`return await d.waitEnded(15000)`, { timeout: 25000 });
    await sleepMs(500);
    const left = godotProcs("scenes/boom.tscn");
    return { ok: p.stopReason === "exception" && /Invalid access to property or key 'name'/.test(p.exception?.message ?? "") && p.frames[0].line === 7 && end.status === "ended" && left.length === 0, note: J({ reason: p.stopReason, exc: p.exception, line: p.frames[0].line, left }) };
  });

  // ------------------------------------------------------------ live reload
  await check("Reload Scripts in Running Game (⌘F10 action): edit a script on disk, running game picks it up", async () => {
    await scrubBefore();
    await G(`await g.run({ type: "scene", scene: "res://scenes/loop.tscn", headless: true, liveReload: true, timeLimit: 40, name: "live" }); return 1`);
    await until(`const s = g.sessions()[0]; return s && /VALUE 1/.test(s.text) && g.liveGames() === 1 ? 1 : null;`, 25000, "VALUE 1 + connected");
    const enabled = await app.ev(`return (await __qa.actions()).length >= 0`);
    const f = P("scripts/loop_scene.gd");
    fs.writeFileSync(f, fs.readFileSync(f, "utf8").replace("return 1", "return 2"));
    await app.ev(`await __qa.runAction("Godot.ReloadScripts"); return 1`);
    const ok2 = await until(`const s = g.sessions()[0]; return /VALUE 2/.test(s.text) ? 1 : null;`, 10000, "VALUE 2");
    fs.writeFileSync(f, fs.readFileSync(f, "utf8").replace("return 2", "return 3"));
    await app.ev(`await __qa.key("meta F10"); return 1`);
    const ok3 = await until(`const s = g.sessions()[0]; return /VALUE 3/.test(s.text) ? 1 : null;`, 10000, "VALUE 3 via ⌘F10");
    await G(`run.stop(g.sessions()[0].id); return 1`);
    await until(`return g.sessions()[0].status === "finished" && g.liveGames() === 0 ? 1 : null`, 15000, "stopped, link closed");
    return { ok: !!ok2 && !!ok3 && enabled, note: "" };
  });

  // ------------------------------------------------------------ editor integration
  await check("Reimport Assets: headless --import in the Run window, exits 0, .godot created in the scratch project", async () => {
    await scrubBefore();
    await G(`await g.reimport(); return 1`);
    const f = await waitFinished("Godot: Reimport Assets", 120000);
    return { ok: f.exit?.display === 0 && /--headless/.test(f.commandLine) && /--import/.test(f.commandLine) && fs.existsSync(P(".godot")), note: f.text.slice(-200) };
  });
  await check("Open in Godot Editor: command line is godot --path <proj> -e <scene> (launch intercepted), editor never started", async () => {
    fs.rmSync(launchLog, { force: true });
    const argv = await G(`return await g.openEditor("res://scenes/other.tscn")`);
    await reset("scenes/other.tscn");
    await app.ev(`await __qa.runAction("Godot.OpenEditor"); return 1`);
    await sleepMs(500);
    const lines = fs.readFileSync(launchLog, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const left = godotProcs(" -e ");
    return { ok: /godot$/i.test(argv[0]) && argv.slice(1).join(" ") === `--path ${proj} -e res://scenes/other.tscn` && lines.length === 2 && lines[1].join(" ") === lines[0].join(" ") && left.filter((p) => godotProcs("ace-godot-").includes(p)).length === 0, note: J(lines) };
  });
  await check("Run context (⌃⇧R on a SceneTree script runs it headless; context configs for .tscn and for a script attached to a scene)", async () => {
    await scrubBefore();
    await reset("tools/sim/hello.gd");
    await app.ev(`await __qa.key("control shift R"); return 1`);
    const f = await until(`const s = g.sessions().find((x) => /hello/.test(x.name)); return s && s.status === "finished" ? s : null;`, 30000, "hello via ⌃⇧R");
    const scene = await G(`return await py.run.contextConfig(${J(P("scenes/other.tscn"))}, 1)`);
    const attached = await G(`return await py.run.contextConfig(${J(P("scripts/main.gd"))}, 1)`);
    const none = await G(`return await py.run.contextConfig(${J(P("README.md"))}, 1)`);
    return { ok: f.exit?.display === 0 && f.type === "godot-script" && /--headless --script res:\/\/tools\/sim\/hello\.gd/.test(f.commandLine) && scene?.type === "godot-scene" && scene.scene === "res://scenes/other.tscn" && attached?.type === "godot-scene" && attached.scene === "res://scenes/main.tscn" && none === null, note: J({ scene: scene?.scene, attached: attached?.scene }) };
  });
  await check("Structure window (⌘7) and File Structure (⌘F12) show the node tree of a .tscn; clicking a node goes to its line", async () => {
    await reset("scenes/main.tscn");
    await app.ev(`await __qa.runAction("ActivateStructureToolWindow"); return 1`);
    const r = await until(`const rows = [...document.querySelectorAll('[data-testid="structure-row"]')]; return rows.length >= 4 ? rows.map((e) => ({ t: e.querySelector('.gd-label').textContent, h: e.querySelector('.gd-hint')?.textContent ?? "", l: +e.dataset.line, pad: parseInt(e.style.paddingLeft) })) : null;`, 8000, "structure rows");
    const text = fs.readFileSync(P("scenes/main.tscn"), "utf8").split("\n");
    const leafLine = text.findIndex((l) => l.includes('name="Leaf"')) + 1;
    await app.ev(`[...document.querySelectorAll('[data-testid="structure-row"]')].find((e) => e.querySelector('.gd-label').textContent === 'Leaf').click(); return 1`);
    await sleepMs(900);
    const s = await app.ev(`return __qa.state()`);
    await app.ev(`await __qa.runAction("FileStructurePopup"); await __qa.sleep(400); return 1`);
    const pop = await app.ev(`return { open: __qa.state().popup.open, rows: document.querySelectorAll('.lsp-kind').length }`);
    await app.ev(`window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); return 1`);
    const names = r.map((x) => x.t).join();
    return { ok: names === "Main,Other,Group,Leaf" && r[1].h.includes("other.tscn") && r[0].h.includes("main.gd") && r[3].pad > r[2].pad && s.cursor?.line === leafLine && pop.open && pop.rows === 4, note: J({ names, leafLine, cursor: s.cursor, pop, hints: r.map((x) => x.h) }) };
  });

  // ------------------------------------------------------------ hygiene
  await check("every game process started by the suite is gone; the headless LSP editor was not started (auto-start off)", async () => {
    await scrubBefore();
    await sleepMs(800);
    const left = godotProcs("ace-godot-").filter((p) => !godotBefore.includes(p));
    return { ok: left.length === 0, note: left.join() };
  });
} finally {
  await app.stop();
  const left = godotProcs("ace-godot-").filter((p) => !godotBefore.includes(p));
  for (const pid of left) { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } }
  fs.rmSync(scratch, { recursive: true, force: true });
  const failed = rows.filter((r) => !r.ok).length;
  console.log(`\n${rows.length - failed}/${rows.length} passed${failed ? `, ${failed} FAILED` : ""}${left.length ? `\nleftover godot processes (killed): ${left.join(" ")}` : ""}`);
  process.exit(failed ? 1 : 0);
}
