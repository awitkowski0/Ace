import { promises as fsp } from "node:fs";
import { basename, dirname, join } from "node:path";
import { allow } from "./paths";
import { compactDiff } from "./diff";
import { getAnimations, clipSemantics, docKindForPath, parseDoc, serialize, validateSpidey, findPoseSets, isArmorAnimationPath, type Doc, type DocKind, type FsLike, type Problem, type PoseSet, type Animation, type Keyframe, CHANNELS } from "./core";
import { text, UserError, type Ctx, type ToolOutput } from "./types";

export const nodeFs: FsLike = {
  async listDir(p) {
    return (await fsp.readdir(p, { withFileTypes: true })).map((e) => ({ name: e.name, isDir: e.isDirectory() }));
  },
  readFile: (p) => fsp.readFile(p, "utf8"),
};

export interface Opened {
  path: string;
  kind: DocKind;
  text: string;
  doc: Doc;
  /** where the text came from: the file on disk, or the open (possibly unsaved) editor buffer in Ace */
  via: "disk" | "ace";
}

export async function openDoc(ctx: Ctx, file: string, kinds?: DocKind[]): Promise<Opened> {
  const path = allow(ctx.roots, file);
  const kind = docKindForPath(path);
  if (!kind) throw new UserError(`${basename(path)} is not a .geo.json, .animation.json or .bbmodel file`);
  if (kinds && !kinds.includes(kind)) throw new UserError(`This tool needs a ${kinds.join(" / ")} file; ${basename(path)} is ${kind}`);
  let via: "disk" | "ace" = "disk";
  let src: string | undefined;
  if (await ctx.bridge.available()) {
    try {
      const r = await ctx.bridge.call<{ open: boolean; text?: string }>("file_text", { file: path });
      if (r.open && typeof r.text === "string") { src = r.text; via = "ace"; }
    } catch { /* fall back to disk */ }
  }
  if (src === undefined) {
    try { src = await fsp.readFile(path, "utf8"); } catch (e) { throw new UserError(`Cannot read ${path}: ${(e as Error).message}`); }
  }
  let doc: Doc;
  try { doc = parseDoc(src, kind, clipSemantics(path)); } catch (e) { throw new UserError(`${basename(path)} does not parse: ${(e as Error).message}`); }
  return { path, kind, text: src, doc, via };
}

/** Read-only access to the typed animations of a file (throws UserError for a missing animation). */
export function pickAnim(doc: Doc, name: string): Animation {
  const a = getAnimations(doc).find((x) => x.name === name);
  if (!a) {
    const names = getAnimations(doc).map((x) => x.name);
    throw new UserError(`No animation "${name}". Available: ${names.slice(0, 40).join(", ")}${names.length > 40 ? ", …" : ""}`);
  }
  return a;
}

// ---------------------------------------------------------------- validation helpers

const poseCache = new Map<string, { at: number; sets: PoseSet[] }>();
export async function poseSetsFor(path: string): Promise<PoseSet[]> {
  if (!isArmorAnimationPath(path)) return [];
  const hit = poseCache.get(path);
  if (hit && Date.now() - hit.at < 3000) return hit.sets;
  let sets: PoseSet[] = [];
  try { sets = (await findPoseSets(path, nodeFs)).map((f) => f.set); } catch { /* none */ }
  poseCache.set(path, { at: Date.now(), sets });
  return sets;
}

export const fixId = (p: Problem) => [p.code, p.anim, p.bone ?? "", p.channel ?? "", p.time ?? ""].join(":");
export function fmtProblem(p: Problem): string {
  const where = [p.anim, p.bone, p.channel].filter(Boolean).join("/") + (p.time !== undefined ? `@${p.time}` : "");
  return `[${p.severity === "error" ? "E" : p.severity === "warning" ? "W" : "I"}] ${p.code} ${where}: ${p.message}${p.fix ? `  (fix_id: ${fixId(p)} — ${p.fix.title})` : ""}`;
}

export async function validateDoc(path: string, doc: Doc, opts: { anim?: string; allClips?: boolean } = {}): Promise<Problem[]> {
  if (doc.kind !== "animation") return [];
  const sets = await poseSetsFor(path);
  let ps = validateSpidey(doc, sets, { allClips: opts.allClips });
  if (opts.anim) ps = ps.filter((p) => p.anim === opts.anim || p.anim === "");
  return ps;
}

// ---------------------------------------------------------------- change summary

const keySig = (k: Keyframe) => JSON.stringify([k.value, k.pre, k.easing, k.easingArgs, k.lerp]);
/** "web_air: armorLeftArm/rotation +2 ~1 -0; …" — key-level delta for the animations that differ. */
export function keyDelta(before: Doc, after: Doc, only?: string[]): string[] {
  if (before.kind === "geo" || after.kind === "geo") return [];
  const out: string[] = [];
  const A = new Map(getAnimations(before).map((a) => [a.name, a]));
  const B = new Map(getAnimations(after).map((a) => [a.name, a]));
  for (const name of new Set([...A.keys(), ...B.keys()])) {
    if (only && !only.includes(name)) continue;
    const a = A.get(name);
    const b = B.get(name);
    if (!a) { out.push(`${name}: new animation (${countKeys(b!)} keys, length ${b!.length ?? "?"})`); continue; }
    if (!b) { out.push(`${name}: deleted`); continue; }
    const parts: string[] = [];
    if (a.loop !== b.loop) parts.push(`loop ${String(a.loop)}→${String(b.loop)}`);
    if (a.length !== b.length) parts.push(`length ${a.length}→${b.length}`);
    let add = 0, chg = 0, del = 0;
    const per: string[] = [];
    for (const bone of new Set([...a.bones.keys(), ...b.bones.keys()])) {
      for (const ch of CHANNELS) {
        const ka = new Map((a.bones.get(bone)?.[ch]?.keys ?? []).map((k) => [Math.round(k.time * 10000), k]));
        const kb = new Map((b.bones.get(bone)?.[ch]?.keys ?? []).map((k) => [Math.round(k.time * 10000), k]));
        let ad = 0, cg = 0, dl = 0;
        for (const [t, k] of kb) { const o = ka.get(t); if (!o) ad++; else if (keySig(o) !== keySig(k)) cg++; }
        for (const t of ka.keys()) if (!kb.has(t)) dl++;
        if (ad + cg + dl) per.push(`${bone}/${ch} ${[ad && `+${ad}`, cg && `~${cg}`, dl && `-${dl}`].filter(Boolean).join(" ")}`);
        add += ad; chg += cg; del += dl;
      }
    }
    if (add + chg + del) parts.push(`keys +${add} ~${chg} -${del}`);
    if (per.length) parts.push(per.slice(0, 8).join("; ") + (per.length > 8 ? `; … ${per.length - 8} more` : ""));
    if (parts.length) out.push(`${name}: ${parts.join(" | ")}`);
  }
  return out;
}
const countKeys = (a: Animation) => [...a.bones.values()].reduce((n, b) => n + CHANNELS.reduce((m, c) => m + (b[c]?.keys.length ?? 0), 0), 0);

// ---------------------------------------------------------------- committing

export interface CommitOpts {
  label: string;
  dry_run?: boolean;
  /** animations to re-validate after the change (armor files) */
  anims?: string[];
  /** extra lines for the result head */
  note?: string;
}

async function writeAtomic(path: string, data: string) {
  const tmp = join(dirname(path), `.${basename(path)}.ace-mcp-${process.pid}.tmp`);
  let mode: number | undefined;
  try { mode = (await fsp.stat(path)).mode & 0o777; } catch { /* new file */ }
  await fsp.writeFile(tmp, data, { encoding: "utf8", mode });
  await fsp.rename(tmp, path);
}

/** Serialize `next`, report a compact diff, and (unless dry_run) write it — to the open Ace editor when the file is open there, else to disk. */
export async function commit(ctx: Ctx, o: Opened, next: Doc, c: CommitOpts): Promise<ToolOutput> {
  const out = serialize(next);
  const { diff, added, removed } = compactDiff(o.text, out);
  const head: string[] = [];
  const delta = keyDelta(o.doc, next, c.anims);
  if (out === o.text) {
    return text(`${basename(o.path)}: ${c.label} — no change (file already matches).${c.note ? "\n" + c.note : ""}`);
  }
  if (c.dry_run) {
    head.push(`DRY RUN — nothing written. ${basename(o.path)}: ${c.label} (+${added} -${removed} lines)`);
  } else if (o.via === "ace") {
    try {
      await ctx.bridge.call("apply_text", { file: o.path, text: out, label: `Claude: ${c.label}` });
    } catch (e) {
      throw new UserError(`The file is open in Ace but applying the edit failed: ${(e as Error).message}. Nothing was written.`);
    }
    head.push(`Applied to the open Ace editor (unsaved; ⌘Z undoes it, ⌘S saves). ${basename(o.path)}: ${c.label} (+${added} -${removed} lines)`);
  } else {
    let cur: string;
    try { cur = await fsp.readFile(o.path, "utf8"); } catch { cur = o.text; }
    if (cur !== o.text) throw new UserError(`${basename(o.path)} changed on disk while the edit was prepared; nothing written. Re-run the tool.`);
    await writeAtomic(o.path, out);
    head.push(`Wrote ${o.path}: ${c.label} (+${added} -${removed} lines)`);
  }
  if (c.note) head.push(c.note);
  head.push(...delta.map((d) => "  " + d));
  if (next.kind === "animation") {
    const sets = await poseSetsFor(o.path);
    if (sets.length) {
      const names = c.anims ?? [];
      const ps = (await validateDoc(o.path, next)).filter((p) => p.severity !== "info" && (!names.length || names.includes(p.anim)));
      const errs = ps.filter((p) => p.severity === "error");
      if (ps.length) head.push(`validate: ${errs.length} error(s), ${ps.length - errs.length} warning(s)` + (errs.length ? ":\n" + errs.slice(0, 4).map((p) => "  " + fmtProblem(p)).join("\n") : ""));
    }
  }
  head.push(diff);
  return text(head.join("\n"));
}
