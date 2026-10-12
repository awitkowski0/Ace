#!/usr/bin/env node
// Screenshots of the Animation Studio timeline/layout (before/after UI polish). Read-only copies of the spidey clip + pose set and a gun geo
// go into a temp fixture; nothing is written to Thematic repos.
// Usage: ATELIER_BIN=src-tauri/target-qa/release/atelier node scripts/qa/animstudio-shots.mjs <before|after>
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { launch, sleep, repo } from "./lib.mjs";

const tag = process.argv[2] || "after";
const SP = path.join(os.homedir(), "IdeaProjects/Thematic-Collections"); // MAIN checkout, read-only
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ace-qa-shots-"));
const proj = path.join(tmp, "proj");
const put = (rel, src) => { const f = path.join(proj, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.copyFileSync(src, f); return f; };
const swing = put("src/common/resources/assets/thematic/animations/armor/web_sling.animation.json", path.join(SP, "src/common/resources/assets/thematic/animations/armor/web_sling.animation.json"));
put("src/packs/heroes/resources/assets/thematic/poses/web.json", path.join(SP, "src/packs/heroes/resources/assets/thematic/poses/web.json"));
const geo = put("guns/.geo/m4.geo.json", path.join(SP, "guns/.geo/m4.geo.json"));
const app = await launch(proj, { dataDir: fs.mkdtempSync(path.join(tmp, "data-")) });
const E = (b) => app.ev(`const A = await __qa.anim(); ${b}`);
try {
  await app.ev(`await __qa.waitFor(() => document.querySelector('.statusbar'), 20000); return 1`);
  await E(`return await A.open(${JSON.stringify(geo)}, {})`);
  await sleep(1200);
  app.shot(`animstudio-edit-${tag}`);
  await E(`return await A.open(${JSON.stringify(swing)}, {})`);
  for (let i = 0; i < 40; i++) { const n = await E(`return A.snapshot().clips`); if (n > 5) break; await sleep(250); }
  const names = await E(`return A.snapshot().anims`);
  console.log("anims", names.length, names.slice(0, 6));
  const pick = names.find((n) => /swing_right/.test(n)) ?? names[0];
  const bones = await E(`const a = A.state().doc; return 1`);
  await E(`A.set({ anim: ${JSON.stringify(pick)}, time: 0.4, bones: ["armorRightArm"], keys: [] }); await A.sleep(500); return 1`);
  await sleep(900);
  app.shot(`animstudio-timeline-${tag}`);
  await E(`A.set({ mode: "pose" }); await A.sleep(500); return 1`);
  await sleep(500);
  app.shot(`animstudio-pose-${tag}`);
} finally {
  await app.stop();
  fs.rmSync(tmp, { recursive: true, force: true });
}
