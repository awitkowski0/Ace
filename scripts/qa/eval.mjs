#!/usr/bin/env node
// Usage: node scripts/qa/eval.mjs [--window project-2] '<async JS body>'   (body may `return` a value; window.__qa has the helpers)
//        echo 'return __qa.state()' | node scripts/qa/eval.mjs -
// Without --window the body runs in the active (last focused) project window; `__qa.windows()` lists the windows.
// Env: ACE_AUTOMATION_SOCK (default $TMPDIR/ace-automation.sock; the old ATELIER_AUTOMATION_SOCK is still read)
import net from "node:net";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** `ACE_<name>` from the environment, falling back to the pre-rename `ATELIER_<name>`. */
export const aceEnv = (name, e = process.env) => e["ACE_" + name] ?? e["ATELIER_" + name];

export const sockPath = () => aceEnv("AUTOMATION_SOCK") || path.join(process.env.TMPDIR || "/tmp", "ace-automation.sock");

/** Open the automation connection. Windows: loopback TCP to the port in `<sock>.json` ({port, token}), token line first
 *  (same as openBridge in tools/ace-mcp/src/bridge.ts). Unix: the unix socket at `sock`. */
export function openAutomation(sock) {
  if (process.platform !== "win32") return net.createConnection(sock);
  const ext = sock.match(/\.[^./\\]*$/)?.[0] ?? "";
  const info = JSON.parse(readFileSync(sock.slice(0, sock.length - ext.length) + ".json", "utf8"));
  const c = net.createConnection({ host: "127.0.0.1", port: info.port });
  c.write(info.token + "\n");
  return c;
}

/** Evaluate an async JS body in the Ace webview. Resolves to the returned value; rejects on JS error/timeout. */
export function evalJs(body, { sock = sockPath(), timeout = 35000, window } = {}) {
  // Optional target window: a JSON header line {"window":"project-2"} in front of the body (see automation.rs).
  if (window) body = JSON.stringify({ window }) + "\n" + body;
  return new Promise((resolve, reject) => {
    let c;
    try { c = openAutomation(sock); } catch (e) { return reject(e); }
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
