/** Clip semantics (player vs geo) of the open Studio document: the path decides, the user can override. */
import { clipSemantics, type ClipSemantics } from "../core";
import type { StudioApi, StudioState } from "./state";

export const SEM_MODES = ["auto", "player", "geo"] as const;
export type SemMode = (typeof SEM_MODES)[number];

/** What the preview samples with: forced mode, else by path (`assets/<ns>/animations/armor/**` = player, otherwise geo). */
export function effectiveSemantics(s: Pick<StudioState, "path" | "semMode">): ClipSemantics {
  return s.semMode === "player" || s.semMode === "geo" ? s.semMode : clipSemantics(s.path);
}

/** Choose the preview semantics; re-stamps the current doc so every sampler (viewport, graph, tools) follows. */
export function setSemMode(api: StudioApi, mode: SemMode): void {
  api.store.set({ semMode: mode });
  const s = api.store.get();
  if (!s.doc) return;
  const sem = effectiveSemantics(s);
  if ((s.doc.semantics ?? "geo") !== sem) api.store.set({ doc: { ...s.doc, semantics: sem === "geo" ? undefined : sem } });
}
