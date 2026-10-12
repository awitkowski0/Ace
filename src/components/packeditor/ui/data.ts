/** Async loaders shared by the views: a suit's model and texture, ability scripts by id, flight profiles with inheritance. */
import { useEffect, useState } from "react";
import { parseDoc } from "../../animstudio/core";
import { playerRigModel, rigFromGeo, type RigModel } from "../../animstudio/ui/model";
import { loadImage } from "../../animstudio/ui/resolve";
import { abilityName, nsOf } from "../core/suit";
import { findByName, findInRoots, readText } from "./resolve";

export function useAsync<T>(fn: () => Promise<T>, deps: unknown[], initial: T): [T, boolean] {
  const [v, setV] = useState<{ v: T; loading: boolean }>({ v: initial, loading: true });
  useEffect(() => {
    let dead = false;
    setV((s) => ({ ...s, loading: true }));
    fn().then((x) => { if (!dead) setV({ v: x, loading: false }); }, () => { if (!dead) setV({ v: initial, loading: false }); });
    return () => { dead = true; };
  }, deps); // eslint-disable-line react-hooks/exhaustive-deps
  return [v.v, v.loading];
}

export interface SuitModel { rig: RigModel; texture: HTMLImageElement | null; geoPath: string | null; texPath: string | null }

/** `assets/<ns>/geo/armor/<id>.geo.json` + `textures/armor/<id>.png` (CharacterModel's lookups); the plain player when missing. */
export async function loadSuitModel(host: string, roots: string[], ns: string, id: string): Promise<SuitModel> {
  const geoPath = await findInRoots(host, roots, `assets/${ns}/geo/armor/${id}.geo.json`);
  let rig: RigModel | null = null;
  if (geoPath) {
    const text = await readText(host, geoPath);
    if (text) { try { rig = rigFromGeo(parseDoc(text, "geo")); } catch { rig = null; } }
  }
  const texPath = await findInRoots(host, roots, `assets/${ns}/textures/armor/${id}.png`);
  const texture = texPath ? await loadImage(host, texPath) : null;
  return { rig: rig ?? playerRigModel(), texture: rig ? texture : null, geoPath, texPath };
}

const abilityCache = new Map<string, Promise<string | null>>();
/** The script (or JSON) behind an ability id, searched under data/<ns>/abilities of every root. */
export function abilityPath(host: string, roots: string[], id: string): Promise<string | null> {
  const key = host + ":" + roots[0] + ":" + id;
  let p = abilityCache.get(key);
  if (!p) {
    const name = abilityName(id);
    p = findByName(host, roots, nsOf(id), "abilities", [name + ".js", name + ".json"], 5);
    abilityCache.set(key, p);
  }
  return p;
}

export interface FlightJet { index: number; anchor: string; when?: string; aim?: string; flame?: Record<string, unknown>; raw: Record<string, unknown>; from: string }
export interface Flight { id: string; path: string | null; chain: string[]; jets: FlightJet[]; raw: Record<string, unknown> | null }

/** A flight profile and what it inherits (`parent`): the jets of the nearest profile that declares any. */
export async function loadFlight(host: string, roots: string[], id: string): Promise<Flight> {
  const chain: string[] = [];
  let cur: string | undefined = id;
  let first: { path: string | null; raw: Record<string, unknown> | null } | null = null;
  let jets: FlightJet[] | null = null;
  for (let guard = 0; cur && guard < 8; guard++) {
    const path = await findByName(host, roots, nsOf(cur), "flight_profiles", [abilityName(cur) + ".json"], 3);
    if (!path) break;
    chain.push(path);
    const t = await readText(host, path);
    let raw: Record<string, unknown> | null = null;
    try { raw = t ? JSON.parse(t) : null; } catch { raw = null; }
    if (!first) first = { path, raw };
    const list = (raw?.effects as { jets?: unknown } | undefined)?.jets;
    if (!jets && Array.isArray(list)) {
      jets = list.map((j: Record<string, unknown>, index) => ({
        index, anchor: String(j?.anchor ?? ""), when: j?.when as string | undefined, aim: j?.aim as string | undefined,
        flame: j?.flame as Record<string, unknown> | undefined, raw: j ?? {}, from: path,
      }));
    }
    cur = typeof raw?.parent === "string" ? raw.parent : undefined;
  }
  return { id, path: first?.path ?? null, chain, jets: jets ?? [], raw: first?.raw ?? null };
}

/** `flight_type` shorthand -> the shipped profile of that name. */
export const flightIdOf = (profile: string | undefined, type: string | undefined) =>
  profile ?? (type ? "thematic:" + type.toLowerCase() : "thematic:no_hands");
