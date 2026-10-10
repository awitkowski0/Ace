/**
 * Background polling policy ("no work when nobody is looking"): timers keep ticking but skip their work while the window
 * is hidden/occluded (`visibilityState`) or not the focused window; `onWindowActive` lets a poller catch up the moment
 * the window is used again instead of showing stale data.
 */
export const windowActive = () => document.visibilityState === "visible" && document.hasFocus();

/** Run `fn` whenever the window regains focus or becomes visible. Returns an unsubscribe function. */
export function onWindowActive(fn: () => void): () => void {
  const h = () => { if (windowActive()) fn(); };
  window.addEventListener("focus", h);
  document.addEventListener("visibilitychange", h);
  return () => { window.removeEventListener("focus", h); document.removeEventListener("visibilitychange", h); };
}
