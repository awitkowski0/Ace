/**
 * Thematic pose sets (`assets/<ns>/poses/*.json`): how the limb driver poses a body on a web line and
 * what each web clip is for. Keys starting with `_` (comments) are ignored.
 */

export interface PoseMode {
  mode: string;
  /** Game state name (`line`, `wall_running`, `airborne`, …). */
  when: string;
  clip?: string;
  right?: string;
  left?: string;
  cling?: string;
  startsWith?: string;
  ticks?: number;
}
export interface PoseSpin {
  axis: string;
  turns: number;
  ticks: number;
}
export type Playback = "loop" | "one_shot" | "stride" | "whole" | (string & {});
export interface PoseClip {
  name: string;
  role?: string;
  timeline?: string;
  playback?: Playback;
  /** Limbs whose pitch/yaw the game overrides (`right_arm`, `left_arm`, …). */
  aimed: string[];
  mirrored: boolean;
  spin?: PoseSpin;
}
export interface PoseSet {
  /** File stem (`web`). */
  name: string;
  path?: string;
  isDefault: boolean;
  modes: PoseMode[];
  clips: Record<string, PoseClip>;
  /** Problems found while parsing (bad shape), not validator output. */
  errors: string[];
}

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

export function parsePoseSet(text: string, name = "", path?: string): PoseSet {
  const out: PoseSet = { name, path, isDefault: false, modes: [], clips: {}, errors: [] };
  let j: unknown;
  try {
    j = JSON.parse(text);
  } catch (e) {
    out.errors.push("invalid JSON: " + (e as Error).message);
    return out;
  }
  if (!j || typeof j !== "object" || Array.isArray(j)) {
    out.errors.push("pose set must be an object");
    return out;
  }
  const o = j as Record<string, unknown>;
  out.isDefault = o.default === true;
  if (Array.isArray(o.modes)) {
    o.modes.forEach((m, i) => {
      if (!m || typeof m !== "object") {
        out.errors.push(`modes[${i}] is not an object`);
        return;
      }
      const r = m as Record<string, unknown>;
      const mode = str(r.mode);
      const when = str(r.when);
      if (!mode || !when) {
        out.errors.push(`modes[${i}] needs "mode" and "when"`);
        return;
      }
      out.modes.push({
        mode, when,
        clip: str(r.clip), right: str(r.right), left: str(r.left), cling: str(r.cling),
        startsWith: str(r.starts_with),
        ticks: typeof r.ticks === "number" ? r.ticks : undefined,
      });
    });
  }
  if (o.clips && typeof o.clips === "object") {
    for (const [cn, cv] of Object.entries(o.clips as Record<string, unknown>)) {
      if (cn.startsWith("_") || !cv || typeof cv !== "object") continue;
      const r = cv as Record<string, unknown>;
      let spin: PoseSpin | undefined;
      if (r.spin && typeof r.spin === "object") {
        const s = r.spin as Record<string, unknown>;
        spin = { axis: str(s.axis) ?? "", turns: typeof s.turns === "number" ? s.turns : 1, ticks: typeof s.ticks === "number" ? s.ticks : 0 };
      }
      out.clips[cn] = {
        name: cn,
        role: str(r.role),
        timeline: str(r.timeline),
        playback: str(r.playback),
        aimed: Array.isArray(r.aimed) ? r.aimed.filter((x): x is string => typeof x === "string") : [],
        mirrored: r.mirrored === true,
        spin,
      };
    }
  }
  return out;
}

/** Game states (`when`) whose mode names this clip (as clip/right/left/cling). */
export function usedByStates(set: PoseSet, clip: string): string[] {
  const s = new Set<string>();
  for (const m of set.modes) if (m.clip === clip || m.right === clip || m.left === clip || m.cling === clip) s.add(m.when);
  return [...s];
}
/** Every clip name the modes reference. */
export function modeClipNames(set: PoseSet): string[] {
  const s = new Set<string>();
  for (const m of set.modes) for (const c of [m.clip, m.right, m.left, m.cling]) if (c) s.add(c);
  return [...s];
}
