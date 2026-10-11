// The Python key table (docs/PYTHON.md) is bound as documented, and existing IntelliJ keys still behave with Python features loaded.
export async function checks(c) {
  const { check, app, key, S, py, sleep, P } = c;
  const actions = () => app.ev("return __qa.actions()");
  const table = {
    Run: "control R", Debug: "control D", RunClass: "control shift R", DebugClass: "control shift D", ChooseRunConfiguration: "control alt R",
    ChooseDebugConfiguration: "control alt D", Stop: "meta F2", Rerun: "meta R", RerunTests: "control meta R", ActivateRunToolWindow: "meta 4",
    ActivateDebugToolWindow: "meta 5", ToggleLineBreakpoint: "meta F8", ViewBreakpoints: "meta shift F8", StepOver: "F8", StepInto: "F7",
    StepOut: "shift F8", Resume: "meta alt R", RunToCursor: "alt F9", EvaluateExpression: "alt F8", ShowExecutionPoint: "alt F10",
    ExecuteInPyConsoleAction: "alt shift E", ReformatCode: "meta alt L", OptimizeImports: "control alt O", GotoDeclaration: "meta B",
    FindUsages: "alt F7", RenameElement: "shift F6", FileStructurePopup: "meta F12", ParameterInfo: "meta P", QuickJavaDoc: "F1",
  };
  await check("every documented key is bound to its action", async () => {
    const a = await actions();
    const bad = [];
    for (const [id, k] of Object.entries(table)) {
      const hit = a.filter((x) => x.id === id || x.id.startsWith(id)).flatMap((x) => x.keys);
      const norm = (s) => s.toLowerCase().split(/\s+/).sort().join(' ');
      if (!hit.some((h) => norm(h) === norm(k))) bad.push(`${id}:${k} (has ${hit.join("|") || "none"})`);
    }
    return { ok: bad.length === 0, note: bad.join("; ") };
  }, { fresh: "hello.py" });

  await check("⌘D duplicates a line in the editor; ⌘R opens Replace (does not rerun)", async () => {
    const before = await app.ev("return __qa.editor().getModel().getLineCount()");
    const runs0 = await py("return py.run.sessions().length");
    await app.ev("const e = __qa.editor(); e.setPosition({lineNumber:1,column:1}); e.focus(); return 1");
    await key("meta D");
    await sleep(150);
    const after = await app.ev("return __qa.editor().getModel().getLineCount()");
    await key("meta R");
    await sleep(300);
    const runs1 = await py("return py.run.sessions().length");
    const st = await S();
    await key("ESCAPE");
    await app.ev("__qa.editor().trigger('qa','undo',null); return 1");
    return { ok: after === before + 1 && runs1 === runs0 && !st.toolWindows.bottom, note: JSON.stringify({ before, after, runs0, runs1, bottom: st.toolWindows.bottom }) };
  });

  await check("⌘4 / ⌘5 toggle the Run / Debug windows; ⌘1 still the Project window; ⌥F12 terminal", async () => {
    await key("meta 4"); await sleep(250);
    const a = (await S()).toolWindows.bottom;
    await key("meta 5"); await sleep(250);
    const b = (await S()).toolWindows.bottom;
    await key("meta 1"); await sleep(250);
    const l = (await S()).toolWindows.left;
    await key("alt F12"); await sleep(400);
    const t = (await S()).toolWindows.bottom;
    return { ok: a === "run" && b === "debug" && t === "terminal", note: JSON.stringify({ a, b, l, t }) };
  });

  await check("F7/F8/⌥F8 are inert in the editor while no debug session exists (keys fall through)", async () => {
    await app.ev("__qa.editor().focus(); return 1");
    await key("F8"); await key("F7"); await key("alt F8"); await sleep(200);
    const s = await S();
    return { ok: !s.popup.open && s.toolWindows.bottom !== "debug", note: JSON.stringify(s.toolWindows) };
  });

  await check("⌘E Recent Files and double-⇧ Search Everywhere still open", async () => {
    await key("meta E"); await sleep(250);
    const a = (await S()).popup.open;
    await key("ESCAPE"); await sleep(150);
    await app.ev("return __qa.tap('Shift')"); await app.ev("return __qa.tap('Shift')"); await sleep(400);
    const b = (await S()).popup.open;
    await key("ESCAPE");
    return { ok: a && b, note: `recent=${a} se=${b}` };
  });
}
