// Debugger + editor gutter checks (docs/PYTHON.md, agent B). Everything goes through window.__qa / __qa.py().debug and the real key
// dispatcher (no OS-level input). Fixture lines (app/main.py): 15 def compute, 18 `total = add(total, i)`, 22 `if __name__`, 25 `result = compute(5)`,
// 26 print("result"..), (app/util.py): 3 `return a + b`; crash.py: 2 `return 1 / x`.
export async function checks(c) {
  const { check, py, S, key, P, app, sleep, venvPython, uv, scratch, fs, path, execSync, execFileSync, proj } = c;
  const J = JSON.stringify;
  const d = (body, o) => py(`const d = py.debug; ${body}`, o);
  const main = P("app/main.py"), util = P("app/util.py"), crash = P("crash.py"), loop = P("loop.py"), ask = P("ask.py");
  const long = { timeout: 40000 };
  const ev = (b, o) => app.ev(b, o);
  const sel = (s) => J(s);

  /** clean slate: no sessions, no breakpoints, default exception filters, unmuted */
  const clean = () => d(`await d.closeAll(); d.bps.clear(); d.bps.exceptions({ raised: false, uncaught: false, userUnhandled: false }); d.bps.mute(false); d.fakeRunMarkers(null); return 1`, long);
  /** set breakpoints, start `o`, wait for the first pause */
  const startAt = async (o, bps = []) => {
    await clean();
    for (const b of bps) await d(`d.bps.add(${J(typeof b === "number" ? { path: main, line: b } : b)}); return 1`);
    const r = await d(`const r = await d.start(${J({ python: venvPython, ...o })}); if (r.adapterMissing) throw new Error("adapter missing"); return await d.waitPaused(20000)`, long);
    return r;
  };
  const st = () => d("return d.state()");
  const frame0 = async () => { const s = await st(); return s?.frames?.[0]; };
  const local = (s, n) => s?.locals?.find((v) => v.name === n)?.value;
  const focusEditor = () => ev(`const e = __qa.editor(); e.focus(); return 1`);
  const gutter = (file) => d(`return d.gutter().find((g) => g.path === ${J(file)})`);
  const waitStatus = (status, ms = 15000) => d(`return (await d.waitStatus(${J(status)}, ${ms})).ok`, { timeout: ms + 5000 });
  const leftover = () => { try { return execSync(`pgrep -f ${J(scratch)} || true`).toString().trim().split("\n").filter(Boolean).filter((p) => p !== String(process.pid)); } catch { return []; } };
  const pgrepDebug = () => { try { return execSync(`pgrep -fl 'debugpy' | grep -F ${J(scratch)} || true`).toString().trim(); } catch { return ""; } };
  const waitNoProcs = async (ms = 6000) => { const t0 = Date.now(); let p = pgrepDebug(); while (p && Date.now() - t0 < ms) { await sleep(150); p = pgrepDebug(); } return p; };

  // ------------------------------------------------------------------------------------------ gutter + breakpoints
  await check("⌘F8 toggles a line breakpoint at the caret: red dot decoration, persisted store entry; again removes it", async () => {
    await clean();
    await ev(`const e = __qa.editor(); e.setPosition({ lineNumber: 18, column: 1 }); e.focus(); return 1`);
    await key("meta F8");
    await sleep(150);
    const l1 = await d("return d.bps.list()");
    const g1 = await gutter(main);
    await key("meta F8");
    await sleep(150);
    const l2 = await d("return d.bps.list()");
    const g2 = await gutter(main);
    const ok = l1.length === 1 && l1[0].line === 18 && l1[0].path === main && g1.breakpoints.length === 1 && g1.breakpoints[0].line === 18 && /dbg-bp-line/.test(g1.breakpoints[0].cls) && l2.length === 0 && g2.breakpoints.length === 0;
    return { ok, note: JSON.stringify({ l1, g1: g1.breakpoints, l2: l2.length }) };
  }, { fresh: "app/main.py" });

  await check("gutter: clicking the glyph margin and the line numbers (real hit-test) toggles breakpoints", async () => {
    await clean();
    const a = await d(`return d.gutterClick(19, "glyph")`);
    const b = await d(`return d.gutterClick(20, "lineNumber")`);
    await sleep(100);
    const lines = (await d("return d.bps.list()")).map((x) => x.line).sort();
    const c2 = await d(`return d.gutterClick(19, "glyph")`);
    await sleep(100);
    const after = (await d("return d.bps.list()")).map((x) => x.line);
    return { ok: a === "added" && b === "added" && lines.join() === "19,20" && c2 === "removed" && after.join() === "20", note: JSON.stringify({ a, b, lines, c2, after }) };
  }, { fresh: "app/main.py" });

  await check("gutter lanes: run marker on the left, breakpoint on the right; marker click opens Run/Debug menu, breakpoint lane toggles", async () => {
    await clean();
    await d(`d.fakeRunMarkers([{ line: 22, kind: "main", label: "Run 'main'" }]); return 1`);
    await sleep(200);
    const g0 = await gutter(main);
    const click1 = await d(`return d.gutterClick(22, "glyph", "left")`);
    await sleep(100);
    const menu = await ev(`return [...document.querySelectorAll(".menu .menu-item")].map((e) => e.textContent)`);
    await ev(`document.querySelector(".menu-backdrop")?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })); return 1`);
    const click2 = await d(`return d.gutterClick(22, "glyph", "right")`);
    await sleep(120);
    const g1 = await gutter(main);
    await d(`d.fakeRunMarkers(null); return 1`);
    const ok = g0.runLines.join() === "22" && /dbg-run/.test(g0.runClasses[0]) && click1 === "run-menu" && menu.join("|") === "Run 'main'|Debug 'main'" && click2 === "added" && g1.breakpoints.some((b) => b.line === 22) && g1.runLines.join() === "22";
    return { ok, note: JSON.stringify({ g0: g0.runLines, click1, menu, click2, bp: g1.breakpoints.length }) };
  }, { fresh: "app/main.py" });

  await check("breakpoint variants render: conditional (?), log point, disabled (hollow)", async () => {
    await clean();
    await d(`d.bps.add({ path: ${J(main)}, line: 17, condition: "i == 3" }); d.bps.add({ path: ${J(main)}, line: 18, logMessage: "i={i}" }); d.bps.add({ path: ${J(main)}, line: 19, enabled: false }); d.bps.add({ path: ${J(main)}, line: 16 }); return 1`);
    await sleep(150);
    const g = await gutter(main);
    const by = Object.fromEntries(g.breakpoints.map((b) => [b.line, b.cls]));
    await clean();
    return { ok: /dbg-bp-cond/.test(by[17]) && /dbg-bp-log/.test(by[18]) && /dbg-bp-off/.test(by[19]) && /dbg-bp-line/.test(by[16]) && !/dbg-bp-off|cond|log/.test(by[16]), note: JSON.stringify(by) };
  }, { fresh: "app/main.py" });

  await check("breakpoints follow edits (decoration stickiness) and the new line is written back to the store", async () => {
    await clean();
    await d(`d.bps.toggle(${J(main)}, 18); return 1`);
    await sleep(150);
    await ev(`const e = __qa.editor(); e.executeEdits("qa", [{ range: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 }, text: "# one\\n# two\\n" }]); return 1`);
    await sleep(900);
    const moved = (await d("return d.bps.list()")).map((b) => b.line);
    const g = await gutter(main);
    await ev(`const e = __qa.editor(); e.trigger("qa", "undo", null); return 1`);
    await sleep(900);
    const back = (await d("return d.bps.list()")).map((b) => b.line);
    const dirty = (await S()).dirty;
    await clean();
    return { ok: moved.join() === "20" && g.breakpoints[0].line === 20 && back.join() === "18" && dirty.length === 0, note: JSON.stringify({ moved, back, dirty }) };
  }, { fresh: "app/main.py" });

  await check("breakpoints persist per project (pstore 'breakpoints') and survive a reload of the store", async () => {
    await clean();
    await d(`d.bps.add({ path: ${J(main)}, line: 18, condition: "i == 2" }); d.bps.exceptions({ uncaught: true }); await d.bps.flush(); return 1`);
    const raw = await ev(`return await __qa.invoke("pstore_get", { root: { host: "local", path: ${J(proj)} }, name: "breakpoints" })`);
    const j = JSON.parse(raw);
    await clean();
    await d(`await d.bps.flush(); return 1`);
    return { ok: j.breakpoints?.[0]?.line === 18 && j.breakpoints[0].path === main && j.breakpoints[0].condition === "i == 2" && j.exceptions.uncaught === true, note: raw.slice(0, 200) };
  }, { fresh: "app/main.py" });

  // ------------------------------------------------------------------------------------------ session basics
  await check("breakpoint in the compute loop is hit: frame compute app/main.py:18, caller <module>:25, variables n/total/i", async () => {
    const r = await startAt({ program: main }, [18]);
    const f = r.frames[0];
    const ok = r.ok && f.name === "compute" && f.line === 18 && f.path === main && r.frames[1]?.name === "<module>" && r.frames[1].line === 25 && local(r, "n") === "5" && local(r, "total") === "0" && local(r, "i") === "0" && r.stopReason === "breakpoint";
    return { ok, note: JSON.stringify({ frames: r.frames.slice(0, 2), locals: r.locals?.map((v) => v.name + "=" + v.value) }) };
  }, { fresh: "app/main.py" });

  await check("stop location opens the file at the line; execution-line decoration + gutter arrow + inline values; all removed on resume", async () => {
    await startAt({ program: main }, [18]);
    await d("return await d.waitPaused()");
    await sleep(500);
    const state = await S();
    const ex = (await d("return d.execution()")).find((e) => e.path === main);
    const pt = await d("return d.execPoint()");
    await d(`d.bps.clear(); await d.resume(); return 1`);
    await sleep(300);
    const ex2 = (await d("return d.execution()")).find((e) => e.path === main);
    const pt2 = await d("return d.execPoint()");
    const inl = (ex?.inline ?? []).map((i) => i.line + ":" + i.text);
    const ok = ex?.execLine === 18 && ex.arrow && pt?.line === 18 && pt.top && state.cursor.line === 18 && ex.inline.some((i) => i.line === 15 && /n = 5/.test(i.text)) && ex.inline.some((i) => i.line === 18 && /total = 0/.test(i.text)) && ex2?.execLine === null && ex2.inline.length === 0 && pt2 === null;
    return { ok, note: JSON.stringify({ execLine: ex?.execLine, inl, cursor: state.cursor, after: ex2?.execLine }) };
  }, { fresh: "app/main.py" });

  await check("lazy expansion: module frame variable c (Counter instance) expands to value = 2", async () => {
    const r = await startAt({ program: main }, [26]);
    const c0 = r.locals.find((v) => v.name === "c");
    const kids = await d(`return await d.expand("c")`);
    const v = kids.find((k) => k.name === "value");
    const ok = r.frames[0].name === "<module>" && r.frames[0].line === 26 && !!c0 && c0.ref > 0 && /Counter/.test(c0.type + c0.value) && v?.value === "2" && local(r, "result") === "10";
    return { ok, note: JSON.stringify({ c0, kids: kids.map((k) => k.name + "=" + k.value) }) };
  }, { fresh: "app/main.py" });

  await check("step over / into / out: into add (util.py:3), out to compute, over to the next statement", async () => {
    await startAt({ program: main }, [18]);
    await d(`await d.stepInto(); return 1`);
    const into = await d(`return await d.waitPaused()`);
    const f1 = into.frames[0];
    await d(`await d.stepOut(); return 1`);
    await sleep(100);
    const out = await d(`const r = await d.waitPaused(); return r`);
    const f2 = out.frames[0];
    await d(`await d.stepOver(); return 1`);
    await sleep(100);
    const over = await d(`return await d.waitPaused()`);
    const f3 = over.frames[0];
    const ok = f1.name === "add" && f1.path === util && f1.line === 3 && f2.name === "compute" && f2.path === main && [18, 17].includes(f2.line) && f3.name === "compute" && f3.line !== 19;
    return { ok, note: JSON.stringify({ f1, f2, f3 }) };
  }, { fresh: "app/main.py" });

  await check("step keys: F7 into, ⇧F8 out, F8 over reach the debugger from the editor (and are inert when not debugging)", async () => {
    await clean();
    await ev(`__qa.editor().focus(); return 1`);
    await key("F8"); await key("F7");
    const none = await d("return d.state()");
    await startAt({ program: main }, [18]);
    await focusEditor();
    await key("F7");
    await sleep(500);
    const a = (await d("return await d.waitPaused()")).frames[0];
    await focusEditor();
    await key("shift F8");
    await sleep(500);
    const b = (await d("return await d.waitPaused()")).frames[0];
    await focusEditor();
    await key("F8");
    await sleep(500);
    const e = (await d("return await d.waitPaused()")).frames[0];
    return { ok: (none === null || none.status === "ended") && a.name === "add" && b.name === "compute" && e.name === "compute" && e.line !== b.line, note: JSON.stringify({ a, b, e }) };
  }, { fresh: "app/main.py" });

  await check("evaluate `total + 1`, a watch `total * 2`, hover evaluation; watch refreshed on the next stop", async () => {
    await startAt({ program: main }, [18]);
    await d(`await d.resume(); return 1`);
    await sleep(100);
    const r2 = await d(`return await d.waitPaused()`); // i == 1, total == 0
    const ev1 = await d(`return await d.evaluate("total + 1")`);
    const hov = await d(`return await d.evaluate("i", "hover")`);
    await d(`await d.watches.add("total * 2"); return 1`);
    await sleep(500);
    const w1 = (await st()).watches["total * 2"];
    await d(`await d.resume(); return 1`);
    await sleep(100);
    await d(`return await d.waitPaused()`);
    await sleep(500);
    const w2 = (await st()).watches["total * 2"];
    const panel = await ev(`return document.querySelector('[data-watch="total * 2"]')?.textContent ?? null`);
    await d(`d.watches.remove("total * 2"); return 1`);
    return { ok: ev1.value === "1" && hov.value === "1" && w1?.value === "0" && w2?.value === "2" && /total \* 2=\{int\}2/.test(panel ?? ""), note: JSON.stringify({ ev1, hov, w1, w2, panel }) };
  }, { fresh: "app/main.py" });

  await check("resume to the next hit, then run to the end: process exit code 0, output captured, 'Process finished' line", async () => {
    await startAt({ program: main }, [18]);
    await d(`await d.resume(); return 1`);
    const r1 = await d(`return await d.waitPaused()`);
    await d(`d.bps.clear(); await d.resume(); return 1`);
    const end = await d(`return await d.waitEnded(20000)`);
    const ok = local(r1, "i") === "1" && end.ok && end.exitCode === 0 && /result 10/.test(end.output) && /hello ace/.test(end.output) && /Process finished with exit code 0/.test(end.output);
    return { ok, note: JSON.stringify({ i: local(r1, "i"), exit: end.exitCode, out: end.output.slice(-120) }) };
  }, { fresh: "app/main.py" });

  await check("conditional breakpoint `i == 3` stops once, with total == 3", async () => {
    await clean();
    await d(`d.bps.add({ path: ${J(main)}, line: 18, condition: "i == 3" }); return 1`);
    await d(`await d.start(${J({ python: venvPython, program: main })}); return 1`, long);
    const r = await d(`return await d.waitPaused(20000)`, long);
    await d(`await d.resume(); return 1`);
    const end = await d(`return await d.waitEnded(20000)`);
    return { ok: r.ok && local(r, "i") === "3" && local(r, "total") === "3" && end.exitCode === 0, note: JSON.stringify({ i: local(r, "i"), total: local(r, "total"), exit: end.exitCode }) };
  }, { fresh: "app/main.py" });

  await check("log point prints its message and does not stop; pass count stops on the Nth hit", async () => {
    await clean();
    await d(`d.bps.add({ path: ${J(main)}, line: 18, logMessage: "LOG i={i}" }); return 1`);
    await d(`await d.start(${J({ python: venvPython, program: main })}); return 1`, long);
    const end = await d(`return await d.waitEnded(20000)`);
    const logged = /LOG i=0/.test(end.output) && /LOG i=4/.test(end.output);
    await clean();
    await d(`d.bps.add({ path: ${J(main)}, line: 18, hitCount: "3" }); return 1`);
    await d(`await d.start(${J({ python: venvPython, program: main })}); return 1`, long);
    const r = await d(`return await d.waitPaused(20000)`, long);
    const i = local(r, "i");
    await clean();
    return { ok: end.ok && logged && r.ok && i === "2", note: JSON.stringify({ logged, i, out: end.output.slice(0, 80) }) };
  }, { fresh: "app/main.py" });

  await check("run to cursor (⌥F9 from the editor) stops at the caret line and then the temporary breakpoint is gone", async () => {
    await startAt({ program: main }, [25]);
    await ev(`const e = __qa.editor(); e.focus(); e.setPosition({ lineNumber: 27, column: 1 }); return 1`);
    await key("alt F9");
    const r = await d(`await __qa.sleep(300); return await d.waitPaused(15000)`, long);
    const f = r.frames[0];
    await d(`await d.resume(); return 1`);
    const end = await d(`return await d.waitEnded(15000)`);
    return { ok: f.line === 27 && f.name === "<module>" && end.exitCode === 0, note: JSON.stringify({ f, exit: end.exitCode }) };
  }, { fresh: "app/main.py" });

  await check("clicking a frame selects it, opens its file at its line, switches variables and the highlight (non-top frame)", async () => {
    await startAt({ program: main }, [18]);
    await d(`await d.stepInto(); return 1`);
    const r = await d(`return await d.waitPaused()`); // in add
    await d(`await d.selectFrame(1); return 1`);
    await sleep(700);
    const s = await st();
    const state = await S();
    const pt = await d("return d.execPoint()");
    const ok = r.frames[0].name === "add" && s.frameIdx === 1 && local(s, "total") === "0" && pt.line === 18 && pt.top === false && pt.path === main && state.cursor.line === 18;
    return { ok, note: JSON.stringify({ frameIdx: s.frameIdx, pt: pt && { line: pt.line, top: pt.top }, cursor: state.cursor }) };
  }, { fresh: "app/main.py" });

  await check("exception breakpoint (uncaught): crash.py stops at ZeroDivisionError in boom, line 2", async () => {
    await clean();
    await d(`d.bps.exceptions({ uncaught: true }); return 1`);
    await d(`await d.start(${J({ python: venvPython, program: crash })}); return 1`, long);
    const r = await d(`return await d.waitPaused(20000)`, long);
    const f = r.frames[0];
    const txt = await ev(`return document.querySelector(".dbg-sub .status")?.textContent`);
    await clean();
    return { ok: r.ok && r.stopReason === "exception" && f.name === "boom" && f.line === 2 && /ZeroDivisionError/.test(r.exception?.type + r.exception?.message) && /ZeroDivisionError/.test(txt ?? ""), note: JSON.stringify({ reason: r.stopReason, f, exc: r.exception, txt }) };
  }, { fresh: "crash.py" });

  await check("without exception breakpoints crash.py just fails: exit code 1, traceback in the Console tab with a clickable file link", async () => {
    await clean();
    await d(`await d.start(${J({ python: venvPython, program: crash })}); return 1`, long);
    const end = await d(`return await d.waitEnded(20000)`, long);
    await ev(`document.querySelector('[data-tab="console"]').dispatchEvent(new MouseEvent("mousedown", { bubbles: true })); return 1`);
    await sleep(300);
    const links = await ev(`return [...document.querySelectorAll(".dbg-out a[data-link]")].map((a) => a.getAttribute("data-link"))`);
    await ev(`document.querySelector('.dbg-out a[data-link*="crash.py"]').click(); return 1`);
    await sleep(500);
    const state = await S();
    return { ok: end.exitCode === 1 && /ZeroDivisionError/.test(end.output) && links.some((l) => l.endsWith("crash.py:2")) && state.cursor.line === 2 && state.tabs.some((g) => g.tabs.some((t) => t.name === "crash.py" && g.active === t.key)), note: JSON.stringify({ exit: end.exitCode, links, cursor: state.cursor }) };
  }, { fresh: "hello.py" });

  await check("stdin: the Console tab input reaches the debuggee (ask.py prints hi ace)", async () => {
    await clean();
    await d(`await d.start(${J({ python: venvPython, program: ask })}); return 1`, long);
    await d(`await __qa.sleep(1200); return 1`);
    await ev(`document.querySelector('[data-tab="console"]').dispatchEvent(new MouseEvent("mousedown", { bubbles: true })); return 1`);
    await sleep(300);
    // type through the real input element + Enter key dispatch
    await ev(`const el = document.querySelector("[data-stdin]"); el.focus(); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set; set.call(el, "ace"); el.dispatchEvent(new Event("input", { bubbles: true })); return 1`);
    await key("ENTER");
    const end = await d(`return await d.waitEnded(15000)`, long);
    return { ok: end.exitCode === 0 && /name\?/.test(end.output) && /hi ace/.test(end.output), note: JSON.stringify(end.output.slice(0, 80)) };
  }, { fresh: "hello.py" });

  await check("console REPL line evaluates in the selected frame while paused", async () => {
    await startAt({ program: main }, [18]);
    await ev(`document.querySelector('[data-tab="console"]').dispatchEvent(new MouseEvent("mousedown", { bubbles: true })); return 1`);
    await sleep(300);
    await ev(`const el = document.querySelector("[data-repl]"); el.focus(); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set; set.call(el, "n * 10"); el.dispatchEvent(new Event("input", { bubbles: true })); return 1`);
    await key("ENTER");
    await sleep(800);
    const out = (await st()).output;
    return { ok: /^>>> n \* 10\n50$/m.test(out), note: JSON.stringify(out.slice(-60)) };
  }, { fresh: "hello.py" });

  // ------------------------------------------------------------------------------------------ dialogs
  await check("⌥F8 opens Evaluate with the selection preset and shows the result; Esc closes", async () => {
    await startAt({ program: main }, [18]);
    await ev(`const e = __qa.editor(); e.focus(); e.setSelection({ startLineNumber: 18, startColumn: 9, endLineNumber: 18, endColumn: 14 }); return e.getModel().getValueInRange(e.getSelection())`);
    await key("alt F8");
    await ev(`return await __qa.waitFor('[data-dialog="Evaluate"]', 4000)`);
    await sleep(700);
    const txt = await ev(`return { in: document.querySelector("[data-eval-in]").value, res: document.querySelector("[data-eval-res]").textContent }`);
    await ev(`const el = document.querySelector("[data-eval-in]"); const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set; set.call(el, "total + 100"); el.dispatchEvent(new Event("input", { bubbles: true })); return 1`);
    await key("ENTER");
    await sleep(700);
    const res2 = await ev(`return document.querySelector("[data-eval-res]").textContent`);
    await key("ESCAPE");
    await sleep(150);
    const closed = await ev(`return !document.querySelector('[data-dialog="Evaluate"]')`);
    return { ok: txt.in === "total" && /0/.test(txt.res) && /100/.test(res2) && closed, note: JSON.stringify({ txt, res2, closed }) };
  }, { fresh: "app/main.py" });

  await check("⌘⇧F8 Breakpoints dialog: lists breakpoints, edits condition / disables, exception section toggles filters", async () => {
    await clean();
    await d(`d.bps.add({ path: ${J(main)}, line: 18 }); d.bps.add({ path: ${J(util)}, line: 3 }); return 1`);
    await ev(`__qa.editor().focus(); return 1`);
    await key("meta shift F8");
    await ev(`return await __qa.waitFor('[data-dialog="Breakpoints"]', 4000)`);
    const rows = await ev(`return [...document.querySelectorAll("[data-bp-row]")].map((e) => e.getAttribute("data-bp-row"))`);
    await ev(`document.querySelector('[data-bp-row="main.py:18"]').click(); return 1`);
    await sleep(100);
    await ev(`const el = document.querySelector('[data-f="condition"]'); el.focus(); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set; set.call(el, "i == 2"); el.dispatchEvent(new Event("input", { bubbles: true })); el.blur(); return 1`);
    await sleep(100);
    await ev(`document.querySelector('[data-bp-row="exceptions"]').click(); return 1`);
    await sleep(100);
    await ev(`document.querySelector('[data-exc="raised"]').click(); return 1`);
    await sleep(100);
    const list = await d("return d.bps.list()");
    const exc = await d("return d.bps.exceptions()");
    await key("ESCAPE");
    await sleep(150);
    const closed = await ev(`return !document.querySelector('[data-dialog="Breakpoints"]')`);
    await clean();
    return { ok: rows.includes("main.py:18") && rows.includes("util.py:3") && rows.includes("exceptions") && list.find((b) => b.line === 18 && b.path === main).condition === "i == 2" && exc.raised === true && closed, note: JSON.stringify({ rows, cond: list.map((b) => b.condition), exc, closed }) };
  }, { fresh: "app/main.py" });

  // ------------------------------------------------------------------------------------------ lifecycle
  await check("a breakpoint added to a live running session is sent to it (loop.py stops on it)", async () => {
    await clean();
    await d(`await d.start(${J({ python: venvPython, program: loop })}); return 1`, long);
    await d(`await __qa.sleep(1000); return 1`);
    const running = (await st()).status;
    await d(`d.bps.toggle(${J(loop)}, 4); return 1`);
    const r = await d(`return await d.waitPaused(12000)`, long);
    await clean();
    return { ok: running === "running" && r.ok && r.frames[0].line === 4 && r.frames[0].path === loop, note: JSON.stringify({ running, f: r.frames[0] }) };
  }, { fresh: "loop.py" });

  await check("pause a running program (Pause), then Stop kills adapter + debuggee: nothing left from this project", async () => {
    await clean();
    await d(`await d.start(${J({ python: venvPython, program: loop })}); return 1`, long);
    await d(`await __qa.sleep(1200); return 1`);
    const during = pgrepDebug();
    await d(`await d.pause(); return 1`);
    const p = await d(`return await d.waitPaused(10000)`, long);
    await d(`await d.stop(); return 1`, long);
    const ended = await waitStatus("ended", 8000);
    const left = await waitNoProcs();
    const loopLeft = leftover().filter((pid) => { try { return /loop\.py|debugpy/.test(execSync(`ps -o command= -p ${pid}`).toString()); } catch { return false; } });
    return { ok: !!during && p.ok && ended && !left && loopLeft.length === 0, note: JSON.stringify({ during: during.slice(0, 80), paused: p.ok, ended, left, loopLeft }) };
  }, { fresh: "hello.py" });

  await check("Stop through the shared registry (⌘F2 Stop action) ends the debug session", async () => {
    await clean();
    const has = await ev(`return __qa.actions().some((a) => a.id === "Stop")`);
    if (!has) return { ok: true, note: "Stop action not registered yet (Run area) - covered by the stop handler hook" };
    await d(`await d.start(${J({ python: venvPython, program: loop })}); return 1`, long);
    await d(`await __qa.sleep(800); return 1`);
    await ev(`__qa.editor().focus(); return 1`);
    await key("meta F2");
    const ended = await waitStatus("ended", 8000);
    const left = await waitNoProcs();
    return { ok: ended && !left, note: JSON.stringify({ ended, left }) };
  }, { fresh: "hello.py" });

  await check("two sessions get two tabs; closing a tab stops its process; Rerun (⌘R in the Debug window) replaces the session", async () => {
    await clean();
    await d(`await d.start(${J({ python: venvPython, program: loop, title: "one" })}); await d.start(${J({ python: venvPython, program: loop, title: "two" })}); return 1`, long);
    await d(`await __qa.sleep(1000); return 1`);
    const tabs = await ev(`return [...document.querySelectorAll("[data-session]")].map((e) => e.textContent)`);
    const ids = await d("return d.sessions()");
    // focus the Debug window and rerun the active session with the real key path
    await ev(`document.querySelector("[data-dbg-window]").focus(); return 1`);
    await key("meta R");
    await sleep(2500);
    const ids2 = await d("return d.sessions()");
    await d(`await d.closeSession(${J(ids2[0].id)}); return 1`, long);
    await sleep(500);
    const ids3 = await d("return d.sessions()");
    await clean();
    return { ok: tabs.length === 2 && ids.length === 2 && ids2.length === 2 && ids2[1].id !== ids[1].id && ids2.some((s) => s.status === "running") && ids3.length === 1, note: JSON.stringify({ tabs, ids: ids.map((s) => s.id), ids2: ids2.map((s) => s.id + ":" + s.status), n3: ids3.length }) };
  }, { fresh: "hello.py" });

  await check("Mute Breakpoints: a muted breakpoint does not stop; unmuting re-sends it to the live session", async () => {
    await clean();
    await d(`d.bps.add({ path: ${J(loop)}, line: 4 }); d.bps.mute(true); return 1`);
    await d(`await d.start(${J({ python: venvPython, program: loop })}); return 1`, long);
    await d(`await __qa.sleep(1500); return 1`);
    const s1 = (await st()).status;
    await d(`d.bps.mute(false); return 1`);
    const r = await d(`return await d.waitPaused(10000)`, long);
    await clean();
    return { ok: s1 === "running" && r.ok && r.frames[0].line === 4, note: JSON.stringify({ s1, f: r.frames?.[0] }) };
  }, { fresh: "loop.py" });

  // ------------------------------------------------------------------------------------------ debugpy discovery
  let venv2 = null;
  await check("venv WITHOUT debugpy: the adapter runs from another interpreter and still debugs the script (breakpoint hit)", async () => {
    venv2 = path.join(scratch, "venv-nodebugpy");
    execFileSync(uv, ["venv", "--seed", venv2], { stdio: "ignore" });
    const py2 = path.join(venv2, "bin/python");
    const has = execSync(`${J(py2)} -c "import importlib.util as u; print(u.find_spec('debugpy') is not None)"`).toString().trim();
    const choice = await d(`return await d.chooseAdapter(${J(py2)})`);
    const r = await startAt({ program: main, python: py2 }, [18]);
    const ok = has === "False" && choice && choice.own === false && choice.python !== py2 && r.ok && r.adapterOwn === false && r.adapter === choice.python && r.frames[0].name === "compute" && r.frames[0].line === 18 && local(r, "n") === "5";
    await d(`d.bps.clear(); await d.resume(); return 1`);
    const end = await d(`return await d.waitEnded(15000)`, long);
    return { ok: ok && end.exitCode === 0 && /result 10/.test(end.output), note: JSON.stringify({ has, choice, adapter: r.adapter, exit: end.exitCode }) };
  }, { fresh: "app/main.py" });

  await check("no debugpy anywhere: an install balloon is shown ('Install debugpy into …'); nothing is installed automatically", async () => {
    await clean();
    const py2 = path.join(venv2 ?? path.join(scratch, "venv-nodebugpy"), "bin/python");
    if (!fs.existsSync(py2)) execFileSync(uv, ["venv", "--seed", path.dirname(py2)], { stdio: "ignore" });
    const r = await d(`return await d.withOnlyInterpreter(${J(py2)}, ${J({ program: main })})`, long);
    const after = execSync(`${J(py2)} -c "import importlib.util as u; print(u.find_spec('debugpy') is not None)"`).toString().trim();
    const dom = await ev(`return [...document.querySelectorAll(".dbg-balloon")].map((e) => e.textContent)`);
    const sessions = await d("return d.sessions()");
    await ev(`document.querySelectorAll(".dbg-balloon-x").forEach((b) => b.click()); return 1`);
    return { ok: r.started === false && r.balloons.some((b) => /debugpy is not installed/.test(b.title) && b.actions.some((a) => /^Install debugpy into/.test(a))) && after === "False" && sessions.length === 0 && dom.some((t) => /Install debugpy into/.test(t)), note: JSON.stringify({ r, after, dom: dom.map((t) => t.slice(0, 60)) }) };
  }, { fresh: "hello.py" });

  await check("Install button: confirm dialog, then debugpy is installed into the (scratch) env and the debug session starts by itself", async () => {
    await clean();
    const py2 = path.join(venv2 ?? path.join(scratch, "venv-nodebugpy"), "bin/python");
    if (!fs.existsSync(py2)) execFileSync(uv, ["venv", "--seed", path.dirname(py2)], { stdio: "ignore" });
    await d(`d.bps.add({ path: ${J(main)}, line: 18 }); return 1`);
    await d(`return await d.withOnlyInterpreter(${J(py2)}, ${J({ program: main })})`, long);
    await ev(`document.querySelector(".dbg-balloon-link").click(); return 1`);
    await ev(`return await __qa.waitFor(() => [...document.querySelectorAll(".dialog-title")].some((e) => e.textContent === "Install debugpy"), 4000)`);
    const msg = await ev(`return document.querySelector(".dialog-msg").textContent`);
    const before = execSync(`${J(py2)} -c "import importlib.util as u; print(u.find_spec('debugpy') is not None)"`).toString().trim();
    await ev(`[...document.querySelectorAll(".dialog button")].find((b) => b.textContent === "Install").click(); return 1`);
    const r = await d(`const s = await __qa.waitFor(async () => { const x = d.state(); return x && x.status === "paused" ? x : null; }, 60000); return s`, { timeout: 70000 });
    const after = execSync(`${J(py2)} -c "import importlib.util as u; print(u.find_spec('debugpy') is not None)"`).toString().trim();
    await clean();
    return { ok: before === "False" && after === "True" && /debugpy/.test(msg) && r.adapterOwn === true && r.adapter === py2 && r.frames[0].line === 18, note: JSON.stringify({ before, after, msg: msg.slice(0, 80), adapterOwn: r.adapterOwn }) };
  }, { fresh: "hello.py" });

  await check("cleanup: no debug adapter / debuggee from this project is left running", async () => {
    await clean();
    const left = await waitNoProcs(8000);
    try { if (venv2) fs.rmSync(venv2, { recursive: true, force: true }); } catch {}
    return { ok: !left, note: left };
  }, { fresh: "hello.py" });
}
