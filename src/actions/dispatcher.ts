import { getBindings } from "./keymap";
import { isModifierCode, modifierName, strokeFromEvent } from "./keystroke";
import { getAction, runAction } from "./registry";

const DOUBLE_TAP_MS = 300;
const CHORD_MS = 1500;

function runFirst(ids: string[]): boolean {
  for (const id of ids) {
    const a = getAction(id);
    if (a && (!a.isEnabled || a.isEnabled())) {
      runAction(id);
      return true;
    }
  }
  return false;
}

/** Keys the webview would otherwise handle (reload, zoom, print, ...). */
const LEAKY = new Set(["meta R", "meta shift R", "F5", "control R", "meta EQUALS", "meta MINUS", "meta 0", "meta shift EQUALS",
  "meta P", "control meta F", "meta shift J"]);

export function installDispatcher() {
  let pending: string | null = null;
  let pendingTimer: number | undefined;
  let down: { name: string; clean: boolean } | null = null;
  let lastTap: { name: string; t: number } | null = null;

  const clearPending = () => {
    pending = null;
    clearTimeout(pendingTimer);
  };

  window.addEventListener(
    "keydown",
    (e) => {
      if (e.isComposing) return;
      if (isModifierCode(e.code)) {
        if (!e.repeat) down = { name: modifierName(e.code)!, clean: true };
        return;
      }
      if (down) down.clean = false;
      lastTap = null;
      const stroke = strokeFromEvent(e);
      if (!stroke) return;
      const { exact, prefixes } = getBindings();
      const full = pending ? `${pending} , ${stroke}` : stroke;
      const hit = exact.get(full);
      if (hit && runFirst(hit)) {
        e.preventDefault();
        e.stopPropagation();
        clearPending();
        return;
      }
      if (prefixes.has(full)) {
        e.preventDefault();
        e.stopPropagation();
        pending = full;
        clearTimeout(pendingTimer);
        pendingTimer = window.setTimeout(clearPending, CHORD_MS);
        return;
      }
      clearPending();
      if (LEAKY.has(stroke)) e.preventDefault();
    },
    true,
  );

  window.addEventListener(
    "keyup",
    (e) => {
      if (!isModifierCode(e.code)) return;
      const name = modifierName(e.code)!;
      if (down && down.name === name && down.clean) {
        const now = performance.now();
        if (lastTap && lastTap.name === name && now - lastTap.t < DOUBLE_TAP_MS) {
          lastTap = null;
          const hit = getBindings().exact.get(`double ${name}`);
          if (hit) runFirst(hit);
        } else lastTap = { name, t: now };
      } else lastTap = null;
      down = null;
    },
    true,
  );

  // No browser-default leakage: native context menu, ctrl+wheel zoom.
  window.addEventListener("contextmenu", (e) => e.preventDefault(), true);
  window.addEventListener("wheel", (e) => e.ctrlKey && e.preventDefault(), { passive: false, capture: true });
  window.addEventListener("dragover", (e) => e.preventDefault());
  window.addEventListener("drop", (e) => e.preventDefault());
}
