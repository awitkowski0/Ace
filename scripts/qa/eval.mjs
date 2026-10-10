#!/usr/bin/env node
// Usage: node scripts/qa/eval.mjs '<async JS body>'   (body may `return` a value; window.__qa has the helpers)
//        echo 'return __qa.state()' | node scripts/qa/eval.mjs -
// Env: ATELIER_AUTOMATION_SOCK (default $TMPDIR/atelier-automation.sock)
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const sockPath = () => process.env.ATELIER_AUTOMATION_SOCK || path.join(process.env.TMPDIR || "/tmp", "atelier-automation.sock");

/** Evaluate an async JS body in the Atelier webview. Resolves to the returned value; rejects on JS error/timeout. */
export function evalJs(body, { sock = sockPath(), timeout = 35000 } = {}) {
  return new Promise((resolve, reject) => {
    const c = net.createConnection(sock);
    let buf = "";
    const timer = setTimeout(() => { c.destroy(); reject(new Error("client timeout")); }, timeout);
    c.on("connect", () => c.end(body));
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
  let body = process.argv[2];
  if (body === undefined || body === "-") body = await new Promise((r) => { let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => r(s)); });
  try {
    console.log(JSON.stringify(await evalJs(body), null, 2));
  } catch (e) { console.error(String(e.message || e)); process.exit(1); }
}
