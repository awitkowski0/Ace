#!/usr/bin/env node
// Animation Studio playback benchmark (docs/ANIMSTUDIO.md). READ-ONLY on the real Thematic-Collections web_sling clip + spiderman geo.
// The hidden QA webview never fires rAF, so __qa.anim().perf.bench() drives N synthetic frames through the same code the rAF loop
// runs (playback stepOnce -> store.set -> React + engine sync flush -> three render -> timeline canvases) and times every stage.
// Usage: ACE_BIN=src-tauri/target-qa/release/ace node scripts/qa/animperf.mjs   (FRAMES=240, OUT=path.json)
import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { launch, sleep } from "./lib.mjs";

const TC = path.join(os.homedir(), "IdeaProjects/Thematic-Collections");
const clip = path.join(TC, "src/common/resources/assets/thematic/animations/armor/web_sling.animation.json");
const geo = path.join(TC, "src/packs/heroes/resources/assets/thematic/geo/armor/spiderman.geo.json");
const status = () => { try { return +execSync(`git -C ${JSON.stringify(TC)} status --short | wc -l`, { encoding: "utf8" }).trim(); } catch { return -1; } };
const before = status();
const FRAMES = +(process.env.FRAMES || 180);
const BATCH = +(process.env.BATCH || 45);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ace-animperf-"));
const proj = path.join(tmp, "p"); fs.mkdirSync(path.join(proj, ".ace"), { recursive: true });
fs.writeFileSync(path.join(proj, ".ace/config.json"), JSON.stringify({ version: 1, profile: "asset" }) + "\n");
const tab = (want) => `{ const b = document.querySelector('[data-testid=as-tl-graph]'); const isGraph = b?.title.startsWith("Back"); if (b && isGraph !== ${want === "graph"}) b.click(); }`;
const base = `A.set({ mode: "animate", anim: "web_sling_right", bones: [], keys: [], time: 0, onion: { on: false, before: 2, after: 2, step: 0.1 }, speed: 1, loopPreview: true });`;
const scenarios = {
  "dope, no selection": `${base} ${tab("dope")}`,
  "dope, bone selected": `${base} A.set({ bones: ["armorRightArm"] }); ${tab("dope")}`,
  "graph, bone selected": `${base} A.set({ bones: ["armorRightArm"] }); ${tab("graph")}`,
  "dope, onion 2+2": `${base} ${tab("dope")} A.set({ onion: { on: true, before: 2, after: 2, step: 0.1 } });`,
};
const results = {};
// one fresh app per scenario: a WebGL context lost by one heavy scenario must not poison the next
for (const [name, setup] of Object.entries(scenarios)) {
  if (process.env.ONLY && !new RegExp(process.env.ONLY).test(name)) continue;
  const app = await launch(proj, { dataDir: fs.mkdtempSync(path.join(tmp, "data-")) });
  const E = (body, o) => app.ev(`const A = await __qa.anim(); ${body}`, o);
  try {
    await E(`return await A.open(${JSON.stringify(clip)}, { mode: "preview" })`);
    await E(`await A.call("pickModel", ${JSON.stringify(geo)}); await A.sleep(1500); return 1`);
    if (!results.rig) { const snap = await E(`return A.snapshot()`); results.rig = `${snap.rig?.label} bones=${snap.viewport?.boneCount} cubes=${snap.viewport?.cubeCount} anim=${snap.anim}`; console.log(results.rig); }
    await E(`${setup} await A.sleep(400); A.renderNow(); return 1`);
    // the app answers an eval within 30 s: run the frames in batches and merge
    const p95s = [], maxes = [], times = [], bins = {}, rend = {}; let draws = 0, calls = 0, n = 0, wait = 0, drawMs = 0, layoutMs = 0;
    for (let left = FRAMES; left > 0; left -= BATCH) {
      const f = Math.min(BATCH, left);
      const b = await E(`return await A.perf.bench(${f}, { warmup: ${n ? 3 : 30} })`, { timeout: 120000 });
      times.push(...(b.times ?? Array(f).fill(b.meanMs))); if (!b.times) { p95s.push(b.p95Ms); maxes.push(b.maxMs); }
      if (b.stages) { wait += b.stages.waitMs * f; drawMs += b.stages.drawMs * f; layoutMs += (b.stages.layoutMs ?? 0) * f; } n += f; draws += b.drawsPerFrame * f; calls = b.calls;
      for (const [k, v] of Object.entries(b.bins)) bins[k] = (bins[k] ?? 0) + v * f;
      for (const [k, v] of Object.entries(b.rendersPerFrame)) rend[k] = (rend[k] ?? 0) + v * f;
    }
    const sorted = [...times].sort((x, y) => x - y), r3 = (v) => Math.round(v * 1000) / 1000;
    const r = { frames: n, meanMs: r3(times.reduce((x, y) => x + y, 0) / n), p95Ms: p95s.length ? Math.max(...p95s) : sorted[Math.floor(n * 0.95)], maxMs: maxes.length ? Math.max(...maxes) : sorted[n - 1],
      bins: Object.fromEntries(Object.entries(bins).map(([k, v]) => [k, r3(v / n)])), rendersPerFrame: Object.fromEntries(Object.entries(rend).map(([k, v]) => [k, r3(v / n)])), drawsPerFrame: r3(draws / n), calls, stages: { setAndFlushMs: r3(wait / n), renderMs: r3(drawMs / n), layoutMs: r3(layoutMs / n) } };
    results[name] = r;
    const rr = Object.entries(r.rendersPerFrame).filter(([, v]) => v > 0).map(([k, v]) => `${k}=${v}`).join(" ");
    console.log(`${name.padEnd(22)} mean ${r.meanMs} ms  p95 ${r.p95Ms}  max ${r.maxMs}  | store ${r.bins.store} flush ${r.bins.flush} (pose ${r.bins.pose}) three+gpu ${r.bins.render} 2D ${r.bins.canvas}  | draws/f ${r.drawsPerFrame} calls ${r.calls} | set+flush ${r.stages.setAndFlushMs} render+gpu ${r.stages.renderMs} layout ${r.stages.layoutMs}\n    React renders/frame: ${rr || "none"}`);
  } catch (e) {
    console.log(`${name.padEnd(22)} FAILED: ${String(e.message).split("\n")[0].slice(0, 160)}`);
    results[name] = { error: String(e.message).split("\n")[0] };
  } finally {
    await app.stop();
  }
}
const after = status();
console.log(`Thematic-Collections git status --short | wc -l: before=${before} after=${after}`);
if (process.env.OUT) fs.writeFileSync(process.env.OUT, JSON.stringify(results, null, 2));
process.exit(before === after ? 0 : 1);
