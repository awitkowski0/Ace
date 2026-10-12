/**
 * Profile store (docs/PROFILES.md): `useProfile()`, `getProfile()`, `onProfileChange()`, `setProfile()`.
 * Per-user choice lives in the app data dir (ui-prefs.json, key `profiles`: { byProject, default }), NOT in the repo.
 * A project may suggest one with `.ace/config.json` `"profile": "asset"`. Resolution: this user's choice for the project,
 * else the project's suggestion, else the user's default, else Developer. Until the prefs are read the profile is Developer.
 */
import { useSyncExternalStore } from "react";
import { invoke } from "../../lib/ipc";
import { createStore } from "../../lib/store";
import { projectKey, projectStore } from "../../lib/project";
import { ensureRepoConfig, repoConfigStore } from "../../lib/repoConfig";
import { isProfile, type Profile } from "./gate";

export type { Profile };
const PREF = "profiles";
interface Prefs { byProject: Record<string, Profile>; default?: Profile }

export const profileStore = createStore<{ profile: Profile; source: "user" | "project" | "default" | "none"; suggested: Profile | null; ready: boolean }>({
  profile: "developer", source: "none", suggested: null, ready: false,
});
export const getProfile = () => profileStore.get().profile;
export const useProfile = (): Profile => useSyncExternalStore(profileStore.subscribe, getProfile);

const listeners = new Set<(p: Profile, prev: Profile) => void>();
export const onProfileChange = (fn: (p: Profile, prev: Profile) => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; };

let prefs: Prefs = { byProject: {} };
let loaded = false;

async function loadPrefs() {
  try {
    const t = await invoke<string | null>("ui_pref_get", { name: PREF });
    const v = t ? JSON.parse(t) : null;
    prefs = { byProject: {}, ...(v && typeof v === "object" ? v : {}) };
    if (!prefs.byProject || typeof prefs.byProject !== "object") prefs.byProject = {};
  } catch { prefs = { byProject: {} }; }
  loaded = true;
}
async function savePrefs() {
  await invoke("ui_pref_set", { name: PREF, value: JSON.stringify(prefs) }).catch(() => {});
}

const repoSuggestion = (): Profile | null => {
  const v = repoConfigStore.get().raw.profile;
  return isProfile(v) ? v : null;
};

/** Recompute the effective profile from prefs + repo config and publish it. */
export function resolveProfile() {
  if (!loaded) return;
  const root = projectStore.get().root;
  const mine = root ? prefs.byProject[projectKey(root)] : undefined;
  const sug = repoSuggestion();
  let profile: Profile, source: "user" | "project" | "default";
  if (isProfile(mine)) { profile = mine; source = "user"; }
  else if (sug) { profile = sug; source = "project"; }
  else if (isProfile(prefs.default)) { profile = prefs.default; source = "default"; }
  else { profile = "developer"; source = "default"; }
  const prev = getProfile();
  profileStore.set({ profile, source, suggested: sug, ready: true });
  if (prev !== profile) listeners.forEach((f) => f(profile, prev));
}

/** The user picks a profile for this project (remembered per user); `asDefault` also makes it the default for projects without a choice. */
export async function setProfile(p: Profile, o: { asDefault?: boolean } = {}) {
  if (!loaded) await loadPrefs();
  await loadPrefs(); // another window may have written meanwhile
  const root = projectStore.get().root;
  if (root) prefs.byProject[projectKey(root)] = p;
  if (o.asDefault) prefs.default = p;
  resolveProfile();
  await savePrefs();
}

let started = false;
export async function startProfiles() {
  if (started) return;
  started = true;
  const onProject = () => { if (projectStore.get().root) ensureRepoConfig(); resolveProfile(); };
  projectStore.subscribe(onProject);
  repoConfigStore.subscribe(resolveProfile);
  await loadPrefs();
  onProject();
  resolveProfile();
}
