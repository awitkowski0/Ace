import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { UserError, fail, type Ctx, type ToolDef } from "./types";
import { discoverTools } from "./tools/discover";
import { editTools } from "./tools/edit";
import { geoTools } from "./tools/geo";
import { gitTools } from "./tools/git";
import { studioTools } from "./tools/studio";

export const ALL_TOOLS: ToolDef[] = [...discoverTools, ...editTools, ...geoTools, ...gitTools, ...studioTools];

const INSTRUCTIONS = `Ace Animation Studio tools for Minecraft Bedrock/GeckoLib assets (.geo.json, .animation.json, .bbmodel) and asset git.
Workflow: describe_* / validate to read -> any edit tool with dry_run:true to preview the diff -> repeat without dry_run -> validate -> studio_screenshot when Ace is running.
Edits are byte-faithful (only the touched JSON changes). When the file is open in Ace the edit goes into the editor buffer (undoable, unsaved). Times are seconds on a 0.05 s (1 tick) grid.
save_assets_to_git needs confirm:true — only after the user explicitly agreed.`;

export function createServer(ctx: Ctx): { server: McpServer; refreshLive: () => Promise<boolean> } {
  const server = new McpServer({ name: "ace-studio", version: "0.1.0" }, { instructions: INSTRUCTIONS });
  const live: Array<{ enable(): void; disable(): void; enabled: boolean }> = [];
  for (const t of ALL_TOOLS) {
    const reg = server.registerTool(
      t.name,
      { description: t.description, inputSchema: t.shape, annotations: { readOnlyHint: !!t.readOnly, openWorldHint: false } },
      async (args: any) => {
        try {
          return await t.handler(args, ctx);
        } catch (e) {
          if (e instanceof UserError) return fail(e.message);
          return fail(`${t.name} crashed: ${(e as Error).message}`);
        }
      },
    );
    if (t.live) live.push(reg as never);
  }
  // Live tools appear only while Ace's bridge answers (the list-changed notification is sent by enable/disable).
  const refreshLive = async () => {
    const up = await ctx.bridge.available(true);
    for (const r of live) if (r.enabled !== up) (up ? r.enable() : r.disable());
    return up;
  };
  return { server, refreshLive };
}
