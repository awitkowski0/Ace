// Interpreter area (Agent D): status widget, switcher popup, Add Python Interpreter dialog, terminal venv activation.
// Everything is driven through window.__qa / __qa.py() (no OS-level input).
export async function checks(c) {
  const { app, proj, venv, venvPython, check, key, py, P, S, sleep, fs, path, scratch, execSync } = c;
  const ev = (body, o) => app.ev(body, o);
  const dq = (sel) => JSON.stringify(sel);
  const setInput = (sel, val) => ev(`const el = document.querySelector(${dq(sel)}); if (!el) throw new Error("no element"); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set; set.call(el, ${JSON.stringify(val)}); el.dispatchEvent(new Event("input", { bubbles: true })); return el.value`);
  const setSelect = (sel, val) => ev(`const el = document.querySelector(${dq(sel)}); const set = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set; set.call(el, ${JSON.stringify(val)}); el.dispatchEvent(new Event("change", { bubbles: true })); return el.value`);
  const click = (sel) => ev(`const el = document.querySelector(${dq(sel)}); if (!el) throw new Error("no element"); el.click(); return 1`);
  const exists = (sel) => ev(`return !!document.querySelector(${dq(sel)})`);
  const waitSel = (sel, ms = 5000) => ev(`return !!(await __qa.waitFor(${dq(sel)}, ${ms}))`, { timeout: ms + 3000 });
  const gone = (sel, ms = 8000) => ev(`return await __qa.waitFor(() => !document.querySelector(${dq(sel)}), ${ms})`, { timeout: ms + 3000 });
  const widget = () => py("return py.interp.widgetText()");
  const cur = () => py("return py.interp.current()");
  const waitCurrent = (p, ms = 20000) => py(`return await __qa.waitFor(() => { const c = py.interp.current(); const s = py.interp.state(); return c && c.path === ${JSON.stringify(p)} && !s.loading && s.probe; }, ${ms})`, { timeout: ms + 3000 });
  const toVenv = async () => { await py(`await py.interp.switchTo(${JSON.stringify(venvPython)}); return 1`); await waitCurrent(venvPython); };
  const made = [];
  const newDir = (n) => { const d = path.join(scratch, n); made.push(d); return d; };

  await check("status widget shows 'Python 3.x (proj)' for the project .venv", async () => {
    await py(`return await __qa.waitFor(() => py.interp.widgetText() && py.interp.current(), 20000)`, { timeout: 25000 });
    const w = await widget(), cu = await cur();
    return { ok: /^Python 3\.\d+ \(proj\)$/.test(w) && cu.path === venvPython && cu.project === true, note: `widget='${w}' current=${cu?.path}` };
  });

  await check("discovery lists the project venv first, then system interpreters", async () => {
    const l = await py("return py.interp.list()");
    return { ok: l.length >= 2 && l[0].project && l[0].path === venvPython && l.some((i) => !i.project), note: l.map((i) => `${i.kind}:${i.name}`).join(" | ").slice(0, 160) };
  });

  await check("widget click opens the popup: project group first, current interpreter checked, paths shown", async () => {
    await click('[data-testid="py-interp-widget"]');
    await waitSel('[data-testid="py-interp-popup"]');
    const rows = await py("return py.interp.popupRows()");
    const cr = rows.find((r) => r.interp === venvPython);
    const firstSec = rows.find((r) => r.sec);
    const acts = rows.filter((r) => r.act).map((r) => r.text);
    await key("ESCAPE");
    return { ok: firstSec?.text === "Project interpreters" && cr && cr.text.startsWith("✓") && cr.text.includes(".venv/bin/python") && acts.some((t) => /Add New Interpreter/.test(t)) && acts.some((t) => /Interpreter Settings/.test(t)), note: JSON.stringify(rows.slice(0, 4)).slice(0, 220) };
  });

  await check("popup: Esc closes it", async () => {
    await click('[data-testid="py-interp-widget"]');
    await waitSel('[data-testid="py-interp-popup"]');
    await key("ESCAPE");
    return { ok: await gone('[data-testid="py-interp-popup"]', 2000) };
  });

  await check("popup: ArrowDown + Enter switches the interpreter (widget + pyStore follow), switching back works", async () => {
    await click('[data-testid="py-interp-widget"]');
    await waitSel('[data-testid="py-interp-popup"]');
    const before = (await py("return py.interp.popupRows()")).find((r) => r.selected);
    await key("DOWN");
    await sleep(80);
    const after = (await py("return py.interp.popupRows()")).find((r) => r.selected);
    if (!after?.interp || after.interp === venvPython) { await key("ESCAPE"); return { ok: false, note: `selection did not move to another interpreter: ${JSON.stringify(after)}` }; }
    await key("ENTER");
    await waitCurrent(after.interp);
    const w = await widget(), s = await py("return py.interp.state()");
    const switched = w === (await py("return py.interp.current()")).name && s.explicit === true;
    await toVenv();
    const back = await widget();
    return { ok: switched && /\(proj\)$/.test(back), note: `from ${before?.text?.slice(0, 40)} to ${after.interp} widget='${w}' back='${back}'` };
  });

  await check("Find Action entries: Select Python Interpreter / Add Python Interpreter", async () => {
    const acts = await ev("return __qa.actions().filter((a) => /Python Interpreter/.test(a.title)).map((a) => a.title)");
    await ev('return __qa.runAction("Ace.SelectPythonInterpreter")');
    const opened = await waitSel('[data-testid="py-interp-popup"]', 3000);
    await key("ESCAPE");
    await ev('return __qa.runAction("Ace.AddPythonInterpreter")');
    const dlg = await waitSel('[data-testid="py-add-dialog"]', 3000);
    await key("ESCAPE");
    return { ok: acts.includes("Select Python Interpreter") && acts.includes("Add Python Interpreter") && opened && dlg && (await gone('[data-testid="py-add-dialog"]', 2000)), note: acts.join(",") };
  });

  await check("popup: 'Interpreter Settings…' opens the dialog on the Existing tab; Add New opens Virtualenv", async () => {
    await click('[data-testid="py-interp-widget"]');
    await waitSel('[data-testid="py-interp-popup"]');
    await click('[data-act="settings"]');
    await waitSel('[data-testid="py-add-dialog"]');
    const existing = await exists('[data-testid="ex-path"]');
    await key("ESCAPE");
    await gone('[data-testid="py-add-dialog"]', 2000);
    await click('[data-testid="py-interp-widget"]');
    await waitSel('[data-testid="py-interp-popup"]');
    await click('[data-act="add"]');
    await waitSel('[data-testid="py-add-dialog"]');
    const venvTab = await exists('[data-testid="venv-dir"]');
    await key("ESCAPE");
    return { ok: existing && venvTab };
  });

  await check("Add dialog / Existing: a bad path shows the error and keeps the dialog; a typed path is selected", async () => {
    await py(`py.interp.openPopup("existing"); return 1`);
    await waitSel('[data-testid="ex-path"]');
    await setInput('[data-testid="ex-path"]', "/nonexistent/bin/python");
    await click('[data-testid="py-add-ok"]');
    await waitSel('[data-testid="py-add-error"]', 15000);
    const kept = await exists('[data-testid="py-add-dialog"]');
    const sys = (await py("return py.interp.list()")).find((i) => !i.project);
    await setInput('[data-testid="ex-path"]', sys.path);
    await click('[data-testid="py-add-ok"]');
    const closed = await gone('[data-testid="py-add-dialog"]', 20000);
    await waitCurrent(sys.path);
    const ok = kept && closed && (await cur()).path === sys.path;
    await toVenv();
    return { ok, note: `kept=${kept} closed=${closed} sys=${sys.path}` };
  });

  await check("Add dialog / Virtualenv: defaults, nothing created before OK, then created + auto-selected (inherit site-packages ticked)", async () => {
    const dir = newDir("qa-venv-a");
    await py(`py.interp.openPopup("venv"); return 1`);
    await waitSel('[data-testid="venv-dir"]');
    const def = await ev(`return document.querySelector('[data-testid="venv-dir"]').value`);
    const tool = await ev(`return document.querySelector('[data-testid="venv-tool"]').textContent`);
    const bases = await ev(`return document.querySelector('[data-testid="venv-base"]').options.length`);
    await setInput('[data-testid="venv-dir"]', dir);
    await click('[data-testid="venv-site"]');
    await sleep(500);
    const before = fs.existsSync(dir);
    await click('[data-testid="py-add-ok"]');
    const sawBusy = await waitSel('[data-testid="py-add-busy"]', 3000).catch(() => false);
    const closed = await gone('[data-testid="py-add-dialog"]', 120000);
    const py1 = path.join(dir, "bin/python");
    await waitCurrent(py1, 30000);
    const cfg = fs.readFileSync(path.join(dir, "pyvenv.cfg"), "utf8");
    const w = await widget();
    return { ok: def === path.join(proj, ".venv") && /^uv/.test(tool) && bases >= 1 && !before && closed && /include-system-site-packages = true/.test(cfg) && w.startsWith("Python 3."), note: `default=${def} tool=${tool} bases=${bases} before=${before} busy=${sawBusy} widget='${w}'` };
  });

  await check("Add dialog / Virtualenv: a failing creation shows the tool's error and keeps the dialog open", async () => {
    await py(`py.interp.openPopup("venv"); return 1`);
    await waitSel('[data-testid="venv-dir"]');
    const bad = path.join(scratch, "no-such-parent", "deeper", "x");
    // a regular file where a directory is needed
    const blocker = path.join(scratch, "blocker-file");
    fs.writeFileSync(blocker, "x");
    made.push(blocker);
    await setInput('[data-testid="venv-dir"]', path.join(blocker, "env"));
    await click('[data-testid="py-add-ok"]');
    await waitSel('[data-testid="py-add-error"]', 30000);
    const stillOpen = await exists('[data-testid="py-add-dialog"]');
    const errText = await ev(`return document.querySelector('[data-testid="py-add-error"]').textContent`);
    await key("ESCAPE");
    return { ok: stillOpen && errText.length > 3, note: errText.slice(0, 100) };
  });

  await check("Add dialog / Conda: existing conda environments are listed from discovery", async () => {
    const conda = (await py("return py.interp.list()")).filter((i) => i.kind === "conda").length;
    const hasConda = !!(await py("return py.interp.state().tools.conda"));
    await py(`py.interp.openPopup("existing"); return 1`);
    await waitSel('[data-testid="py-add-dialog"]');
    await click('[data-tab="conda"]');
    const shown = await ev(`const s = document.querySelector('[data-testid="conda-existing"]'); return s ? s.options.length : -1`);
    const newMode = await exists('[data-testid="conda-dir"]');
    await key("ESCAPE");
    return { ok: hasConda ? shown === conda && newMode : true, note: `conda=${hasConda} envs=${conda} shown=${shown}` };
  });

  await check("custom interpreter persists per project (python.json in the app data dir)", async () => {
    const f = execSync(`find ${JSON.stringify(app.dataDir)} -name python.json | head -1`).toString().trim();
    const j = f ? JSON.parse(fs.readFileSync(f, "utf8")) : null;
    return { ok: !!j && typeof j.interpreter === "string" && j.custom.some((i) => i.path.includes("qa-venv-a")), note: j ? `interpreter=${j.interpreter} custom=${j.custom.length}` : "no file" };
  });

  // ---------------------------------------------------------------- terminal activation
  const T = (body, o) => ev(`const T = await __qa.term(); const st = () => T.state(); const cur = () => { const s = st(); const t = s.tabs.find((x) => x.id === s.active); return t && t.panes.find((p) => p.focused); }; ${body}`, o);
  const openTerm = async () => {
    await key("alt F12");
    await T(`await __qa.waitFor(() => { const p = cur(); return p && p.cols > 10 && p.domFocused; }, 10000); return 1`, { timeout: 15000 });
    await T(`await __qa.waitFor(() => { const p = cur(); return p && p.cwdFromShell && p.blocks > 0; }, 30000); return 1`, { timeout: 35000 });
  };
  const runIn = async (cmd, marker) => {
    await T(`const id = cur().id; T.sendText(id, ${JSON.stringify(cmd + "\n")}); await __qa.waitFor(() => T.text(id).includes(${JSON.stringify(marker)}), 12000); return 1`, { timeout: 16000 });
    return T(`return T.text(cur().id)`);
  };
  const closeTerminal = () => T(`for (let i = 0; i < 6; i++) { const s = st(); if (!s.tabs.length) break; await __qa.key("meta W"); await __qa.sleep(250); } return st().tabs.length`).catch(() => 0);

  /** last regex match over the buffer text with soft line wraps removed (the scratch paths are longer than the terminal is wide) */
  const grab = (txt, re) => { const all = [...txt.replace(/\n/g, "").matchAll(re)]; return all.length ? all[all.length - 1] : null; };

  await check("terminal: a new tab in the project auto-activates the selected venv (which python, VIRTUAL_ENV, prompt)", async () => {
    await toVenv();
    try { await openTerm(); } catch (e) { return { ok: false, note: "openTerm: " + String(e.message).replace(/\s+/g, " ").slice(0, 300) }; }
    const txt = await runIn(`echo "WHICH=[$(command -v python)] VENV=[$VIRTUAL_ENV] PS1=<$PS1> END"`, "END");
    const m = grab(txt, /WHICH=\[([^\]]*)\] VENV=\[([^\]]*)\] PS1=<([^>]*)> END/g);
    return { ok: !!m && m[1] === venvPython && m[2] === venv && /\(\.?\w*\)/.test(m[3]), note: m ? `python=${m[1].slice(-30)} venv=${m[2].slice(-12)} ps1=${m[3]}` : "no output" };
  }, { fresh: true });

  await check("terminal: a split inherits the cwd and is activated too", async () => {
    const before = await T("return st().tabs[st().tabs.findIndex((t) => t.id === st().active)].panes.length");
    await key("meta D");
    await T(`await __qa.waitFor(() => { const s = st(); const t = s.tabs.find((x) => x.id === s.active); return t.panes.length === ${before + 1} && cur() && cur().cwdFromShell && cur().blocks > 0; }, 30000); return 1`, { timeout: 35000 });
    const txt = await runIn(`echo "W2=[$(command -v python)] CWD=[$PWD] E2"`, "E2");
    const m = grab(txt, /W2=\[([^\]]*)\] CWD=\[([^\]]*)\] E2/g);
    return { ok: !!m && m[1] === venvPython && m[2] === proj, note: m ? `python=${m[1].slice(-30)} cwd=${m[2].slice(-12)}` : "no output" };
  }, { fresh: false });

  await check("terminal: with 'Activate virtualenv' turned off, new tabs are not activated; turning it on again restores it", async () => {
    await py("py.interp.setTerminalActivate(false); return 1");
    await key("meta T");
    await T(`await __qa.waitFor(() => { const p = cur(); return p && p.cwdFromShell && p.blocks > 0 && st().tabs.length >= 2; }, 30000); return 1`, { timeout: 35000 });
    const off = await runIn(`echo "OFF=[$VIRTUAL_ENV] E3"`, "E3");
    const offM = grab(off, /OFF=\[([^\]]*)\] E3/g);
    await py("py.interp.setTerminalActivate(true); return 1");
    await key("meta T");
    await T(`await __qa.waitFor(() => { const p = cur(); return p && p.cwdFromShell && p.blocks > 0 && st().tabs.length >= 3; }, 30000); return 1`, { timeout: 35000 });
    const on = await runIn(`echo "ON=[$VIRTUAL_ENV] E4"`, "E4");
    const onM = grab(on, /ON=\[([^\]]*)\] E4/g);
    return { ok: !!offM && offM[1] === "" && !!onM && onM[1] === venv, note: `off=[${offM?.[1]}] on=[${onM?.[1]?.slice(-12)}]` };
  }, { fresh: false });

  await check("terminal: selecting a system interpreter stops activation for new tabs (no venv forced)", async () => {
    const sys = (await py("return py.interp.list()")).find((i) => !i.project && i.kind === "system") || (await py("return py.interp.list()")).find((i) => !i.project);
    await py(`await py.interp.switchTo(${JSON.stringify(sys.path)}); return 1`);
    await waitCurrent(sys.path);
    await key("meta T");
    await T(`await __qa.waitFor(() => { const p = cur(); return p && p.cwdFromShell && p.blocks > 0 && st().tabs.length >= 4; }, 30000); return 1`, { timeout: 35000 });
    const out = await runIn(`echo "SYS=[$VIRTUAL_ENV] E5"`, "E5");
    const m = grab(out, /SYS=\[([^\]]*)\] E5/g);
    await toVenv();
    await closeTerminal();
    return { ok: !!m && m[1] === "", note: `venv=[${m?.[1]}] using ${sys.kind}` };
  }, { fresh: false });

  // ---------------------------------------------------------------- remote project on mc (second app instance, own socket)
  if (!c.noSsh) {
    const { launch } = await import("../lib.mjs");
    const rdir = `/tmp/ace-qa-d-${process.pid}-${Date.now().toString(36)}`;
    let rapp = null;
    const cleanupRemote = () => { try { execSync(`ssh -o BatchMode=yes mc 'rm -rf ${rdir}'`, { stdio: "ignore" }); } catch {} };
    try {
      const sshIn = (cmd, input) => execSync(`ssh -o BatchMode=yes -o ConnectTimeout=10 mc ${JSON.stringify(cmd)}`, { input, stdio: ["pipe", "ignore", "ignore"] });
      sshIn(`mkdir -p ${rdir} && cat > ${rdir}/pyproject.toml`, '[project]\nname = "r"\n');
      sshIn(`cat > ${rdir}/a.py`, "print(1)\n");
      rapp = await launch(`mc:${rdir}`, { sock: path.join(process.env.TMPDIR || "/tmp", `ace-qa-remote-${process.pid}.sock`) });
      const R = (body, o) => rapp.ev(`const py = await __qa.py(); ${body}`, o);
      const rsel = (sel, ms = 8000) => rapp.ev(`return !!(await __qa.waitFor(${dq(sel)}, ${ms}))`, { timeout: ms + 3000 });
      await check("remote (mc): the status widget shows the host's interpreter; the dialog creates a venv on the host (venv --without-pip fallback)", async () => {
        await rapp.ev(`return await __qa.waitFor(() => __qa.state().project && __qa.state().project.host === "mc", 30000)`, { timeout: 35000 });
        await R(`return await __qa.waitFor(() => py.interp.current(), 40000)`, { timeout: 45000 });
        const w = await R("return py.interp.widgetText()");
        const cu = await R("return py.interp.current()");
        await R(`py.interp.openPopup("venv"); return 1`);
        await rsel('[data-testid="venv-dir"]');
        const def = await rapp.ev(`return document.querySelector('[data-testid="venv-dir"]').value`);
        const tool = await rapp.ev(`return document.querySelector('[data-testid="venv-tool"]').textContent`);
        const browse = await rapp.ev(`return [...document.querySelectorAll(".pyd button")].some((b) => /Browse/.test(b.textContent))`);
        await rapp.ev(`document.querySelector('[data-testid="py-add-ok"]').click(); return 1`);
        await rapp.ev(`return await __qa.waitFor(() => !document.querySelector('[data-testid="py-add-dialog"]'), 120000)`, { timeout: 125000 });
        await R(`return await __qa.waitFor(() => py.interp.current() && py.interp.current().path.endsWith("/.venv/bin/python") && !py.interp.state().loading, 40000)`, { timeout: 45000 });
        const after = await R("return py.interp.current()");
        const onHost = execSync(`ssh -o BatchMode=yes mc 'test -x ${rdir}/.venv/bin/python && cat ${rdir}/.venv/pyvenv.cfg | head -3'`).toString();
        const sess = await R("return await py.lang.sessions()");
        return { ok: /^Python 3\.\d+/.test(w) && cu.path.startsWith("/usr/") && def === `${rdir}/.venv` && /venv/.test(tool) && !browse && after.path === `${rdir}/.venv/bin/python` && /home/.test(onHost) && sess.length === 0, note: `widget='${w}' base=${cu.path} tool='${tool}' created=${after.path} sessions=${sess.length}` };
      }, { fresh: false });
    } catch (e) {
      console.log("remote interp checks skipped:", String(e.message).split("\n")[0].slice(0, 160));
    } finally {
      if (rapp) await rapp.stop();
      cleanupRemote();
    }
  }

  // ---------------------------------------------------------------- cleanup of what this area created
  await check("cleanup: scratch environments removed", async () => {
    for (const d of made) fs.rmSync(d, { recursive: true, force: true });
    await toVenv();
    return { ok: made.every((d) => !fs.existsSync(d)) };
  }, { fresh: false });
}
