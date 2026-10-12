#!/usr/bin/env node
// One screenshot per scheme and file for Alex to compare: scripts/qa/out/themes/<scheme>-<file>.png (gd, tscn, java, json),
// then the contact sheet (scripts/qa/contact-sheet.py -> out/themes/contact-sheet.png).
// Opens REAL files strictly READ-ONLY (no typing, no save) through the automation harness; `git status` of both repos is compared before/after.
// Usage: ACE_BIN=... node scripts/qa/theme-shots.mjs
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { launch, sleep, here } from "./lib.mjs";

const KYF = path.join(os.homedir(), "thematic-kyf");
const TC = path.join(os.homedir(), "IdeaProjects/Thematic-Collections");
const FILES = [
  { key: "gd", path: path.join(KYF, "scripts/gameplay/survivor.gd"), top: 97 },
  { key: "java", path: path.join(TC, "src/common/java/bond/thematic/api/mixin/core/CommandManagerMixin.java"), top: 1 },
  { key: "tscn", path: path.join(KYF, "scenes/main_menu.tscn"), top: 1 },
  { key: "json", path: path.join(TC, "testpacks/wilfred_character_pack/assets/wilfred/models/item/stage_wilfred.json"), top: 1 },
];
const git = (repo) => execFileSync("git", ["-C", repo, "status", "--porcelain"], { encoding: "utf8" });
const before = { kyf: git(KYF), tc: git(TC) };
const out = path.join(here, "out/themes");
fs.mkdirSync(out, { recursive: true });
const jq = JSON.stringify;

const app = await launch(KYF);
let dirty = [];
try {
  await app.ev("return await __qa.themes().then((t) => t.noAutoGodot())");
  await sleep(2500);
  const ids = (await app.ev("const t = await __qa.themes(); return t.list()")).map((s) => s.id);
  for (const f of FILES) {
    await app.ev(`await __qa.openFile(${jq(f.path)}); return 1`, { timeout: 20000 });
  }
  for (const id of ids) {
    await app.ev(`const t = await __qa.themes(); t.set(${jq(id)}); await __qa.sleep(300); return 1`);
    for (const f of FILES) {
      await app.ev(`await __qa.openFile(${jq(f.path)}); await __qa.sleep(400); const ed = __qa.editor(); ed.revealLineNearTop(${f.top}); ed.setPosition({ lineNumber: ${f.top}, column: 1 }); return 1`, { timeout: 20000 });
      await sleep(700); // grammar + semantic refresh
      console.log(app.shot(`themes/${id}-${f.key}`));
    }
  }
  dirty = (await app.ev("return __qa.state().dirty")) ?? [];
} finally {
  await app.stop();
}
const after = { kyf: git(KYF), tc: git(TC) };
const same = before.kyf === after.kyf && before.tc === after.tc;
console.log(`dirty tabs: ${dirty.length}; git status identical before/after: ${same}`);
if (dirty.length || !same) process.exit(1);
execFileSync("python3", [path.join(here, "contact-sheet.py")], { stdio: "inherit" });
