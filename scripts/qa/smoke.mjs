#!/usr/bin/env node
// Scripted smoke checklist. Launches Atelier on a COPY of a scratch project (never a real project), drives it
// only through the automation harness (no OS-level input), prints a pass/fail table, writes shots to scripts/qa/out/.
// Usage: node scripts/qa/smoke.mjs [--keep]    Env: ATELIER_BIN, SCRATCH (dir for the copy)
import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { launch, sleep } from "./lib.mjs";

const scratch = process.env.SCRATCH || fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), "atelier-smoke-"));
const proj = path.join(scratch, "proj");
fs.rmSync(proj, { recursive: true, force: true });
fs.mkdirSync(path.join(proj, "scripts"), { recursive: true });
fs.mkdirSync(path.join(proj, "src"), { recursive: true });
fs.writeFileSync(path.join(proj, "scripts/player.gd"), "extends Node\nclass_name Player\n\nvar speed := 5.0\n\nfunc _ready() -> void:\n\tprint(\"ready\")\n");
fs.writeFileSync(path.join(proj, "scripts/enemy.gd"), "extends Node\n");
fs.writeFileSync(path.join(proj, "src/util.ts"), "export const add = (a: number, b: number) => a + b;\n");
fs.writeFileSync(path.join(proj, "README.md"), "# Scratch\n\nhello\n");
execSync("git init -q . && git add -A && git -c user.email=q@q -c user.name=qa commit -qm init", { cwd: proj });

const app = await launch(proj);
const rows = [];
const P = (f) => JSON.stringify(path.join(proj, f));
const S = () => app.ev("return __qa.state()");
const key = (k) => app.ev(`return await __qa.key(${JSON.stringify(k)})`);
// Every check starts from the same baseline (no popup, Project visible, player.gd active + editor focused), so one failed or
// timed-out check can never cascade into the next. A reset that itself times out is retried once.
const reset = async () => { for (let i = 0; ; i++) { try { return await app.ev(`return await __qa.reset(${P("scripts/player.gd")})`, { timeout: 15000 }); } catch (e) { if (i) throw e; await sleep(500); } } };
async function check(name, fn) {
  let ok = false, note = "";
  try { await reset(); const r = await fn(); ok = r === true || (r && r.ok); note = r && r.note ? r.note : ""; } catch (e) { note = String(e.message || e).split("\n")[0].slice(0, 110); }
  const shot = app.shot(name.replace(/[^a-z0-9]+/gi, "_").toLowerCase());
  rows.push({ name, ok, note });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${note ? "  - " + note : ""}`);
}
const popupHas = async (re) => { await sleep(250); const s = await S(); return { ok: s.popup.open && re.test(s.popup.text), note: s.popup.open ? JSON.stringify(s.popup.text.replace(/\s+/g, " ").slice(0, 60)) : "no popup" }; };
const nTabs = (s) => s.tabs.reduce((x, g) => x + g.tabs.length, 0);

try {
await check("meta shift O -> Go to File", async () => { await key("meta shift O"); return popupHas(/^\s*(go to )?files?\b/i); });
await check("shift shift -> Search Everywhere", async () => { await key("shift shift"); return popupHas(/everywhere|search|all/i); });
await check("meta E -> Recent Files", async () => { await key("meta E"); return popupHas(/recent/i); });
await check("meta L -> Go to Line", async () => { await key("meta L"); await sleep(250); const s = await S(); return { ok: (s.popup.open && /line/i.test(s.popup.text + (s.popup.placeholder ?? ""))) || /line/i.test(s.monacoWidget ?? ""), note: `focused=${s.focused} popup=${s.popup.open} widget=${JSON.stringify(s.monacoWidget)}` }; });
await check("meta 1 toggles Project (focus -> hide)", async () => {
  await key("meta 1"); await sleep(200);
  const a = await S();
  await key("meta 1"); await sleep(250);
  const b = await S();
  return { ok: a.focused === "toolwindow:project" && b.toolWindows.left !== "project", note: `after1=${a.focused}/${a.toolWindows.left} after2=${b.focused}/${b.toolWindows.left}` };
});
await check("alt F12 opens Terminal", async () => { await key("alt F12"); await sleep(900); const s = await S(); return { ok: s.toolWindows.bottom === "terminal", note: `bottom=${s.toolWindows.bottom} focused=${s.focused}` }; });
await check("shift Escape hides tool window", async () => { await key("alt F12"); await sleep(900); const a = await S(); await key("shift Escape"); await sleep(250); const b = await S(); return { ok: a.toolWindows.bottom === "terminal" && !b.toolWindows.bottom, note: `before=${a.toolWindows.bottom}/${a.focused} after=${b.toolWindows.bottom}/${b.focused}` }; });
await check("Escape returns focus to editor", async () => { await key("meta 1"); await sleep(250); const a = await S(); await key("Escape"); await sleep(250); const b = await S(); return { ok: a.focused === "toolwindow:project" && b.focused === "editor", note: `before=${a.focused} after=${b.focused}` }; });
await check("typing marks tab dirty", async () => { await app.ev("await __qa.type('zz'); await __qa.sleep(200); return 1"); const s = await S(); return { ok: s.dirty.length === 1, note: `dirty=${s.dirty.length}` }; });
await check("meta S saves (clears dirty, writes file)", async () => { await app.ev("await __qa.type('zz'); await __qa.sleep(100); return 1"); await key("meta S"); await sleep(500); const s = await S(); const txt = fs.readFileSync(path.join(proj, "scripts/player.gd"), "utf8"); return { ok: s.dirty.length === 0 && txt.includes("zz"), note: `dirty=${s.dirty.length} onDisk=${txt.includes("zz")}` }; });
await check("meta W closes tab", async () => { await app.ev(`await __qa.openFile(${P("src/util.ts")}); await __qa.sleep(200); __qa.editor()?.focus(); return 1`); const a = await S(); await key("meta W"); await sleep(300); const b = await S(); return { ok: nTabs(b) === nTabs(a) - 1, note: `${nTabs(a)} -> ${nTabs(b)}` }; });
} catch (e) { console.error("smoke aborted:", e.message); }

console.log("\n| # | Check | Result | Note |\n|---|---|---|---|");
rows.forEach((r, i) => console.log(`| ${i + 1} | ${r.name} | ${r.ok ? "PASS" : "FAIL"} | ${r.note} |`));
const failed = rows.filter((r) => !r.ok).length;
console.log(`\n${rows.length - failed}/${rows.length} passed; screenshots in scripts/qa/out/`);
await app.stop();
try { execSync(`pkill -f ${JSON.stringify("--path " + proj)} || true`); } catch {}
if (!process.argv.includes("--keep")) fs.rmSync(scratch, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
