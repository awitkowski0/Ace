import { z } from "zod";
import { commit, fixId, fmtProblem, openDoc, pickAnim, validateDoc, type Opened } from "../files";
import {
  CHANNELS, EASING_NAMES, addAnimation, addKeyframe, applyNoise, copyKeys, deleteAnimation, deleteKeyframes, duplicateAnimation, insertBreakdown, insertPushRelax,
  moveKeyframes, pasteWithNoise, patchKeyframes, renameAnimation, setLength, setLoop, snapKeysToTicks, sortedKeys,
  type ChannelName, type Doc, type KeyRef, type Animation, type Vec3,
} from "../core";
import { text, UserError, type ToolDef, type ToolOutput } from "../types";

const ch = z.enum(["rotation", "position", "scale"]);
const comp = z.union([z.number(), z.string()]);
const vec3 = z.array(comp).length(3).describe("[x, y, z]; numbers (degrees for rotation, px for position, 1.0 = normal for scale), or molang strings");
const dry = z.boolean().optional().describe("true = compute and show the diff, write nothing");
const keyRef = z.object({ bone: z.string(), channel: ch, time: z.number() });
const select = z.object({
  bone: z.string().optional(), bones: z.array(z.string()).optional(), channel: ch.optional(), channels: z.array(ch).optional(),
  from: z.number().optional().describe("first time (s), inclusive"), to: z.number().optional().describe("last time (s), inclusive"),
}).describe("Select existing keys of the clip by bone(s) / channel(s) / time window. {} selects every key.");

type Sel = z.infer<typeof select>;
const EPS = 1e-4;

export function selectRefs(an: Animation, s: Sel): KeyRef[] {
  const bones = s.bones ?? (s.bone ? [s.bone] : undefined);
  const chans = s.channels ?? (s.channel ? [s.channel] : undefined);
  const out: KeyRef[] = [];
  for (const [bone, b] of an.bones) {
    if (bones && !bones.includes(bone)) continue;
    for (const c of CHANNELS) {
      if (chans && !chans.includes(c)) continue;
      for (const k of sortedKeys(b[c] ?? { shape: "keys", keys: [] })) {
        if ((s.from !== undefined && k.time < s.from - EPS) || (s.to !== undefined && k.time > s.to + EPS)) continue;
        out.push({ bone, channel: c, time: k.time });
      }
    }
  }
  return out;
}

function refsOf(an: Animation, keys?: KeyRef[], sel?: Sel): KeyRef[] {
  if (keys?.length) {
    for (const r of keys) if (!an.bones.get(r.bone)?.[r.channel]?.keys.some((k) => Math.abs(k.time - r.time) < 5e-4)) throw new UserError(`No key at ${r.bone}/${r.channel} t=${r.time} in ${an.name}`);
    return keys;
  }
  if (sel) {
    const r = selectRefs(an, sel);
    if (!r.length) throw new UserError(`The selection matched no keys in ${an.name}`);
    return r;
  }
  throw new UserError("Give `keys` (explicit refs) or `select` (use {} for every key)");
}

const canonEasing = (n: string): string => {
  const hit = EASING_NAMES.find((e) => e.toLowerCase() === n.toLowerCase());
  if (!hit) throw new UserError(`Unknown easing "${n}". Known: linear, step, and easeIn/easeOut/easeInOut + Sine|Quad|Cubic|Quart|Quint|Expo|Circ|Back|Elastic|Bounce`);
  return hit;
};

interface Edit { doc: Doc; label: string; anims?: string[]; note?: string }
function editTool(name: string, description: string, shape: z.ZodRawShape, run: (o: Opened, a: any) => Edit | Promise<Edit>, kinds: Array<"animation" | "bbmodel"> = ["animation", "bbmodel"]): ToolDef {
  return {
    name, description, shape: { file: z.string(), ...shape, dry_run: dry },
    async handler(a, ctx): Promise<ToolOutput> {
      const o = await openDoc(ctx, a.file, kinds);
      let e: Edit;
      try { e = await run(o, a); } catch (err) { if (err instanceof UserError) throw err; throw new UserError(`${name} failed: ${(err as Error).message}`); }
      return commit(ctx, o, e.doc, { label: e.label, dry_run: a.dry_run, anims: e.anims, note: e.note });
    },
  };
}

const loopSchema = z.union([z.boolean(), z.literal("hold_on_last_frame")]);
const noiseShape = {
  amplitude: z.object({ rotation: z.number().optional().describe("degrees"), position: z.number().optional().describe("px"), scale: z.number().optional().describe("percent") }).describe("Peak noise per channel; 0/absent = channel untouched"),
  axes: z.array(z.boolean()).length(3).optional().describe("[x,y,z] which axes get noise (default all)"),
  kind: z.enum(["perlin", "random"]).optional().describe("perlin = smooth over time (default), random = independent per key"),
  frequency: z.number().optional().describe("perlin: noise features per second (default 2)"),
  seed: z.number().int().optional().describe("same seed = same result; omitted -> a random one is chosen and returned"),
  keep_ends: z.boolean().optional().describe("keep first/last key of each bone+channel exact (default true) so loops stay seamless"),
};
function noiseOpts(a: any) {
  const seed = a.seed ?? 1 + Math.floor(Math.random() * 99998);
  return { seed, o: { amplitude: { rotation: a.amplitude?.rotation ?? 0, position: a.amplitude?.position ?? 0, scale: a.amplitude?.scale ?? 0 }, axes: a.axes as [boolean, boolean, boolean] | undefined, kind: (a.kind ?? "perlin") as "perlin" | "random", frequency: a.frequency, seed, keepEnds: a.keep_ends ?? true } };
}

export const editTools: ToolDef[] = [
  editTool("add_animation", "Add an empty clip. `loop`: true | false | \"hold_on_last_frame\". length in seconds (multiple of 0.05).", { name: z.string(), length: z.number().positive().optional(), loop: loopSchema.optional() },
    (o, a) => ({ doc: addAnimation(o.doc, { name: a.name, length: a.length, loop: a.loop }), label: `add animation ${a.name}`, anims: [a.name] })),
  editTool("duplicate_animation", "Copy a clip under a new name (variants are named base_1, base_2 … and must be consecutive and the same length as the base).", { name: z.string(), new_name: z.string() },
    (o, a) => { pickAnim(o.doc, a.name); return { doc: duplicateAnimation(o.doc, { name: a.name, newName: a.new_name }), label: `duplicate ${a.name} → ${a.new_name}`, anims: [a.new_name] }; }),
  editTool("rename_animation", "Rename a clip (check pose sets / ability scripts that reference the old name).", { name: z.string(), new_name: z.string() },
    (o, a) => { pickAnim(o.doc, a.name); return { doc: renameAnimation(o.doc, { name: a.name, newName: a.new_name }), label: `rename ${a.name} → ${a.new_name}` }; }),
  editTool("delete_animation", "Delete a clip.", { name: z.string() },
    (o, a) => { pickAnim(o.doc, a.name); return { doc: deleteAnimation(o.doc, { name: a.name }), label: `delete animation ${a.name}` }; }),
  editTool("set_loop", "Set a clip's loop mode: true (cycle), false (play once), \"hold_on_last_frame\".", { anim: z.string(), loop: loopSchema },
    (o, a) => { pickAnim(o.doc, a.anim); return { doc: setLoop(o.doc, { anim: a.anim, loop: a.loop }), label: `${a.anim} loop=${String(a.loop)}`, anims: [a.anim] }; }),
  editTool("set_length", "Set animation_length in seconds (multiple of 0.05; ticks = seconds × 20). Keys are not moved.", { anim: z.string(), length: z.number().positive() },
    (o, a) => { pickAnim(o.doc, a.anim); return { doc: setLength(o.doc, { anim: a.anim, length: a.length }), label: `${a.anim} length=${a.length}`, anims: [a.anim] }; }),
  editTool("set_keys", "Bulk upsert keyframes. Each item: bone, channel, time (s), value [x,y,z] (omit to keep/sample the existing value), optional pre, easing (+easing_args), lerp (linear|catmullrom). An existing key at the same time is replaced but keeps its easing unless you set one. Easing applies to the segment ENDING at that key. Keep times on the 0.05 s grid.", {
    anim: z.string(),
    keys: z.array(z.object({ bone: z.string(), channel: ch, time: z.number().min(0), value: vec3.optional(), pre: vec3.optional(), easing: z.string().optional(), easing_args: z.array(z.number()).optional(), lerp: z.enum(["linear", "catmullrom"]).optional() })).min(1).max(400),
  }, (o, a) => {
    pickAnim(o.doc, a.anim);
    let d = o.doc;
    for (const k of a.keys) d = addKeyframe(d, { anim: a.anim, bone: k.bone, channel: k.channel, time: k.time, value: k.value as Vec3 | undefined, pre: k.pre as Vec3 | undefined, easing: k.easing ? canonEasing(k.easing) : undefined, easingArgs: k.easing_args, lerp: k.lerp });
    return { doc: d, label: `${a.anim}: set ${a.keys.length} key(s)`, anims: [a.anim] };
  }),
  editTool("delete_keys", "Delete keyframes, by explicit refs or by selection.", { anim: z.string(), keys: z.array(keyRef).optional(), select: select.optional() },
    (o, a) => { const an = pickAnim(o.doc, a.anim); const refs = refsOf(an, a.keys, a.select); return { doc: deleteKeyframes(o.doc, { anim: a.anim, keys: refs }), label: `${a.anim}: delete ${refs.length} key(s)`, anims: [a.anim] }; }),
  editTool("move_keys", "Shift keys by `delta` seconds (use multiples of 0.05). With anchor=true (Thematic anchor mode) moving any key of a bone+channel shifts ALL keys of that bone+channel by the same delta.", { anim: z.string(), keys: z.array(keyRef).optional(), select: select.optional(), delta: z.number(), anchor: z.boolean().optional() },
    (o, a) => { const an = pickAnim(o.doc, a.anim); const refs = refsOf(an, a.keys, a.select); return { doc: moveKeyframes(o.doc, { anim: a.anim, keys: refs, delta: a.delta, anchor: a.anchor }), label: `${a.anim}: move ${refs.length} key(s) by ${a.delta}s`, anims: [a.anim] }; }),
  editTool("set_easing", "Set easing on keys (geo rule: it shapes the segment ENDING at each key; in assets/<ns>/animations/armor/ files read by the player serializer it shapes the segment LEAVING the key). `easing`: linear (clears), step, easeIn|easeOut|easeInOut + Sine|Quad|Cubic|Quart|Quint|Expo|Circ|Back|Elastic|Bounce; `easing_args` e.g. overshoot for Back. Or `lerp`: linear|catmullrom (spline through neighbours). Exactly one of easing/lerp.", {
    anim: z.string(), keys: z.array(keyRef).optional(), select: select.optional(), easing: z.string().optional(), easing_args: z.array(z.number()).optional(), lerp: z.enum(["linear", "catmullrom"]).optional(),
  }, (o, a) => {
    if ((a.easing === undefined) === (a.lerp === undefined)) throw new UserError("Give exactly one of `easing` or `lerp`");
    const an = pickAnim(o.doc, a.anim);
    const refs = refsOf(an, a.keys, a.select);
    const patch = a.lerp !== undefined ? { lerp: a.lerp } : { easing: canonEasing(a.easing), ...(a.easing_args ? { easingArgs: a.easing_args } : {}) };
    return { doc: patchKeyframes(o.doc, { anim: a.anim, keys: refs, patch }), label: `${a.anim}: ${a.lerp ?? a.easing} on ${refs.length} key(s)`, anims: [a.anim] };
  }),
  editTool("breakdown", "Pose between two frames (Blender-style breakdowner): blend the sampled pose at t_a and t_b by `factor` (0 = A, 1 = B, -0.5..1.5 overshoots; rotations slerp, positions/scales lerp) and INSERT the result as keys at `time`. follow_curve uses the easing of the segment ending at B instead of linear. Default bones: all animated bones.", {
    anim: z.string(), t_a: z.number(), t_b: z.number(), factor: z.number().min(-1).max(2), time: z.number().min(0).describe("where to insert the keys"),
    bones: z.array(z.string()).optional(), channels: z.array(ch).optional(), follow_curve: z.boolean().optional(), easing: z.string().optional().describe("easing for the inserted keys"),
  }, (o, a) => {
    pickAnim(o.doc, a.anim);
    const d = insertBreakdown(o.doc, a.anim, { tA: a.t_a, tB: a.t_b, factor: a.factor, bones: a.bones, channels: a.channels as ChannelName[] | undefined, followCurve: a.follow_curve }, a.time, a.easing ? canonEasing(a.easing) : undefined);
    return { doc: d, label: `${a.anim}: breakdown ${a.t_a}→${a.t_b} @${a.factor} → t=${a.time}`, anims: [a.anim] };
  }),
  editTool("push_relax", "Push/relax the pose at time t versus the straight blend of its neighbouring keys: amount > 0 exaggerates, < 0 softens, -1 = exactly on the line. Writes keys at t.", {
    anim: z.string(), t: z.number().min(0), amount: z.number().min(-1).max(2), bones: z.array(z.string()).optional(), channels: z.array(ch).optional(), easing: z.string().optional(),
  }, (o, a) => {
    pickAnim(o.doc, a.anim);
    return { doc: insertPushRelax(o.doc, a.anim, { t: a.t, amount: a.amount, bones: a.bones, channels: a.channels as ChannelName[] | undefined }, a.easing ? canonEasing(a.easing) : undefined), label: `${a.anim}: push/relax ${a.amount} @ t=${a.t}`, anims: [a.anim] };
  }),
  editTool("paste_with_noise", "Copy keys from a time window of a clip and paste them (repeat N times every `every` s starting at target_time) with seeded noise — for organic loops, idles, crowds. mirror_lr swaps Left/Right bones and flips yaw/roll. Returns the seed used.", {
    anim: z.string(), source: select.describe("keys to copy (bones/channels/from/to)"), target_time: z.number().min(0), target_anim: z.string().optional().describe("default: same clip"),
    repeat: z.number().int().min(1).max(64).optional(), every: z.number().positive().optional(), target_bones: z.union([z.record(z.string(), z.string()), z.array(z.string())]).optional().describe("map source bone -> target bone, or list matched to the copied bones in order"),
    mirror_lr: z.boolean().optional(), ...noiseShape,
  }, (o, a) => {
    const an = pickAnim(o.doc, a.anim);
    const tgt = a.target_anim ?? a.anim;
    pickAnim(o.doc, tgt);
    const clip = copyKeys(o.doc, a.anim, refsOf(an, undefined, a.source));
    const { o: n, seed } = noiseOpts(a);
    const d = pasteWithNoise(o.doc, tgt, clip, { ...n, targetTime: a.target_time, repeat: a.repeat, every: a.every, targetBones: a.target_bones, mirrorLR: a.mirror_lr });
    return { doc: d, label: `${tgt}: paste ${clip.keys.length} key(s) ×${a.repeat ?? 1} at ${a.target_time}s, seed ${seed}`, anims: [tgt], note: `seed: ${seed}` };
  }),
  editTool("add_noise", "Add seeded noise in place to selected keys (rotation degrees, position px, scale %). keep_ends (default true) leaves the first/last key of each bone+channel exact. Returns the seed.", { anim: z.string(), keys: z.array(keyRef).optional(), select: select.optional(), ...noiseShape },
    (o, a) => {
      const an = pickAnim(o.doc, a.anim);
      const refs = refsOf(an, a.keys, a.select);
      const { o: n, seed } = noiseOpts(a);
      return { doc: applyNoise(o.doc, a.anim, refs, n), label: `${a.anim}: noise on ${refs.length} key(s), seed ${seed}`, anims: [a.anim], note: `seed: ${seed}` };
    }),
  editTool("mirror_clip", "Create a new clip that is the left/right mirror of `anim`: Left<->Right bones swapped (armorLeftArm<->armorRightArm …), rotation Y/Z and position X negated. Same length/loop. Use it to derive the left-handed version of a right-handed clip.", { anim: z.string(), new_name: z.string() },
    (o, a) => {
      const an = pickAnim(o.doc, a.anim);
      const refs = selectRefs(an, {});
      if (!refs.length) throw new UserError(`${a.anim} has no keys`);
      const t0 = Math.min(...refs.map((r) => r.time));
      let d = addAnimation(o.doc, { name: a.new_name, length: an.length, loop: an.loop });
      const clip = copyKeys(o.doc, a.anim, refs);
      d = pasteWithNoise(d, a.new_name, clip, { amplitude: { rotation: 0, position: 0, scale: 0 }, kind: "perlin", seed: 1, targetTime: t0, mirrorLR: true });
      return { doc: d, label: `mirror ${a.anim} → ${a.new_name}`, anims: [a.new_name] };
    }),
  editTool("snap_to_ticks", "Snap key times (and animation_length) to the tick grid (default 20 ticks/s = 0.05 s). Optionally only selected keys.", { anim: z.string(), ticks_per_second: z.number().positive().optional(), keys: z.array(keyRef).optional(), select: select.optional() },
    (o, a) => { const an = pickAnim(o.doc, a.anim); const refs = a.keys || a.select ? refsOf(an, a.keys, a.select) : undefined; return { doc: snapKeysToTicks(o.doc, { anim: a.anim, ticksPerSecond: a.ticks_per_second, keys: refs }), label: `${a.anim}: snap to ${a.ticks_per_second ?? 20} ticks/s`, anims: [a.anim] }; }),
  editTool("apply_fix", "Apply the quick-fix of a validation problem by its fix_id (from `validate`). Re-validates first, so stale ids are rejected.", { fix_id: z.string() },
    async (o, a) => {
      const ps = await validateDoc(o.path, o.doc, { allClips: true });
      const p = ps.find((x) => fixId(x) === a.fix_id && x.fix);
      if (!p) throw new UserError(`No fixable problem with fix_id "${a.fix_id}" (it may be fixed already). Re-run validate.`);
      return { doc: p.fix!.apply(o.doc), label: `fix: ${p.fix!.title}`, anims: [p.anim], note: fmtProblem(p) };
    }, ["animation"]),
];
