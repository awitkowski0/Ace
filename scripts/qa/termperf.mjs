#!/usr/bin/env node
// Terminal memory + keystroke->echo latency probe (works on any build; harness only, no OS input).
// Usage: node scripts/qa/termperf.mjs   Env: ATELIER_BIN
import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { launch, sleep } from "./lib.mjs";

const sh = (c) => { try { return execSync(c, { encoding: "utf8" }).trim(); } catch { return ""; } };
const wkPids = () => new Set(sh(`ps -axo pid=,command= | grep -E 'com.apple.WebKit.(WebContent|GPU|Networking)' | grep -v grep | awk '{print $1}'`).split("\n").filter(Boolean));
const rss = (pids) => Math.round(pids.reduce((s, p) => s + (+sh(`ps -o rss= -p ${p}`) || 0), 0) / 1024);
const scratch = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), "atelier-perf-"));
fs.writeFileSync(path.join(scratch, "a.txt"), "x\n");
const wk0 = wkPids();
const app = await launch(scratch);
process.on('uncaughtException', async (e) => { console.error(e.message); await app.stop(); process.exit(1); });
await sleep(1500);
const wk = [...wkPids()].filter((p) => !wk0.has(p));
const idle0 = rss([String(app.pid), ...wk]);
await app.ev(`
  window.__ptyIds = new Set(); const f = window.fetch.bind(window);
  window.fetch = (u, o) => { try { if (String(u).includes('pty_write') && typeof o?.body === 'string') window.__ptyIds.add(JSON.parse(o.body).id); } catch {} return f(u, o); };
  await __qa.key('alt F12'); await __qa.sleep(2500); return 1`);
await sleep(4000);
const withTerm = rss([String(app.pid), ...wk]);
const lat = await app.ev(`
  const ta = document.querySelector('.xterm-helper-textarea'); ta.focus();
  const press = (k) => { const o = { key: k, code: 'Key' + k.toUpperCase(), keyCode: k.toUpperCase().charCodeAt(0), bubbles: true, cancelable: true }; ta.dispatchEvent(new KeyboardEvent('keydown', o)); ta.dispatchEvent(new KeyboardEvent('keyup', o)); };
  press('x'); await __qa.sleep(600); // learn the pty id
  const id = [...window.__ptyIds][0]; if (!id) throw new Error('no pty id');
  const out = [];
  for (let i = 0; i < 40; i++) {
    const t0 = performance.now();
    const p = new Promise((res) => { __qa.listen('pty://data/' + id, () => res(performance.now())).then((un) => { window.__un = un; }); });
    await __qa.sleep(5);
    const t1 = performance.now(); press('y');
    const t2 = await Promise.race([p, new Promise((r) => setTimeout(() => r(NaN), 1000))]);
    out.push(t2 - t1); try { (await window.__un)?.(); } catch {}
    await __qa.sleep(80);
  }
  return out;`);
const ok = lat.filter((x) => x === x).sort((a, b) => a - b);
await sleep(3000);
const idle = rss([String(app.pid), ...wk]);
console.log(JSON.stringify({ rssBeforeTermMB: idle0, rssWithTerminalMB: withTerm, rssIdleAfterMB: idle, latencyMsMedian: +ok[Math.floor(ok.length / 2)].toFixed(1), latencyMsP95: +ok[Math.floor(ok.length * 0.95)].toFixed(1), samples: ok.length }));
await app.stop();
fs.rmSync(scratch, { recursive: true, force: true });
