#!/usr/bin/env node
// Idle memory with the Gradle window open vs closed (cached scratch project, nothing spawned). Usage: node scripts/qa/gradleperf.mjs  Env: ACE_BIN
import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { launch, sleep } from "./lib.mjs";
const sh = (c) => execSync(c, { encoding: "utf8", shell: "/bin/zsh" });
const real = path.join(os.homedir(), "IdeaProjects/Thematic-Collections");
const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ace-gperf-")));
fs.mkdirSync(path.join(d, "gradle/wrapper"), { recursive: true });
for (const f of ["gradlew", "gradle/wrapper/gradle-wrapper.jar", "gradle/wrapper/gradle-wrapper.properties"]) fs.copyFileSync(path.join(real, f), path.join(d, f));
fs.writeFileSync(path.join(d, "settings.gradle"), "rootProject.name='perf'\ninclude 'a','b','c'\n");
for (const n of ["a", "b", "c"]) { fs.mkdirSync(path.join(d, n)); fs.writeFileSync(path.join(d, n, "build.gradle"), ""); }
fs.writeFileSync(path.join(d, "build.gradle"), "");
const plain = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ace-gperf-plain-")));
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ace-gperf-data-"));
const tree = (pid) => { const t = sh("ps -axo pid=,ppid=").split("\n").map((l) => l.trim().split(/\s+/)); const out = [String(pid)]; for (let i = 0; i < out.length; i++) for (const [c, p] of t) if (p === out[i]) out.push(c); return out; };
const wk = () => sh(`ps -axo pid=,command= | grep -E 'com.apple.WebKit.(WebContent|GPU|Networking)' | grep -v grep | awk '{print $1}'`).split("\n").filter(Boolean);
const rss = (pids) => Math.round(pids.reduce((s, p) => s + (+sh(`ps -o rss= -p ${p} || true`) || 0), 0) / 1024);
async function measure(label, project, open) {
  const before = new Set(wk());
  const app = await launch(project, { dataDir });
  try {
    await app.ev(`await __qa.waitFor(() => document.querySelector('.statusbar'), 15000); return 1`);
    if (project === d) { for (let i = 0; i < 100; i++) { const s = await app.ev(`return (await __qa.gradle()).state().status`); if (s === "ready") break; await sleep(200); } }
    if (open) await app.ev(`document.querySelector('.stripe.right .stripe-btn[title^="Gradle"]').click(); await __qa.sleep(300); return 1`);
    await sleep(9000);
    const mine = wk().filter((p) => !before.has(p));
    const kids = tree(app.pid).filter((p) => p !== String(app.pid));
    const cpu = sh(`ps -o %cpu= -p ${app.pid}`).trim();
    console.log(label, JSON.stringify({ appAndWebkitMB: rss([String(app.pid), ...mine]), childProcesses: kids.length, appCpuPct: cpu }));
  } finally { await app.stop(); }
}
await measure("plain project (no Gradle)      ", plain, false);
await measure("gradle project, window closed  ", d, false);
await measure("gradle project, window open    ", d, true);
fs.rmSync(d, { recursive: true, force: true }); fs.rmSync(plain, { recursive: true, force: true });
