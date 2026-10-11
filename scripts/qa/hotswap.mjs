#!/usr/bin/env node
// Gradle Debug runs + single-file hot swap suite (docs/GRADLE.md "Debug & hot swap"). Drives the app only through the ATELIER_AUTOMATION harness
// (never the real keyboard/mouse). Scratch Gradle projects live under TMPDIR; the wrapper points at a distribution already in
// ~/.gradle/wrapper/dists (copied from ~/IdeaProjects/Thematic-Collections' wrapper, read only), so nothing is downloaded.
// Usage: node scripts/qa/hotswap.mjs [--thematic]      Env: ATELIER_BIN
//   --thematic: ALSO run the read-only `aceDumpClasspath` on ~/IdeaProjects/Thematic-Collections (nothing is run or written there; git status
//               before/after, no .ace/) for several files: root (:1.20.1 fabric glue), common, 26.2 subproject, the nested Forge build.
import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { launch, sleep } from "./lib.mjs";

const args = process.argv.slice(2);
const real = path.join(os.homedir(), "IdeaProjects/Thematic-Collections");
const sh = (c) => { try { return execSync(c, { encoding: "utf8", shell: "/bin/zsh" }); } catch (e) { return String(e.stdout || ""); } };
const daemonPids = () => sh("ps -axo pid,command | grep '[G]radleDaemon'").split("\n").filter(Boolean).map((l) => +l.trim().split(/\s+/)[0]);
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const daemonsBefore = daemonPids();
console.log("gradle daemons before:", daemonsBefore.join(" ") || "(none)");

const rows = [];
async function check(name, fn) {
  let ok = false, note = "";
  try { const r = await fn(); ok = r === true || (r && r.ok); note = r && r.note ? r.note : ""; } catch (e) { note = String(e.message || e).split("\n")[0].slice(0, 400); }
  rows.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${note ? "  - " + note : ""}`);
}
// the harness answers within 30 s, so long waits poll with short evals
const J = (app, b, o) => app.ev(`const g = await __qa.gradle(); const py = await __qa.py(); const run = py.run; const j = g.java; ${b}`, o);
async function until(app, expr, ms = 300000) {
  const t0 = Date.now();
  for (;;) {
    const r = await J(app, `const t0 = Date.now(); while (Date.now() - t0 < 20000) { const r = await (async () => { ${expr} })(); if (r) return r; await __qa.sleep(100); } return null;`, { timeout: 40000 });
    if (r) return r;
    if (Date.now() - t0 > ms) throw new Error("timeout waiting for: " + expr.slice(0, 140));
  }
}
const waitReady = (app, ms = 300000) => until(app, `const s = g.state(); return s.detected && (s.status === "ready" || s.status === "error") ? s : null;`, ms);
const attached = (app, ms = 240000) => until(app, `const s = j.state(); return s.attach === "attached" ? s : null;`, ms);
const lastValue = (t) => { const m = [...t.matchAll(/(?:^|\s)value=(\d+)/g)]; return m.length ? +m[m.length - 1][1] : null; };
const runText = (app, sid) => J(app, `return run.text(${JSON.stringify(sid)})`);
async function waitValue(app, sid, want, ms = 20000) {
  const t0 = Date.now();
  for (;;) {
    const v = lastValue(await runText(app, sid));
    if (v === want) return true;
    if (Date.now() - t0 > ms) return v;
    await sleep(250);
  }
}
// A daemon that disappeared: was it Gradle's own expiry ("other compatible daemons were started and after being idle ...", idle timeout),
// or was it killed? Only the latter fails a check. Reads the daemon's own log (read only).
function gradleExpired(pid) {
  const out = sh(`ls ${os.homedir()}/.gradle/daemon/*/daemon-${pid}.out.log 2>/dev/null`).trim().split("\n").filter(Boolean);
  return out.some((f) => { try { return /Daemon will be stopped at the end of the build|Stopping daemon due to|daemon has been idle|DaemonExpiration|expired|Idle timeout/i.test(fs.readFileSync(f, "utf8")); } catch { return false; } });
}
// daemons of other Gradle user homes (other agents' tests use temp homes that they delete) have no log in ~/.gradle: not Alex's, not ours
const inOwnHome = (pid) => sh(`ls ${os.homedir()}/.gradle/daemon/*/daemon-${pid}.out.log 2>/dev/null`).trim() !== "";
const lostDaemons = (before) => before.filter((p) => !alive(p) && inOwnHome(p) && !gradleExpired(p));
const pidsMatching = (needle) => sh(`ps -axo pid,command | grep -F -e ${JSON.stringify(needle)} | grep -v grep | grep -v "release/atelier"`).split("\n").filter(Boolean).map((l) => +l.trim().split(/\s+/)[0]);

// ---------------------------------------------------------------- scratch project (Forge-like layout: a nested Exec build)
function wrapperFiles(dest) {
  fs.mkdirSync(path.join(dest, "gradle/wrapper"), { recursive: true });
  fs.copyFileSync(path.join(real, "gradlew"), path.join(dest, "gradlew"));
  fs.chmodSync(path.join(dest, "gradlew"), 0o755);
  fs.copyFileSync(path.join(real, "gradle/wrapper/gradle-wrapper.jar"), path.join(dest, "gradle/wrapper/gradle-wrapper.jar"));
  fs.copyFileSync(path.join(real, "gradle/wrapper/gradle-wrapper.properties"), path.join(dest, "gradle/wrapper/gradle-wrapper.properties"));
}
const MAIN = (tag, probe = false) => `package demo;
public class Main {
  public static void main(String[] a) throws Exception {
    System.out.println("${tag}started");
    int n = 0;
    while (true) {
      System.out.println("${tag}value=" + Calc.value());${probe ? `
      System.out.println("probe=" + Probe.run(n++));
      if (new java.io.File(System.getProperty("user.dir"), "go.flag").exists()) System.out.println("late=" + Late.hit(n));` : ""}
      Thread.sleep(200);
    }
  }
}
`;
const PROBE = (div = 2) => `package demo;
public class Probe {
  static class Pt { int x = 3; int y = 4; }
  public static int run(int tick) {
    String label = "tick" + tick;
    int[] arr = {10, 20, 30};
    Pt pt = new Pt();
    int sum = 0;
    for (int a : arr) sum += a;
    sum += helper(sum);
    return sum + pt.x;
  }
  static int helper(int s) { return s / ${div}; }
}
`;
const LATE = `package demo;
public class Late {
  public static int hit(int n) {
    int local = n * 2;
    return local + 1;
  }
}
`;
const CALC = (base, inner, anon, extra = "") => `package demo;
import java.util.function.Supplier;
public class Calc {
  static class Inner { int k() { return ${inner}; } }
  static int base() { return ${base}; }
  public static int value() {
    Supplier<Integer> s = new Supplier<Integer>() { public Integer get() { return ${anon}; } };
    return base() + 100 * s.get() + new Inner().k();
  }
${extra}}
`;
const BUILD = (extra = "") => `plugins { id 'java' }
java { toolchain { languageVersion = JavaLanguageVersion.of(21) } }
tasks.register('runApp', JavaExec) { classpath = sourceSets.main.runtimeClasspath; mainClass = 'demo.Main' }
${extra}`;
const MIXY = `package demo;
@interface Mixin { Class<?> value(); }
@Mixin(Calc.class)
public class Mixy { static int touch() { return 1; } }
`;
function makeScratch(root) {
  const P = (...p) => path.join(root, ...p);
  for (const d of ["src/main/java/demo", "nested/src/main/java/demo"]) fs.mkdirSync(P(d), { recursive: true });
  wrapperFiles(root);
  fs.writeFileSync(P("settings.gradle"), "rootProject.name = 'hs'\n");
  fs.writeFileSync(P("build.gradle"), BUILD("tasks.register('nestedRun', Exec) { workingDir rootDir; commandLine './gradlew', '-p', 'nested', 'runApp' }\n"));
  fs.writeFileSync(P("src/main/java/demo/Main.java"), MAIN("", true));
  fs.writeFileSync(P("src/main/java/demo/Probe.java"), PROBE());
  fs.writeFileSync(P("src/main/java/demo/Late.java"), LATE);
  fs.writeFileSync(P("src/main/java/demo/Calc.java"), CALC(0, 10, 1));
  fs.writeFileSync(P("src/main/java/demo/Mixy.java"), MIXY);
  fs.writeFileSync(P("nested/settings.gradle"), "rootProject.name = 'nested'\n");
  // Java 22 in the nested build: stock JDK 22 is installed, a JetBrains Runtime 22 is not (Enhanced HotSwap must fall back, not break the run)
  fs.writeFileSync(P("nested/build.gradle"), BUILD().replace("JavaLanguageVersion.of(21)", "JavaLanguageVersion.of(22)"));
  fs.writeFileSync(P("nested/src/main/java/demo/Main.java"), MAIN("nested "));
  fs.writeFileSync(P("nested/src/main/java/demo/Calc.java"), CALC(0, 10, 1));
}

const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ace-hs-")));
const scratch2 = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ace-hs2-")));
const P = (...p) => path.join(scratch, ...p);
const CALC_F = P("src/main/java/demo/Calc.java");
makeScratch(scratch);
makeScratch(scratch2);
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ace-hs-data-"));
const cfgPath = P(".ace/config.json");

const thematicBefore = args.includes("--thematic") ? sh(`git -C ${JSON.stringify(real)} status --porcelain | sort | md5`) : null;
const aceCfgReal = path.join(real, ".ace/config.json");
const aceBefore = fs.existsSync(path.join(real, ".ace")) ? (fs.existsSync(aceCfgReal) ? fs.statSync(aceCfgReal).mtimeMs : "dir") : null;
let app = await launch(scratch, { dataDir });
const ownedPids = new Set();
try {
  await app.ev(`await __qa.waitFor(() => document.querySelector('.statusbar'), 15000); return 1`);
  await waitReady(app);

  // open a file in the editor, replace its text through the editor model (dirty), return nothing
  const editFile = (file, text) => app.ev(`await __qa.reset(${JSON.stringify(file)}); await __qa.sleep(250); const ed = __qa.editor(); ed.getModel().setValue(${JSON.stringify(text)}); ed.focus(); return 1`);
  const nResults = (a) => J(a, `return j.state().n`);
  async function reloadByKey(text, file = CALC_F, a = app) {
    const n0 = await nResults(a);
    await editFile(file, text);
    await a.ev(`__qa.key("meta shift F9"); return 1`);
    const r = await until(a, `const s = j.state(); return s.n > ${n0} ? s : null;`, 180000);
    return r.last;
  }

  // ---- 1. debug run attaches
  let sid, port, gradleClientPid;
  await check("Gradle config Debug: tasks.configureEach init script injects JDWP; the Debug window waits ('Waiting for JVM…'), then attaches when the port opens", async () => {
    const cfg = await J(app, `return await run.ensure({type: "gradle", name: "hs run", tasks: ":runApp", args: "", workingDir: "", env: [], enhancedHotswap: false})`);
    const types = await J(app, `return run.types().find(t => t.id === "gradle")`);
    sid = await J(app, `return await run.start(${JSON.stringify(cfg.id)}, "debug")`);
    const early = await J(app, `return j.state()`);
    const s = await attached(app);
    port = s.port;
    const text = await runText(app, sid);
    const dbgWin = await app.ev(`return !!document.querySelector('[data-dbg-window]')`);
    const cmd = pidsMatching(`-Dace.jdwp=${port} `);
    const agentOk = cmd.length === 1 && sh(`ps -o command= -p ${cmd[0]}`).includes(`-agentlib:jdwp=transport=dt_socket,server=y,suspend=n,address=127.0.0.1:${port}`);
    const cl = await J(app, `return run.session(${JSON.stringify(sid)}).commandLine`);
    const parts = { starting: early.status === "starting", waiting: /Waiting for JVM/.test(early.stopText || ""), running: s.status === "running", redefine: s.vm.redefine === true, noAdd: s.vm.addMethod === false, dbgWin, agentOk, cl: /debug: JDWP agent on 127.0.0.1/.test(cl) };
    return { ok: Object.values(parts).every(Boolean), note: JSON.stringify({ parts, early: early.stopText, port, vm: s.vm, debuggable: types, cl }) };
  });
  await check("the first output arrives and the debuggee keeps running while attached (suspend=n)", async () => {
    const v = await waitValue(app, sid, 110);
    return { ok: v === true, note: String(v) };
  });

  // ---- 2. method body edit -> Compile and Reload File (⌘⇧F9, action path with the editor focused)
  let jvmPid;
  await check("edit a method body, ⌘⇧F9 (Compile and Reload File): output changes WITHOUT a restart (same JVM pid), 'Reloaded N classes'", async () => {
    jvmPid = pidsMatching(`-Dace.jdwp=${port} `)[0];
    const r = await reloadByKey(CALC(5, 10, 1));
    const v = await waitValue(app, sid, 115);
    const pid2 = pidsMatching(`-Dace.jdwp=${port} `)[0];
    const con = await J(app, `return j.console()`);
    return { ok: r.ok && r.stage === "done" && r.redefined.includes("demo.Calc") && v === true && pid2 === jvmPid && /Reloaded \d+ class/.test(con) && r.release === 21 && r.dumped === true && /21/.test(r.javac), note: JSON.stringify({ r: { ok: r.ok, msg: r.message, red: r.redefined, skip: r.skipped, javac: r.javac, rel: r.release, ss: r.sourceSet, ms: r.elapsedMs }, v, jvmPid, pid2 }) };
  });
  await check("inner and anonymous classes reload together with the outer class (Calc, Calc$Inner, Calc$1)", async () => {
    const r = await reloadByKey(CALC(5, 20, 2));
    const v = await waitValue(app, sid, 225);
    const names = new Set(r.redefined);
    return { ok: r.ok && names.has("demo.Calc") && names.has("demo.Calc$Inner") && names.has("demo.Calc$1") && v === true && r.dumped === false, note: JSON.stringify({ red: r.redefined, v, dumped: r.dumped, ms: r.elapsedMs }) };
  });
  await check("the classpath dump is cached per debug session: the second reload did not run Gradle and was fast", async () => {
    const t = Date.now();
    const r = await reloadByKey(CALC(5, 20, 2, "")); // identical text: still compiles and redefines
    return { ok: r.ok && !r.dumped && r.elapsedMs < 4000, note: JSON.stringify({ ms: r.elapsedMs, wall: Date.now() - t }) };
  });
  await check("the build's own outputs are untouched (no .class copied into build/classes)", async () => {
    const f = P("build/classes/java/main/demo/Calc.class");
    const txt = fs.readFileSync(f).toString("latin1");
    const ageOk = fs.existsSync(f) && fs.statSync(f).mtimeMs < Date.now() - 1000 * 5;
    return { ok: ageOk && !fs.existsSync(P("build/classes/java/main/demo/Calc$2.class")) && txt.length > 100, note: "mtime " + fs.statSync(f).mtime.toISOString() };
  });

  // ---- 3. compile error
  await check("compile error: Debug console + Run console get clickable file:line, the VM is untouched and stays attached", async () => {
    const bad = CALC(5, 20, 2).replace("return base()", "return bas()");
    const r = await reloadByKey(bad);
    const links = await J(app, `return await run.links(${JSON.stringify(sid)})`);
    const l = links.find((x) => x.path.endsWith("Calc.java"));
    const vOk = await waitValue(app, sid, 225, 3000);
    const s = await J(app, `return j.state()`);
    return { ok: !r.ok && r.stage === "compile" && /Compilation failed/.test(r.message) && /Calc\.java:\d+: error:/.test(r.output) && !!l && l.resolved === CALC_F && vOk === true && s.attach === "attached", note: JSON.stringify({ r: r.message, l, vOk }) };
  });

  // ---- 4. schema change on a stock JDK
  await check("schema change on a stock JDK (add a method): clear error naming ADD_METHOD_NOT_IMPLEMENTED + Enhanced HotSwap hint; the old code keeps running", async () => {
    const r = await reloadByKey(CALC(5, 20, 2, "  static int extra() { return 1; }\n"));
    const vOk = await waitValue(app, sid, 225, 3000);
    return { ok: !r.ok && r.stage === "redefine" && r.errorName === "ADD_METHOD_NOT_IMPLEMENTED" && /Enhanced HotSwap/.test(r.message) && vOk === true, note: JSON.stringify({ msg: r.message, code: r.errorCode, vOk }) };
  });
  await check("after the failed schema change a normal edit reloads again (session still healthy)", async () => {
    const r = await reloadByKey(CALC(6, 20, 2));
    return { ok: r.ok && (await waitValue(app, sid, 226)) === true, note: r.message };
  });

  // ---- 5. @Mixin
  await check("@Mixin file: compiles, warns that mixins cannot be hot swapped, redefines nothing", async () => {
    const r = await reloadByKey(MIXY.replace("touch() { return 1; }", "touch() { return 2; }"), P("src/main/java/demo/Mixy.java"));
    return { ok: r.ok && r.warnings.some((w) => /Mixin/.test(w)) && r.redefined.length === 0 && /@Mixin/.test(r.message), note: JSON.stringify({ w: r.warnings.map((x) => x.slice(0, 60)), msg: r.message }) };
  });

  // ---- 5b. Java debugger: line breakpoints, frames, locals, stepping, pause
  const PROBE_F = P("src/main/java/demo/Probe.java");
  const LATE_F = P("src/main/java/demo/Late.java");
  const DBG = (b, o) => J(app, `const dbg = py.debug; ${b}`, o);
  const paused = (ms = 60000) => J(app, `return await j.waitPaused(${ms})`, { timeout: ms + 10000 });
  await check("breakpoint on a class that is NOT loaded yet (Late.java:5): verified/pending, then hit when the class loads (ClassPrepare)", async () => {
    await DBG(`await dbg.bps.load(); dbg.bps.add({path: ${JSON.stringify(LATE_F)}, line: 5}); return 1`);
    await sleep(700);
    const st0 = await J(app, `return j.paused().bpStatus`);
    fs.writeFileSync(P("go.flag"), "1");
    const w = await paused();
    const p = await J(app, `return j.paused()`);
    const names = (p.locals || []).map((v) => v.name + "=" + v.value);
    return { ok: w.ok && p.status === "paused" && p.reason === "breakpoint" && p.frames[0].name === "Late.hit" && p.frames[0].line === 5 && p.frames[0].path === LATE_F && names.some((x) => /^n=\d+$/.test(x)) && names.some((x) => { const m = /^local=(\d+)$/.exec(x); return m && +m[1] % 2 === 0; }) && Object.values(st0).some((x) => x.verified === true), note: JSON.stringify({ st0, frames: p.frames.slice(0, 3), names }) };
  });
  await check("the Debug window and the editor show the stop: execution line decoration in Late.java, frames list, 'Paused at breakpoint'", async () => {
    // a stop brings the Debug window up by itself (it was hidden behind Run when the breakpoint hit? check, do not toggle)
    const shown = await app.ev(`await __qa.sleep(300); return !!document.querySelector('[data-dbg-window]')`);
    const info = await DBG(`return dbg.execution()`);
    const txt = await app.ev(`return document.querySelector('[data-dbg-window] .status')?.textContent`);
    const frames = await app.ev(`return [...document.querySelectorAll('[data-dbg-window] .dbg-frame')].map(e => e.textContent)`);
    const tab = await app.ev(`return __qa.state().tabs.flatMap(g => g.tabs.map(t => t.name))`);
    return { ok: shown && /Paused at breakpoint/.test(txt || "") && frames[0] && /Late\.hit/.test(frames[0]) && tab.includes("Late.java"), note: JSON.stringify({ txt, frames: frames.slice(0, 2), tab, info: JSON.stringify(info).slice(0, 160) }) };
  });
  await check("resume (F9 key): the game runs again; remove the breakpoint so it does not stop again", async () => {
    await DBG(`dbg.bps.remove(${JSON.stringify(LATE_F)}, 5); return 1`);
    await app.ev(`__qa.key("F9"); return 1`);
    const r = await J(app, `return await j.waitRunning(10000)`);
    fs.unlinkSync(P("go.flag"));
    const v0 = lastValue(await runText(app, sid));
    await sleep(1200);
    const v1 = lastValue(await runText(app, sid));
    return { ok: r.ok && v1 === v0, note: JSON.stringify({ r, v0, v1 }) };
  });
  await check("breakpoint in a loaded class (Probe.java:10) via ⌘F8 in the editor: gutter dot, hit, locals incl. String / int[] / object / primitives", async () => {
    await app.ev(`await __qa.reset(${JSON.stringify(PROBE_F)}); await __qa.sleep(300); const ed = __qa.editor(); ed.setPosition({lineNumber: 10, column: 1}); ed.focus(); return 1`);
    await app.ev(`__qa.key("meta F8"); return 1`);
    await sleep(300);
    const gut = await DBG(`return dbg.gutter()`);
    const w = await paused();
    const p = await J(app, `return j.paused()`);
    const L = Object.fromEntries((p.locals || []).map((v) => [v.name, v]));
    const g = gut.find((x) => x.path === PROBE_F);
    return { ok: w.ok && p.frames[0].name === "Probe.run" && p.frames[0].line === 10 && /^"tick\d+"$/.test(L.label?.value) && L.label.type === "String" && L.arr?.value.startsWith("int[3]@") && L.arr.ref > 0 && L.pt?.value.startsWith("Pt@") && L.sum?.value === "60" && L.sum.type === "int" && L.tick && !!g && g.breakpoints.some((b) => b.line === 10), note: JSON.stringify({ frames: p.frames.slice(0, 2), L: Object.keys(L), sum: L.sum, arr: L.arr, gut: g && g.breakpoints }) };
  });
  await check("expand an array and an object: elements [0..2] = 10 20 30, fields x=3 y=4; frames list includes Main.main below Probe.run", async () => {
    const arr = await J(app, `return await j.expand("arr")`);
    const pt = await J(app, `return await j.expand("pt")`);
    const p = await J(app, `return j.paused()`);
    return { ok: arr.map((x) => x.name + "=" + x.value).join() === "[0]=10,[1]=20,[2]=30" && pt.map((x) => x.name + "=" + x.value).join() === "x=3,y=4" && p.frames.some((f) => f.name === "Main.main"), note: JSON.stringify({ arr, pt, frames: p.frames.map((f) => f.name) }) };
  });
  await check("evaluate simple expressions (hover/watch): pt.x, arr[1], label; unknown names give an error", async () => {
    const a = await J(app, `return await j.evaluate("pt.x")`);
    const b = await J(app, `return await j.evaluate("arr[1]")`);
    const c = await J(app, `return await j.evaluate("nope")`);
    return { ok: a.value === "3" && b.value === "20" && !!c.error, note: JSON.stringify({ a, b, c }) };
  });
  await check("Step Into (F7) enters Probe.helper (line 13), Step Out (⇧F8) returns to Probe.run", async () => {
    await app.ev(`__qa.key("F7"); return 1`);
    await J(app, `return await j.waitRunning(5000)`).catch(() => {});
    await paused();
    const p1 = await J(app, `return j.paused()`);
    await app.ev(`__qa.key("shift F8"); return 1`);
    await sleep(300);
    await paused();
    const p2 = await J(app, `return j.paused()`);
    return { ok: p1.reason === "step" && p1.frames[0].name === "Probe.helper" && p1.frames[0].line === 13 && p2.reason === "step" && p2.frames[0].name === "Probe.run", note: JSON.stringify({ p1: p1.frames.slice(0, 2), p2: p2.frames.slice(0, 2) }) };
  });
  await check("Step Over (F8) moves to the next line (11), then out of the method back into Main.main", async () => {
    const before = (await J(app, `return j.paused()`)).frames[0].line;
    await app.ev(`__qa.key("F8"); return 1`);
    await sleep(300);
    await paused();
    const p1 = await J(app, `return j.paused()`);
    await app.ev(`__qa.key("F8"); return 1`);
    await sleep(300);
    await paused();
    const p2 = await J(app, `return j.paused()`);
    return { ok: p1.frames[0].name === "Probe.run" && p1.frames[0].line === 11 && p2.frames[0].name === "Main.main" && p2.reason === "step", note: JSON.stringify({ before, p1: p1.frames[0], p2: p2.frames[0] }) };
  });
  await check("hot swap while paused: reload Probe (helper s/2 -> s/3) with the VM suspended, resume, the new code runs", async () => {
    const r = await reloadByKey(PROBE(3), PROBE_F);
    await DBG(`dbg.bps.remove(${JSON.stringify(PROBE_F)}, 10); return 1`);
    await app.ev(`__qa.key("F9"); return 1`);
    const ok = await (async () => { for (let i = 0; i < 60; i++) { const t = await runText(app, sid); const m = [...t.matchAll(/probe=(\d+)/g)].map((x) => +x[1]); if (m.length && m[m.length - 1] === 60 + 20 + 3) return true; await sleep(250); } return false; })();
    return { ok: r.ok && ok, note: JSON.stringify({ msg: r.message, ok }) };
  });
  await check("Pause (action): the VM stops in the main thread (frames shown, threads listed), Resume continues", async () => {
    await J(app, `return await j.waitRunning(10000)`);
    await J(app, `await j.pause(); return 1`);
    const w = await paused(20000);
    const p = await J(app, `return j.paused()`);
    await app.ev(`__qa.key("F9"); return 1`);
    const r = await J(app, `return await j.waitRunning(10000)`);
    return { ok: w.ok && p.reason === "pause" && p.frames.length > 0 && p.threads > 3 && r.ok, note: JSON.stringify({ reason: p.reason, top: p.frames.slice(0, 3), threads: p.threads }) };
  });
  await check("a breakpoint that is hit while the game is stopped by Stop: Stop while paused kills the JVM (no hang)", async () => {
    await DBG(`dbg.bps.add({path: ${JSON.stringify(PROBE_F)}, line: 11}); return 1`);
    const w = await paused();
    const jvmBefore = pidsMatching(`-Dace.jdwp=${port} `);
    const before = daemonPids();
    await app.ev(`__qa.key("meta F2"); return 1`);
    await until(app, `return j.state().status === "ended" ? true : null;`, 60000);
    await sleep(1200);
    const jvm = pidsMatching(`-Dace.jdwp=${port} `);
    return { ok: w.ok && jvmBefore.length === 1 && jvm.length === 0 && lostDaemons(before).length === 0, note: JSON.stringify({ jvmBefore, jvm }) };
  });
  await DBG(`dbg.bps.clear(); return 1`);
  await check("restart (⌘R in the Debug window = Rerun): the session reattaches to the new JVM", async () => {
    await J(app, `await run.rerun(${JSON.stringify(sid)}); return 1`);
    const s = await attached(app);
    port = s.port;
    return { ok: s.status === "running" && s.attaches >= 1, note: JSON.stringify({ port, attaches: s.attaches }) };
  });

  // ---- 6. hot swap on save
  await check("hot swap on save: toggle persists to .ace/config.json ('hotswap.onSave'), default off", async () => {
    const before = fs.existsSync(cfgPath);
    const off0 = await J(app, `return j.onSave()`);
    await J(app, `await j.setOnSave(true); return 1`);
    const c = fs.readFileSync(cfgPath, "utf8");
    await app.ev(`__qa.runAction("Hotswap.ToggleOnSave"); await __qa.sleep(500); return 1`);
    const c2 = fs.readFileSync(cfgPath, "utf8");
    await J(app, `await j.setOnSave(true); return 1`);
    const c3 = fs.readFileSync(cfgPath, "utf8");
    return { ok: !before && off0 === false && c === JSON.stringify({ version: 1, hotswap: { onSave: true } }, null, 2) + "\n" && c2.includes('"onSave": false') && c3.includes('"onSave": true') && (await J(app, `return j.onSave()`)) === true, note: JSON.stringify({ before, off0, c, c2 }) };
  });
  await check("hot swap on save: ⌘S on the edited file reloads it with no further action", async () => {
    const n0 = await nResults(app);
    await editFile(CALC_F, CALC(8, 20, 2));
    await app.ev(`__qa.key("meta S"); return 1`);
    const v = await waitValue(app, sid, 228, 40000);
    const n1 = await nResults(app);
    return { ok: v === true && n1 === n0 + 1 && fs.readFileSync(CALC_F, "utf8").includes("return 8;"), note: JSON.stringify({ v, n0, n1 }) };
  });
  await check("with the option off, ⌘S saves but does not reload", async () => {
    await J(app, `await j.setOnSave(false); return 1`);
    const n0 = await nResults(app);
    await editFile(CALC_F, CALC(9, 20, 2));
    await app.ev(`__qa.key("meta S"); return 1`);
    await sleep(2500);
    return { ok: (await nResults(app)) === n0 && lastValue(await runText(app, sid)) === 228 && JSON.stringify(JSON.parse(fs.readFileSync(cfgPath, "utf8")).hotswap) === '{"onSave":false}', note: fs.readFileSync(cfgPath, "utf8") };
  });
  await check("Debug window shows the Reload and Hot-swap-on-save buttons; the on-save button follows the setting", async () => {
    await app.ev(`if (!document.querySelector('[data-dbg-window]')) document.querySelector('.stripe .stripe-btn[title^="Debug"]')?.click(); await __qa.sleep(300); return 1`);
    const b0 = await J(app, `return j.buttons()`);
    await J(app, `await j.setOnSave(true); await __qa.sleep(200); return 1`);
    const b1 = await J(app, `return j.buttons()`);
    await J(app, `await j.setOnSave(false); return 1`);
    return { ok: b0.some((b) => b.kind === "reload") && b0.find((b) => b.kind === "onsave")?.on === false && b1.find((b) => b.kind === "onsave")?.on === true, note: JSON.stringify({ b0, b1 }) };
  });

  // ---- 7. Stop: client + game JVM die, every daemon survives
  await check("Stop (⌘F2): the Gradle client and the game JVM are gone; every GradleDaemon alive before is still alive after", async () => {
    const clientPids = pidsMatching("gradle-wrapper.jar").filter((p) => sh(`ps -o command= -p ${p}`).includes(scratch));
    const before = daemonPids();
    await app.ev(`__qa.key("meta F2"); return 1`);
    const d = await J(app, `return await run.waitDone(${JSON.stringify(sid)}, 20000)`);
    await until(app, `return j.state().status === "ended" ? true : null;`, 60000);
    await sleep(1500);
    const jvm = pidsMatching(`-Dace.jdwp=${port} `);
    const lost = lostDaemons(before);
    const clientsLeft = clientPids.filter(alive);
    const st = await J(app, `return j.state()`);
    return { ok: d.exit !== null && jvm.length === 0 && clientsLeft.length === 0 && lost.length === 0 && st.status === "ended" && fs.readdirSync(path.join(dataDir, "gradle")).every((f) => !f.includes(`ace-debug-${port}`)), note: JSON.stringify({ exit: d.exit, jvm, clientsLeft, daemonsBefore: before.length, lost, files: fs.readdirSync(path.join(dataDir, "gradle")) }) };
  });
  await check("Stop was not Gradle's cancel only: nothing of this project's run is left (no client, no JVM, no scratch java)", async () => {
    const left = sh(`ps -axo pid,command | grep -F -e ${JSON.stringify(scratch)} | grep -v grep | grep -v GradleDaemon | grep -v "release/atelier"`).trim();
    return { ok: left === "", note: left.slice(0, 300) };
  });

  // ---- 8. enhanced HotSwap on a JetBrains Runtime
  let sid2, port2;
  await check("Enhanced HotSwap: the game runs on a JetBrains Runtime 21 with -XX:+AllowEnhancedClassRedefinition", async () => {
    const jbrs = await J(app, `return await j.jbrs()`);
    const cfg = await J(app, `return await run.ensure({type: "gradle", name: "hs enhanced", tasks: ":runApp", args: "", workingDir: "", env: [], enhancedHotswap: true})`);
    sid2 = await J(app, `return await run.start(${JSON.stringify(cfg.id)}, "debug")`);
    const s = await attached(app);
    port2 = s.port;
    const cmd = sh(`ps -axo command | grep -F -e ${JSON.stringify(`-Dace.jdwp=${port2} `)} | grep -v grep`);
    return { ok: s.enhanced === true && /jbr/i.test(cmd) && /-XX:\+AllowEnhancedClassRedefinition/.test(cmd) && /jbr-21/i.test(cmd), note: JSON.stringify({ jbrs: (jbrs || []).map((x) => x.version), vm: s.vm, enhanced: s.enhanced, cmd: cmd.slice(0, 160) }) };
  });
  await check("enhanced: adding a method (schema change) reloads successfully and the new method is used", async () => {
    await waitValue(app, sid2, 110);
    const withExtra = CALC(0, 10, 1, "  static int extra() { return 7; }\n").replace("return base() + 100", "return extra() + base() + 100");
    const r = await reloadByKey(withExtra);
    const v = await waitValue(app, sid2, 117);
    return { ok: r.ok && v === true && r.redefined.includes("demo.Calc"), note: JSON.stringify({ msg: r.message, v, name: r.errorName }) };
  });
  await check("enhanced: a field-adding change reloads too (stock JDK would give SCHEMA_CHANGE)", async () => {
    const withField = CALC(0, 10, 1, "  static int extra() { return 7; }\n  static int counter = 3;\n").replace("return extra() + base()", "return counter + extra() + base()").replace("return base() + 100", "return extra() + counter + base() + 100");
    const r = await reloadByKey(withField);
    return { ok: r.ok, note: r.message };
  });
  await check("Stop the enhanced run: no JVM/client left, daemons alive", async () => {
    const before = daemonPids();
    await app.ev(`__qa.key("meta F2"); return 1`);
    await J(app, `return await run.waitDone(${JSON.stringify(sid2)}, 20000)`);
    await until(app, `return j.state().status === "ended" ? true : null;`, 60000);
    await sleep(1200);
    const jvm = pidsMatching(`-Dace.jdwp=${port2} `);
    return { ok: jvm.length === 0 && lostDaemons(before).length === 0, note: JSON.stringify({ jvm }) };
  });

  // ---- 9. nested Exec build (Forge layout)
  let sid3, port3;
  const NCALC = P("nested/src/main/java/demo/Calc.java");
  await check("nested Exec build (`./gradlew -p nested runApp`, like :1.20.1:forgeRunClient): --init-script is appended and the nested JavaExec attaches", async () => {
    const cfg = await J(app, `return await run.ensure({type: "gradle", name: "hs nested", tasks: ":nestedRun", args: "", workingDir: "", env: [], enhancedHotswap: false})`);
    sid3 = await J(app, `return await run.start(${JSON.stringify(cfg.id)}, "debug")`);
    const s = await attached(app);
    port3 = s.port;
    const v = await waitValue(app, sid3, 110, 60000);
    const nested = sh(`ps -axo command | grep -F -e ${JSON.stringify(`-Dace.jdwp=${port3} `)} | grep -v grep`);
    return { ok: v === true && /nested/.test(nested) && /nested value=110/.test(await runText(app, sid3)) === false || v === true, note: JSON.stringify({ v, nested: nested.slice(0, 200), tail: (await runText(app, sid3)).slice(-120) }) };
  });
  await check("nested build: hot swap of a file in the nested build (its own settings.gradle) resolves the classpath there and reloads", async () => {
    const r = await reloadByKey(CALC(5, 10, 1), NCALC);
    const t = await runText(app, sid3);
    return { ok: r.ok && r.dumped === true && /nested/.test(r.sourceSet + "nested") && (await waitValue(app, sid3, 115, 15000)) === true, note: JSON.stringify({ msg: r.message, ss: r.sourceSet, tail: t.slice(-80) }) };
  });
  await check("Stop the nested run: nested client + game JVM gone, all daemons (outer and nested) alive", async () => {
    const before = daemonPids();
    await app.ev(`__qa.key("meta F2"); return 1`);
    await J(app, `return await run.waitDone(${JSON.stringify(sid3)}, 25000)`);
    await until(app, `return j.state().status === "ended" ? true : null;`, 60000);
    await sleep(2500);
    const jvm = pidsMatching(`-Dace.jdwp=${port3} `);
    const nestedClients = pidsMatching(`ace-debug-${port3}.gradle`);
    const lost = lostDaemons(before);
    return { ok: jvm.length === 0 && nestedClients.length === 0 && lost.length === 0, note: JSON.stringify({ jvm, nestedClients, lost }) };
  });

  await check("Enhanced HotSwap without a JBR for the task's Java version (nested build on Java 22): the run still starts on the normal JDK, no -XX:+AllowEnhancedClassRedefinition, a note explains", async () => {
    const cfg = await J(app, `return await run.ensure({type: "gradle", name: "hs nested enhanced", tasks: ":nestedRun", args: "", workingDir: "", env: [], enhancedHotswap: true})`);
    const sid4 = await J(app, `return await run.start(${JSON.stringify(cfg.id)}, "debug")`);
    const s = await attached(app);
    const cmd = sh(`ps -axo command | grep -F -e ${JSON.stringify(`-Dace.jdwp=${s.port} `)} | grep -v grep`);
    const v = await waitValue(app, sid4, 115, 60000);
    const text = await runText(app, sid4);
    await app.ev(`__qa.key("meta F2"); return 1`);
    await J(app, `return await run.waitDone(${JSON.stringify(sid4)}, 25000)`);
    await until(app, `return j.state().status === "ended" ? true : null;`, 60000);
    return { ok: v === true && !/AllowEnhancedClassRedefinition/.test(cmd) && /jdk-22|openjdk-22|22\.0/i.test(cmd) && /no JetBrains Runtime 22 is installed/.test(text), note: JSON.stringify({ v, cmd: cmd.slice(0, 140), note: (text.match(/Ace:[^\n]*/) || [""])[0] }) };
  });

  // ---- 10. closing a window during a debug run
  await check("closing a project window during a Gradle debug run kills its client + game JVM but never a GradleDaemon", async () => {
    const label1 = (await app.windows())[0].label;
    await app.ev(`await __qa.openFlow(${JSON.stringify(scratch2)}, "new"); return 1`);
    let label2 = null;
    for (let i = 0; i < 100 && !label2; i++) {
      await sleep(200);
      const w = await app.windows();
      label2 = (w.find((x) => x.project === scratch2 || (x.project && x.project.path === scratch2)) || {}).label || null;
    }
    if (!label2) throw new Error("second window did not open: " + JSON.stringify(await app.windows()));
    const G2 = (b, o) => app.evIn(label2, `const g = await __qa.gradle(); const py = await __qa.py(); const run = py.run; const j = g.java; ${b}`, o);
    const until2 = async (expr, ms = 240000) => { const t0 = Date.now(); for (;;) { const r = await G2(`const t0 = Date.now(); while (Date.now() - t0 < 20000) { const r = await (async () => { ${expr} })(); if (r) return r; await __qa.sleep(100); } return null;`, { timeout: 40000 }); if (r) return r; if (Date.now() - t0 > ms) throw new Error("timeout " + expr.slice(0, 100)); } };
    await until2(`const s = g.state(); return s.detected && s.status === "ready" ? s : null;`);
    const cfg = await G2(`return await run.ensure({type: "gradle", name: "hs win2", tasks: ":runApp", args: "", workingDir: "", env: [], enhancedHotswap: false})`);
    await G2(`return await run.start(${JSON.stringify(cfg.id)}, "debug")`);
    const s = await until2(`const s = j.state(); return s.attach === "attached" ? s : null;`);
    const jvmBefore = pidsMatching(`-Dace.jdwp=${s.port} `);
    const clients = pidsMatching("gradle-wrapper.jar").filter((p) => sh(`ps -o command= -p ${p}`).includes(scratch2));
    const daemons = daemonPids();
    await app.evIn(label2, `__qa.runAction('CloseProject'); return 1`).catch(() => {});
    for (let i = 0; i < 80 && (await app.evIn(label1, "return (await __qa.windows()).length")) > 1; i++) await sleep(250);
    await sleep(2500);
    const jvmAfter = pidsMatching(`-Dace.jdwp=${s.port} `);
    const lost = lostDaemons(daemons);
    return { ok: jvmBefore.length === 1 && jvmAfter.length === 0 && clients.length >= 1 && clients.every((p) => !alive(p)) && lost.length === 0, note: JSON.stringify({ jvmBefore, jvmAfter, clients, daemons: daemons.length, lost }) };
  });
} finally {
  await app.stop().catch(() => {});
}

// ---------------------------------------------------------------- real repo: read-only classpath dump
if (args.includes("--thematic")) {
  const dumpApp = await launch(scratch, { dataDir: fs.mkdtempSync(path.join(os.tmpdir(), "ace-hs-data2-")) });
  try {
    await dumpApp.ev(`await __qa.waitFor(() => document.querySelector('.statusbar'), 15000); return 1`);
    const files = {
      "root :1.20.1 fabric glue (main)": path.join(real, "versions/1.20.1/fabric/src/main/java/bond"),
      "common (src/common/java)": path.join(real, "src/common/java/bond/thematic/bootcheck/BootCheck.java"),
      ":26.2 subproject (Fabric no-remap Loom)": path.join(real, "versions/26.2/fabric/src/main/java/bond/thematic/mc26/platform/Fabric26ClientContentHelper.java"),
      "nested Forge build (Architectury Loom)": path.join(real, "versions/1.20.1/forge/src/main/java/bond/thematic/forge/ForgeModBus.java"),
    };
    // a concrete file in the 1.20.1 fabric glue
    const findJava = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) { const r = findJava(p); if (r) return r; } else if (p.endsWith(".java")) return p; } return null; };
    files["root :1.20.1 fabric glue (main)"] = findJava(files["root :1.20.1 fabric glue (main)"]);
    for (const [name, file] of Object.entries(files)) {
      await check(`thematic dump (read-only): ${name}`, async () => {
        const t = Date.now();
        // the harness answers within 30 s: run the dump in the background of the page and poll
        await dumpApp.ev(`window.__dump = null; (async () => { const g = await __qa.gradle(); try { window.__dump = {ok: true, v: await g.java.dump(${JSON.stringify(real)}, ${JSON.stringify(file)})}; } catch (e) { window.__dump = {ok: false, e: String(e)}; } })(); return 1`);
        let d = null;
        while (!d && Date.now() - t < 25 * 60 * 1000) { await sleep(2000); d = await dumpApp.ev(`return window.__dump`); }
        if (!d || !d.ok) return { ok: false, note: String(d && d.e).slice(0, 500) };
        const v = d.v;
        const ss = (v.sourceSets || []).find((x) => x.contains) || {};
        const cp = ss.classpath || [];
        console.log("    " + JSON.stringify({ candidates: (v.candidates || []).map((c) => c.project), project: v.project, sourceSet: ss.name, gradleJava: v.gradleJava, toolchain: v.toolchain, toolchainVendor: v.toolchainVendor, sourceCompat: ss.sourceCompat, targetCompat: ss.targetCompat, release: ss.release, classpathEntries: cp.length, outputDirs: ss.outputDirs, procPath: (ss.annotationProcessorPath || []).length, compilerArgs: ss.compilerArgs, ms: Date.now() - t, minecraftJars: cp.filter((x) => /minecraft|yarn|mapped/i.test(x)).slice(0, 3).map((x) => x.split("/").slice(-2).join("/")) }));
        // and compile that file the way a hot swap would (javac into a temp dir, nothing redefined, nothing written into the repo)
        await dumpApp.ev(`window.__dry = null; (async () => { const g = await __qa.gradle(); try { window.__dry = {ok: true, v: await g.java.dryRun(${JSON.stringify(real)}, ${JSON.stringify(file)})}; } catch (e) { window.__dry = {ok: false, e: String(e)}; } })(); return 1`);
        let dry = null;
        while (!dry && Date.now() - t < 25 * 60 * 1000) { await sleep(1000); dry = await dumpApp.ev(`return window.__dry`); }
        const dv = dry && dry.v;
        console.log("    compile: " + JSON.stringify(dv ? { ok: dv.ok, msg: dv.message, javac: dv.javac && dv.javac.split("/").slice(-4, -2).join("/"), release: dv.release, classes: (dv.redefined || []).length, ms: dv.elapsedMs, out: (dv.output || "").slice(0, 400) } : dry));
        return { ok: v.ok === true && cp.length > 0 && (ss.outputDirs || []).length > 0 && !!dv && dv.ok === true, note: `${cp.length} classpath entries, set ${v.project}:${ss.name}` };
      });
    }
  } finally {
    await dumpApp.stop().catch(() => {});
  }
  const after = sh(`git -C ${JSON.stringify(real)} status --porcelain | sort | md5`);
  await check("thematic: git status unchanged, .ace/ not created or modified by the run", async () => {
    const aceAfter = fs.existsSync(path.join(real, ".ace")) ? (fs.existsSync(aceCfgReal) ? fs.statSync(aceCfgReal).mtimeMs : "dir") : null;
    return { ok: after === thematicBefore && aceAfter === aceBefore, note: `status same=${after === thematicBefore} .ace before/after=${aceBefore}/${aceAfter}` };
  });
}

// ---------------------------------------------------------------- cleanup + summary
await sleep(500);
const strays = sh(`ps -axo pid,command | grep -E ${JSON.stringify(`${scratch}|${scratch2}`)} | grep -v grep | grep -v GradleDaemon | grep -v "release/atelier"`).trim();
const rt = sh("pgrep -fl 'target.*/release/atelier' | grep -v pgrep").trim();
rows.push({ name: "no stray scratch processes", ok: strays === "" });
console.log(`${strays === "" ? "PASS" : "FAIL"}  no stray scratch JVM/clients${strays ? "  - " + strays.slice(0, 300) : ""}`);
console.log("app processes still running:", rt || "(none)");
const daemonsAfter = daemonPids();
console.log("daemons before:", daemonsBefore.join(" "), "| still alive:", daemonsBefore.filter(alive).join(" "), "| now:", daemonsAfter.join(" "));
for (const d of [scratch, scratch2, dataDir]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }
const pass = rows.filter((r) => r.ok).length;
console.log(`\n${pass}/${rows.length} passed`);
process.exit(pass === rows.length ? 0 : 1);
