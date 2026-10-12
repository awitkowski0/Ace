/** Clip metadata for the Studio's clip list badges (role, playback, used-by-states, mirrored, pose-only…). */
import type { Animation } from "../format/animation";
import { modeClipNames, usedByStates, type PoseClip, type PoseSet, type PoseSpin } from "./poseSet";
import { crawlClipNames, playbackKind, positionUse, type PlaybackKind, type PositionUse, type StrideGait } from "./game";

/**
 * Clips the limb driver reads by name that no ability broadcasts (from WebSlingAnimationsJsonTest.POSE_ONLY).
 * For other pose sets we fall back to the mode heuristic in `isPoseOnly`.
 */
export const KNOWN_POSE_ONLY: ReadonlySet<string> = new Set([
  "web_land", "web_hook", "web_hang", "web_run", "web_wall_run", "web_perch_right", "web_perch_left", "web_perch_back",
  "web_wall_slide_right", "web_wall_slide_left", "web_ceiling_crawl", "web_ceiling_still",
]);
/** Modes the limb driver animates by itself (no broadcast). `climb`/`swing`/`zip`… are broadcast by abilities. */
const POSE_ONLY_MODES = new Set(["land", "hang", "run", "hook", "wall"]);
/** Clips known to be broadcast (WebSlingAnimationsJsonTest LOOPS/ONE_SHOTS/TRICKS). */
const KNOWN_BROADCAST = new Set([
  "web_sling_right", "web_sling_left", "web_zip", "web_air", "web_slingshot", "web_climb", "web_shoot_right", "web_shoot_left", "web_spin", "web_kickoff",
  "web_flip_front", "web_flip_back", "web_twist_left", "web_twist_right", "web_cling",
]);
/**
 * Extra game uses of a clip that no pose-set mode lists (shown in the badges). From the code, 2026-10:
 * a hard slingshot launch plays the swing's front trick clip itself (TrickInput.java:277, TetherClient.java:996/1088).
 */
export const EXTRA_USES: Readonly<Record<string, string[]>> = {
  web_flip_front: ["slingshot hard launch (draw > 0.85)"],
};
export const KIND_LABEL: Readonly<Record<PlaybackKind, string>> = { drawn: "plays as drawn", pose: "pose-set clip", stride: "stride clip" };
export const KIND_TIP: Readonly<Record<PlaybackKind, string>> = {
  drawn: "The animation system plays this clip exactly as drawn: rotations and positions. The limb driver stays out of it.",
  pose: "A pose-set clip: rotations as drawn, but an aimed limb's pitch and yaw are pointed at the web anchor live (only its roll is yours). Position keys are only read where the Positions badge says so. swing_pivot Y is the height the whole model turns about.",
  stride: "Walked by distance, not time: one clip length per stride. Use the speed slider to preview the pace.",
};

/** `web_flip_front_2` -> base `web_flip_front` when the base exists (mirrors ClipVariants.base). */
export function variantBase(name: string, names: ReadonlySet<string>): string {
  const m = /^(.*)_([1-9])$/.exec(name);
  return m && names.has(m[1]) ? m[1] : name;
}

export interface ClipInfo {
  name: string;
  /** Base clip name (same as `name` unless this is an `_N` variant). */
  base: string;
  variantIndex?: number;
  role?: string;
  timeline?: string;
  playback?: string;
  /** Game states (`when`) that use this clip. */
  usedByStates: string[];
  /** Mode names of those uses. */
  usedByModes: string[];
  mirrored: boolean;
  aimed: string[];
  spin?: PoseSpin;
  /** The pose set lists this clip in its `clips` table or a mode. */
  inPoseSet: boolean;
  /** Used only through the limb driver (not broadcast). */
  poseOnly: boolean;
  poseSet?: string;
  /** How the game plays it: drawn / pose-set clip / stride (derived from the pose set's `playback`). */
  kind: PlaybackKind;
  kindLabel: string;
  /** How position keys reach the model (playback / limb driver (wall crawl) / ignored). */
  positions: PositionUse;
  /** For stride clips: what walks the phase ("gait" = CrawlGait distance, "walk" = vanilla's walk cycle). */
  strideGait?: StrideGait;
  /** Other game uses not listed in a mode (e.g. the slingshot's hard-launch flip). */
  extraUses: string[];
}

export function isPoseOnly(set: PoseSet | undefined, base: string): boolean {
  if (KNOWN_POSE_ONLY.has(base)) return true;
  if (KNOWN_BROADCAST.has(base) || !set) return false;
  const modes = set.modes.filter((m) => [m.clip, m.right, m.left, m.cling].includes(base));
  return modes.length > 0 && modes.every((m) => POSE_ONLY_MODES.has(m.mode));
}

export function clipInfos(anims: readonly Animation[], sets: readonly PoseSet[]): Map<string, ClipInfo> {
  const names = new Set(anims.map((a) => a.name));
  const out = new Map<string, ClipInfo>();
  for (const a of anims) {
    const base = variantBase(a.name, names);
    const set = sets.find((s) => s.clips[base] || modeClipNames(s).includes(base));
    const c: PoseClip | undefined = set?.clips[base];
    const inSet = !!set && (!!c || modeClipNames(set).includes(base));
    const isCrawl = crawlClipNames(set).has(base);
    const poseOnly = !!set && (isPoseOnly(set, base) || isCrawl);
    const args = { inPoseSet: inSet, playback: c?.playback, broadcast: !poseOnly, isCrawl };
    const kind = playbackKind(args);
    out.set(a.name, {
      name: a.name,
      base,
      variantIndex: base !== a.name ? Number(a.name.slice(-1)) : undefined,
      role: c?.role,
      timeline: c?.timeline,
      playback: c?.playback,
      usedByStates: set ? usedByStates(set, base) : [],
      usedByModes: set ? [...new Set(set.modes.filter((m) => [m.clip, m.right, m.left, m.cling].includes(base)).map((m) => m.mode))] : [],
      mirrored: c?.mirrored ?? false,
      aimed: c?.aimed ?? [],
      spin: c?.spin,
      inPoseSet: inSet,
      poseOnly,
      poseSet: set?.name,
      kind,
      kindLabel: KIND_LABEL[kind],
      positions: positionUse(args),
      strideGait: kind === "stride" ? (isCrawl ? "gait" : "walk") : undefined,
      extraUses: EXTRA_USES[base] ?? [],
    });
  }
  return out;
}

/** Bones the limb driver reads: rotation of these, plus `swing_pivot` position Y. */
export const LIMB_DRIVER_BONES: readonly string[] = ["armorHead", "armorRightArm", "armorLeftArm", "armorRightLeg", "armorLeftLeg"];
/**
 * True when the limb driver itself reads a channel (rotations of the five limbs, `swing_pivot` position Y). Anything else only reaches the
 * model through playerAnimator playback, which plays drawn and broadcast clips but NOT pose-only ones.
 */
export function isChannelDriverRead(bone: string, channel: string): boolean {
  if (channel === "rotation") return LIMB_DRIVER_BONES.includes(bone);
  return bone === "swing_pivot" && channel === "position";
}
export const AIMED_TIP = "Code-driven pitch/yaw: in game this limb is pointed at the web anchor live, so only its roll (Z) is yours.";
export const IGNORED_TIP = "Ignored in game: nothing plays this clip's position keys (the limb driver reads rotations only here).";
export interface ChannelUse {
  /** Greyed in the dope sheet / graph. */
  dim: boolean;
  /** pitch + yaw of this rotation channel are overridden by live aim. */
  aimedXY: boolean;
  tip?: string;
}
/**
 * How the game uses one channel of one clip. Without clip info (not a Thematic file) nothing is dimmed.
 *  - drawn clips and broadcast pose clips: every channel reaches the model (playback), aimed limbs lose pitch/yaw.
 *  - pose-only clips: only limb rotations, swing_pivot Y and (wall crawl) limb positions are read.
 */
export function channelUse(info: ClipInfo | undefined, bone: string, channel: string): ChannelUse {
  if (!info || !info.inPoseSet) return { dim: false, aimedXY: false };
  const aimed = channel === "rotation" && info.aimed.some((a) => AIMED_BONE[a] === bone);
  let dim = false;
  let tip: string | undefined;
  if (aimed) tip = AIMED_TIP;
  if (info.kind !== "drawn" && info.poseOnly) {
    const crawlPos = info.positions === "limb-driver" && channel === "position" && LIMB_DRIVER_BONES.includes(bone) && bone !== "armorHead";
    if (!isChannelDriverRead(bone, channel) && !crawlPos) {
      dim = true;
      tip = channel === "position" ? IGNORED_TIP : "Not read in game: the limb driver poses the five limbs' rotations and swing_pivot Y" + (info.positions === "limb-driver" ? " (plus the limbs' positions in the wall crawl)." : ".");
    }
  }
  return { dim, aimedXY: aimed, tip };
}
/** `aimed` entries use `right_arm` style; map to the animation bone. */
export const AIMED_BONE: Readonly<Record<string, string>> = {
  head: "armorHead", right_arm: "armorRightArm", left_arm: "armorLeftArm", right_leg: "armorRightLeg", left_leg: "armorLeftLeg",
};
