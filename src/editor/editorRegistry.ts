/** Lightweight handle to the focused Monaco editor without importing monaco eagerly. */
import type { editor } from "monaco-editor";

const editors = new Map<string, editor.IStandaloneCodeEditor>();
let activeGroupId: string | null = null;

export const registerEditor = (groupId: string, e: editor.IStandaloneCodeEditor) => editors.set(groupId, e);
export const unregisterEditor = (groupId: string) => editors.delete(groupId);
export const setActiveEditorGroup = (id: string) => (activeGroupId = id);
export const activeEditor = () => (activeGroupId ? editors.get(activeGroupId) : undefined) ?? [...editors.values()][0];
export const focusEditor = () => activeEditor()?.focus();
/** Run a Monaco built-in command on the active editor (e.g. "editor.action.deleteLines"). */
export const triggerEditor = (id: string) => {
  const e = activeEditor();
  if (!e) return false;
  e.focus();
  e.trigger("atelier", id, null);
  return true;
};
