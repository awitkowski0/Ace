import { promises as fsp } from "node:fs";
import { basename, join, relative } from "node:path";
import { z } from "zod";
import { allow } from "../paths";
import { nodeFs, openDoc, pickAnim, poseSetsFor, validateDoc, fmtProblem } from "../files";
import {
  CHANNELS, animLength, classifyAsset, clipInfos, getAnimations, getBb, getGeo, isChannelDriverRead, samplePose, sortedKeys, armorAnimLocation,
  type Animation, type GeoBone, type BbGroup, type PoseSet,
} from "../core";
import { text, UserError, type ToolDef } from "../types";

const r = (v: number, d = 4) => Math.round(v * 10 ** d) / 10 ** d;
const vec = (v: readonly (number | string)[]) => "[" + v.map((x) => (typeof x === "number" ? r(x, 3) : JSON.stringify(x))).join(", ") + "]";
const SKIP = new Set(["build", ".git", "node_modules", ".gradle", ".claude", ".idea", "out", "run", "runs", "target", "dist"]);

async function walk(root: string, cap: number): Promise<string[]> {
  const out: string[] = [];
  const rec = async (d: string, depth: number) => {
    if (out.length >= cap || depth > 14) return;
    let es;
    try { es = await fsp.readdir(d, { withFileTypes: true }); } catch { return; }
    es.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of es) {
      if (SKIP.has(e.name)) continue;
      const p = join(d, e.name);
      if (e.isDirectory()) await rec(p, depth + 1);
      else if (/\.(geo\.json|animation\.json|bbmodel|json|png)$/.test(e.name)) out.push(p);
      if (out.length >= cap) return;
    }
  };
  await rec(root, 0);
  return out;
}

export const listAssets: ToolDef = {
  name: "list_assets",
  readOnly: true,
  description: "List asset files under a directory (default: the first allowed root), classified like Ace's Assets tree. Filter by kind (armor|item|entity|block), type (model|animation|texture|pose|lang|sound) and a substring `search`. Returns up to `limit` paths with type/kind.",
  shape: {
    root: z.string().optional().describe("Directory to scan (inside the allowed roots)"),
    type: z.enum(["model", "animation", "texture", "pose", "lang", "sound"]).optional(),
    kind: z.enum(["armor", "item", "entity", "block"]).optional(),
    search: z.string().optional().describe("Case-insensitive substring of the path"),
    limit: z.number().int().min(1).max(500).optional(),
  },
  async handler(a, ctx) {
    const root = a.root ? allow(ctx.roots, a.root) : ctx.roots[0];
    const limit = a.limit ?? 100;
    const files = await walk(root, 60_000);
    const q = (a.search ?? "").toLowerCase();
    const rows: string[] = [];
    let total = 0;
    for (const f of files) {
      const rel = relative(root, f);
      const info2 = classifyAsset(rel);
      if (!info2 || !info2.inTree) continue;
      if (a.type && info2.type !== a.type) continue;
      if (a.kind && info2.kind !== a.kind) continue;
      if (q && !rel.toLowerCase().includes(q)) continue;
      total++;
      if (rows.length < limit) rows.push(`${rel}  [${info2.type}${info2.kind ? "/" + info2.kind : ""}]`);
    }
    return text(`${total} match(es) under ${root}${total > rows.length ? ` (showing ${rows.length})` : ""}\n${rows.join("\n")}`);
  },
};

function boneTree(bones: GeoBone[]): string[] {
  const kids = new Map<string | undefined, GeoBone[]>();
  const names = new Set(bones.map((b) => b.name));
  for (const b of bones) {
    const p = b.parent && names.has(b.parent) ? b.parent : undefined;
    (kids.get(p) ?? kids.set(p, []).get(p)!).push(b);
  }
  const out: string[] = [];
  const rec = (p: string | undefined, d: number) => {
    for (const b of kids.get(p) ?? []) {
      out.push(`${"  ".repeat(d)}${b.name} pivot ${vec(b.pivot)}${b.rotation ? " rot " + vec(b.rotation) : ""}${b.cubes.length ? ` cubes:${b.cubes.length}` : ""}`);
      rec(b.name, d + 1);
    }
  };
  rec(undefined, 0);
  return out;
}

export const describeModel: ToolDef = {
  name: "describe_model",
  readOnly: true,
  description: "Summarise a .geo.json or .bbmodel: identifier, texture size, and the bone tree (name, pivot, rotation, cube count). With `bone`, list that bone's cubes (index, origin, size, uv). Use this before editing geometry or choosing bone names for an animation.",
  shape: { file: z.string(), bone: z.string().optional().describe("Show the cubes of this bone (geo only)"), max_lines: z.number().int().optional() },
  async handler(a, ctx) {
    const o = await openDoc(ctx, a.file, ["geo", "bbmodel"]);
    const lines: string[] = [];
    if (o.kind === "geo") {
      const g = getGeo(o.doc);
      for (const geo of g.geometries) {
        lines.push(`geometry ${geo.identifier} (#${geo.index}) texture ${geo.textureWidth}x${geo.textureHeight}, ${geo.bones.length} bones, ${geo.bones.reduce((n, b) => n + b.cubes.length, 0)} cubes${g.formatVersion ? ", format " + g.formatVersion : ""}`);
        if (a.bone) {
          const b = geo.bones.find((x) => x.name === a.bone);
          if (!b) throw new UserError(`No bone "${a.bone}"`);
          lines.push(`${b.name}: parent ${b.parent ?? "-"} pivot ${vec(b.pivot)}${b.rotation ? " rot " + vec(b.rotation) : ""}`);
          b.cubes.forEach((c) => lines.push(`  cube ${c.index}: origin ${vec(c.origin)} size ${vec(c.size)}${c.inflate ? " inflate " + c.inflate : ""}${c.rotation ? " rot " + vec(c.rotation) : ""}${c.mirror ? " mirror" : ""} uv ${c.uv ? (c.uv.kind === "box" ? vec(c.uv.uv) : "per-face") : "-"}`));
        } else lines.push(...boneTree(geo.bones));
      }
    } else {
      const m = getBb(o.doc);
      lines.push(`bbmodel ${m.name ?? ""} (${m.modelFormat ?? "?"} ${m.formatVersion ?? ""}) ${m.elements.length} elements (${m.elements.filter((e) => e.type !== "cube").length} non-cube), ${m.textures.length} textures, ${m.animations.length} animations: ${m.animations.map((x) => x.name).join(", ")}`);
      const rec = (g: BbGroup, d: number) => {
        lines.push(`${"  ".repeat(d)}${g.name} origin ${vec(g.origin)}${g.rotation ? " rot " + vec(g.rotation) : ""}`);
        for (const c of g.children) if (typeof c !== "string") rec(c, d + 1);
      };
      m.groups.forEach((g) => rec(g, 0));
    }
    const max = a.max_lines ?? 150;
    const more = lines.length > max ? [`… ${lines.length - max} more lines (use bone= or max_lines=)`] : [];
    return text([`${basename(o.path)}`, ...lines.slice(0, max), ...more].join("\n"));
  },
};

function animLine(a: Animation, info?: ReturnType<typeof clipInfos> extends Map<string, infer V> ? V : never): string {
  let keys = 0;
  for (const b of a.bones.values()) for (const c of CHANNELS) keys += b[c]?.keys.length ?? 0;
  const len = animLength(a);
  const badges = info ? [info.playback, info.mirrored ? "mirrored" : "", info.poseOnly ? "pose-only" : "", info.aimed.length ? "aimed:" + info.aimed.join("/") : "", info.spin ? `spin:${info.spin.axis}` : "", info.usedByStates.length ? "when:" + info.usedByStates.join("/") : ""].filter(Boolean).join(" ") : "";
  return `${a.name}: loop=${String(a.loop ?? false)} length=${a.length ?? "(auto " + r(len) + ")"}s (${r(len * 20, 2)} ticks) bones=${a.bones.size} keys=${keys}${badges ? "  {" + badges + "}" : ""}`;
}

export const describeAnimation: ToolDef = {
  name: "describe_animation",
  readOnly: true,
  description: "Summarise an .animation.json or .bbmodel. Without `anim`: one line per clip (loop, length in seconds and ticks, bone/key counts; spidey badges for armor files). With `anim`: every bone x channel with its key times, easings and the value range. Times are seconds; 20 ticks = 1 s.",
  shape: { file: z.string(), anim: z.string().optional(), bone: z.string().optional().describe("Limit to one bone"), search: z.string().optional().describe("Filter clip names (substring)") },
  async handler(a, ctx) {
    const o = await openDoc(ctx, a.file, ["animation", "bbmodel"]);
    const anims = getAnimations(o.doc);
    const sets = await poseSetsFor(o.path);
    const infos = sets.length ? clipInfos(anims, sets) : undefined;
    if (!a.anim) {
      const q = (a.search ?? "").toLowerCase();
      const rows = anims.filter((x) => !q || x.name.toLowerCase().includes(q)).map((x) => animLine(x, infos?.get(x.name)));
      return text(`${basename(o.path)} — ${anims.length} animation(s)${sets.length ? `, pose set(s): ${sets.map((s) => s.name).join(", ")}` : ""}\n${rows.slice(0, 200).join("\n")}${rows.length > 200 ? `\n… ${rows.length - 200} more` : ""}`);
    }
    const an = pickAnim(o.doc, a.anim);
    const lines = [animLine(an, infos?.get(an.name))];
    for (const [bone, b] of an.bones) {
      if (a.bone && bone !== a.bone) continue;
      for (const ch of CHANNELS) {
        const c = b[ch];
        if (!c) continue;
        const ks = sortedKeys(c);
        const times = ks.map((k) => r(k.time)).join(" ");
        const eas = [...new Set(ks.map((k) => k.lerp ?? k.easing).filter(Boolean))];
        const lo = [0, 1, 2].map((i) => Math.min(...ks.map((k) => (typeof k.value[i] === "number" ? (k.value[i] as number) : Infinity))));
        const hi = [0, 1, 2].map((i) => Math.max(...ks.map((k) => (typeof k.value[i] === "number" ? (k.value[i] as number) : -Infinity))));
        const rng = lo.every(Number.isFinite) ? ` range ${vec(lo)}..${vec(hi)}` : "";
        const dim = infos && !isChannelDriverRead(bone, ch) ? " (not read by the limb driver)" : "";
        lines.push(`  ${bone}/${ch} [${c.shape}] t: ${times}${eas.length ? " easing: " + eas.join(",") : ""}${rng}${dim}`);
      }
    }
    return text(lines.join("\n"));
  },
};

export const findPreviewModel: ToolDef = {
  name: "find_preview_model",
  readOnly: true,
  description: "Find the model and texture Ace's Studio would preview an animation/geo file with: for geo/<kind>/X.geo.json it looks for animations/<kind>/X.animation.json and textures/<kind>/X.png under the same assets/<ns>/ root (and the reverse). Armor animation files are a shared clip library: they preview on the built-in Player rig (bones armorHead/Body/RightArm/LeftArm/RightLeg/LeftLeg).",
  shape: { file: z.string() },
  async handler(a, ctx) {
    const p = allow(ctx.roots, a.file).replace(/\\/g, "/");
    const m = /^(.*\/assets\/([^/]+))\/(geo|animations)\/(?:(.+)\/)?([^/]+?)\.(geo|animation)\.json$/.exec(p);
    if (!m) return text(`${basename(p)} is not under assets/<ns>/geo|animations/…; no sibling lookup possible.`);
    const [, root, ns, , kind = "", stem, type] = m;
    const k = kind ? kind + "/" : "";
    const ex = async (f: string) => !!(await fsp.stat(f).catch(() => null));
    const geo = `${root}/geo/${k}${stem}.geo.json`;
    const anim = `${root}/animations/${k}${stem}.animation.json`;
    const tex = `${root}/textures/${k}${stem}.png`;
    const lines = [`namespace ${ns}, kind "${kind || "-"}"`];
    lines.push(`geo:       ${(await ex(geo)) ? geo : "(none)"}`, `animation: ${(await ex(anim)) ? anim : "(none)"}`, `texture:   ${(await ex(tex)) ? tex : "(none)"}`);
    if (type === "animation" && kind.split("/")[0] === "armor") lines.push("Armor clip library: previews on the built-in Player rig; pick any geo as preview model in Ace.");
    return text(lines.join("\n"));
  },
};

function describeSet(s: PoseSet): string[] {
  const out = [`pose set "${s.name}"${s.isDefault ? " (default)" : ""}${s.path ? " " + s.path : ""}: ${s.modes.length} modes, ${Object.keys(s.clips).length} clips${s.errors.length ? ", ERRORS: " + s.errors.join("; ") : ""}`];
  for (const m of s.modes) out.push(`  mode ${m.mode} when=${m.when}${m.clip ? " clip=" + m.clip : ""}${m.right ? " right=" + m.right : ""}${m.left ? " left=" + m.left : ""}${m.cling ? " cling=" + m.cling : ""}${m.ticks ? " ticks=" + m.ticks : ""}`);
  return out;
}

export const listPoseSets: ToolDef = {
  name: "list_pose_sets",
  readOnly: true,
  description: "For an armor animation file (…/assets/<ns>/animations/armor/*.animation.json) find the pose sets (poses/*.json) that tell the game which clip plays in which state, and list their modes. Empty for other files.",
  shape: { file: z.string() },
  async handler(a, ctx) {
    const p = allow(ctx.roots, a.file);
    if (!armorAnimLocation(p)) return text("Not an armor animation file: no pose sets apply.");
    const sets = await poseSetsFor(p);
    return text(sets.length ? sets.flatMap(describeSet).join("\n") : "No poses/*.json found in this source tree.");
  },
};

export const clipInfoTool: ToolDef = {
  name: "clip_info",
  readOnly: true,
  description: "Pose-set facts for clips of an armor animation file: role, timeline meaning, playback (loop|one_shot|stride|whole), game states using it, mirrored (draw right-handed), aimed limbs (pitch/yaw overridden in game), spin, pose-only. Omit `anim` for all clips in the pose set.",
  shape: { file: z.string(), anim: z.string().optional() },
  async handler(a, ctx) {
    const o = await openDoc(ctx, a.file, ["animation"]);
    const sets = await poseSetsFor(o.path);
    if (!sets.length) return text("No pose set found for this file; clip_info only applies to armor animation files with poses/*.json.");
    const infos = clipInfos(getAnimations(o.doc), sets);
    const rows: string[] = [];
    for (const [name, i] of infos) {
      if (a.anim && name !== a.anim) continue;
      if (!a.anim && !i.inPoseSet && !i.variantIndex) continue;
      rows.push(`${name}${i.variantIndex ? ` (variant ${i.variantIndex} of ${i.base})` : ""}: role="${i.role ?? "-"}" playback=${i.playback ?? "-"}${i.timeline ? ` timeline="${i.timeline}"` : ""} when=[${i.usedByStates.join(",")}] mirrored=${i.mirrored} aimed=[${i.aimed.join(",")}] poseOnly=${i.poseOnly}${i.spin ? ` spin=${i.spin.axis}x${i.spin.turns}/${i.spin.ticks}t` : ""}`);
    }
    return text(rows.join("\n") || "(no matching clips)");
  },
};

export const samplePoseTool: ToolDef = {
  name: "sample_pose",
  readOnly: true,
  description: "Sample the pose of a clip at time t (seconds) with the clip semantics the file path implies: geo/GeckoLib (easing belongs to the segment ENDING at a key) or, for assets/<ns>/animations/armor/ files, the player rules (easing of the EARLIER key governs the segment leaving it, ticks floored, scale ignored; see thematic-animation skill). The first output line names the semantics. Loops wrap. Returns rotation/position/scale per animated bone (file units: degrees / px). Use it to check a pose before and after an edit.",
  shape: { file: z.string(), anim: z.string(), t: z.number(), bones: z.array(z.string()).optional(), wrap: z.boolean().optional().describe("Apply loop wrapping (default true)") },
  async handler(a, ctx) {
    const o = await openDoc(ctx, a.file, ["animation", "bbmodel"]);
    const an = pickAnim(o.doc, a.anim);
    const pose = samplePose(an, a.t, { wrap: a.wrap });
    const lines = [`${a.anim} @ t=${a.t}s (tick ${r(a.t * 20, 2)}) [${an.semantics ?? "geo"} semantics]`];
    for (const [bone, p] of Object.entries(pose)) {
      if (a.bones && !a.bones.includes(bone)) continue;
      const parts = CHANNELS.filter((c) => p[c]).map((c) => `${c.slice(0, 3)} ${vec(p[c]!)}`);
      if (parts.length) lines.push(`  ${bone}: ${parts.join("  ")}`);
    }
    return text(lines.join("\n"));
  },
};

export const getKeys: ToolDef = {
  name: "get_keys",
  readOnly: true,
  description: "List the keyframes of one clip: time, value, pre, easing/easingArgs, lerp. Filter by bone, channel and time window. Capped at `limit` rows (default 80).",
  shape: { file: z.string(), anim: z.string(), bone: z.string().optional(), channel: z.enum(["rotation", "position", "scale"]).optional(), from: z.number().optional(), to: z.number().optional(), limit: z.number().int().min(1).max(500).optional() },
  async handler(a, ctx) {
    const o = await openDoc(ctx, a.file, ["animation", "bbmodel"]);
    const an = pickAnim(o.doc, a.anim);
    const rows: string[] = [];
    let n = 0;
    for (const [bone, b] of an.bones) {
      if (a.bone && bone !== a.bone) continue;
      for (const ch of CHANNELS) {
        if (a.channel && ch !== a.channel) continue;
        for (const k of sortedKeys(b[ch] ?? { shape: "keys", keys: [] })) {
          if ((a.from !== undefined && k.time < a.from - 1e-6) || (a.to !== undefined && k.time > a.to + 1e-6)) continue;
          n++;
          if (rows.length < (a.limit ?? 80)) rows.push(`${bone}/${ch} t=${r(k.time)} ${vec(k.value)}${k.pre ? " pre " + vec(k.pre) : ""}${k.easing ? " ease=" + k.easing + (k.easingArgs ? "(" + k.easingArgs.join(",") + ")" : "") : ""}${k.lerp ? " lerp=" + k.lerp : ""}`);
        }
      }
    }
    return text(`${n} key(s)${n > rows.length ? ` (showing ${rows.length})` : ""}\n${rows.join("\n")}`);
  },
};

export const validateTool: ToolDef = {
  name: "validate",
  readOnly: true,
  description: "Validate an animation file: generic checks (0.05 s tick grid, >180° rotation steps between keys, unknown bones, keys past length, open loops) plus, for armor files with a pose set, the spidey rules (swing_pivot hinge table, trick/flourish rules, variants, loop/one-shot per pose set). Each line is [E]rror/[W]arning with a fix_id when apply_fix can fix it. Errors only fire for clips named in a pose set unless all_clips=true.",
  shape: { file: z.string(), anim: z.string().optional().describe("Only this clip"), all_clips: z.boolean().optional(), include_warnings: z.boolean().optional().describe("default true"), limit: z.number().int().optional() },
  async handler(a, ctx) {
    const o = await openDoc(ctx, a.file, ["animation"]);
    let ps = await validateDoc(o.path, o.doc, { anim: a.anim, allClips: a.all_clips });
    if (a.include_warnings === false) ps = ps.filter((p) => p.severity === "error");
    const errs = ps.filter((p) => p.severity === "error").length;
    const lim = a.limit ?? 40;
    return text(`${basename(o.path)}${a.anim ? " / " + a.anim : ""}: ${errs} error(s), ${ps.length - errs} warning/info(s)\n${ps.slice(0, lim).map(fmtProblem).join("\n")}${ps.length > lim ? `\n… ${ps.length - lim} more (use anim= or limit=)` : ""}`);
  },
};

export const discoverTools: ToolDef[] = [listAssets, describeModel, describeAnimation, findPreviewModel, listPoseSets, clipInfoTool, samplePoseTool, getKeys, validateTool];
