/**
 * The currently active Studio (the one whose tab is visible/focused). Actions registered by tools/actions.ts are gated on it.
 * StudioView should call `setActiveStudio(api)` when its tab becomes active/focused and `setActiveStudio(null)` (or
 * `clearActiveStudio(api)`) when it hides or unmounts.
 */
import type { StudioApi } from "./state";

let active: StudioApi | null = null;
const subs = new Set<() => void>();

export const getActiveStudio = (): StudioApi | null => active;
export function setActiveStudio(api: StudioApi | null): void {
  if (active === api) return;
  active = api;
  subs.forEach((f) => f());
}
/** Clear only if `api` is still the active one (safe in unmount cleanups). */
export function clearActiveStudio(api: StudioApi): void {
  if (active === api) setActiveStudio(null);
}
export function subscribeActiveStudio(fn: () => void): () => void {
  subs.add(fn);
  return () => subs.delete(fn);
}
