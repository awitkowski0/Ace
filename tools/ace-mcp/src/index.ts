import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createBridge } from "./bridge";
import { parseRoots } from "./paths";
import { createServer } from "./server";

async function main() {
  const roots = parseRoots(process.argv.slice(2), process.env, process.cwd());
  const bridge = createBridge();
  const { server, refreshLive } = createServer({ roots, bridge });
  await refreshLive();
  await server.connect(new StdioServerTransport());
  const t = setInterval(() => { refreshLive().catch(() => {}); }, 4000);
  t.unref();
  process.stderr.write(`[ace-mcp] roots: ${roots.join(", ")}\n`);
}
main().catch((e) => { process.stderr.write(`[ace-mcp] fatal: ${e?.stack ?? e}\n`); process.exit(1); });
