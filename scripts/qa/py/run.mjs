// Run configurations, toolbar widget, Run window, Python run types, keys (docs/PYTHON.md "Run configuration infra").
// Everything goes through window.__qa / (await __qa.py()).run and real-shaped key events dispatched INSIDE the webview.
export async function checks(c) {
  const { check, py, key, S, P, W, sleep, app, proj, venvPython, execSync } = c;
  const R = (body, o) => py(`const run = py.run; ${body}`, o);
  const cfgOf = (type, patch) => R(`return run.addConfig(${JSON.stringify(type)}, ${JSON.stringify(patch)})`);
  const startAndWait = async (id, ms = 20000) => {
    const sid = await R(`return await run.start(${JSON.stringify(id)}, "run")`);
    return await R(`return await run.waitDone(${JSON.stringify(sid)}, ${ms})`, { timeout: ms + 8000 });
  };
  const sessions = () => R("return run.sessions()");
  const text = (sid) => R(`return run.text(${JSON.stringify(sid)})`);
  const setField = (sel, val) => app.ev(`const el = document.querySelector(${JSON.stringify(sel)}); if (!el) throw new Error("no " + ${JSON.stringify(sel)}); const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(proto, "value").set.call(el, ${JSON.stringify(val)}); el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? "change" : "input", { bubbles: true })); return true`);
  const click = (sel, i = 0) => app.ev(`const el = [...document.querySelectorAll(${JSON.stringify(sel)})][${i}]; if (!el) throw new Error("no " + ${JSON.stringify(sel)}); el.click(); return true`);
  const exists = (sel) => app.ev(`return !!document.querySelector(${JSON.stringify(sel)})`);
  const pgrep = (pat) => execSync(`pgrep -f ${JSON.stringify(pat)} || true`).toString().trim();
  const clean = async () => {
    await R(`for (const s of run.sessions()) { try { run.stop(s.id); } catch {} } for (const s of run.sessions()) await run.waitDone(s.id, 8000).catch(() => {}); for (const s of run.sessions()) await run.close(s.id); for (const cfg of [...run.configs()]) run.removeConfig(cfg.id); await run.flush(); return true`, { timeout: 30000 });
  };
  W("spam.py", `import sys\nfor i in range(200000):\n    print("line", i)\nprint("\\x1b[32mgreen\\x1b[0m done")\nprint("oops", file=sys.stderr)\n`);
  W("stdin_all.py", `import sys\ndata = sys.stdin.read()\nprint("got", repr(data))\n`);

  await check("python project detected, config types registered", async () => {
    await py(`return 1`);
    for (let i = 0; i < 100; i++) { const t = await R("return run.types()"); if (t.filter((x) => ["python", "python-module", "pytest", "unittest", "shell"].includes(x.id)).every((x) => x.available)) return { ok: t.map((x) => x.id).join(",").includes("pytest") && t.length >= 5, note: t.map((x) => x.id).join(",") }; await sleep(150); }
    return { ok: false, note: JSON.stringify(await R("return run.types()")) };
  });

  await check("widget without configurations: Add Configuration…, Stop disabled", async () => {
    await clean();
    const w = await R("return run.widget()");
    const ok = w.name === "Add Configuration…" && w.empty && w.stop.disabled === true;
    if (!ok) return { ok, note: JSON.stringify(w) };
    // clicking it opens the Edit dialog
    await click('[data-testid="run-widget"] [data-act="config"]');
    await app.ev(`return await __qa.waitFor(".rc-dialog", 3000)`);
    await key("ESCAPE");
    await sleep(150);
    return { ok: !(await exists(".rc-dialog")), note: "Escape closes the dialog" };
  });

  let helloId, crashId;
  await check("create configs, widget shows selection, persisted outside the project", async () => {
    const h = await cfgOf("python", { name: "hello", script: "hello.py", params: "a 'b c'", env: [["QA_X", "1"]] });
    helloId = h.id;
    crashId = (await cfgOf("python", { name: "crash", script: "crash.py" })).id;
    await R(`run.select(${JSON.stringify(helloId)}); return await run.flush()`);
    const w = await R("return run.widget()");
    const stored = await R("return await run.stored()");
    const inProj = c.fs.existsSync(P(".idea")) || c.fs.readdirSync(c.proj).some((f) => /run|config/i.test(f));
    return { ok: w.name === "hello" && !w.empty && stored.configs.length === 2 && stored.selected === helloId && !inProj, note: JSON.stringify({ w, n: stored.configs.length, inProj }) };
  });

  await check("configs survive a reload from the per-project store", async () => {
    const r = await R("const s = await run.reload(); return { n: s.configs.length, sel: s.selectedId, names: s.configs.map((c) => c.name), env: s.configs[0].env, params: s.configs[0].params }");
    return { ok: r.n === 2 && r.sel === helloId && r.names.join() === "hello,crash" && r.env[0][0] === "QA_X" && r.params === "a 'b c'", note: JSON.stringify(r) };
  });

  await check("run hello.py: command line, args, stdout/stderr colours, exit code", async () => {
    const done = await startAndWait(helloId);
    const t = await text(done.id);
    const lines = t.split("\n");
    const spans = await R(`return run.spans(${JSON.stringify(done.id)})`);
    const errSpan = spans.flat().find((s) => s.t.includes("to stderr"));
    const ok = lines[0] === `${venvPython} ${P("hello.py")} a 'b c'` && t.includes("hello from hello.py ['a', 'b c']") && errSpan?.k === "err"
      && done.exit === 0 && lines.at(-1) === "Process finished with exit code 0" && lines.at(-2) === "";
    return { ok, note: ok ? "" : JSON.stringify({ first: lines[0], last: lines.slice(-3), err: errSpan, exit: done.exit }) };
  });

  await check("stderr renders red, console visible in the Run window", async () => {
    await key("meta 4");
    const r = await app.ev(`await __qa.waitFor(".run-console .k-err", 4000); const e = document.querySelector(".run-console .k-err"); return { color: getComputedStyle(e).color, bottom: __qa.state().toolWindows.bottom }`);
    return { ok: r.bottom === "run" && r.color === "rgb(191, 97, 106)", note: JSON.stringify(r) };
  });

  await check("env + working dir + shell config", async () => {
    const id = (await cfgOf("shell", { name: "sh env", command: "echo FOO=$QA_FOO; pwd; echo err >&2; exit 3", env: [["QA_FOO", "bar"]], workingDir: "app" })).id;
    const done = await startAndWait(id);
    const t = await text(done.id);
    return { ok: t.includes("FOO=bar") && t.includes(`${proj}/app`) && done.exit === 3, note: t.slice(-200) };
  });

  await check("traceback links resolve and open the file at the line", async () => {
    const done = await startAndWait(crashId);
    const links = await R(`return await run.links(${JSON.stringify(done.id)})`);
    const crash = links.filter((l) => l.path.endsWith("crash.py"));
    if (done.exit !== 1 || crash.length < 3 || crash.some((l) => l.resolved !== P("crash.py"))) return { ok: false, note: JSON.stringify({ exit: done.exit, links }) };
    await app.ev(`await __qa.waitFor(".run-link", 4000); return true`);
    const dom = await R("return run.domLinks()");
    const idx = dom.findIndex((l) => l.line === 2);
    if (idx < 0) return { ok: false, note: "no DOM link for line 2: " + JSON.stringify(dom) };
    await R(`return run.clickDomLink(${idx})`);
    await app.ev(`await __qa.waitFor(() => { const s = __qa.state(); return s.cursor.line === 2 && s.tabs.some((g) => g.tabs.some((t) => t.name === "crash.py")); }, 5000); return true`);
    const s = await S();
    return { ok: s.cursor.line === 2, note: JSON.stringify(s.cursor) };
  });

  await check("stop loop.py with ⌘F2: signal note, exit status, process gone, widget follows", async () => {
    const id = (await cfgOf("python", { name: "loop", script: "loop.py" })).id;
    const sid = await R(`return await run.start(${JSON.stringify(id)}, "run")`);
    await app.ev(`return await __qa.waitFor(async () => (await (await __qa.py()).run).text(${JSON.stringify(sid)}).includes("looping"), 15000)`, { timeout: 20000 });
    const w1 = await R("return run.widget()");
    const alive = pgrep("loop.py");
    await key("meta F2");
    const done = await R(`return await run.waitDone(${JSON.stringify(sid)}, 8000)`);
    const t = await text(sid);
    await sleep(300);
    const w2 = await R("return run.widget()");
    const good = !!alive && w1.stop.disabled === false && done.exit === 143 && t.endsWith("Process finished with exit code 143 (interrupted by signal 15: SIGTERM)") && !pgrep(`${proj}/loop.py`) && w2.stop.disabled === true;
    return { ok: good, note: good ? "" : JSON.stringify({ exit: done.exit, tail: t.slice(-120), alive, gone: !pgrep(`${proj}/loop.py`), w1, w2 }) };
  });

  await check("rerun reuses the tab (⌘R inside the Run window)", async () => {
    await clean();
    const id = (await cfgOf("python", { name: "hello2", script: "hello.py", params: "once" })).id;
    const first = await startAndWait(id);
    const before = await sessions();
    await key("meta 4"); // Run window: show + focus
    await app.ev(`return await __qa.waitFor(() => __qa.state().focused === "toolwindow:run", 3000)`);
    await key("meta R");
    await app.ev(`return await __qa.waitFor(async () => { const r = (await (await __qa.py()).run); const s = r.sessions()[0]; return s && s.status === "finished" && r.text(s.id).split("hello from hello.py").length === 2 && s.id === ${JSON.stringify(first.id)}; }, 10000)`, { timeout: 15000 }).catch(() => {});
    const after = await sessions();
    const t = await text(first.id);
    return { ok: before.length === 1 && after.length === 1 && after[0].id === first.id && t.split("hello from hello.py").length === 2 && after[0].status === "finished", note: JSON.stringify({ before: before.length, after: after.length, count: t.split("hello from hello.py").length - 1 }) };
  });

  await check("⌘R in the editor stays Replace (no rerun)", async () => {
    const before = (await sessions())[0];
    await key("meta R");
    await sleep(500);
    const after = (await sessions())[0];
    return { ok: after.lines === before.lines && after.status === "finished", note: "" };
  });

  await check("two concurrent runs in two tabs", async () => {
    await clean();
    const l1 = (await cfgOf("python", { name: "loopA", script: "loop.py" })).id;
    const l2 = (await cfgOf("python", { name: "loopB", script: "loop.py" })).id;
    const a = await R(`return await run.start(${JSON.stringify(l1)}, "run")`);
    const b = await R(`return await run.start(${JSON.stringify(l2)}, "run")`);
    const b2 = await R(`return await run.start(${JSON.stringify(l2)}, "run")`); // same config again while running: parallel tab
    await app.ev(`return await __qa.waitFor(async () => { const r = (await __qa.py()).run; return r.sessions().length === 3 && r.sessions().every((s) => s.status === "running" && r.text(s.id).includes("looping")); }, 15000)`, { timeout: 20000 });
    const ss = await sessions();
    const tabs = await app.ev(`return [...document.querySelectorAll(".run-tab")].map((t) => t.querySelector(".run-tab-name").textContent)`);
    const procs = pgrep(`${proj}/loop.py`).split("\n").filter(Boolean).length;
    for (const id of [a, b, b2]) await R(`run.stop(${JSON.stringify(id)}); return 1`);
    for (const id of [a, b, b2]) await R(`return await run.waitDone(${JSON.stringify(id)}, 8000)`);
    await sleep(300);
    const gone = !pgrep(`${proj}/loop.py`);
    return { ok: ss.length === 3 && new Set(ss.map((s) => s.id)).size === 3 && tabs.join() === "loopA,loopB,loopB (2)" && procs >= 3 && gone, note: JSON.stringify({ tabs, procs, gone }) };
  });

  await check("stdin: typed line reaches the process, echoed in the console", async () => {
    await clean();
    const id = (await cfgOf("python", { name: "ask", script: "ask.py" })).id;
    const sid = await R(`return await run.start(${JSON.stringify(id)}, "run")`);
    await app.ev(`return await __qa.waitFor(async () => (await __qa.py()).run.text(${JSON.stringify(sid)}).includes("name? "), 15000)`, { timeout: 20000 });
    await app.ev(`await __qa.waitFor("[data-stdin]", 3000); document.querySelector("[data-stdin]").focus(); await __qa.type("Zed"); return true`);
    await key("ENTER");
    const done = await R(`return await run.waitDone(${JSON.stringify(sid)}, 10000)`);
    const t = await text(sid);
    return { ok: done.exit === 0 && t.includes("name? Zed") && t.includes("hi Zed"), note: t.slice(0, 120) };
  });

  await check("⌃D in the stdin field closes stdin (EOF), it does not start the debugger", async () => {
    const id = (await cfgOf("python", { name: "stdin_all", script: "stdin_all.py" })).id;
    await R(`run.captureDebug(true); return 1`);
    const sid = await R(`return await run.start(${JSON.stringify(id)}, "run")`);
    await app.ev(`await __qa.waitFor("[data-stdin]", 5000); document.querySelector("[data-stdin]").focus(); await __qa.type("abc"); return true`);
    await key("ENTER");
    await key("control D");
    const done = await R(`return await run.waitDone(${JSON.stringify(sid)}, 10000)`);
    const t = await text(sid);
    const calls = await R("return run.debugCalls().length");
    await R(`run.captureDebug(false); return 1`);
    return { ok: done.exit === 0 && t.includes("got 'abc\\n'") && calls === 0, note: JSON.stringify({ t: t.slice(0, 200), calls }) };
  });

  await check("big output stays bounded and the UI responsive (200k lines, ANSI green)", async () => {
    await clean();
    const id = (await cfgOf("python", { name: "spam", script: "spam.py" })).id;
    const sid = await R(`return await run.start(${JSON.stringify(id)}, "run")`);
    const t0 = Date.now();
    let worst = 0;
    for (let i = 0; i < 40; i++) { const t = Date.now(); await app.ev("return 1"); worst = Math.max(worst, Date.now() - t); const s = await R(`return run.session(${JSON.stringify(sid)})`); if (s.status === "finished") break; await sleep(100); }
    const done = await R(`return await run.waitDone(${JSON.stringify(sid)}, 60000)`, { timeout: 70000 });
    const spans = await R(`return run.spans(${JSON.stringify(sid)})`);
    const green = spans.flat().find((s) => s.t.startsWith("green"));
    const dom = await app.ev(`return document.querySelectorAll(".run-console .run-line").length`);
    return { ok: done.exit === 0 && done.lines <= 22100 && done.lines > 5000 && green?.fg === "#a3be8c" && dom < 120 && worst < 1500, note: JSON.stringify({ lines: done.lines, dom, worst, ms: Date.now() - t0, green }) };
  });

  await check("soft wrap toggle + clear all + scroll to end buttons", async () => {
    await key("meta 4");
    await click('.run-vbar [data-act="soft-wrap"]');
    const wrapOn = await exists(".run-console.wrap");
    await click('.run-vbar [data-act="soft-wrap"]');
    const wrapOff = !(await exists(".run-console.wrap"));
    await click('.run-vbar [data-act="clear"]');
    await sleep(300);
    const lines = (await sessions())[0].lines;
    return { ok: wrapOn && wrapOff && lines <= 2, note: JSON.stringify({ wrapOn, wrapOff, lines }) };
  });

  await check("⌃R runs the selected configuration from the editor", async () => {
    await clean();
    const id = (await cfgOf("python", { name: "hello3", script: "hello.py", params: "keyR" })).id;
    await R(`run.select(${JSON.stringify(id)}); return 1`);
    await key("control R");
    await app.ev(`return await __qa.waitFor(async () => { const r = (await __qa.py()).run; const s = r.sessions()[0]; return s && s.status === "finished" && r.text(s.id).includes("['keyR']"); }, 12000)`, { timeout: 16000 });
    return true;
  });

  await check("⌃D debugs the selected configuration (debug launcher gets the target)", async () => {
    await R(`run.captureDebug(true); return 1`);
    await key("control D");
    await sleep(600);
    const calls = await R("return run.debugCalls()");
    await R(`run.captureDebug(false); return 1`);
    const t = calls[0]?.target;
    return { ok: calls.length === 1 && t?.program === P("hello.py") && t.args.join() === "keyR" && t.kind === "python" && t.python === venvPython && t.cwd === proj && t.env.PYTHONPATH === proj, note: JSON.stringify(calls) };
  });

  await check("no selected configuration: ⌃R behaves like ⌃⇧R (temporary config for the open file)", async () => {
    await clean();
    await reset2(c, "app/main.py");
    await key("control R");
    await app.ev(`return await __qa.waitFor(async () => { const r = (await __qa.py()).run; const s = r.sessions()[0]; return s && s.status === "finished"; }, 15000)`, { timeout: 20000 });
    const cfgs = await R("return run.configs()");
    const s = (await sessions())[0];
    const t = await text(s.id);
    const w = await R("return run.widget()");
    return { ok: cfgs.length === 1 && cfgs[0].temporary === true && cfgs[0].name === "main" && cfgs[0].script === "app/main.py" && t.includes("result 10") && t.includes("hello ace") && w.italic && w.name === "main", note: JSON.stringify({ cfgs, t: t.slice(-150), w }) };
  });

  await check("⌃⇧R twice reuses the temporary config; temp configs are capped at 5", async () => {
    await key("control shift R");
    await sleep(800);
    const same = (await R("return run.configs()")).length;
    for (let i = 0; i < 7; i++) await R(`return run.ensure({ type: "python", name: "t${i}", script: "hello.py", params: "p${i}", temporary: true }).id`);
    const cfgs = await R("return run.configs()");
    const temps = cfgs.filter((x) => x.temporary).length;
    const selected = await R("return run.selected()");
    return { ok: same === 1 && temps === 5 && cfgs.some((x) => x.id === selected), note: JSON.stringify({ same, temps }) };
  }, { fresh: "app/main.py" });

  await check("Edit dialog: edit a temporary config promotes it, +/copy/remove, validation, OK persists", async () => {
    await clean();
    const t = await R(`return run.ensure({ type: "python", name: "tmpcfg", script: "hello.py", params: "x", temporary: true })`);
    await app.ev(`return __qa.runAction("EditRunConfigurations")`);
    await app.ev(`return await __qa.waitFor(".rc-dialog", 3000)`);
    const items = await app.ev(`return [...document.querySelectorAll(".rc-item")].map((e) => e.textContent + (e.querySelector(".temp") ? "(temp)" : ""))`);
    await setField('[data-field="params"]', "edited");
    await click('.rc-foot [data-act="ok"]');
    await sleep(300);
    const after = (await R("return run.configs()"))[0];
    const closed = !(await exists(".rc-dialog"));
    // add a new one with an empty script: OK must be refused with a message
    await app.ev(`return __qa.runAction("EditRunConfigurations")`);
    await app.ev(`return await __qa.waitFor(".rc-dialog", 3000)`);
    await click('.rc-lbar [data-act="add"]');
    await app.ev(`return await __qa.waitFor(".menu .menu-item", 3000)`);
    const menu = await app.ev(`return [...document.querySelectorAll(".menu .menu-item")].map((e) => e.textContent)`);
    await app.ev(`[...document.querySelectorAll(".menu .menu-item")].find((e) => e.textContent === "Python").click(); return 1`);
    await sleep(200);
    await click('.rc-foot [data-act="ok"]');
    await sleep(200);
    const err = await app.ev(`return document.querySelector(".rc-err").textContent`);
    const stillOpen = await exists(".rc-dialog");
    await setField('[data-field="script"]', "crash.py");
    await click('.rc-lbar [data-act="copy"]');
    await sleep(150);
    await click('.rc-foot [data-act="ok"]');
    await sleep(400);
    const final = await R("await run.flush(); return await run.stored()");
    const names = final.configs.map((x) => x.name);
    return { ok: items.length === 1 && items[0].includes("tmpcfg(temp)") && after.params === "edited" && !after.temporary && closed
      && menu.includes("Python") && menu.includes("pytest") && menu.includes("Shell Command") && /Script path is not specified/.test(err) && stillOpen
      && final.configs.length === 3 && names.filter((n) => /^python/i.test(n) || /^crash/.test(n)).length >= 2 && final.configs.every((x) => !x.temporary),
      note: JSON.stringify({ items, err, names, menu }) };
  });

  await check("toolbar widget dropdown lists configs (italic temporary), selects, Edit Configurations…", async () => {
    await R(`run.ensure({ type: "shell", name: "tempsh", command: "echo hi", temporary: true }); return 1`);
    await click('[data-testid="run-widget"] [data-act="config"]');
    await app.ev(`return await __qa.waitFor('[data-testid="run-menu"]', 3000)`);
    const items = await R("return run.menuItems()");
    const last = await app.ev(`return [...document.querySelectorAll('[data-testid="run-menu"] .menu-item')].at(-1).textContent`);
    const first = items.find((i) => !i.temp);
    await app.ev(`document.querySelector('[data-testid="run-menu"] .run-menu-item[data-cfg="${first.id}"]').click(); return 1`);
    await sleep(200);
    const sel = await R("return run.selected()");
    const closed = !(await exists('[data-testid="run-menu"]'));
    return { ok: items.length === 4 && items.some((i) => i.temp && i.name === "tempsh") && last === "Edit Configurations…" && sel === first.id && closed, note: JSON.stringify(items) };
  });

  await check("toolbar ▶ button runs the selected configuration", async () => {
    await clean();
    const id = (await cfgOf("python", { name: "viaButton", script: "hello.py", params: "btn" })).id;
    await R(`run.select(${JSON.stringify(id)}); return 1`);
    await click('[data-testid="run-widget"] [data-act="run"]');
    await app.ev(`return await __qa.waitFor(async () => { const r = (await __qa.py()).run; const s = r.sessions()[0]; return s && s.status === "finished" && r.text(s.id).includes("['btn']"); }, 12000)`, { timeout: 16000 });
    return true;
  });

  await check("⌃⌥R choose-configuration popup runs the highlighted entry; Esc closes; ⌃⌥D debugs", async () => {
    await clean();
    await cfgOf("python", { name: "chooseA", script: "hello.py", params: "ca" });
    const b = (await cfgOf("python", { name: "chooseB", script: "hello.py", params: "cb" })).id;
    await R(`run.select(${JSON.stringify(b)}); return 1`);
    await key("control alt R");
    await app.ev(`return await __qa.waitFor('[data-testid="choose-list"]', 3000)`);
    const rows = await app.ev(`return [...document.querySelectorAll(".choose-row")].map((e) => e.textContent.replace("selected", ""))`);
    const hiName = await app.ev(`return document.querySelector(".choose-row.selected").textContent.replace("selected", "")`);
    await key("ESCAPE");
    await sleep(150);
    const closed = !(await exists('[data-testid="choose-list"]'));
    await key("control alt R");
    await app.ev(`return await __qa.waitFor('[data-testid="choose-list"]', 3000)`);
    await key("UP");
    await key("ENTER");
    await app.ev(`return await __qa.waitFor(async () => { const r = (await __qa.py()).run; const s = r.sessions().find((s) => s.name === "chooseA"); return s && s.status === "finished" && r.text(s.id).includes("['ca']"); }, 12000)`, { timeout: 16000 });
    await R(`run.captureDebug(true); return 1`);
    await key("control alt D");
    await app.ev(`return await __qa.waitFor('[data-testid="choose-list"]', 3000)`);
    await key("ENTER");
    await sleep(600);
    const calls = await R("return run.debugCalls()");
    await R(`run.captureDebug(false); return 1`);
    return { ok: rows.join("|") === "chooseA|chooseB|Edit Configurations…" && hiName === "chooseB" && closed && calls.length === 1 && calls[0].target.args.join() === "ca", note: JSON.stringify({ rows, hiName, calls: calls.length }) };
  });

  await check("⌘4 toggles the Run window (show+focus, then hide)", async () => {
    await reset2(c, "hello.py");
    await key("meta 4");
    await sleep(300);
    const s1 = await S();
    await key("meta 4");
    await sleep(300);
    const s2 = await S();
    return { ok: s1.toolWindows.bottom === "run" && s1.focused === "toolwindow:run" && s2.toolWindows.bottom === null, note: JSON.stringify({ a: s1.toolWindows.bottom, f: s1.focused, b: s2.toolWindows.bottom }) };
  });

  await check("⌃R inside the Terminal tool window does NOT run", async () => {
    await clean();
    const id = (await cfgOf("python", { name: "termguard", script: "hello.py", params: "never" })).id;
    await R(`run.select(${JSON.stringify(id)}); return 1`);
    await key("alt F12");
    await app.ev(`return await __qa.waitFor(() => __qa.state().focused.startsWith("toolwindow:terminal"), 6000)`, { timeout: 9000 });
    await sleep(500);
    const acts = await app.ev(`return __qa.actions().filter((a) => ["Run","Debug","RunClass"].includes(a.id)).map((a) => a.id + ":" + a.enabled)`);
    await key("control R");
    await key("control D");
    await sleep(700);
    const n = (await sessions()).length;
    await key("alt F12");
    return { ok: n === 0 && acts.every((a) => a.endsWith(":false")), note: JSON.stringify({ n, acts }) };
  });

  await check("keymap: Run/Debug/RunClass/DebugClass/Choose*/Stop/Rerun/RerunTests bound as in IntelliJ", async () => {
    const a = await app.ev(`return __qa.actions().filter((x) => /^(Run|Debug|RunClass|DebugClass|ChooseRunConfiguration|ChooseDebugConfiguration|Stop|Rerun|Rerun\\.Debug|RerunTests|RerunFailedTests|EditRunConfigurations|ActivateRunToolWindow)$/.test(x.id)).map((x) => x.id + "=" + x.keys.join("/"))`);
    const want = ["Run=control R", "Debug=control D", "RunClass=control shift R", "DebugClass=control shift D", "ChooseRunConfiguration=control alt R", "ChooseDebugConfiguration=control alt D", "Stop=meta F2", "Rerun=meta R", "RerunTests=control meta R/alt shift R", "ActivateRunToolWindow=meta 4"];
    const missing = want.filter((w) => !a.some((x) => x.replace(/,/g, "").includes(w.replace(/,/g, ""))));
    return { ok: missing.length === 0, note: JSON.stringify({ missing, a }) };
  });

  await check("gutter run markers: main + tests computed; marker run starts the config", async () => {
    await clean();
    const main = await R(`return await run.markers(${JSON.stringify(P("app/main.py"))})`);
    const tests = await R(`return await run.markers(${JSON.stringify(P("tests/test_math.py"))})`);
    const unit = await R(`return await run.markers(${JSON.stringify(P("tests/test_unit.py"))})`);
    const none = await R(`return await run.markers(${JSON.stringify(P("app/util.py"))})`);
    const lineOf = (f, re) => c.fs.readFileSync(P(f), "utf8").split("\n").findIndex((l) => re.test(l)) + 1;
    const exp = [
      [lineOf("tests/test_math.py", /^def test_add\(/), "test"], [lineOf("tests/test_math.py", /^def test_add_fails/), "test"], [lineOf("tests/test_math.py", /^def test_skipped/), "test"],
      [lineOf("tests/test_math.py", /^class TestGroup/), "test-class"], [lineOf("tests/test_math.py", /def test_inner_ok/), "test"], [lineOf("tests/test_math.py", /def test_inner_prints/), "test"],
    ];
    const mainLine = lineOf("app/main.py", /^if __name__/);
    const okTests = JSON.stringify(tests.map((m) => [m.line, m.kind])) === JSON.stringify(exp);
    const okMain = main.length === 1 && main[0].line === mainLine && main[0].kind === "main" && main[0].label === "Run 'main'";
    const okUnit = unit.map((m) => m.kind).join() === "test-class,test,test";
    await R(`await run.markerRun(${JSON.stringify(P("app/main.py"))}, ${mainLine}, "run"); return 1`);
    await app.ev(`return await __qa.waitFor(async () => { const r = (await __qa.py()).run; const s = r.sessions()[0]; return s && s.status === "finished" && r.text(s.id).includes("result 10"); }, 15000)`, { timeout: 20000 });
    return { ok: okTests && okMain && okUnit && none.length === 0, note: JSON.stringify({ okTests, okMain, okUnit, none: none.length, tests }) };
  });

  await check("cleanup: no leftover run processes", async () => {
    await clean();
    await sleep(300);
    return { ok: !pgrep(`${proj}/loop.py`), note: "" };
  });
}

async function reset2(c, rel) {
  await c.reset(rel);
}
