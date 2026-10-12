/** Small notification store: transient toasts + one IntelliJ-style balloon with buttons. Rendered by NoticeHost.tsx (bottom right). */
import { createStore } from "../../lib/store";
import { choiceDialog, type ChoiceButton, type ChoiceResult } from "../shell/dialogs";

export interface BalloonAction { label: string; run: () => void | Promise<void>; primary?: boolean }
export interface Balloon { id: string; text: string; actions: BalloonAction[]; kind?: "info" | "warn" }
export interface Toast { id: number; text: string; kind: "info" | "warn" | "ok" }

export const noticeStore = createStore<{ toasts: Toast[]; balloon: Balloon | null }>({ toasts: [], balloon: null });
let n = 0;

export function toast(text: string, kind: Toast["kind"] = "info", ms = 3200) {
  const id = ++n;
  noticeStore.set((s) => ({ toasts: [...s.toasts.slice(-2), { id, text, kind }] }));
  setTimeout(() => noticeStore.set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), ms);
}
export const showBalloon = (b: Balloon) => noticeStore.set({ balloon: b });
export const hideBalloon = (id?: string) => noticeStore.set((s) => (!id || s.balloon?.id === id ? { balloon: null } : {}));

/** The "not available in Asset Dev" notice (gentle, auto-hides) */
export const notAvailable = (what: string) => toast(`${what} isn't available in Asset Dev. You can switch profile from the project menu.`, "info", 3600);

// automation: scripted answers for choice dialogs (scripts/qa/profiles.mjs); empty = ask for real
export const qaAnswers: string[] = [];
/** choiceDialog with scripted answers for the QA harness */
export async function ask(o: { title: string; message: string; buttons: ChoiceButton[]; checkbox?: string }): Promise<ChoiceResult> {
  if (qaAnswers.length) {
    const want = qaAnswers.shift()!;
    const hit = o.buttons.find((b) => b.label === want || b.value === want);
    return { value: hit ? hit.value : null, checked: false };
  }
  return choiceDialog(o);
}
