/** Which pack-editor view a file gets, by where it sits in a resource pack / data pack. */
import { guideKind } from "./guide";

export type PackKind = "suit" | "ability" | "hud" | "flight" | "guide";

export function packKind(path: string): PackKind | null {
  const p = path.replace(/\\/g, "/");
  if (/\/data\/[^/]+\/armors\/.+\.json$/.test(p)) return "suit";
  if (/\/data\/[^/]+\/abilities\/.+\.(js|json)$/.test(p)) return "ability";
  if (/\/data\/[^/]+\/huds\/.+\.(js|json)$/.test(p)) return "hud";
  if (/\/data\/[^/]+\/flight_profiles\/.+\.json$/.test(p)) return "flight";
  if (guideKind(p)) return "guide";
  return null;
}

/** `…/resources` (the folder holding data/ and assets/) and the namespace of a pack file. */
export function packRoot(path: string): { root: string; ns: string; side: "data" | "assets" } | null {
  const p = path.replace(/\\/g, "/");
  const m = /^(.*)\/(data|assets)\/([^/]+)\//.exec(p);
  return m ? { root: m[1], side: m[2] as "data" | "assets", ns: m[3] } : null;
}

/** File name without folders and extension(s): `iron_man.json` -> `iron_man`. */
export const stem = (path: string) => path.replace(/\\/g, "/").split("/").pop()!.replace(/\.(geo|animation)?\.?(json|js)$/, "").replace(/\.$/, "");
