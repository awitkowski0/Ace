/**
 * Action registry. Register from your module's register.tsx:
 *
 *   registerAction({ id: "GotoFile", title: "Go to File…", intellijId: "GotoFile",
 *                    defaultKeys: ["meta shift O"], run: () => openPopup("GotoFile") });
 *
 * Bindings: keymap JSON (`src/keymap/intellij-macos.json`, `{ "<intellijId>": ["meta shift O", ...] }`)
 * wins over `defaultKeys`; user overrides (localStorage) win over both. `isEnabled` false => the key
 * falls through to the focused element (Monaco etc.).
 */
import { createRegistry } from "../lib/store";

/**
 * Where an action is live (IntelliJ-style precedence: popup > focused tool window > editor > global):
 *  "global"            always (default)
 *  "editor"            only while focus is inside an editor group (Monaco, tabs, find bar)
 *  { toolWindow: id }  only while that tool window has focus
 *  "popup"             only while a popup (Search Everywhere, ...) is open
 */
export type ActionContext = "global" | "editor" | "popup" | { toolWindow: string };

export interface Action {
  id: string;
  title: string;
  run: () => void | Promise<void>;
  intellijId?: string;
  defaultKeys?: string[]; // IntelliJ syntax; fallback when keymap has no entry
  isEnabled?: () => boolean;
  /** optional; omitted = "global" (backward compatible) */
  context?: ActionContext;
}

const reg = createRegistry<Action>();
export const registerAction = reg.register;
export const getAction = reg.get;
export const listActions = reg.list;
export const subscribeActions = reg.subscribe;

export function runAction(id: string) {
  const a = reg.get(id);
  if (!a || (a.isEnabled && !a.isEnabled())) return false;
  Promise.resolve(a.run()).catch((e) => console.error(`action ${id} failed`, e));
  return true;
}
