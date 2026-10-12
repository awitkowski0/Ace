/**
 * What a project offers a suit: every ability id (a data/<ns>/abilities script or JSON, with its folder and leading comment),
 * the keybinds (lang keys and the ones suits use), stat ids, the values suits use for enums and tags, flight profiles, the
 * suit ids, and the keybind an ability usually gets. Pure: the views feed it the files they read (ui/data.ts), so the tests run
 * on a synthetic tree.
 */

export interface SourceFile { path: string; text: string }

export interface AbilityEntry {
  /** the id a suit names it by: bare for `thematic` (`immunity_fire`), `<ns>:<name>` for any other namespace */
  id: string;
  ns: string;
  /** the file name without folders or extension */
  name: string;
  /** folder under abilities/, `""` at the top */
  folder: string;
  path: string;
  /** the first line of the script's leading comment, when it has one */
  description?: string;
}

export type Counts = Record<string, number>;

export interface Catalog {
  ns: string;
  abilities: AbilityEntry[];
  /** keybind usage per ability id, across the namespace's suits */
  abilityKeybinds: Record<string, Counts>;
  /** every key.thematic.* keybind: lang files and suits, sorted */
  keybinds: string[];
  keybindCount: Counts;
  /** stat identifiers: those suits use, plus the ones the suit docs name */
  stats: Counts;
  /** attribute identifiers (`pehkui:base`, ...) suits use, plus the docs' */
  attributeIds: Counts;
  /** values for the enum-like fields: seen in suits, plus the ones the docs name */
  fightingTypes: string[];
  flightTypes: string[];
  jetGroups: string[];
  tags: string[];
  types: string[];
  /** `<ns>:<name>` for each flight profile in the namespace */
  flightProfiles: string[];
  /** suit ids (file names) in the namespace */
  suits: string[];
}

/** Values the suit docs (docs/addon-format.md) name, offered even when no suit uses them yet. */
export const DOCUMENTED = {
  stats: ["thematic:base_generic_attack", "thematic:base_generic_speed", "thematic:base_defense", "thematic:base_utility"],
  fightingTypes: ["BRAWLER", "DUELIST", "UTILITY", "MAGIC"],
  flightTypes: ["NO_HANDS", "ONE_HAND_LEFT", "ONE_HAND_RIGHT", "BOTH_HANDS", "JETPACK", "WINGED"],
  jetGroups: ["arms", "legs", "both"],
  attributes: ["pehkui:base", "pehkui:reach", "jump_height", "step_height", "motion", "knockback", "health"],
  keybinds: ["key.thematic.ability_0", "key.thematic.ability_1", "key.thematic.ability_2", "key.thematic.ability_3", "key.thematic.ability_4", "key.thematic.ability_5", "key.thematic.ultimate", "key.thematic.utility", "key.thematic.passive", "key.thematic.cosmetic", "key.thematic.equip_item"],
} as const;

const ABILITY_RE = /\/data\/([^/]+)\/abilities\/(?:(.*)\/)?([^/]+)\.(js|json)$/;
const SUIT_RE = /\/data\/([^/]+)\/armors\/.+\.json$/;
const FLIGHT_RE = /\/data\/([^/]+)\/flight_profiles\/(?:.*\/)?([^/]+)\.json$/;
const LANG_RE = /\/assets\/[^/]+\/lang\/en_us\.json$/;

export const abilityId = (ns: string, name: string) => (ns === "thematic" ? name : `${ns}:${name}`);

/** The first line of a script's leading comment: `// Hand Beam` -> `Hand Beam`; a JSON ability's `description`. */
export function leadingComment(src: string): string | undefined {
  const trimmed = src.replace(/^﻿/, "");
  if (trimmed.trimStart().startsWith("{")) {
    try {
      const d = (JSON.parse(trimmed) as { description?: unknown }).description;
      return typeof d === "string" && d.trim() ? d.trim().slice(0, 160) : undefined;
    } catch {
      return undefined;
    }
  }
  for (const raw of trimmed.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "") continue;
    if (!line.startsWith("//")) return undefined;
    const body = line.replace(/^\/\/+/, "").trim();
    if (body) return body.slice(0, 160);
  }
  return undefined;
}

const top = (c: Counts | undefined): string | undefined => {
  let best: string | undefined;
  for (const [k, n] of Object.entries(c ?? {})) if (best === undefined || n > (c![best] ?? 0)) best = k;
  return best;
};

/** The keybind a suit gets for an ability it is given: that ability's most common keybind across suits, else the most common keybind. */
export function defaultKeybind(cat: Catalog, id: string): string {
  return top(cat.abilityKeybinds[id]) ?? top(cat.keybindCount) ?? "key.thematic.passive";
}

const bump = (c: Counts, k: string, n = 1) => { c[k] = (c[k] ?? 0) + n; };

/** `{ value: count }` sorted by count (most used first), then by name. */
const byUse = (c: Counts) => Object.keys(c).sort((a, b) => c[b] - c[a] || a.localeCompare(b));

const naturalKey = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true });

export function scanCatalog(files: SourceFile[], ns: string): Catalog {
  const abilities: AbilityEntry[] = [];
  const seenAbility = new Set<string>();
  const suits: Array<{ id: string; data: Record<string, unknown> }> = [];
  const langKeys = new Set<string>();
  const flightProfiles: string[] = [];
  const stats: Counts = {};
  const attributeIds: Counts = {};
  const fighting: Counts = {};
  const flight: Counts = {};
  const jet: Counts = {};
  const tags: Counts = {};
  const types: Counts = {};
  const keybindCount: Counts = {};
  const abilityKeybinds: Record<string, Counts> = {};

  for (const f of files) {
    const p = f.path.replace(/\\/g, "/");
    let m = ABILITY_RE.exec(p);
    if (m) {
      const [, ans, folder = "", name] = m;
      const id = abilityId(ans, name);
      if (!seenAbility.has(id)) {
        seenAbility.add(id);
        const description = leadingComment(f.text);
        abilities.push({ id, ns: ans, name, folder, path: f.path, ...(description ? { description } : {}) });
      }
      continue;
    }
    if (LANG_RE.test(p)) {
      try {
        for (const k of Object.keys(JSON.parse(f.text) as object)) if (k.startsWith("key.thematic.")) langKeys.add(k);
      } catch { /* a broken lang file contributes nothing */ }
      continue;
    }
    m = FLIGHT_RE.exec(p);
    if (m && m[1] === ns) { flightProfiles.push(`${ns}:${m[2]}`); continue; }
    if (SUIT_RE.test(p) && p.includes(`/data/${ns}/armors/`)) {
      let data: Record<string, unknown>;
      try { data = JSON.parse(f.text) as Record<string, unknown>; } catch { continue; }
      if (!data || typeof data !== "object") continue;
      suits.push({ id: p.split("/").pop()!.replace(/\.json$/, ""), data });
    }
  }

  for (const { data } of suits) {
    for (const a of Array.isArray(data.abilities) ? (data.abilities as Array<Record<string, unknown>>) : []) {
      if (typeof a?.identifier !== "string") continue;
      if (typeof a.keybind === "string") {
        bump(keybindCount, a.keybind);
        bump((abilityKeybinds[a.identifier] ??= {}), a.keybind);
      }
    }
    for (const s of Array.isArray(data.stats) ? (data.stats as Array<Record<string, unknown>>) : []) {
      if (typeof s?.identifier === "string") bump(stats, s.identifier);
    }
    for (const a of Array.isArray(data.attributes) ? (data.attributes as Array<Record<string, unknown>>) : []) {
      if (typeof a?.identifier === "string") bump(attributeIds, a.identifier);
    }
    for (const x of Array.isArray(data.fighting_type) ? data.fighting_type : []) if (typeof x === "string") bump(fighting, x);
    for (const x of Array.isArray(data.tags) ? data.tags : []) if (typeof x === "string") bump(tags, x);
    if (typeof data.flight_type === "string") bump(flight, data.flight_type);
    if (typeof data.jet_groups === "string") bump(jet, data.jet_groups);
    if (typeof data.type === "string") bump(types, data.type);
  }
  for (const k of Object.keys(keybindCount)) langKeys.add(k);
  for (const k of DOCUMENTED.keybinds) langKeys.add(k);
  for (const s of DOCUMENTED.stats) stats[s] ??= 0;
  for (const a of DOCUMENTED.attributes) bump(attributeIds, a, 0);
  const union = (docs: readonly string[], seen: Counts) => [...new Set([...byUse(seen), ...docs])];

  abilities.sort((a, b) => a.folder.localeCompare(b.folder) || naturalKey(a.id, b.id));
  return {
    ns,
    abilities,
    abilityKeybinds,
    keybinds: [...langKeys].sort(naturalKey),
    keybindCount,
    stats: stats,
    attributeIds,
    fightingTypes: union(DOCUMENTED.fightingTypes, fighting),
    flightTypes: union(DOCUMENTED.flightTypes, flight),
    jetGroups: union(DOCUMENTED.jetGroups, jet),
    tags: byUse(tags),
    types: byUse(types),
    flightProfiles: [...new Set(flightProfiles)].sort(naturalKey),
    suits: [...new Set(suits.map((s) => s.id))].sort(naturalKey),
  };
}

/** Abilities matching a query (id, folder or description), best first: id prefix, id, then the rest. */
export function filterAbilities(list: AbilityEntry[], query: string, limit = 40): AbilityEntry[] {
  const q = query.trim().toLowerCase();
  if (!q) return list.slice(0, limit);
  const score = (a: AbilityEntry) => {
    const id = a.id.toLowerCase();
    const bare = a.name.toLowerCase();
    if (id === q || bare === q) return 0;
    if (id.startsWith(q) || bare.startsWith(q)) return 1;
    if (id.includes(q)) return 2;
    if (a.folder.toLowerCase().includes(q)) return 3;
    if ((a.description ?? "").toLowerCase().includes(q)) return 4;
    return -1;
  };
  return list.map((a) => ({ a, s: score(a) })).filter((x) => x.s >= 0).sort((x, y) => x.s - y.s || naturalKey(x.a.id, y.a.id)).slice(0, limit).map((x) => x.a);
}
