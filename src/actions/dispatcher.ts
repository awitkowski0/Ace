import { getBindings, isIntellijBound, monacoKept } from "./keymap";
import { isModifierCode, modifierName, strokeFromEvent } from "./keystroke";
import { getAction, runAction } from "./registry";
import { candidates, type FocusState } from "./context";
import { ModifierGesture, type Mod } from "./modifierGesture";
import { focusedToolWindowId } from "../lib/layout";
import { isPopupOpen } from "../components/shell/popups";

const CHORD_MS = 1500;

export function focusState(): FocusState {
  const el = document.activeElement;
  const toolWindow = focusedToolWindowId();
  const nowhere = !el || el === document.body || el === document.documentElement;
  return { popupOpen: isPopupOpen(), toolWindow, editor: !toolWindow && (nowhere || !!el?.closest(".editor-group")) };
}

/** Runs the best live action for `ids` under the current focus. Returns true when one ran. */
export function dispatchIds(ids: string[], st: FocusState = focusState()): boolean {
  for (const a of candidates(ids, getAction, st)) {
    if (runAction(a.id)) return true;
  }
  return false;
}

/** Keys the webview would otherwise handle (reload, zoom, print, ...). */
const LEAKY = new Set(["meta R", "meta shift R", "F5", "control R", "meta EQUALS", "meta MINUS", "meta 0", "meta shift EQUALS",
  "meta P", "control meta F", "meta shift J"]);

const modOf = (e: KeyboardEvent): Mod | null => {
  const n = modifierName(e.code) ?? ({ Shift: "shift", Control: "control", Alt: "alt", Meta: "meta" } as Record<string, string>)[e.key];
  return (n as Mod) ?? null;
};
const isModifierEvent = (e: KeyboardEvent) => isModifierCode(e.code) || ["Shift", "Control", "Alt", "Meta"].includes(e.key);

export function installDispatcher() {
  let pending: string | null = null;
  let pendingTimer: number | undefined;
  const gesture = new ModifierGesture();

  const clearPending = () => {
    pending = null;
    clearTimeout(pendingTimer);
  };
  const swallow = (e: Event) => {
    e.preventDefault();
    e.stopPropagation();
  };

  window.addEventListener(
    "keydown",
    (e) => {
      if (e.isComposing) return;
      if (isModifierEvent(e)) {
        const m = modOf(e);
        if (!m) return;
        const doubled = gesture.modDown(m, e.repeat, performance.now());
        if (doubled) {
          const hit = getBindings().exact.get(`double ${doubled}`);
          if (hit) dispatchIds(hit);
        }
        return;
      }
      gesture.otherInput();
      let stroke = strokeFromEvent(e);
      if (!stroke) return;
      const { exact, prefixes } = getBindings();
      // double-⌥ then ↓/↑ while the second ⌥ is still held (clone caret)
      if (gesture.doubleHeld && !pending) {
        const hold = exact.get(`doublehold ${gesture.doubleHeld} ${stroke.split(" ").pop()}`);
        if (hold && dispatchIds(hold)) return swallow(e);
      }
      const full = pending ? `${pending} , ${stroke}` : stroke;
      const hit = exact.get(full);
      if (hit && dispatchIds(hit)) {
        swallow(e);
        clearPending();
        return;
      }
      if (prefixes.has(full)) {
        swallow(e);
        pending = full;
        clearTimeout(pendingTimer);
        pendingTimer = window.setTimeout(clearPending, CHORD_MS);
        return;
      }
      clearPending();
      if (LEAKY.has(stroke)) e.preventDefault();
      // IntelliJ-bound key we do not implement: swallow in the editor instead of letting Monaco/the OS reinterpret it
      // (e.g. ⌥-combos would otherwise insert special characters).
      if (/\b(meta|alt|control)\b/.test(stroke) && isIntellijBound(stroke) && !monacoKept.has(stroke) && focusState().editor && !isPopupOpen() && (e.target as Element | null)?.closest?.(".monaco-editor")) swallow(e);
    },
    true,
  );

  window.addEventListener(
    "keyup",
    (e) => {
      if (!isModifierEvent(e)) return;
      const m = modOf(e);
      if (m) gesture.modUp(m, performance.now());
    },
    true,
  );
  window.addEventListener("mousedown", () => gesture.reset(), true);
  window.addEventListener("blur", () => { gesture.reset(); clearPending(); });

  // No browser-default leakage: native context menu, ctrl+wheel zoom.
  window.addEventListener("contextmenu", (e) => e.preventDefault(), true);
  window.addEventListener("wheel", (e) => e.ctrlKey && e.preventDefault(), { passive: false, capture: true });
  window.addEventListener("dragover", (e) => e.preventDefault());
  window.addEventListener("drop", (e) => e.preventDefault());
}
