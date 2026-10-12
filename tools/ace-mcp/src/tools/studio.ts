// Live tools: only usable while Ace runs (its Studio bridge). Hidden from the tool list otherwise; erroring politely if called anyway.
import { z } from "zod";
import { allow } from "../paths";
import { BridgeError, NOT_RUNNING } from "../bridge";
import { fail, text, type Ctx, type ToolDef, type ToolOutput } from "../types";

async function live(ctx: Ctx, op: string, args: Record<string, unknown>, timeout?: number): Promise<{ ok: true; value: any } | { ok: false; out: ToolOutput }> {
  if (!(await ctx.bridge.available(true))) return { ok: false, out: fail(NOT_RUNNING) };
  try {
    return { ok: true, value: await ctx.bridge.call(op, args, timeout) };
  } catch (e) {
    return { ok: false, out: fail(e instanceof BridgeError ? e.message : String(e)) };
  }
}
const fileArg = (ctx: Ctx, f?: string) => (f ? allow(ctx.roots, f) : undefined);

export const studioTools: ToolDef[] = [
  {
    name: "studio_open", live: true,
    description: "Open a .geo.json / .animation.json / .bbmodel in Ace's Animation Studio (focuses it), optionally selecting a clip and setting the playhead (seconds).",
    shape: { file: z.string(), anim: z.string().optional(), t: z.number().optional(), mode: z.enum(["edit", "animate", "pose"]).optional() },
    async handler(a, ctx) {
      const r = await live(ctx, "open", { file: allow(ctx.roots, a.file), anim: a.anim, t: a.t, mode: a.mode });
      return r.ok ? text(JSON.stringify(r.value)) : r.out;
    },
  },
  {
    name: "studio_state", live: true, readOnly: true,
    description: "What Ace's Studio is showing: open Studio tabs (file, mode, clip, playhead, selected bones/keys, dirty flag, problem counts). Use it to see what the user is looking at.",
    shape: {},
    async handler(_a, ctx) {
      const r = await live(ctx, "state", {});
      return r.ok ? text(JSON.stringify(r.value, null, 1)) : r.out;
    },
  },
  {
    name: "studio_screenshot", live: true, readOnly: true,
    description: "PNG of the Studio viewport (the posed model at the current playhead). Give `t` to look at one moment, or `frames: N` (2-12) to get a left-to-right strip of N evenly spaced moments between `from` and `to` (default the whole clip), or explicit `times`. Look at it after every edit to check the motion reads right. Needs the file open in Ace (use studio_open first, or pass `file` to open it).",
    shape: {
      file: z.string().optional(), anim: z.string().optional(), t: z.number().optional(), frames: z.number().int().min(2).max(12).optional(), from: z.number().optional(), to: z.number().optional(),
      times: z.array(z.number()).max(12).optional(), view: z.enum(["persp", "front", "side", "top"]).optional(), width: z.number().int().min(160).max(1600).optional().describe("px per frame (default 480)"),
    },
    async handler(a, ctx) {
      const r = await live(ctx, "screenshot", { file: fileArg(ctx, a.file), anim: a.anim, t: a.t, frames: a.frames, from: a.from, to: a.to, times: a.times, view: a.view, width: a.width }, 45_000);
      if (!r.ok) return r.out;
      const v = r.value as { png: string; width: number; height: number; times?: number[]; note?: string };
      return { content: [{ type: "image", data: v.png, mimeType: "image/png" }, { type: "text", text: `viewport ${v.width}x${v.height}${v.times ? " at t=" + v.times.join(", ") + "s" : ""}${v.note ? " — " + v.note : ""}` }] };
    },
  },
  {
    name: "studio_set_time", live: true,
    description: "Move the Studio playhead to t seconds (stops playback).",
    shape: { t: z.number().min(0), file: z.string().optional(), anim: z.string().optional() },
    async handler(a, ctx) {
      const r = await live(ctx, "set_time", { t: a.t, file: fileArg(ctx, a.file), anim: a.anim });
      return r.ok ? text(JSON.stringify(r.value)) : r.out;
    },
  },
  {
    name: "studio_select", live: true,
    description: "Select bones / a cube / keyframes in the Studio so the user sees what you mean, optionally switching clip. Selecting does not change the file.",
    shape: {
      file: z.string().optional(), bones: z.array(z.string()).optional(), anim: z.string().optional(),
      cube: z.object({ bone: z.string(), index: z.number().int() }).optional(),
      keys: z.array(z.object({ bone: z.string(), channel: z.enum(["rotation", "position", "scale"]), time: z.number() })).optional(),
    },
    async handler(a, ctx) {
      const r = await live(ctx, "select", { file: fileArg(ctx, a.file), bones: a.bones, anim: a.anim, cube: a.cube, keys: a.keys });
      return r.ok ? text(JSON.stringify(r.value)) : r.out;
    },
  },
];
