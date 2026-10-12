import { createServer, type Server } from "node:net";
import { existsSync, unlinkSync } from "node:fs";

export interface FakeAce {
  sock: string;
  calls: Array<{ op: string; args: any }>;
  open: Map<string, string>;
  close(): Promise<void>;
}
// 1x1 transparent PNG
export const PNG_1PX = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

/** Stand-in for Ace's Studio bridge (JSON lines over a unix socket). */
export function startFakeAce(sock: string): Promise<FakeAce> {
  if (existsSync(sock)) unlinkSync(sock);
  const calls: FakeAce["calls"] = [];
  const open = new Map<string, string>();
  const srv: Server = createServer((c) => {
    let buf = "";
    c.on("data", (d) => {
      buf += d.toString();
      let i: number;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        const req = JSON.parse(line);
        if (req.op !== "ping") calls.push({ op: req.op, args: req.args });
        let value: unknown = null;
        let ok = true;
        let error = "";
        switch (req.op) {
          case "ping": value = { pong: true }; break;
          case "file_text": value = open.has(req.args.file) ? { open: true, text: open.get(req.args.file), dirty: true } : { open: false }; break;
          case "apply_text": open.set(req.args.file, req.args.text); value = { applied: true }; break;
          case "state": value = { studios: [...open.keys()].map((file) => ({ file, mode: "animate", anim: "web_air", time: 0 })) }; break;
          case "screenshot": value = { png: PNG_1PX, width: 1, height: 1, times: req.args.frames ? [0, 0.5] : [req.args.t ?? 0] }; break;
          case "open": case "set_time": case "select": value = { ok: true, ...req.args }; break;
          default: ok = false; error = "unknown op " + req.op;
        }
        c.write(JSON.stringify(ok ? { id: req.id, ok, value } : { id: req.id, ok, error }) + "\n");
      }
    });
  });
  return new Promise((resolve) => srv.listen(sock, () => resolve({ sock, calls, open, close: () => new Promise((r) => srv.close(() => r())) })));
}
