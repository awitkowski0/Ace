/**
 * Spidey-aware validators, mirroring WebSlingAnimationsJsonTest (Thematic-Collections-spidey) plus the pose-set
 * cross-checks of PoseSetTest. Each problem may carry a quick-fix that is a pure doc command.
 */
import { CHANNELS, animLength, sortedKeys, type Animation, type ChannelName, type Keyframe, type NumVec3 } from "../format/animation";
import { addKeyframe, deleteKeyframes, getAnimations, snapKeysToTicks, type Doc } from "../doc";
import { isArmorBone, canonicalBone } from "../rig";
import { sampleChannelRaw } from "../sample";
import { modeClipNames, type PoseSet } from "./poseSet";
import { clipInfos, variantBase } from "./clips";

export type Severity = "error" | "warning" | "info";
export interface QuickFix {
  title: string;
  apply: (doc: Doc) => Doc;
}
export interface Problem {
  severity: Severity;
  /** Stable rule id, e.g. `off-grid`. */
  code: string;
  anim: string;
  bone?: string;
  channel?: ChannelName;
  time?: number;
  message: string;
  fix?: QuickFix;
}

/** Tolerance used by the Java test. */
export const TOLERANCE = 1e-3;
const DEFAULT_PIVOT = 0.9;

/** Expected swing_pivot hinge (blocks) per clip, from the spec / Java test; variants use their base. */
export const HINGE_BLOCKS: Readonly<Record<string, number>> = {
  web_climb: 0.0,
  web_crawl: 1.3,
  web_cling: 1.3,
  web_wall_hold: 1.3,
  web_hook: 1.3,
  web_wall_run: 0.15,
  web_perch_back: 0.7,
};
/** swing_pivot Y (px) that gives the expected hinge. */
export function expectedPivotY(base: string): number {
  return Math.round(((HINGE_BLOCKS[base] ?? DEFAULT_PIVOT) - DEFAULT_PIVOT) * 16 * 1000) / 1000;
}

/** Trick table: clip -> ticks. */
export const TABLE_TRICKS: Readonly<Record<string, number>> = {
  web_tuck: 10,
  web_cartwheel_left: 14, web_cartwheel_right: 14,
  web_corkscrew_left: 18, web_corkscrew_right: 18,
  web_twist_dive_left: 18, web_twist_dive_right: 18,
};
export const TRICK_TICKS = 14;
export const TRICKS = ["web_flip_front", "web_flip_back", "web_twist_left", "web_twist_right"];
export const FLOURISHES = ["web_air_dive", "web_air_spread", "web_air_tuck"];
export const LOOP_CLIPS = ["web_sling_right", "web_sling_left", "web_zip", "web_air", "web_slingshot", "web_climb"];
export const ONE_SHOT_CLIPS = ["web_shoot_right", "web_shoot_left", "web_spin", "web_kickoff"];
export const POSE_ONLY_CLIPS = ["web_land", "web_hook", "web_hang", "web_run", "web_wall_run", "web_perch_right", "web_perch_left", "web_perch_back", "web_wall_slide_right", "web_wall_slide_left", "web_ceiling_crawl", "web_ceiling_still"];
export const VOLLEY_TICKS = 22;
const LIMBS = ["armorRightArm", "armorLeftArm", "armorRightLeg", "armorLeftLeg"];
const ALLOWED_EXTRA_BONES = new Set(["swing_pivot"]);

const KEYS = (a: Animation, bone: string, ch: ChannelName): Keyframe[] => {
  const c = a.bones.get(bone)?.[ch];
  return c ? sortedKeys(c) : [];
};
const num = (k: Keyframe): NumVec3 | undefined => (k.value.every((v) => typeof v === "number") ? (k.value as NumVec3) : undefined);
const near = (a: number, b: number) => Math.abs(a - b) <= TOLERANCE;
const loops = (a: Animation) => a.loop === true;
const atTime = (ks: Keyframe[], t: number) => ks.find((k) => near(k.time, t));
const fmt = (v: NumVec3 | undefined) => (v ? `[${v.map((x) => Math.round(x * 1000) / 1000).join(", ")}]` : "?");

export interface ValidateOptions {
  /** Treat every clip as in scope (default: only clips named by a pose set, plus their `_N` variants). */
  allClips?: boolean;
}

/** Run all validators on an animation document against the pose sets found for it. */
export function validateSpidey(doc: Doc, sets: readonly PoseSet[], opts: ValidateOptions = {}): Problem[] {
  const anims = getAnimations(doc);
  const names = new Set(anims.map((a) => a.name));
  const byName = new Map(anims.map((a) => [a.name, a]));
  const problems: Problem[] = [];
  const add = (p: Problem) => problems.push(p);

  const tableNames = new Set<string>();
  for (const s of sets) for (const n of [...Object.keys(s.clips), ...modeClipNames(s)]) tableNames.add(n);
  const relevant = sets.filter((s) => [...Object.keys(s.clips), ...modeClipNames(s)].some((n) => names.has(n)));
  // WebSlingAnimationsJsonTest checks EVERY clip of the web file (grid, wraps, loop closure, hinge); other files only the clips a pose set names
  const kitFile = relevant.some((s) => Object.keys(s.clips).filter((n) => names.has(n)).length >= 5);
  const inScope = (a: Animation) => opts.allClips || kitFile || tableNames.has(variantBase(a.name, names)) || tableNames.has(a.name);
  const infos = clipInfos(anims, relevant);
  const air = byName.get("web_air");

  for (const a of anims) {
    const scoped = inScope(a);
    const sev: Severity = scoped ? "error" : "warning";
    const len = animLength(a);

    // ---- generic: tick grid, key past length, 180 steps, unknown bones
    if (a.length !== undefined && Math.abs(Math.round(a.length * 20) / 20 - a.length) > TOLERANCE) {
      add({ severity: sev, code: "length-off-grid", anim: a.name, message: `animation_length ${a.length} is off the 0.05s grid`, fix: snapFix(a.name) });
    }
    for (const [bone, b] of a.bones) {
      if (!isArmorBone(bone) && !ALLOWED_EXTRA_BONES.has(bone) && !bone.startsWith("_")) {
        add({ severity: "warning", code: "unknown-bone", anim: a.name, bone, message: `unknown bone "${bone}" (the armor rig has armorHead/Body/RightArm/LeftArm/RightLeg/LeftLeg and swing_pivot)` });
      }
      for (const ch of CHANNELS) {
        const c = b[ch];
        if (!c) continue;
        if (c.shape === "opaque") {
          add({ severity: "warning", code: "opaque-channel", anim: a.name, bone, channel: ch, message: `${bone}/${ch} is not a vector or key map (kept as-is, not previewed)` });
          continue;
        }
        const ks = sortedKeys(c);
        for (const k of ks) {
          if (Math.abs(Math.round(k.time * 20) - k.time * 20) > TOLERANCE) {
            add({ severity: sev, code: "off-grid", anim: a.name, bone, channel: ch, time: k.time, message: `${bone}/${ch} key ${k.time} is off the 0.05s grid`, fix: snapFix(a.name) });
          }
          if (a.length !== undefined && k.time > a.length + TOLERANCE) {
            add({ severity: sev, code: "key-past-length", anim: a.name, bone, channel: ch, time: k.time, message: `${bone}/${ch} key ${k.time} is past animation_length ${a.length}` });
          }
        }
        if (ch === "rotation") {
          for (let i = 1; i < ks.length; i++) {
            const p = num(ks[i - 1]);
            const q = num(ks[i]);
            if (!p || !q) continue;
            for (let ax = 0; ax < 3; ax++) {
              if (Math.abs(q[ax] - p[ax]) > 180) {
                add({ severity: sev, code: "rotation-wrap", anim: a.name, bone, channel: ch, time: ks[i].time, message: `${bone} rotation steps ${Math.round(Math.abs(q[ax] - p[ax]) * 100) / 100}° on axis ${"XYZ"[ax]} between ${ks[i - 1].time} and ${ks[i].time} (euler wrap or sign error)` });
                break;
              }
            }
          }
        }
      }
    }
    if (!scoped) continue;

    // ---- loops close on themselves
    if (loops(a)) {
      for (const [bone, b] of a.bones) {
        for (const ch of CHANNELS) {
          const ks = b[ch] ? sortedKeys(b[ch]!) : [];
          if (ks.length < 2) continue;
          const first = atTime(ks, 0);
          const last = atTime(ks, len);
          if (!first || !last) {
            add({ severity: "error", code: "loop-open", anim: a.name, bone, channel: ch, time: len, message: `${bone}/${ch} loop needs keys at 0 and ${len}`, fix: first && !last ? { title: `Copy first key to ${len}`, apply: (d) => addKeyframe(d, { anim: a.name, bone, channel: ch, time: len, value: first.value }) } : undefined });
            continue;
          }
          const f = num(first);
          const l = num(last);
          if (f && l && f.some((v, i) => !near(v, l[i]))) {
            add({ severity: "error", code: "loop-open", anim: a.name, bone, channel: ch, time: len, message: `${bone}/${ch} does not close: ${fmt(f)} at 0 vs ${fmt(l)} at ${len}`, fix: { title: `Copy first key to ${len}`, apply: (d) => addKeyframe(d, { anim: a.name, bone, channel: ch, time: len, value: first.value }) } });
          }
        }
      }
    }

    // ---- swing_pivot hinge
    const base = variantBase(a.name, names);
    const sp = a.bones.get("swing_pivot")?.position;
    const spKeys = sp ? sortedKeys(sp) : [];
    const k0 = atTime(spKeys, 0);
    const wantY = expectedPivotY(base);
    if (!k0) {
      add({ severity: "error", code: "no-swing-pivot", anim: a.name, bone: "swing_pivot", channel: "position", time: 0, message: `${a.name} has no swing_pivot position key at t=0 (expected Y ${wantY} for hinge ${HINGE_BLOCKS[base] ?? DEFAULT_PIVOT})`, fix: { title: "Add swing_pivot key", apply: (d) => addKeyframe(d, { anim: a.name, bone: "swing_pivot", channel: "position", time: 0, value: [0, wantY, 0] }) } });
    } else {
      const v = num(k0);
      if (v) {
        const hinge = DEFAULT_PIVOT + v[1] / 16;
        const expected = HINGE_BLOCKS[base] ?? DEFAULT_PIVOT;
        if (!near(hinge, expected)) {
          add({ severity: "error", code: "wrong-hinge", anim: a.name, bone: "swing_pivot", channel: "position", time: 0, message: `${a.name} hinges at ${Math.round(hinge * 1000) / 1000} blocks, expected ${expected} (swing_pivot Y ${wantY})`, fix: { title: `Set swing_pivot Y to ${wantY}`, apply: (d) => addKeyframe(d, { anim: a.name, bone: "swing_pivot", channel: "position", time: 0, value: [v[0], wantY, v[2]] }) } });
        }
      }
    }

    // ---- variants match their base
    if (base !== a.name) {
      const b = byName.get(base)!;
      const bl = animLength(b);
      if (!near(bl, len)) add({ severity: "error", code: "variant-length", anim: a.name, message: `${a.name} must be the same length as ${base} (${len} vs ${bl}) - it plays in its place` });
      if (loops(b) !== loops(a)) add({ severity: "error", code: "variant-loop", anim: a.name, message: `${a.name} must loop the same way ${base} does` });
      const n = Number(a.name.slice(-1));
      for (let i = 1; i < n; i++) {
        if (!names.has(`${base}_${i}`)) add({ severity: "error", code: "variant-gap", anim: a.name, message: `${a.name} is unreachable: ${base}_${i} is missing (variants must be consecutive)` });
      }
    } else {
      // an _N that is not consecutive from the base would be treated as an unrelated clip; flag orphan gaps
      for (let i = 2; i <= 9; i++) if (names.has(`${a.name}_${i}`) && !names.has(`${a.name}_${i - 1}`)) add({ severity: "error", code: "variant-gap", anim: `${a.name}_${i}`, message: `${a.name}_${i} is unreachable: ${a.name}_${i - 1} is missing (variants must be consecutive)` });
    }

    // ---- table tricks, tricks, flourishes (by base name)
    const tick = TABLE_TRICKS[base];
    if (tick !== undefined || TRICKS.includes(base)) {
      const want = tick ?? TRICK_TICKS;
      if (loops(a)) add({ severity: "error", code: "trick-loops", anim: a.name, message: `${a.name} should play once` });
      if (Math.round(len * 20) !== want) add({ severity: "error", code: "trick-length", anim: a.name, message: `${a.name} should last ${want} ticks (${want / 20}s), is ${Math.round(len * 20)} ticks`, fix: undefined });
    }
    if (tick !== undefined) {
      if (a.bones.has("armorBody")) add({ severity: "error", code: "trick-body", anim: a.name, bone: "armorBody", message: `${a.name} leaves the trunk to the whole-body spin: remove armorBody` });
      for (const bone of [...LIMBS, "armorHead"]) {
        const ks = KEYS(a, bone, "rotation");
        const ref: NumVec3 | undefined = bone === "armorHead" ? [0, 0, 0] : air ? airFirst(air, bone) : undefined;
        for (const t of [0, len]) {
          const k = atTime(ks, t);
          if (!k) {
            add({ severity: "warning", code: "trick-ends", anim: a.name, bone, channel: "rotation", time: t, message: `${a.name}/${bone} needs a rotation key at ${t}`, fix: ref ? copyAirFix(a.name, bone, t, ref) : undefined });
            continue;
          }
          const v = num(k);
          if (v && ref && v.some((x, i) => !near(x, ref[i]))) {
            add({ severity: "warning", code: "trick-ends", anim: a.name, bone, channel: "rotation", time: t, message: `${a.name}/${bone} should meet ${bone === "armorHead" ? "zero" : "web_air t=0"} at ${t}: ${fmt(ref)}, is ${fmt(v)}`, fix: copyAirFix(a.name, bone, t, ref) });
          }
        }
      }
    }
    if (FLOURISHES.includes(base)) {
      if (loops(a)) add({ severity: "error", code: "trick-loops", anim: a.name, message: `${a.name} should play once` });
      for (const bone of ["armorBody", ...LIMBS]) {
        const ks = KEYS(a, bone, "rotation");
        if (!air) break;
        const ref = airFirst(air, bone);
        if (!ref) continue;
        const ends = ks.length ? [ks[0], ks[ks.length - 1]] : [];
        if (!ends.length) {
          add({ severity: "warning", code: "flourish-ends", anim: a.name, bone, channel: "rotation", message: `${a.name} has no ${bone} rotation keys: it must start and end on web_air's first frame`, fix: copyAirFix(a.name, bone, 0, ref, len) });
          continue;
        }
        for (const k of ends) {
          const v = num(k);
          if (v && v.some((x, i) => !near(x, ref[i]))) {
            add({ severity: "warning", code: "flourish-ends", anim: a.name, bone, channel: "rotation", time: k.time, message: `${a.name}/${bone} should meet web_air at its ends: ${fmt(ref)}, is ${fmt(v)} at ${k.time}`, fix: copyAirFix(a.name, bone, k.time, ref) });
          }
        }
      }
    }

    // ---- playback consistency with the pose set
    for (const s of relevant) {
      const pb = s.clips[base]?.playback;
      if (pb === "loop" && !loops(a)) add({ severity: "error", code: "playback-loop", anim: a.name, message: `${a.name} is a loop clip in pose set "${s.name}" but its loop is ${String(a.loop)}` });
      if ((pb === "one_shot" || pb === "whole") && loops(a)) add({ severity: "error", code: "playback-once", anim: a.name, message: `${a.name} is "${pb}" in pose set "${s.name}" but loops` });
    }

    // ---- position keys the game never plays (pose-only pose-set clips; the wall crawl reads limb positions but not head / body)
    const info = infos.get(a.name);
    if (info && info.inPoseSet && info.kind !== "drawn" && info.poseOnly) {
      const ignoredBones: string[] = [];
      const refs: Array<{ bone: string; channel: "position"; time: number }> = [];
      for (const [bone, b] of a.bones) {
        if (!b.position || b.position.shape === "opaque" || bone === "swing_pivot") continue;
        const limb = LIMBS.includes(bone);
        if (info.positions === "limb-driver" && limb) continue;
        const ks = sortedKeys(b.position);
        if (!ks.length) continue;
        ignoredBones.push(bone);
        for (const k of ks) refs.push({ bone, channel: "position", time: k.time });
      }
      if (refs.length) {
        const why = info.positions === "limb-driver" ? "the wall crawl plays the four limbs' positions but not the head's or body's" : "nothing plays this pose-only clip's positions (the limb driver reads rotations and swing_pivot Y only)";
        add({
          severity: "warning", code: "position-ignored", anim: a.name, bone: refs[0].bone, channel: "position", time: refs[0].time,
          message: `${a.name}: position keys on ${ignoredBones.join(", ")} are ignored in game: ${why}`,
          fix: { title: "Remove ignored position keys", apply: (d) => deleteKeyframes(d, { anim: a.name, keys: refs }) },
        });
      }
    }

    // ---- Java-test specifics for the web kit
    if (LOOP_CLIPS.includes(base)) {
      if (!a.bones.get("armorHead")?.rotation) add({ severity: "error", code: "head-rest", anim: a.name, bone: "armorHead", channel: "rotation", message: `${a.name} does not draw armorHead (it must rest at zero: the head is left to the procedural counter-pitch)` });
      for (const k of KEYS(a, "armorHead", "rotation")) {
        const v = num(k);
        if (v && v.some((x) => !near(x, 0))) add({ severity: "error", code: "head-rest", anim: a.name, bone: "armorHead", channel: "rotation", time: k.time, message: `${a.name}/armorHead must rest at zero (the head is left to the procedural counter-pitch)` });
      }
    }
    const raised: Record<string, string[]> = { web_sling_right: ["armorRightArm"], web_sling_left: ["armorLeftArm"], web_zip: ["armorRightArm", "armorLeftArm"] };
    for (const bone of raised[base] ?? []) {
      const k = atTime(KEYS(a, bone, "rotation"), 0);
      const v = k && num(k);
      if (!v || !(v[0] < -120)) add({ severity: "error", code: "arm-raised", anim: a.name, bone, channel: "rotation", time: 0, message: `${a.name}/${bone} should be raised up the line (pitch below -120), got ${fmt(v || undefined)}` });
    }
    if (base === "web_spin" && len * 20 < VOLLEY_TICKS - TOLERANCE) add({ severity: "error", code: "spin-short", anim: a.name, message: `web_spin must outlast the ${VOLLEY_TICKS}-tick volley` });
    if (base === "web_wall_hold") {
      for (const bone of LIMBS) {
        const arm = bone.includes("Arm");
        for (const k of KEYS(a, bone, "rotation")) {
          const v = num(k);
          if (!v) continue;
          if (!(arm ? v[0] < -120 : Math.abs(v[0]) < 30)) add({ severity: "error", code: "hold-upright", anim: a.name, bone, channel: "rotation", time: k.time, message: `${bone} pitch ${v[0]} breaks the upright hold` });
          if (!(Math.abs(v[2]) < (arm ? 15 : 25))) add({ severity: "error", code: "hold-upright", anim: a.name, bone, channel: "rotation", time: k.time, message: `${bone} roll ${v[2]} splays the hold` });
        }
      }
    }
  }

  // ---- pose set <-> file
  for (const s of relevant) {
    for (const n of modeClipNames(s)) {
      if (!names.has(n)) add({ severity: "error", code: "missing-clip", anim: n, message: `pose set "${s.name}" names clip "${n}" which is not in this file` });
      else if (!s.clips[n]) add({ severity: "warning", code: "no-table-entry", anim: n, message: `pose set "${s.name}" uses "${n}" but has no entry for it in "clips"` });
    }
    for (const n of Object.keys(s.clips)) {
      if (!names.has(n)) add({ severity: "error", code: "missing-clip", anim: n, message: `pose set "${s.name}" lists clip "${n}" which is not in this file` });
    }
    for (const e of s.errors) add({ severity: "warning", code: "pose-set", anim: "", message: `pose set "${s.name}": ${e}` });
    if (s.name === "web") {
      for (const n of [...LOOP_CLIPS, ...ONE_SHOT_CLIPS, ...TRICKS, ...POSE_ONLY_CLIPS, ...FLOURISHES, ...Object.keys(TABLE_TRICKS)]) {
        if (!names.has(n)) add({ severity: "error", code: "missing-clip", anim: n, message: `the web kit expects clip "${n}"` });
      }
      for (const n of LOOP_CLIPS) if (byName.has(n) && !loops(byName.get(n)!)) add({ severity: "error", code: "should-loop", anim: n, message: `${n} should loop` });
      for (const n of [...ONE_SHOT_CLIPS, ...TRICKS]) if (byName.has(n) && loops(byName.get(n)!)) add({ severity: "error", code: "should-play-once", anim: n, message: `${n} should play once` });
    }
  }
  return dedupe(problems);
}

function dedupe(ps: Problem[]): Problem[] {
  const seen = new Set<string>();
  return ps.filter((p) => {
    const id = [p.code, p.anim, p.bone, p.channel, p.time, p.message].join("|");
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

const snapFix = (anim: string): QuickFix => ({ title: "Snap keys to ticks", apply: (d) => snapKeysToTicks(d, { anim }) });

function airFirst(air: Animation, bone: string): NumVec3 | undefined {
  const c = air.bones.get(bone)?.rotation;
  return c ? sampleChannelRaw(c, 0) : undefined;
}
function copyAirFix(anim: string, bone: string, time: number, ref: NumVec3, alsoAt?: number): QuickFix {
  return {
    title: "Copy web_air first frame to start/end",
    apply: (d) => {
      let out = addKeyframe(d, { anim, bone, channel: "rotation", time, value: [...ref] });
      if (alsoAt !== undefined) out = addKeyframe(out, { anim, bone, channel: "rotation", time: alsoAt, value: [...ref] });
      return out;
    },
  };
}
export { canonicalBone };
