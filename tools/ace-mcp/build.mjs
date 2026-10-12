// Bundles the stdio MCP server into one file (core + SDK inlined) and copies it into the plugin.
import { build } from "esbuild";
import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const out = resolve(here, "dist/ace-mcp.mjs");
await build({
  entryPoints: [resolve(here, "src/index.ts")],
  outfile: out,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  minify: false,
  legalComments: "none",
  banner: { js: "#!/usr/bin/env node\nimport { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
});
const dest = resolve(here, "../../plugins/ace-studio/server/ace-mcp.mjs");
mkdirSync(dirname(dest), { recursive: true });
copyFileSync(out, dest);
console.log("built", out, "->", dest);
