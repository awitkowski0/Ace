/** Compile and Reload File: the user-level operation behind ⌘⇧F9, the Debug window button, hot swap on save and the QA hooks. */
import { activeDocKey, editorStore, saveAll } from "../../../editor/store";
import { showBalloon } from "../../python/debug/notify";
import { liveJavaSession } from "./session";
import type { HotswapResult } from "./api";

/** the active editor tab as a local .java file, else null */
export function activeJavaFile(): string | null {
  const k = activeDocKey();
  const d = k ? editorStore.get().docs[k] : undefined;
  if (!d || d.kind === "diff" || d.error || d.viewer || d.loc.host !== "local" || !d.loc.path.endsWith(".java")) return null;
  return d.loc.path;
}

export async function reloadJavaFile(file: string | null = activeJavaFile(), o: { quiet?: boolean } = {}): Promise<HotswapResult | null> {
  if (!file) return null;
  const s = liveJavaSession();
  if (!s) {
    if (!o.quiet) showBalloon({ kind: "warn", title: "Nothing to reload into", text: "Hot swap needs a Gradle run started with Debug (⌃D) so the game JVM carries a debug agent." });
    return null;
  }
  await saveAll();
  return s.reloadFile(file);
}
