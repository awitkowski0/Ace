// Shared helpers for smoke.mjs / bench: launch the app under automation, eval, shots.
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { evalJs } from "./eval.mjs";

export const here = path.dirname(fileURLToPath(import.meta.url));
export const repo = path.resolve(here, "../..");
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const BIN = process.env.ATELIER_BIN || path.join(repo, "src-tauri/target/release/atelier");

/** Launch Atelier with automation on `project`; resolves once window.__qa answers. Returns {child, sock, t0, ready, ev, shot, stop}. */
export async function launch(project, { sock = path.join(process.env.TMPDIR || "/tmp", `atelier-qa-${process.pid}.sock`), env = {} } = {}) {
  try { fs.unlinkSync(sock); } catch {}
  const t0 = Date.now();
  const child = spawn(BIN, [project], { env: { ...process.env, ATELIER_AUTOMATION: "1", ATELIER_AUTOMATION_SOCK: sock, ...env }, stdio: ["ignore", "ignore", "pipe"] });
  let err = ""; child.stderr.on("data", (d) => (err += d));
  const ev = (body, o) => evalJs(body, { sock, ...o });
  for (let i = 0; ; i++) {
    if (child.exitCode !== null) throw new Error("app exited: " + err);
    if (fs.existsSync(sock)) { try { if (await ev("return !!window.__qa", { timeout: 3000 })) break; } catch {} }
    if (Date.now() - t0 > 30000) throw new Error("app did not become ready");
    await sleep(20);
  }
  const ready = Date.now();
  const shot = (name) => { try { return execFileSync(path.join(here, "shot.sh"), [name], { env: { ...process.env, ATELIER_AUTOMATION_SOCK: sock }, encoding: "utf8" }).trim(); } catch (e) { return "shot failed: " + e.message.split("\n")[0]; } };
  const stop = async () => { child.kill("SIGTERM"); await new Promise((r) => { child.once("exit", r); setTimeout(r, 6000); }); };
  return { child, sock, t0, ready, ev, shot, stop, pid: child.pid };
}
