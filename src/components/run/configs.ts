/** Config type registry + the per-project list of run configurations (persisted with pstore("runconfigs")). */
import { createStore } from "../../lib/store";
import { projectStore } from "../../lib/project";
import { newId, pstore } from "../python/api";
import type { ConfigCtx, ConfigType, ContextProvider, EditorContext, RunConfig } from "./types";

const types = new Map<string, ConfigType>();
const typeSubs = new Set<() => void>();
/** Later modules (Gradle, Godot, ...) register their types here. */
export function registerConfigType(t: ConfigType) {
  types.set(t.id, t);
  typeSubs.forEach((f) => f());
  runStore.set((s) => ({ rev: s.rev + 1 }));
}
export const getConfigType = (id: string) => types.get(id);
export const listConfigTypes = () => [...types.values()].sort((a, b) => (a.order ?? 100) - (b.order ?? 100));
export const availableTypes = () => listConfigTypes().filter((t) => !t.available || t.available());
export const typeOf = (c: RunConfig) => types.get(c.type);

const providers: ContextProvider[] = [];
export const registerContextProvider = (p: ContextProvider) => { providers.push(p); };
export async function contextConfig(ctx: EditorContext): Promise<Omit<RunConfig, "id"> | null> {
  for (const p of providers) {
    const r = await p(ctx);
    if (r) return r;
  }
  return null;
}

export const MAX_TEMP = 5;
interface Saved { configs: RunConfig[]; selected: string | null }
export interface RunStoreState { configs: RunConfig[]; selectedId: string | null; loaded: boolean; rev: number }
export const runStore = createStore<RunStoreState>({ configs: [], selectedId: null, loaded: false, rev: 0 });

export const ctxFor = (): ConfigCtx | null => {
  const root = projectStore.get().root;
  return root ? { root } : null;
};

let loadedKey = "";
let saveTimer: ReturnType<typeof setTimeout> | undefined;
let savePending: Promise<void> = Promise.resolve();
const rootKey = () => { const r = projectStore.get().root; return r ? `${r.host}:${r.path}` : ""; };

export async function loadConfigs(force = false) {
  const root = projectStore.get().root;
  const k = rootKey();
  if (!root) { loadedKey = ""; runStore.set({ configs: [], selectedId: null, loaded: false }); return; }
  if (!force && loadedKey === k) return;
  loadedKey = k;
  const saved = await pstore.get<Saved>(root, "runconfigs");
  if (loadedKey !== k) return;
  const configs = (saved?.configs ?? []).filter((c) => c && typeof c.id === "string" && typeof c.type === "string");
  const selectedId = saved?.selected && configs.some((c) => c.id === saved.selected) ? saved.selected : configs[0]?.id ?? null;
  runStore.set({ configs, selectedId, loaded: true });
}

function scheduleSave() {
  const root = projectStore.get().root;
  if (!root) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => void saveNow(), 150);
}
/** Write the current list now (also used by the test hooks to make persistence deterministic). */
export function saveNow(): Promise<void> {
  clearTimeout(saveTimer);
  const root = projectStore.get().root;
  if (!root) return Promise.resolve();
  const { configs, selectedId } = runStore.get();
  savePending = savePending.then(() => pstore.set(root, "runconfigs", { configs, selected: selectedId } satisfies Saved)).catch(() => {});
  return savePending;
}

function commit(configs: RunConfig[], selectedId: string | null = runStore.get().selectedId) {
  // temporary configurations: keep the newest MAX_TEMP (never drop the selected one)
  const temps = configs.filter((c) => c.temporary);
  if (temps.length > MAX_TEMP) {
    const drop = new Set(temps.filter((c) => c.id !== selectedId).slice(0, temps.length - MAX_TEMP).map((c) => c.id));
    configs = configs.filter((c) => !drop.has(c.id));
  }
  if (selectedId && !configs.some((c) => c.id === selectedId)) selectedId = configs[0]?.id ?? null;
  runStore.set({ configs, selectedId });
  scheduleSave();
}

export const getConfig = (id: string | null | undefined) => (id ? runStore.get().configs.find((c) => c.id === id) ?? null : null);
export const selectedConfig = () => getConfig(runStore.get().selectedId);

export function newConfig(typeId: string, ctx: ConfigCtx, patch: Partial<RunConfig> = {}): RunConfig {
  const t = types.get(typeId);
  if (!t) throw new Error(`unknown run configuration type ${typeId}`);
  const cfg: RunConfig = { id: newId("cfg"), type: typeId, name: "", ...t.defaults(ctx), ...patch };
  if (!cfg.name) cfg.name = t.suggestName(cfg) || t.label;
  return cfg;
}

/** Unique-ify a name against the other configurations. */
export function uniqueName(name: string, others: RunConfig[], selfId?: string): string {
  const taken = new Set(others.filter((c) => c.id !== selfId).map((c) => c.name));
  if (!taken.has(name)) return name;
  const base = name.replace(/ \(\d+\)$/, "");
  for (let i = 2; ; i++) if (!taken.has(`${base} (${i})`)) return `${base} (${i})`;
}

export function addConfig(cfg: RunConfig, select = true): RunConfig {
  const { configs } = runStore.get();
  const c = { ...cfg, name: uniqueName(cfg.name, configs) };
  commit([...configs, c], select ? c.id : runStore.get().selectedId);
  return c;
}
export function updateConfig(cfg: RunConfig) {
  const { configs } = runStore.get();
  commit(configs.map((c) => (c.id === cfg.id ? cfg : c)));
}
export function removeConfig(id: string) {
  const { configs } = runStore.get();
  commit(configs.filter((c) => c.id !== id));
}
export function selectConfig(id: string) {
  if (runStore.get().selectedId === id || !getConfig(id)) return;
  runStore.set({ selectedId: id });
  scheduleSave();
}
/** Save a temporary configuration permanently. */
export function promoteConfig(id: string) {
  const c = getConfig(id);
  if (c?.temporary) updateConfig({ ...c, temporary: false });
}
/** Replace the whole list (Edit dialog Apply/OK). */
export function replaceConfigs(configs: RunConfig[], selectedId: string | null) {
  commit(configs, selectedId);
}

const defaultIdentity = (c: RunConfig) => JSON.stringify(Object.entries(c).filter(([k]) => !["id", "name", "temporary"].includes(k)).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
export const identityOf = (c: RunConfig) => `${c.type}\0${(types.get(c.type)?.identity ?? defaultIdentity)(c)}`;

/** Find the configuration equivalent to `partial` (permanent or temporary) or create a temporary one; selects it. */
export function ensureConfig(partial: Omit<RunConfig, "id">): RunConfig {
  const ctx = ctxFor();
  if (!ctx) throw new Error("no project");
  const cfg = newConfig(partial.type as string, ctx, { ...partial, temporary: true });
  const key = identityOf(cfg);
  const found = runStore.get().configs.find((c) => identityOf(c) === key);
  if (found) {
    selectConfig(found.id);
    return found;
  }
  return addConfig(cfg, true);
}
