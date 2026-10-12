import { execFileSync } from "node:child_process";
import { readFileSync, existsSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeFixture } from "./fixtures";
import { startFakeAce } from "./fakeAce";

const here = dirname(fileURLToPath(import.meta.url));
const bundle = resolve(here, "../dist/ace-mcp.mjs");

describe("bundled server over stdio (MCP client SDK)", () => {
  const f = makeFixture();
  let client: Client;
  const text = (r: any) => (r.content as Array<{ type: string; text?: string }>).map((c) => c.text ?? `[${c.type}]`).join("\n");
  beforeAll(async () => {
    execFileSync("node", [resolve(here, "../build.mjs")], { stdio: "pipe" });
    expect(existsSync(bundle)).toBe(true);
    expect(statSync(bundle).size).toBeGreaterThan(100_000);
    client = new Client({ name: "e2e", version: "1" });
    await client.connect(new StdioClientTransport({ command: "node", args: [bundle, "--root", f.root], env: { ...process.env, ACE_STUDIO_SOCK: `${f.root}/none.sock` } as Record<string, string>, stderr: "pipe" }));
  }, 60_000);
  afterAll(async () => { await client?.close(); });

  it("lists tools (studio_* hidden without Ace) with JSON schemas", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["describe_animation", "validate", "breakdown", "paste_with_noise", "save_assets_to_git", "asset_status"]));
    expect(names.some((n) => n.startsWith("studio_"))).toBe(false);
    const bd = tools.find((t) => t.name === "breakdown")!;
    expect(bd.inputSchema.type).toBe("object");
    expect(Object.keys((bd.inputSchema as any).properties)).toEqual(expect.arrayContaining(["file", "anim", "t_a", "t_b", "factor", "time", "dry_run"]));
    expect((bd.inputSchema as any).required).toEqual(expect.arrayContaining(["file", "anim", "factor"]));
  });

  it("describe / validate / breakdown dry-run / paste_with_noise dry-run + real write", async () => {
    const d = await client.callTool({ name: "describe_animation", arguments: { file: f.mini } });
    expect(text(d)).toContain("web_air");
    const v = await client.callTool({ name: "validate", arguments: { file: f.mini } });
    expect(text(v)).toMatch(/error\(s\)/);
    const before = readFileSync(f.mini, "utf8");
    const b = await client.callTool({ name: "breakdown", arguments: { file: f.mini, anim: "web_air", t_a: 0, t_b: 0.5, factor: 0.5, time: 0.25, dry_run: true } });
    expect(text(b)).toContain("DRY RUN");
    const p = await client.callTool({ name: "paste_with_noise", arguments: { file: f.mini, anim: "web_air", source: { bones: ["armorRightArm"] }, target_time: 1, amplitude: { rotation: 2 }, seed: 5, dry_run: true } });
    expect(text(p)).toContain("seed: 5");
    expect(readFileSync(f.mini, "utf8")).toBe(before);
    const w = await client.callTool({ name: "paste_with_noise", arguments: { file: f.mini, anim: "web_air", source: { bones: ["armorRightArm"] }, target_time: 1, amplitude: { rotation: 2 }, seed: 5 } });
    expect(text(w)).toContain("Wrote");
    expect(readFileSync(f.mini, "utf8")).not.toBe(before);
  });

  it("refuses paths outside the root and bad arguments", async () => {
    const r = await client.callTool({ name: "describe_animation", arguments: { file: "/etc/passwd" } });
    expect(r.isError).toBe(true);
    await expect(client.callTool({ name: "set_loop", arguments: { file: f.mini, anim: "web_air" } })).resolves.toMatchObject({ isError: true });
  });
});

describe("live tools appear when Ace's bridge is up", () => {
  it("adds studio_* tools and returns an MCP image", async () => {
    const f = makeFixture();
    const ace = await startFakeAce(`${f.root}/ace.sock`);
    const client = new Client({ name: "e2e2", version: "1" });
    await client.connect(new StdioClientTransport({ command: "node", args: [bundle, "--root", f.root], env: { ...process.env, ACE_STUDIO_SOCK: ace.sock } as Record<string, string>, stderr: "pipe" }));
    try {
      const names = (await client.listTools()).tools.map((t) => t.name);
      expect(names).toEqual(expect.arrayContaining(["studio_open", "studio_state", "studio_screenshot", "studio_set_time", "studio_select"]));
      const shot = await client.callTool({ name: "studio_screenshot", arguments: { t: 0.5 } });
      expect((shot.content as any[])[0]).toMatchObject({ type: "image", mimeType: "image/png" });
    } finally { await client.close(); await ace.close(); }
  }, 30_000);
});
