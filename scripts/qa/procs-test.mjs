#!/usr/bin/env node
// Verifies procs lifecycle against ~/thematic-kyf (read-only: opens a .gd file via the harness, never saves):
//  A) SIGTERM the app with headless Godot running -> that Godot is gone
//  B) SIGKILL the app (orphan Godot survives) -> a relaunch reaps it
// Godots are tracked by exact pid (child of OUR app), so other instances on the same project don't confuse it.
// Also asserts `git status --porcelain` on the project is unchanged.
import { execSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { launch, sleep } from "./lib.mjs";

const proj = process.env.PROJ || path.join(os.homedir(), "thematic-kyf");
const file = path.join(proj, "tools/export_catalog.gd");
const sh = (c) => { try { return execSync(c, { encoding: "utf8" }).trim(); } catch { return ""; } };
const childGodots = (ppid) => sh(`ps -axo pid=,ppid=,command= | grep -F Godot | grep -F -- "--lsp-port" | awk '$2==${ppid}{print $1}'`).split("\n").filter(Boolean);
const alive = (pid) => { try { process.kill(+pid, 0); return sh(`ps -o stat= -p ${pid}`) !== "" && !sh(`ps -o stat= -p ${pid}`).startsWith("Z"); } catch { return false; } };
const porcelain = () => sh(`git -C ${JSON.stringify(proj)} status --porcelain`);
const before = porcelain();
const results = [];
const ok = (n, c, note = "") => { results.push([n, c]); console.log(`${c ? "PASS" : "FAIL"}  ${n} ${note}`); };
const mine = [];

async function waitChild(app, ms = 90000) { const t = Date.now(); while (Date.now() - t < ms) { const g = childGodots(app.pid); if (g.length) { mine.push(...g); return g; } await sleep(300); } return []; }

try {
  // A) SIGTERM
  let app = await launch(proj);
  await app.ev(`await __qa.openFile(${JSON.stringify(file)}); return 1`);
  let g = await waitChild(app);
  ok("A: headless Godot started by LSP (child of app)", g.length === 1, g.join());
  process.kill(app.pid, "SIGTERM");
  await sleep(3000);
  ok("A: app exited on SIGTERM", !alive(app.pid));
  ok("A: that Godot is gone after SIGTERM", g.every((p) => !alive(p)), g.join());

  // B) SIGKILL then relaunch
  app = await launch(proj);
  await app.ev(`await __qa.openFile(${JSON.stringify(file)}); return 1`);
  g = await waitChild(app);
  ok("B: headless Godot started (child of app)", g.length === 1, g.join());
  process.kill(app.pid, "SIGKILL");
  await sleep(1500);
  ok("B: orphan survives kill -9 (expected)", g.every(alive), g.join());
  app = await launch(proj);
  await sleep(3000);
  ok("B: relaunch reaped the orphan", g.every((p) => !alive(p)), g.join());
  await app.stop();
} finally {
  for (const p of mine) if (alive(p)) { try { process.kill(+p, "SIGKILL"); } catch {} }
  ok("git status --porcelain unchanged", porcelain() === before);
}
process.exit(results.every((r) => r[1]) ? 0 : 1);
