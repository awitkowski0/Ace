// Shared helpers for smoke.mjs / bench: launch the app under automation, eval, shots.
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { evalJs } from "./eval.mjs";

export const here = path.dirname(fileURLToPath(import.meta.url));
export const repo = path.resolve(here, "../..");
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Windows has no /tmp; the automation endpoint is a loopback port described by `<sock with .json>` (see scripts/qa/eval.mjs).
const tmp = process.platform === "win32" ? os.tmpdir() : process.env.TMPDIR || "/tmp";
export const BIN = process.env.ATELIER_BIN || path.join(repo, "src-tauri/target/release/atelier");

/** Launch Atelier with automation on `project` (a path, or null/undefined for a launch without arguments, which restores the
 * previous session); resolves once window.__qa answers. Every launch gets its own ATELIER_DATA_DIR (session.json) and, via
 * the automation socket, its own single-instance identity, so harness runs never touch Alex's real session or a running Atelier.
 * Returns {child, sock, dataDir, env, t0, ready, ev, evIn, windows, shot, stop}.
 * `ev(body, {window})` runs in the given project window (default: the active one); `evIn(label, body)` is the same. */
export async function launch(project, { sock = path.join(tmp, `atelier-qa-${process.pid}.sock`), env = {}, dataDir: givenDir } = {}) {
  const ownDataDir = !givenDir;
  const dataDir = givenDir || fs.mkdtempSync(path.join(tmp, "atelier-qa-data-"));
  try { fs.unlinkSync(sock); } catch {}
  const t0 = Date.now();
  const readyFile = process.platform === "win32" ? sock.replace(/\.sock$/, ".json") : sock;
  const fullEnv = { ...process.env, ATELIER_AUTOMATION: "1", ATELIER_AUTOMATION_SOCK: sock, ATELIER_DATA_DIR: dataDir, ...env };
  const child = spawn(BIN, project ? [project] : [], { env: fullEnv, stdio: ["ignore", "ignore", "pipe"] });
  let err = ""; child.stderr.on("data", (d) => { err += d; if (process.env.ATELIER_AUTOMATION_TRACE) process.stderr.write(d); });
  const ev = async (body, o) => {
    const t = Date.now();
    try { return await evalJs(body, { sock, ...o }); }
    catch (e) {
      // Diagnostics for harness flakes: how long it took, and a stack sample of the (possibly stuck) app.
      if (process.env.QA_TRACE || /timeout/i.test(String(e.message))) {
        console.error(`[qa] eval failed after ${Date.now() - t} ms: ${String(e.message).slice(0, 100)} | body: ${body.replace(/\s+/g, " ").slice(0, 100)}`);
        if (/client timeout/.test(String(e.message)) && process.env.QA_SAMPLE) { try { execFileSync("sample", [String(child.pid), "2", "-file", process.env.QA_SAMPLE], { stdio: "ignore" }); } catch {} }
      }
      throw e;
    }
  };
  for (let i = 0; ; i++) {
    if (child.exitCode !== null) throw new Error("app exited: " + err);
    if (fs.existsSync(readyFile)) { try { if (await ev("return !!window.__qa", { timeout: 3000 })) break; } catch {} }
    if (Date.now() - t0 > 30000) throw new Error("app did not become ready");
    await sleep(20);
  }
  const ready = Date.now();
  const evIn = (window, body, o) => ev(body, { ...o, window });
  const windows = () => ev("return await __qa.windows()");
  const shot = (name) => { try { return execFileSync(path.join(here, "shot.sh"), [name], { env: { ...process.env, ATELIER_AUTOMATION_SOCK: sock }, encoding: "utf8" }).trim(); } catch (e) { return "shot failed: " + e.message.split("\n")[0]; } };
  const stop = async () => { child.kill("SIGTERM"); await new Promise((r) => { child.once("exit", r); setTimeout(r, 6000); }); if (!ownDataDir) return; try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {} };
  return { child, sock, dataDir, env: fullEnv, t0, ready, ev, evIn, windows, shot, stop, pid: child.pid };
}
