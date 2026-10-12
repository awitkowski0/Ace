/** Flight-profile helpers that need the file system: the poses a profile inherits, and opening a profile by id. */
import { openFile } from "../../../editor/store";
import { abilityName, nsOf } from "../core/suit";
import { findByName, readText, resourceRoots } from "./resolve";

/** The `poses` object of each profile up the `parent` chain, nearest first (undefined where a profile has none). */
export async function loadPoseChain(host: string, roots: string[], parentId: string | undefined): Promise<Array<Record<string, unknown> | undefined>> {
  const out: Array<Record<string, unknown> | undefined> = [];
  const seen = new Set<string>();
  for (let cur = parentId; cur && !seen.has(cur) && out.length < 8;) {
    seen.add(cur);
    const path = await findByName(host, roots, nsOf(cur), "flight_profiles", [abilityName(cur) + ".json"], 3);
    if (!path) break;
    let raw: Record<string, unknown> | null = null;
    try { raw = JSON.parse((await readText(host, path)) ?? "null"); } catch { raw = null; }
    out.push((raw?.poses ?? undefined) as Record<string, unknown> | undefined);
    cur = typeof raw?.parent === "string" ? raw.parent : undefined;
  }
  return out;
}

/**
 * Open flight profile `id` (e.g. `thematic:repulsor`, a suit's `flight_profile`) in its designer. `fromPath` is any pack file of
 * the same project (the suit being edited); the profile is looked up in that project's resource roots. Resolves false when
 * no such profile is found.
 */
export async function openFlightProfile(host: string, fromPath: string, id: string): Promise<boolean> {
  const roots = await resourceRoots(host, fromPath);
  const path = await findByName(host, roots, nsOf(id), "flight_profiles", [abilityName(id) + ".json"], 3);
  if (!path) return false;
  void openFile({ host, path });
  return true;
}
