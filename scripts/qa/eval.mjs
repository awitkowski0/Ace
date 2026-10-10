#!/usr/bin/env node
// Usage: node scripts/qa/eval.mjs [--window project-2] '<async JS body>'   (body may `return` a value; window.__qa has the helpers)
//        echo 'return __qa.state()' | node scripts/qa/eval.mjs -
// Without --window the body runs in the active (last focused) project window; `__qa.windows()` lists the windows.
// Env: ATELIER_AUTOMATION_SOCK (default $TMPDIR/atelier-automation.sock)
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const sockPath = () => process.env.ATELIER_AUTOMATION_SOCK || path.join(process.env.TMPDIR || "/tmp", "atelier-automation.sock");

/** Evaluate an async JS body in the Atelier webview. Resolves to the returned value; rejects on JS error/timeout. */
export function evalJs(body, { sock = sockPath(), timeout = 35000, window } = {}) {
  // Optional target window: a JSON header line {"window":"project-2"} in front of the body (see automation.rs).
  if (window) body = JSON.stringify({ window }) + "\n" + body;
  return new Promise((resolve, reject) => {
    const c = net.createConnection(sock);
    let buf = "";
    const timer = setTimeout(() => { c.destroy(); reject(new Error("client timeout")); }, timeout);
    c.on("connect", () => c.end(body + "\0")); // NUL terminates the request: end() alone sometimes never delivers FIN
    c.on("data", (d) => (buf += d));
    c.on("error", (e) => { clearTimeout(timer); reject(e); });
    c.on("close", () => {
      clearTimeout(timer);
      try {
        const r = JSON.parse(buf);
        r.ok ? resolve(r.value) : reject(new Error(r.error));
      } catch { reject(new Error("bad reply: " + buf.slice(0, 200))); }
    });
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  let window;
  const wi = argv.indexOf("--window");
  if (wi >= 0) window = argv.splice(wi, 2)[1];
  let body = argv[0];
  if (body === undefined || body === "-") body = await new Promise((r) => { let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => r(s)); });
  try {
    console.log(JSON.stringify(await evalJs(body, { window }), null, 2));
  } catch (e) { console.error(String(e.message || e)); process.exit(1); }
}
