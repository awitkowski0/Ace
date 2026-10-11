// pytest / unittest runner: test tree in the Run window, counters, output, jump to source, rerun failed (docs/PYTHON.md).
export async function checks(c) {
  const { check, py, key, S, P, sleep, app, proj } = c;
  const R = (body, o) => py(`const run = py.run; ${body}`, o);
  const J = JSON.stringify;
  const click = (sel, i = 0) => app.ev(`const el = [...document.querySelectorAll(${J(sel)})][${i}]; if (!el) throw new Error("no " + ${J(sel)}); el.click(); return true`);
  const exists = (sel) => app.ev(`return !!document.querySelector(${J(sel)})`);
  const clean = () => R(`for (const s of run.sessions()) { try { run.stop(s.id); } catch {} } for (const s of run.sessions()) await run.close(s.id); for (const cfg of [...run.configs()]) run.removeConfig(cfg.id); await run.flush(); return true`, { timeout: 20000 });
  const runCfg = async (type, patch, ms = 60000) => {
    const cfg = await R(`return run.addConfig(${J(type)}, ${J(patch)})`);
    const sid = await R(`return await run.start(${J(cfg.id)}, "run")`);
    const done = await R(`return await run.waitDone(${J(sid)}, ${ms})`, { timeout: ms + 8000 });
    return { cfg, sid, done };
  };
  const showRun = async () => { await key("meta 4"); await sleep(250); };
  const tree = (sid) => R(`return run.tests(${J(sid)})`);
  const flat = (n, out = {}) => { if (n.kind === "test") out[n.id] = n; n.children.forEach((k) => flat(k, out)); return out; };
  const T = "tests/test_math.py";
  const ids = { ok: `${T}::test_add`, bad: `${T}::test_add_fails`, skip: `${T}::test_skipped`, in1: `${T}::TestGroup::test_inner_ok`, in2: `${T}::TestGroup::test_inner_prints` };

  let math;
  await check("pytest: tree with passed / failed / skipped / class tests and counters", async () => {
    await clean();
    math = await runCfg("pytest", { name: "math", target: T });
    const t = await tree(math.sid);
    const f = flat(t.root);
    const oc = (k) => f[ids[k]]?.outcome;
    const root = t.root.counts;
    const text = await R(`return run.text(${J(math.sid)})`);
    const ok = oc("ok") === "passed" && oc("bad") === "failed" && oc("skip") === "skipped" && oc("in1") === "passed" && oc("in2") === "passed"
      && t.status === "Tests passed: 3 of 5, 1 failed, 1 skipped" && math.done.exit === 1 && t.done && root.total === 5
      && !text.includes("##ace") && !text.includes("\x1e") && /1 failed, 3 passed, 1 skipped/.test(text);
    return { ok, note: ok ? "" : JSON.stringify({ status: t.status, exit: math.done.exit, oc: Object.keys(ids).map(oc), tail: text.slice(-300) }) };
  });

  await check("pytest: structure (module > class > test) and durations", async () => {
    const t = await tree(math.sid);
    const mod = t.root.children[0];
    const grp = mod.children.find((k) => k.kind === "class");
    return { ok: t.root.children.length === 1 && mod.kind === "module" && mod.name === T && grp?.name === "TestGroup" && grp.children.length === 2 && flat(t.root)[ids.ok].duration > 0, note: JSON.stringify(mod.children.map((k) => k.name)) };
  });

  await check("pytest: command line echo, plain pytest args, abs paths", async () => {
    const t = await R(`return run.text(${J(math.sid)})`);
    const first = t.split("\n")[0];
    return { ok: first === `${c.venvPython} -m pytest --color=yes ${T}`, note: first };
  });

  await check("Test Results panel renders: status text, progress bar, rows with outcome icons", async () => {
    await showRun();
    await app.ev(`return await __qa.waitFor('[data-testid="tests-status"]', 5000)`);
    const r = await app.ev(`return { status: document.querySelector('[data-testid="tests-status"] .tests-status-text').textContent, bad: document.querySelector('[data-testid="tests-status"]').classList.contains("bad"), rows: [...document.querySelectorAll(".test-row")].map((e) => e.dataset.kind + ":" + e.dataset.outcome + ":" + e.querySelector(".gname").textContent) }`);
    return { ok: r.status === "Tests passed: 3 of 5, 1 failed, 1 skipped" && r.bad && r.rows[0] === "root:failed:Test Results" && r.rows.includes("test:failed:test_add_fails") && r.rows.includes("test:skipped:test_skipped") && r.rows.includes("class:passed:TestGroup"), note: JSON.stringify(r) };
  });

  await check("select a failing test: message, traceback with file:line link, then click opens the source line", async () => {
    await showRun();
    await R(`run.selectTest(${J(math.sid)}, ${J(ids.bad)}); return 1`);
    await app.ev(`return await __qa.waitFor('[data-testid="test-detail"]', 4000)`);
    await sleep(500);
    const d = await app.ev(`return { text: document.querySelector('[data-testid="test-detail"]').innerText, links: [...document.querySelectorAll('[data-testid="test-detail"] .run-link')].map((a) => a.dataset.path + ":" + a.dataset.line) }`);
    const badLine = c.fs.readFileSync(P(T), "utf8").split("\n").findIndex((l) => l.includes("assert add(1, 2) == 4")) + 1;
    const link = d.links.find((l) => l.endsWith(`test_math.py:${badLine}`));
    if (!/assert 3 == 4/.test(d.text) || !link) return { ok: false, note: JSON.stringify(d) };
    await app.ev(`const a = [...document.querySelectorAll('[data-testid="test-detail"] .run-link')].find((a) => a.dataset.line === "${badLine}"); a.click(); await __qa.waitFor(() => __qa.state().cursor.line === ${badLine}, 5000); return true`);
    return { ok: (await S()).cursor.line === badLine, note: "" };
  });

  await check("captured output of a test is shown in the right pane", async () => {
    await showRun();
    await app.ev(`document.querySelector('.test-row[data-key="${ids.in2}"]').dispatchEvent(new MouseEvent("mousedown", { bubbles: true })); return 1`);
    await sleep(300);
    const t = await app.ev(`return document.querySelector('[data-testid="test-detail"]').innerText`);
    const n = flat((await tree(math.sid)).root)[ids.in2];
    return { ok: /captured text/.test(t) && /captured text/.test(n.output), note: t.slice(0, 200) };
  });

  await check("jump to source: Enter, F4 and double-click open the test at its definition line", async () => {
    const lineOf = (re) => c.fs.readFileSync(P(T), "utf8").split("\n").findIndex((l) => re.test(l)) + 1;
    const expect = { [ids.bad]: lineOf(/def test_add_fails/), [ids.in1]: lineOf(/def test_inner_ok/), [ids.ok]: lineOf(/def test_add\(/) };
    const got = {};
    const open = async (id, how, want) => {
      await reset2(c, "hello.py");
      await showRun();
      await R(`run.selectTest(${J(math.sid)}, ${J(id)}); return 1`);
      await app.ev(`document.querySelector(".tests-list").focus(); return 1`);
      await sleep(150);
      if (how === "enter") await key("ENTER");
      else if (how === "f4") await key("F4");
      else await app.ev(`document.querySelector('.test-row[data-key="${id}"]').dispatchEvent(new MouseEvent("dblclick", { bubbles: true })); return 1`);
      await app.ev(`return await __qa.waitFor(() => { const s = __qa.state(); return s.tabs.some((g) => g.tabs.some((t) => t.name === "test_math.py")); }, 6000)`, { timeout: 9000 });
      await sleep(900);
      return (await S()).cursor.line;
    };
    got.enter = await open(ids.bad, "enter", expect[ids.bad]);
    got.f4 = await open(ids.in1, "f4", expect[ids.in1]);
    got.dbl = await open(ids.ok, "dbl", expect[ids.ok]);
    const ok = got.enter === expect[ids.bad] && got.f4 === expect[ids.in1] && got.dbl === expect[ids.ok];
    return { ok, note: JSON.stringify({ got, expect }) };
  });

  await check("filters: show passed / show ignored / sort alphabetically / collapse & expand all", async () => {
    await showRun();
    await R(`run.selectTest(${J(math.sid)}, ${J(ids.bad)}); return 1`);
    const names = () => app.ev(`return [...document.querySelectorAll(".test-row")].map((e) => e.querySelector(".gname").textContent)`);
    const all = await names();
    const names0 = all.filter((n) => n.startsWith("test_"));
    await click('[data-act="show-passed"]');
    const noPassed = await names();
    await click('[data-act="show-skipped"]');
    const onlyBad = await names();
    await click('[data-act="show-passed"]');
    await click('[data-act="show-skipped"]');
    await click('[data-act="sort-alpha"]');
    const sorted = (await names()).filter((n) => n.startsWith("test_"));
    await click('[data-act="sort-alpha"]');
    await click('[data-act="collapse-all"]');
    const collapsed = await names();
    await click('[data-act="expand-all"]');
    const expanded = await names();
    const ok = all.length === 8 && !noPassed.includes("test_add") && noPassed.includes("test_skipped") && noPassed.includes("test_add_fails")
      && onlyBad.join() === "Test Results,tests/test_math.py,test_add_fails" && sorted.indexOf("test_add") < sorted.indexOf("test_add_fails") && sorted.indexOf("test_add_fails") < sorted.indexOf("test_skipped")
      && collapsed.length === 2 && expanded.length === 8;
    return { ok, note: JSON.stringify({ all, noPassed, onlyBad, collapsed: collapsed.length, expanded: expanded.length }) };
  });

  await check("rerun failed: runs exactly the failed node id, same tab, tree replaced", async () => {
    await showRun();
    const before = await R("return run.sessions().length");
    await click('[data-act="rerun-failed"]');
    await app.ev(`return await __qa.waitFor(async () => { const r = (await __qa.py()).run; const t = r.tests(${J(math.sid)}); return t && t.done && t.root.counts.total === 1; }, 30000)`, { timeout: 35000 });
    await R(`return await run.waitDone(${J(math.sid)}, 10000)`);
    const t = await tree(math.sid);
    const text = await R(`return run.text(${J(math.sid)})`);
    const after = await R("return run.sessions()");
    const f = flat(t.root);
    const ok = after.length === before && Object.keys(f).join() === ids.bad && f[ids.bad].outcome === "failed" && t.status === "Tests passed: 0 of 1, 1 failed"
      && text.split("\n")[0].includes(ids.bad) && !text.includes("test_inner_ok");
    return { ok, note: JSON.stringify({ keys: Object.keys(f), status: t.status, first: text.split("\n")[0], n: after.length }) };
  });

  await check("RerunTests (⌃⌘R) reruns everything in the same tab", async () => {
    await reset2(c, "hello.py");
    await key("control meta R");
    await app.ev(`return await __qa.waitFor(async () => { const r = (await __qa.py()).run; const t = r.tests(${J(math.sid)}); return t && t.done && t.root.counts.total === 5 && r.session(${J(math.sid)}).status === "finished"; }, 30000)`, { timeout: 35000 });
    const t = await tree(math.sid);
    return { ok: t.status === "Tests passed: 3 of 5, 1 failed, 1 skipped" && (await R("return run.sessions().length")) === 1, note: t.status };
  });

  await check("RerunFailedTests action", async () => {
    await app.ev(`return __qa.runAction("RerunFailedTests")`);
    await app.ev(`return await __qa.waitFor(async () => { const r = (await __qa.py()).run; const t = r.tests(${J(math.sid)}); return t && t.done && t.root.counts.total === 1 && r.session(${J(math.sid)}).status === "finished"; }, 30000)`, { timeout: 35000 });
    return true;
  });

  await check("context menu on a test: Run / Debug / Jump to Source", async () => {
    await R(`return await run.rerun(${J(math.sid)})`, { timeout: 40000 });
    await app.ev(`return await __qa.waitFor(async () => { const r = (await __qa.py()).run; const t = r.tests(${J(math.sid)}); return t && t.done && t.root.counts.total === 5; }, 30000)`, { timeout: 35000 });
    await app.ev(`document.querySelector('.test-row[data-key="${ids.in1}"]').dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 200, clientY: 200 })); return 1`);
    await app.ev(`return await __qa.waitFor(".menu .menu-item", 3000)`);
    const items = await app.ev(`return [...document.querySelectorAll(".menu .menu-item")].map((e) => e.textContent)`);
    await R(`run.captureDebug(true); return 1`);
    await app.ev(`[...document.querySelectorAll(".menu .menu-item")].find((e) => e.textContent.startsWith("Debug")).click(); return 1`);
    await sleep(700);
    const calls = await R("return run.debugCalls()");
    await R(`run.captureDebug(false); return 1`);
    await app.ev(`document.querySelector('.test-row[data-key="${ids.in1}"]').dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 200, clientY: 200 })); await __qa.waitFor(".menu .menu-item", 3000); [...document.querySelectorAll(".menu .menu-item")].find((e) => e.textContent.startsWith("Run ")).click(); return 1`);
    await app.ev(`return await __qa.waitFor(async () => { const r = (await __qa.py()).run; const s = r.sessions().find((s) => s.name.includes("test_inner_ok")); return s && s.status === "finished"; }, 30000)`, { timeout: 35000 });
    const s = (await R("return run.sessions()")).find((x) => x.name.includes("test_inner_ok"));
    const t = await tree(s.id);
    const cfgs = await R("return run.configs()");
    return { ok: items[0] === "Run 'test_inner_ok'" && items[1] === "Debug 'test_inner_ok'" && items.some((i) => i.startsWith("Jump to Source")) && calls.length === 1 && calls[0].target.module === "pytest" && calls[0].target.args.join() === ids.in1 && t.status === "Tests passed: 1 of 1" && cfgs.some((x) => x.temporary && x.target === ids.in1 || x.temporary && String(x.target).includes("test_inner_ok")), note: JSON.stringify({ items, calls: calls.length, status: t.status }) };
  });

  await check("⌃⇧R in a test method runs that test (temporary pytest config)", async () => {
    await clean();
    await reset2(c, T);
    const line = c.fs.readFileSync(P(T), "utf8").split("\n").findIndex((l) => l.includes("assert add(2, 2) == 4")) + 1;
    await app.ev(`const ed = __qa.editor(); ed.setPosition({ lineNumber: ${line}, column: 5 }); ed.focus(); return 1`);
    await sleep(150);
    await key("control shift R");
    await app.ev(`return await __qa.waitFor(async () => { const r = (await __qa.py()).run; const s = r.sessions()[0]; return s && s.status === "finished"; }, 30000)`, { timeout: 35000 });
    const cfgs = await R("return run.configs()");
    const s = (await R("return run.sessions()"))[0];
    const t = await tree(s.id);
    return { ok: cfgs.length === 1 && cfgs[0].type === "pytest" && cfgs[0].temporary && cfgs[0].target === ids.in1 && cfgs[0].name === "pytest for test_math.TestGroup.test_inner_ok" && t.status === "Tests passed: 1 of 1", note: JSON.stringify({ cfgs, status: t.status }) };
  });

  await check("⌃⇧R on a class / on a free spot of a test file", async () => {
    const lines = c.fs.readFileSync(P(T), "utf8").split("\n");
    const clsLine = lines.findIndex((l) => l.startsWith("class TestGroup")) + 1;
    await app.ev(`const ed = __qa.editor(); ed.setPosition({ lineNumber: ${clsLine}, column: 3 }); ed.focus(); return 1`);
    await key("control shift R");
    await app.ev(`return await __qa.waitFor(async () => (await __qa.py()).run.configs().some((x) => x.target === "${T}::TestGroup"), 8000)`);
    await app.ev(`const ed = __qa.editor(); ed.setPosition({ lineNumber: 1, column: 1 }); ed.focus(); return 1`);
    await key("control shift R");
    await app.ev(`return await __qa.waitFor(async () => (await __qa.py()).run.configs().some((x) => x.target === "${T}"), 8000)`);
    await app.ev(`return await __qa.waitFor(async () => { const r = (await __qa.py()).run; return r.sessions().every((s) => s.status === "finished"); }, 30000)`, { timeout: 35000 });
    const cfgs = await R("return run.configs().map((x) => x.name)");
    return { ok: cfgs.includes("pytest for test_math.TestGroup") && cfgs.includes("pytest in test_math.py"), note: JSON.stringify(cfgs) };
  }, { fresh: T });

  await check("unittest: tree, failure details, exit code", async () => {
    await clean();
    const u = await runCfg("unittest", { name: "unit", targetKind: "script", target: "tests/test_unit.py" });
    const t = await tree(u.sid);
    const f = flat(t.root);
    const ok = u.done.exit === 1 && t.status === "Tests passed: 1 of 2, 1 failed" && f["tests/test_unit.py::AddTests::test_ok"]?.outcome === "passed" && f["tests/test_unit.py::AddTests::test_bad"]?.outcome === "failed"
      && /AssertionError/.test((await R(`return run.text(${J(u.sid)})`))) && f["tests/test_unit.py::AddTests::test_bad"].hasTrace && f["tests/test_unit.py::AddTests::test_bad"].message.includes("2 != 3");
    if (!ok) return { ok, note: JSON.stringify({ exit: u.done.exit, status: t.status, f: Object.keys(f) }) };
    // rerun failed for unittest -> dotted name
    await R(`return await run.rerunFailed(${J(u.sid)})`, { timeout: 30000 });
    await R(`return await run.waitDone(${J(u.sid)}, 20000)`);
    const t2 = await tree(u.sid);
    return { ok: t2.root.counts.total === 1 && t2.status === "Tests passed: 0 of 1, 1 failed", note: t2.status };
  });

  await check("unittest by pattern (discover) and by dotted names", async () => {
    const p = await runCfg("unittest", { name: "unit-pattern", targetKind: "pattern", target: "tests", pattern: "test_unit*.py" });
    const n = await runCfg("unittest", { name: "unit-names", targetKind: "names", target: "tests.test_unit.AddTests.test_ok" });
    const tp = await tree(p.sid);
    const tn = await tree(n.sid);
    return { ok: tp.root.counts.total === 2 && tn.status === "Tests passed: 1 of 1" && n.done.exit === 0, note: JSON.stringify({ p: tp.status, n: tn.status }) };
  });

  await check("remote-style transport (plugin sent through python -c) gives the same tree", async () => {
    await R(`await run.setInline(true); return 1`);
    try {
      const m = await runCfg("pytest", { name: "math-inline", target: T });
      const u = await runCfg("unittest", { name: "unit-inline", targetKind: "script", target: "tests/test_unit.py" });
      const tm = await tree(m.sid), tu = await tree(u.sid);
      return { ok: tm.status === "Tests passed: 3 of 5, 1 failed, 1 skipped" && tu.status === "Tests passed: 1 of 2, 1 failed", note: JSON.stringify({ m: tm.status, u: tu.status }) };
    } finally { await R(`await run.setInline(false); return 1`); }
  });

  await check("custom pytest arguments (-k) and additional arguments", async () => {
    const r = await runCfg("pytest", { name: "k", targetKind: "custom", target: `-k "add and not fails" ${T}` });
    const t = await tree(r.sid);
    const r2 = await runCfg("pytest", { name: "x", target: T, args: "-x" });
    const t2 = await tree(r2.sid);
    return { ok: t.status === "Tests passed: 1 of 1" && r.done.exit === 0 && t2.root.counts.failed === 1 && r2.done.exit === 1, note: JSON.stringify({ a: t.status, b: t2.status }) };
  });

  await check("collection error shows as an error node, not a hang", async () => {
    c.W("tests/test_broken.py", "import does_not_exist_xyz\n\ndef test_x():\n    pass\n");
    try {
      const r = await runCfg("pytest", { name: "broken", target: "tests/test_broken.py" });
      const t = await tree(r.sid);
      return { ok: r.done.exit !== 0 && t.root.counts.error === 1 && /1 error/.test(t.status), note: t.status };
    } finally { c.fs.rmSync(P("tests/test_broken.py"), { force: true }); }
  });

  await check("pytest missing in the chosen interpreter: install hint shown (nothing is installed)", async () => {
    const list = await R("return run.interpreters()");
    let target = null;
    for (const i of list) { if (i.project) continue; const m = await R(`return await run.probe(${J(i.path)})`).catch(() => null); if (m && m.pytest === false) { target = i; break; } }
    if (!target) return { ok: true, note: "skipped: every other interpreter already has pytest" };
    const r = await runCfg("pytest", { name: "nopytest", target: T, interpreter: target.path });
    const s = await R(`return run.session(${J(r.sid)})`);
    const txt = await R(`return run.text(${J(r.sid)})`);
    await sleep(300);
    return { ok: s.missing === "pytest" && /No module named pytest/.test(txt) && (await exists(".run-banner")) && r.done.exit !== 0, note: JSON.stringify({ missing: s.missing, interp: target.path }) };
  });

  await check("cleanup", async () => {
    await clean();
    return true;
  });
}

async function reset2(c, rel) {
  await c.reset(rel);
}
