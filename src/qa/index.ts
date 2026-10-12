/**
 * QA harness entry. Asks Rust whether ACE_AUTOMATION is set; only then lazy-loads ./harness
 * (which installs window.__qa). Without the env var this is one cheap invoke and no other effect.
 */
import { invoke } from "@tauri-apps/api/core";

export async function maybeInstallQa() {
  try {
    if (await invoke<boolean>("qa_enabled")) (await import("./harness")).installQaHarness();
  } catch {
    /* harness unavailable: ignore */
  }
}
