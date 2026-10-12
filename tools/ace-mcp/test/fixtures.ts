import { cpSync, existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { noBridge, type Bridge } from "../src/bridge";
import { ALL_TOOLS } from "../src/server";
import type { Ctx, ToolOutput } from "../src/types";

export const SPIDEY = "/Users/alexw/IdeaProjects/Thematic-Collections"; // spidey work is merged into the main checkout (read-only; tests copy to temp)
const RES = `${SPIDEY}/src/common/resources/assets/thematic`;
export const HAVE_SPIDEY = existsSync(`${RES}/animations/armor/web_sling.animation.json`);

export const MINI_ANIM = `{
  "format_version": "1.8.0",
  "animations": {
    "web_air": {
      "loop": true,
      "animation_length": 1.0,
      "bones": {
        "armorRightArm": {
          "rotation": { "0.0": [-150, 0, 10], "0.5": [-160, 5, 20], "1.0": [-150, 0, 10] }
        },
        "armorLeftArm": {
          "rotation": { "0.0": [-30, 0, -10], "1.0": [-30, 0, -10] }
        },
        "swing_pivot": { "position": [0, 0, 0] }
      }
    }
  }
}
`;

export function tmpRoot(prefix = "ace-mcp-"): string {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

export interface Fixture { root: string; anim: string; mini: string; geo: string; poses: string }
/** A temp tree shaped like a Thematic checkout: real copies when available, plus a synthetic mini clip file. */
export function makeFixture(): Fixture {
  const root = tmpRoot();
  const base = `${root}/src/common/resources/assets/thematic`;
  const pk = `${root}/src/packs/heroes/resources/assets/thematic`;
  mkdirSync(`${base}/animations/armor`, { recursive: true });
  mkdirSync(`${base}/geo/entity`, { recursive: true });
  mkdirSync(`${pk}/poses`, { recursive: true });
  const mini = `${base}/animations/armor/mini.animation.json`;
  writeFileSync(mini, MINI_ANIM);
  const out: Fixture = { root, mini, anim: `${base}/animations/armor/web_sling.animation.json`, geo: `${base}/geo/entity/science_vial.geo.json`, poses: `${pk}/poses/web.json` };
  if (HAVE_SPIDEY) {
    cpSync(`${RES}/animations/armor/web_sling.animation.json`, out.anim);
    cpSync(`${RES}/geo/entity/science_vial.geo.json`, out.geo);
    cpSync(`${SPIDEY}/src/packs/heroes/resources/assets/thematic/poses/web.json`, out.poses);
  }
  return out;
}

export function tool(name: string) {
  const t = ALL_TOOLS.find((x) => x.name === name);
  if (!t) throw new Error("no tool " + name);
  return t;
}
export const ctxFor = (root: string, bridge: Bridge = noBridge): Ctx => ({ roots: [root], bridge });
export async function run(ctx: Ctx, name: string, args: Record<string, unknown>): Promise<ToolOutput & { str: string }> {
  const t = tool(name);
  // go through the same error mapping as the server
  const { UserError, fail } = await import("../src/types");
  let r: ToolOutput;
  try { r = await t.handler(args, ctx); } catch (e) { r = e instanceof UserError ? fail(e.message) : fail("crash: " + (e as Error).message); }
  return Object.assign(r, { str: r.content.map((c) => (c.type === "text" ? c.text : `[image ${c.mimeType}]`)).join("\n") });
}
export { dirname };
