#!/usr/bin/env node
// Gradle tool window suite (docs/GRADLE.md). Drives the app only through the ATELIER_AUTOMATION harness (never the real keyboard/mouse).
// Scratch Gradle projects live under TMPDIR; their wrapper points at a distribution already in ~/.gradle/wrapper/dists (nothing is downloaded),
// copied from ~/IdeaProjects/Thematic-Collections' wrapper (read only). Remote part: scratch dir /tmp/ace-qa-gradle-<pid> on `mc` (removed afterwards).
// Usage: node scripts/qa/gradle.mjs [--no-remote] [--thematic]      Env: ATELIER_BIN
//   --thematic: ONLY measure discovery on ~/IdeaProjects/Thematic-Collections (read only; nothing is run or written there) and exit.
import { execFileSync, execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { launch, sleep } from "./lib.mjs";

const args = process.argv.slice(2);
const real = path.join(os.homedir(), "IdeaProjects/Thematic-Collections");
const daemonPids = () => { try { return execSync("ps -axo pid,command | grep '[G]radleDaemon'", { encoding: "utf8" }).split("\n").filter(Boolean).map((l) => +l.trim().split(/\s+/)[0]); } catch { return []; } };
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const daemonsBefore = daemonPids();
console.log("gradle daemons before:", daemonsBefore.join(" ") || "(none)");

const rows = [];
async function check(name, fn) {
  let ok = false, note = "";
  try { const r = await fn(); ok = r === true || (r && r.ok); note = r && r.note ? r.note : ""; } catch (e) { note = String(e.message || e).split("\n")[0].slice(0, 300); }
  rows.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${note ? "  - " + note : ""}`);
}
const G = (app, b, o) => app.ev(`const g = await __qa.gradle(); const py = await __qa.py(); const run = py.run; ${b}`, o);
// the harness answers within 30 s, so long waits poll with short evals
async function until(app, expr, ms = 300000) {
  const t0 = Date.now();
  for (;;) {
    const r = await G(app, `const t0 = Date.now(); while (Date.now() - t0 < 20000) { const r = (() => { ${expr} })(); if (r) return r; await __qa.sleep(100); } return null;`);
    if (r) return r;
    if (Date.now() - t0 > ms) throw new Error("timeout waiting for: " + expr.slice(0, 120));
  }
}
const waitReady = (app, ms = 300000) => until(app, `const s = g.state(); return s.detected && (s.status === "ready" || s.status === "error") ? s : null;`, ms);
const waitDone = async (app, sid, ms = 240000) => { await until(app, `return run.session(${JSON.stringify(sid)}).status === "finished" ? true : null;`, ms); return G(app, `return await run.waitDone(${JSON.stringify(sid)}, 5000)`); };

function wrapperFiles(dest) {
  fs.mkdirSync(path.join(dest, "gradle/wrapper"), { recursive: true });
  fs.copyFileSync(path.join(real, "gradlew"), path.join(dest, "gradlew"));
  fs.chmodSync(path.join(dest, "gradlew"), 0o755);
  fs.copyFileSync(path.join(real, "gradle/wrapper/gradle-wrapper.jar"), path.join(dest, "gradle/wrapper/gradle-wrapper.jar"));
  fs.copyFileSync(path.join(real, "gradle/wrapper/gradle-wrapper.properties"), path.join(dest, "gradle/wrapper/gradle-wrapper.properties"));
}

if (args.includes("--thematic")) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ace-gradle-them-"));
  const status0 = execSync("git status --porcelain | sort | md5", { cwd: real, encoding: "utf8", shell: "/bin/zsh" });
  const app = await launch(real, { dataDir });
  try {
    await app.ev(`await __qa.waitFor(() => document.querySelector('.statusbar'), 15000); return 1`);
    const t0 = Date.now();
    const s = await waitReady(app, 1200000);
    console.log("COLD", JSON.stringify({ ms: Date.now() - t0, ...s, projects: s.projects.length }));
    const info = await G(app, `g.expandAll(); await __qa.sleep(300); const m = g.model(); if (!m) return null; const th = m.projects.map(p => ({ p: p.path, t: p.tasks.filter(t => t.group === "thematic").map(t => t.name) })).filter(x => x.t.length); return { th, included: m.includedBuilds }; `);
    console.log("thematic group:", JSON.stringify(info));
    const t1 = Date.now();
    const d0 = (await G(app, `return g.state().discoveries`));
    await G(app, `g.reload(); return 1`);
    const s2 = await until(app, `const s = g.state(); return s.discoveries > ${d0} && (s.status === "ready" || s.status === "error") ? s : null;`, 1200000);
    console.log("WARM reload", JSON.stringify({ ms: Date.now() - t1, lastMs: s2.lastMs, daemonPid: s2.daemonPid }));
  } finally { await app.stop(); }
  const app2 = await launch(real, { dataDir });
  try {
    await app2.ev(`await __qa.waitFor(() => document.querySelector('.statusbar'), 15000); return 1`);
    const s3 = await waitReady(app2, 120000);
    console.log("REOPEN (cache)", JSON.stringify({ fromCache: s3.fromCache, discoveries: s3.discoveries }));
  } finally { await app2.stop(); }
  const status1 = execSync("git status --porcelain | sort | md5", { cwd: real, encoding: "utf8", shell: "/bin/zsh" });
  console.log("repo status unchanged:", status0 === status1, "| .ace exists:", fs.existsSync(path.join(real, ".ace")));
  console.log("daemons alive:", daemonsBefore.map((p) => `${p}:${alive(p)}`).join(" "));
  process.exit(0);
}

// ---------------------------------------------------------------- scratch project
const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ace-gradle-")));
const P = (...p) => path.join(scratch, ...p);
fs.mkdirSync(P("app"), { recursive: true }); fs.mkdirSync(P("lib")); fs.mkdirSync(P("src"));
wrapperFiles(scratch);
fs.writeFileSync(P("settings.gradle"), "rootProject.name = 'demo'\ninclude 'app', 'lib'\n");
fs.writeFileSync(P("build.gradle"), `
tasks.register('hello') { group = 'ace'; description = 'Prints the hello marker'; doLast { println 'ACE_MARKER_HELLO' } }
tasks.register('badJava') { group = 'ace'; description = 'Fails with a javac style error'; doLast {
  System.err.println(projectDir.path + '/src/Bad.java:12: error: cannot find symbol'); throw new GradleException('compile failed') } }
tasks.register('badKotlin') { group = 'ace'; doLast { println 'e: file://' + projectDir.path + '/src/Bad.kt:7:3 Unresolved reference: foo'; throw new GradleException('kt failed') } }
tasks.register('slow') { group = 'ace'; description = 'Sleeps'; doLast { println 'SLOW_START'; Thread.sleep(120000) } }
tasks.register('noGroup') { description = 'Task without a group' }
`);
fs.writeFileSync(P("app/build.gradle"), "tasks.register('appRun') { group = 'application'; description = 'Runs the app'; doLast { println 'ACE_MARKER_APP' } }\n");
fs.writeFileSync(P("lib/build.gradle"), "tasks.register('libCheck') { group = 'verification'; description = 'Checks the lib' }\n");
fs.writeFileSync(P("src/Bad.java"), Array.from({ length: 20 }, (_, i) => `// line ${i + 1}`).join("\n") + "\n");
fs.writeFileSync(P("src/Bad.kt"), Array.from({ length: 20 }, (_, i) => `// kt ${i + 1}`).join("\n") + "\n");
const plain = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ace-plain-")));
fs.writeFileSync(path.join(plain, "a.txt"), "x\n");
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ace-gradle-data-"));
const cfgPath = P(".ace/config.json");
const exp = (o) => JSON.stringify(o, null, 2) + "\n";
const readCfg = () => (fs.existsSync(cfgPath) ? fs.readFileSync(cfgPath, "utf8") : null);
const waitCfg = async (pred, ms = 8000) => { const t = Date.now(); while (Date.now() - t < ms) { const c = readCfg(); if (c !== null && pred(c)) return c; await sleep(100); } return readCfg(); };
const waitPins = (app, n, ms = 8000) => G(app, `const t0 = Date.now(); while (g.pins().length !== ${n} && Date.now() - t0 < ${ms}) await __qa.sleep(50); return g.pins();`, { timeout: ms + 5000 });

let app = await launch(scratch, { dataDir });
try {
  await app.ev(`await __qa.waitFor(() => document.querySelector('.statusbar'), 15000); return 1`);
  let tCold = Date.now();
  await check("Gradle project detected: tool window appears by itself, tree loads from discovery", async () => {
    const s = await waitReady(app);
    const btn = await app.ev(`return !!document.querySelector('.stripe.right .stripe-btn[title^="Gradle"]')`);
    return { ok: s.status === "ready" && s.name === "demo" && !s.fromCache && s.discoveries === 1 && btn && s.projects.includes(":app") && s.projects.includes(":lib"), note: JSON.stringify({ ...s, ms: Date.now() - tCold, btn }) };
  });
  await check("discovery ran offline against the existing wrapper distribution, reporting the daemon pid", async () => {
    const s = await G(app, `return g.state()`);
    return { ok: s.offline === true && /^\d+$/.test(String(s.daemonPid)) && s.version === "9.8.0", note: JSON.stringify(s) };
  });
  await check("Gradle stripe button opens the window; tree shows root project, Tasks, subprojects", async () => {
    await app.ev(`document.querySelector('.stripe.right .stripe-btn[title^="Gradle"]').click(); await __qa.waitFor('[data-testid="gradle-window"]', 4000); return 1`);
    const r = await G(app, `return g.rows()`);
    const ids = r.map((x) => x.id);
    return { ok: ids.includes("proj::") && ids.includes("tasks::") && ids.includes("proj:app:") === false && ids.includes("proj::app") && ids.includes("proj::lib"), note: ids.join(",") };
  });
  await check("groups (ace/application/verification/other), tasks and description tooltips", async () => {
    const r = await G(app, `g.expandAll(); await __qa.sleep(300); return g.rows()`);
    const hello = r.find((x) => x.id === "task::hello");
    const labels = r.filter((x) => x.kind === "group").map((x) => x.text);
    const other = r.findIndex((x) => x.id === "group:::other"), ace = r.findIndex((x) => x.id === "group:::ace");
    return { ok: hello?.title === "Prints the hello marker" && labels.includes("ace") && labels.includes("application") && labels.includes("verification") && labels.includes("Build Setup") && labels.includes("help") && other > ace && r.some((x) => x.id === "task::noGroup") && r.some((x) => x.id === "task::app:appRun" && x.title === "Runs the app"), note: labels.join(",") };
  });
  await check("no .ace/ and no other file written into the project by discovery", async () => {
    const names = fs.readdirSync(scratch).filter((n) => !["app", "lib", "src", "gradle", "gradlew", "settings.gradle", "build.gradle", ".gradle"].includes(n));
    return { ok: names.length === 0 && !fs.existsSync(P(".ace")), note: names.join(",") };
  });
  await check("non-Gradle project: no tool window, no discovery; back to the Gradle project = cache hit, no spawn", async () => {
    const before = (await G(app, `return g.state().discoveries`));
    await app.ev(`await __qa.openProject(${JSON.stringify(plain)}); await __qa.sleep(600); return 1`);
    const mid = await G(app, `return g.state()`);
    const btn1 = await app.ev(`return !!document.querySelector('.stripe.right .stripe-btn[title^="Gradle"]')`);
    await app.ev(`await __qa.openProject(${JSON.stringify(scratch)}); return 1`);
    const s = await waitReady(app, 30000);
    const btn2 = await app.ev(`return !!document.querySelector('.stripe.right .stripe-btn[title^="Gradle"]')`);
    return { ok: !mid.detected && !btn1 && btn2 && s.fromCache && s.discoveries === before, note: JSON.stringify({ mid: mid.detected, btn1, btn2, fromCache: s.fromCache, before, after: s.discoveries }) };
  });
  await check("run a task (double-click): Run window output, marker, exit 0, temporary gradle config", async () => {
    await app.ev(`document.querySelector('.stripe.right .stripe-btn[title^="Gradle"]')?.click(); await __qa.sleep(200); const gw = document.querySelector('[data-testid="gradle-window"]'); if (!gw) document.querySelector('.stripe.right .stripe-btn[title^="Gradle"]').click(); await __qa.waitFor('[data-testid="gradle-window"]', 4000); return 1`);
    await G(app, `g.expandAll(); await __qa.sleep(300); return 1`);
    await app.ev(`const e = document.querySelector('[data-row="task::hello"]'); e.dispatchEvent(new MouseEvent("mousedown", {bubbles: true})); e.dispatchEvent(new MouseEvent("dblclick", {bubbles: true})); return 1`);
    const sid = await G(app, `const t0 = Date.now(); while (!run.sessions().length && Date.now() - t0 < 5000) await __qa.sleep(50); return run.sessions()[0]?.id`);
    const d = await waitDone(app, sid);
    const t = await G(app, `return run.text(${JSON.stringify(sid)})`);
    const cfgs = await G(app, `return run.configs()`);
    const st = await app.ev(`return __qa.state().toolWindows`);
    return { ok: d.exit === 0 && t.includes("ACE_MARKER_HELLO") && /BUILD SUCCESSFUL/.test(t) && cfgs.some((c) => c.type === "gradle" && c.temporary && c.tasks === ":hello") && st.bottom === "run", note: JSON.stringify({ exit: d.exit, cmd: d.commandLine, tail: t.slice(-160), tw: st }) };
  });
  await check("rerun in the same tab runs the build again", async () => {
    const sid = await G(app, `return run.sessions()[0].id`);
    await G(app, `await run.rerun(${JSON.stringify(sid)}); return 1`);
    const d = await waitDone(app, sid);
    const t = await G(app, `return run.text(${JSON.stringify(sid)})`);
    return { ok: d.exit === 0 && t.includes("ACE_MARKER_HELLO"), note: t.slice(-80) };
  });
  await check("Enter in the Gradle window runs the selected task (tool-window scoped key)", async () => {
    const before = await G(app, `return run.sessions().length`);
    await app.ev(`document.querySelector('[data-testid="gradle-tree"]').focus(); return 1`);
    await G(app, `g.select("task::app:appRun"); await __qa.sleep(100); return 1`);
    await app.ev(`__qa.key("ENTER"); return 1`);
    const sid = await G(app, `const t0 = Date.now(); while (run.sessions().length <= ${before} && Date.now() - t0 < 5000) await __qa.sleep(50); return run.sessions().at(-1).id`);
    const d = await waitDone(app, sid);
    const t = await G(app, `return run.text(${JSON.stringify(sid)})`);
    return { ok: d.exit === 0 && t.includes("ACE_MARKER_APP"), note: d.commandLine };
  });
  await check("javac-style error line becomes a link that opens the file at the line", async () => {
    const sid = await G(app, `return await run.start((await run.ensure({type: "gradle", name: "bj", tasks: ":badJava", args: "", workingDir: "", env: []})).id)`);
    const d = await waitDone(app, sid);
    const links = await G(app, `return await run.links(${JSON.stringify(sid)})`);
    const l = links.find((x) => x.path.endsWith("Bad.java"));
    if (!l || l.line !== 12 || l.resolved !== P("src/Bad.java")) return { ok: false, note: JSON.stringify({ exit: d.exit, links }) };
    await app.ev(`const c = document.querySelector(".run-console"); c.scrollTop = 0; c.dispatchEvent(new Event("scroll")); await __qa.waitFor(() => [...document.querySelectorAll(".run-link")].some(x => x.dataset.path.endsWith("Bad.java")), 6000); [...document.querySelectorAll(".run-link")].find(x => x.dataset.path.endsWith("Bad.java")).click(); return 1`);
    await sleep(800);
    const s = await app.ev(`return __qa.state()`);
    return { ok: d.exit !== 0 && s.tabs.some((g) => g.tabs.some((t) => t.name === "Bad.java")) && s.cursor.line === 12, note: JSON.stringify({ exit: d.exit, cursor: s.cursor }) };
  });
  await check("kotlin `e: file:///...Bad.kt:7:3` error resolves to the file", async () => {
    const sid = await G(app, `return await run.start((await run.ensure({type: "gradle", name: "bk", tasks: ":badKotlin", args: "", workingDir: "", env: []})).id)`);
    await waitDone(app, sid);
    const links = await G(app, `return await run.links(${JSON.stringify(sid)})`);
    const l = links.find((x) => x.path.endsWith("Bad.kt"));
    return { ok: !!l && l.line === 7 && l.col === 3 && l.resolved === P("src/Bad.kt"), note: JSON.stringify(links) };
  });
  let slowId;
  await check("stop (Stop action key) cancels the build gracefully; the client ends, daemons survive", async () => {
    slowId = await G(app, `return await run.start((await run.ensure({type: "gradle", name: "slow", tasks: ":slow", args: "", workingDir: "", env: []})).id)`);
    await until(app, `return run.text(${JSON.stringify(slowId)}).includes("SLOW_START") ? true : null;`, 120000);
    const pidsBefore = daemonPids();
    await app.ev(`__qa.key("meta F2"); return 1`);
    const d = await waitDone(app, slowId);
    const t = await G(app, `return run.text(${JSON.stringify(slowId)})`);
    const stillThere = pidsBefore.filter((p) => !alive(p));
    return { ok: d.stopRequested && d.exit !== 0 && stillThere.length === 0 && !/SLOW_END/.test(t), note: JSON.stringify({ exit: d.exit, signal: d.signal, daemonsLost: stillThere, tail: t.slice(-200) }) };
  });
  await check("no leftover Gradle client process for the scratch project", async () => {
    await sleep(1500);
    const out = execSync(`ps -axo pid,command | grep -F 'GradleWrapperMain' | grep -F ${JSON.stringify(scratch)} | grep -v grep || true`, { encoding: "utf8" });
    return { ok: out.trim() === "", note: out.slice(0, 200) };
  });

  // ---- pinning
  await check("pin a task (Pin action): .ace/config.json is created with the exact JSON; Pinned section shows it", async () => {
    await app.ev(`document.querySelector('[data-testid="gradle-tree"]').focus(); return 1`);
    await G(app, `g.select("task::hello"); await __qa.sleep(100); return 1`);
    await app.ev(`__qa.runAction("Gradle.Pin"); return 1`);
    const c = await waitCfg((x) => x.includes(":hello"));
    const rowsNow = await G(app, `await __qa.sleep(200); return g.rows().filter(r => r.kind.startsWith("pinned")).map(r => r.text)`);
    return { ok: c === exp({ version: 1, gradle: { pinned: [{ task: ":hello" }] } }) && rowsNow.join() === "Pinned,:hello", note: JSON.stringify({ c, rowsNow }) };
  });
  await check("pin with args + label via the toolbar pin button; stable key order, pretty printed", async () => {
    await G(app, `g.select("task::app:appRun"); await __qa.sleep(100); return 1`);
    await app.ev(`document.querySelector('[data-act="pin"]').click(); return 1`);
    await waitCfg((x) => x.includes("appRun"));
    await G(app, `await g.pin(":lib:libCheck", "--info", "Check lib"); return 1`);
    const c = await waitCfg((x) => x.includes("libCheck"));
    return { ok: c === exp({ version: 1, gradle: { pinned: [{ task: ":hello" }, { task: ":app:appRun" }, { task: ":lib:libCheck", args: "--info", name: "Check lib" }] } }), note: c };
  });
  await check("unpin with Delete (tool-window key) removes it from the file", async () => {
    await app.ev(`document.querySelector('[data-testid="gradle-tree"]').focus(); return 1`);
    await G(app, `const r = g.rows().find(r => r.kind === "pinned" && r.text === ":app:appRun"); g.select(r.id); await __qa.sleep(100); return 1`);
    await app.ev(`__qa.key("DELETE"); return 1`);
    const c = await waitCfg((x) => !x.includes("appRun"));
    return { ok: c === exp({ version: 1, gradle: { pinned: [{ task: ":hello" }, { task: ":lib:libCheck", args: "--info", name: "Check lib" }] } }), note: c };
  });
  await check("external edit of .ace/config.json reloads the pinned list; unknown keys survive the next write", async () => {
    fs.writeFileSync(cfgPath, JSON.stringify({ version: 1, team: { note: "keep me" }, gradle: { other: true, pinned: [{ task: ":app:appRun", args: "-q" }, { task: ":hello" }] } }, null, 2) + "\n");
    const pins = await G(app, `const t0 = Date.now(); while (!g.pins().some(p => p.task === ":app:appRun") && Date.now() - t0 < 8000) await __qa.sleep(50); return g.pins()`, { timeout: 15000 });
    if (JSON.stringify(pins) !== JSON.stringify([{ task: ":app:appRun", args: "-q" }, { task: ":hello" }])) return { ok: false, note: JSON.stringify({ pins, repo: await G(app, `return g.repo()`), file: readCfg() }) };
    await G(app, `await g.unpin(":hello"); return 1`);
    const c = await waitCfg((x) => !x.includes(":hello"));
    return { ok: c === exp({ version: 1, team: { note: "keep me" }, gradle: { other: true, pinned: [{ task: ":app:appRun", args: "-q" }] } }), note: c };
  });
  await check("invalid .ace/config.json is never overwritten and the error is shown", async () => {
    fs.writeFileSync(cfgPath, "{ nope");
    await sleep(800);
    let rejected = false;
    await G(app, `try { await g.pin(":hello"); return "wrote"; } catch (e) { return "rejected"; }`).then((r) => { rejected = r === "rejected"; });
    const still = readCfg();
    const shown = await app.ev(`return !!document.querySelector('.gj-err')`);
    fs.writeFileSync(cfgPath, exp({ version: 1, gradle: { pinned: [{ task: ":hello" }, { task: ":app:appRun", args: "-q" }] } }));
    await waitPins(app, 2);
    return { ok: rejected && still === "{ nope" && shown, note: JSON.stringify({ rejected, still, shown }) };
  });
  await check("pinned tasks appear in the Run widget dropdown; clicking one runs it", async () => {
    await app.ev(`document.querySelector('[data-testid="run-widget"] [data-act="more"]').click(); await __qa.waitFor('[data-testid="run-menu"]', 3000); return 1`);
    const items = await app.ev(`return [...document.querySelectorAll('[data-widget-item]')].map(e => e.textContent)`);
    const before = await G(app, `return run.sessions().length`);
    // picking a pinned item selects it (temporary config, shown in the widget); the run button then runs it
    await app.ev(`document.querySelector('[data-widget-item="gradle-pin-0"]').click(); await __qa.sleep(300); return 1`);
    const selected = await G(app, `return run.sessions().length === ${before} && /hello/.test(run.widget().name)`);
    await app.ev(`document.querySelector('[data-testid="run-widget"] [data-act="run"]').click(); return 1`);
    const sid = await G(app, `await __qa.sleep(500); return run.sessions().find(s => s.active).id`);
    const d = await waitDone(app, sid);
    const t = await G(app, `return run.text(${JSON.stringify(sid)})`);
    return { ok: selected && items.length === 2 && /:hello/.test(items[0]) && /ACE_MARKER_HELLO/.test(t) && d.exit === 0, note: JSON.stringify({ items, before }) };
  });
  await check("Execute Gradle Task popup fuzzy-matches tasks and runs the pick", async () => {
    await app.ev(`__qa.runAction("Gradle.ExecuteTask"); await __qa.waitFor('[data-testid="gradle-exec-input"]', 3000); document.querySelector('[data-testid="gradle-exec-input"]').focus(); await __qa.type("appr"); await __qa.sleep(250); return 1`);
    const list = await app.ev(`return [...document.querySelectorAll('[data-testid="gradle-exec-list"] [data-task]')].map(e => e.dataset.task)`);
    const before = await G(app, `return run.sessions().length`);
    await app.ev(`__qa.key("ENTER"); return 1`);
    const sid = await G(app, `await __qa.sleep(500); return run.sessions().find(s => s.active).id`);
    const d = await G(app, `return await run.waitDone(${JSON.stringify(sid)}, 25000)`);
    const t = await G(app, `return run.text(${JSON.stringify(sid)})`);
    const closed = await app.ev(`return !document.querySelector('.popup')`);
    return { ok: list[0] === ":app:appRun" && d.exit === 0 && t.includes("ACE_MARKER_APP") && closed, note: JSON.stringify({ list: list.slice(0, 4), exit: d.exit }) };
  });
  await check("Gradle actions are registered for Find Action; Reload uses the IntelliJ key (⌘⇧I)", async () => {
    const a = await app.ev(`return __qa.actions().filter(x => x.id.startsWith("Gradle.") || x.id === "ActivateGradleToolWindow").map(x => [x.id, x.title, x.keys.join("|")])`);
    const ids = a.map((x) => x[0]);
    const refresh = a.find((x) => x[0] === "Gradle.Refresh");
    return { ok: ["Gradle.Refresh", "Gradle.ExecuteTask", "Gradle.RunSelected", "Gradle.Pin", "Gradle.Unpin", "Gradle.CopyPath", "ActivateGradleToolWindow"].every((i) => ids.includes(i)) && /shift meta I/i.test(refresh[2]), note: JSON.stringify(a) };
  });

  // ---- refresh on build-file change
  await check("editing a build file triggers a background refresh (new task appears); an unrelated file does not", async () => {
    const d0 = (await G(app, `return g.state().discoveries`));
    fs.writeFileSync(P("src/unrelated.txt"), "x");
    await sleep(2000);
    const dMid = (await G(app, `return g.state().discoveries`));
    fs.appendFileSync(P("build.gradle"), "tasks.register('later') { group = 'ace'; description = 'added later' }\n");
    const r = await until(app, `const s = g.state(); const has = g.model()?.projects[0].tasks.some(t => t.name === "later"); return has && s.status === "ready" ? {has, d: s.discoveries} : null;`);
    return { ok: dMid === d0 && r.has && r.d === d0 + 1, note: JSON.stringify({ d0, dMid, r }) };
  });
  await check("Reload (toolbar button) re-runs discovery with the shared daemon (same or existing pid)", async () => {
    const before = await G(app, `return g.state()`);
    await app.ev(`document.querySelector('[data-act="reload"]').click(); return 1`);
    await sleep(300);
    const mid = await app.ev(`return document.querySelector('[data-testid="gradle-status"]').dataset.status`);
    const s = await waitReady(app, 120000);
    return { ok: s.discoveries === before.discoveries + 1 && s.status === "ready" && daemonPids().includes(+s.daemonPid), note: JSON.stringify({ mid, daemon: s.daemonPid, ms: s.lastMs }) };
  });
  await check("a failing sync shows an error node with the output; Retry recovers", async () => {
    const orig = fs.readFileSync(P("build.gradle"), "utf8");
    fs.appendFileSync(P("build.gradle"), "\nthis is not groovy (((\n");
    const s = await until(app, `const s = g.state(); return s.status === "error" ? s : null;`);
    const shown = await app.ev(`return document.querySelector('[data-testid="gradle-error"]')?.innerText.slice(0, 200)`);
    fs.writeFileSync(P("build.gradle"), orig);
    const ok2 = await until(app, `const s = g.state(); return s.status === "ready" && !s.error ? true : null;`);
    return { ok: s.status === "error" && /build\.gradle|Script compilation|unexpected/i.test(String(s.error)) && !!shown && ok2, note: JSON.stringify({ shown, ok2 }) };
  });
  await app.stop();

  // ---- restart: cache across app launches
  app = await launch(scratch, { dataDir });
  await app.ev(`await __qa.waitFor(() => document.querySelector('.statusbar'), 15000); return 1`);
  await check("reopen the app: tree comes from the cache instantly and nothing is spawned", async () => {
    const t0 = Date.now();
    const s = await waitReady(app, 30000);
    const ms = Date.now() - t0;
    await sleep(1500);
    const s2 = await G(app, `return g.state()`);
    const ps = execSync(`ps -axo command | grep -F ace-init.gradle | grep -v grep || true`, { encoding: "utf8" });
    return { ok: s.fromCache && s2.discoveries === 0 && s2.status === "ready" && ps.trim() === "" && s2.projects.length === 3, note: JSON.stringify({ ms, discoveries: s2.discoveries, fromCache: s2.fromCache, ps }) };
  });
  await check("pinned list is loaded from .ace/config.json on open", async () => {
    const pins = await waitPins(app, 2);
    return { ok: JSON.stringify(pins) === JSON.stringify([{ task: ":hello" }, { task: ":app:appRun", args: "-q" }]), note: JSON.stringify(pins) };
  });
  await app.stop();
} finally {
  try { await app.stop(); } catch {}
}

// ---------------------------------------------------------------- remote (mc)
if (!args.includes("--no-remote")) {
  const ssh = (cmd) => execFileSync("ssh", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=8", "mc", cmd], { encoding: "utf8" });
  let usable = false;
  try { usable = ssh("test -d ~/.gradle/wrapper/dists/gradle-9.8.0-bin && command -v java >/dev/null && echo yes").trim() === "yes"; } catch {}
  if (!usable) console.log("SKIP  remote: mc unreachable or no java / gradle 9.8.0 distribution there");
  else {
    const rdir = `/tmp/ace-qa-gradle-${process.pid}`;
    const rl = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ace-gradle-r-")));
    wrapperFiles(rl);
    fs.writeFileSync(path.join(rl, "settings.gradle"), "rootProject.name = 'remote-demo'\ninclude 'sub'\n");
    fs.writeFileSync(path.join(rl, "build.gradle"), "tasks.register('hi') { group = 'ace'; description = 'remote hello'; doLast { println 'REMOTE_MARKER' } }\n");
    fs.mkdirSync(path.join(rl, "sub"));
    fs.writeFileSync(path.join(rl, "sub/build.gradle"), "tasks.register('subTask') { group = 'ace' }\n");
    ssh(`mkdir -p ${rdir}`);
    execFileSync("scp", ["-q", "-r", "-o", "BatchMode=yes", ...fs.readdirSync(rl).map((n) => path.join(rl, n)), `mc:${rdir}/`]);
    const rapp = await launch(`mc:${rdir}`);
    try {
      await rapp.ev(`await __qa.waitFor(() => document.querySelector('.statusbar'), 15000); return 1`);
      await check("remote (mc): discovery over ssh via the login shell, tree appears", async () => {
        const s = await waitReady(rapp, 300000);
        await rapp.ev(`document.querySelector('.stripe.right .stripe-btn[title^="Gradle"]').click(); await __qa.waitFor('[data-testid="gradle-window"]', 4000); return 1`);
        const r = await G(rapp, `g.expandAll(); await __qa.sleep(300); return g.rows().map(x => x.id)`);
        return { ok: s.status === "ready" && s.name === "remote-demo" && r.includes("task::hi") && r.includes("proj::sub"), note: JSON.stringify({ ...s, error: String(s.error).slice(0, 300) }) };
      });
      await check("remote (mc): run task over ssh, marker + exit 0; pin writes mc:.ace/config.json", async () => {
        const sid = await G(rapp, `return await run.start((await run.ensure({type: "gradle", name: "rhi", tasks: ":hi", args: "", workingDir: "", env: []})).id)`);
        const d = await waitDone(rapp, sid);
        const t = await G(rapp, `return run.text(${JSON.stringify(sid)})`);
        await G(rapp, `await g.pin(":hi"); return 1`);
        await sleep(500);
        const c = ssh(`cat ${rdir}/.ace/config.json`);
        return { ok: d.exit === 0 && t.includes("REMOTE_MARKER") && c === exp({ version: 1, gradle: { pinned: [{ task: ":hi" }] } }), note: JSON.stringify({ exit: d.exit, tail: t.slice(-100), c }) };
      });
    } finally {
      await rapp.stop();
      try { ssh(`case ${rdir} in /tmp/ace-qa-gradle-*) rm -rf ${rdir};; esac`); } catch {}
      fs.rmSync(rl, { recursive: true, force: true });
    }
  }
}

await check("no Gradle daemon that existed before the run was stopped", async () => {
  // a daemon that disappeared is only acceptable when ITS OWN log says Gradle expired it by policy (idle / newer compatible daemon / memory)
  const lost = daemonsBefore.filter((p) => !alive(p));
  const why = lost.map((p) => {
    const dir = path.join(os.homedir(), ".gradle/daemon");
    for (const v of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
      const f = path.join(dir, v, `daemon-${p}.out.log`);
      if (fs.existsSync(f)) { const m = fs.readFileSync(f, "utf8").match(/Storing daemon stop event: (.*)/); return { pid: p, reason: m ? m[1] : "unknown" }; }
    }
    return { pid: p, reason: "no log" };
  });
  const ours = why.filter((w) => !/other compatible daemons were started|idle|memory|expir/i.test(w.reason));
  return { ok: ours.length === 0, note: `before=${daemonsBefore.join(",")} after=${daemonPids().join(",")} lost=${JSON.stringify(why)}` };
});
fs.rmSync(scratch, { recursive: true, force: true }); fs.rmSync(plain, { recursive: true, force: true }); fs.rmSync(dataDir, { recursive: true, force: true });
const pass = rows.filter((r) => r.ok).length;
console.log(`\n${pass}/${rows.length} checks passed`);
process.exit(pass === rows.length ? 0 : 1);
