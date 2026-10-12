// Client for Ace's live Studio bridge: a per-user unix socket speaking JSON lines (one request line, one reply line).
// Windows: no unix sockets; the bridge is loopback TCP. The discovery file next to the socket path (".json") holds
// {"port","token"}; the client sends the token as its first line. Same protocol.
// Ace side: src-tauri/src/studio_bridge.rs (local_ipc) + src/components/animstudio/bridge.ts. NOT the QA automation socket.
import { createConnection, type Socket } from "node:net";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const NOT_RUNNING = "Ace isn't running (or its Studio bridge isn't listening). Open the project in Ace, or work on the files directly with the file-based tools.";

export function bridgeSocketPath(env: NodeJS.ProcessEnv = process.env): string {
  if (env.ACE_STUDIO_SOCK) return env.ACE_STUDIO_SOCK;
  // Rust side: user_tag() = getuid on unix, the USERNAME env var with non-alphanumerics removed on Windows
  const user = process.platform === "win32" ? (env.USERNAME ?? "user").replace(/[^A-Za-z0-9]/g, "") : String(typeof process.getuid === "function" ? process.getuid() : 0);
  return join(tmpdir(), `ace-studio-${user}.sock`);
}

/** Open a connection to the bridge at `sock`. Windows: TCP to the port in `<sock with .json>`, token line first. */
export function openBridge(sock: string): Socket {
  if (process.platform !== "win32") return createConnection(sock);
  const ext = sock.match(/\.[^./\\]*$/)?.[0] ?? "";
  const info = JSON.parse(readFileSync(sock.slice(0, sock.length - ext.length) + ".json", "utf8")) as { port: number; token: string };
  const c = createConnection({ host: "127.0.0.1", port: info.port });
  c.write(info.token + "\n");
  return c;
}

export class BridgeError extends Error {
  constructor(msg: string, readonly down = false) { super(msg); }
}

export interface Bridge {
  /** true when Ace answered a ping recently */
  available(force?: boolean): Promise<boolean>;
  call<T = any>(op: string, args?: Record<string, unknown>, timeoutMs?: number): Promise<T>;
}

export function createBridge(sock = bridgeSocketPath()): Bridge {
  let seq = 0;
  let upAt = 0;
  let upVal = false;
  const call = <T,>(op: string, args: Record<string, unknown> = {}, timeoutMs = 20_000): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const id = ++seq;
      let c: Socket;
      try { c = openBridge(sock); } catch (e) { return reject(new BridgeError(NOT_RUNNING + ` (${(e as NodeJS.ErrnoException).code ?? (e as Error).message})`, true)); }
      let buf = "";
      let done = false;
      const finish = (f: () => void) => { if (!done) { done = true; clearTimeout(timer); c.destroy(); f(); } };
      const timer = setTimeout(() => finish(() => reject(new BridgeError(`Ace did not answer "${op}" within ${timeoutMs / 1000}s`))), timeoutMs);
      c.on("connect", () => c.write(JSON.stringify({ id, op, args }) + "\n"));
      c.on("data", (d) => {
        buf += d.toString("utf8");
        const i = buf.indexOf("\n");
        if (i < 0) return;
        try {
          const r = JSON.parse(buf.slice(0, i));
          if (r.ok) finish(() => resolve(r.value as T));
          else finish(() => reject(new BridgeError(String(r.error ?? "bridge error"))));
        } catch (e) {
          finish(() => reject(new BridgeError("bad reply from Ace: " + String(e))));
        }
      });
      c.on("error", (e) => finish(() => reject(new BridgeError(NOT_RUNNING + ` (${(e as NodeJS.ErrnoException).code ?? e.message})`, true))));
      c.on("close", () => finish(() => reject(new BridgeError("Ace closed the connection", true))));
    });
  return {
    call,
    async available(force = false) {
      const now = Date.now();
      if (!force && now - upAt < 2000) return upVal;
      try { await call("ping", {}, 1500); upVal = true; } catch { upVal = false; }
      upAt = now;
      return upVal;
    },
  };
}

/** A bridge that is never there (tests, `--no-bridge`). */
export const noBridge: Bridge = {
  available: async () => false,
  call: async () => { throw new BridgeError(NOT_RUNNING, true); },
};
