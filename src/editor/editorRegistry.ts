/** Lightweight handle to the focused Monaco editor without importing monaco eagerly. */
import type { editor } from "monaco-editor";

const editors = new Map<string, editor.IStandaloneCodeEditor>();
let activeGroupId: string | null = null;

const editorListeners = new Set<(e: editor.IStandaloneCodeEditor) => void>();
/** Called for every editor already registered and every one registered later (Python gutter, decorations). */
export const onEditorRegistered = (cb: (e: editor.IStandaloneCodeEditor) => void) => {
  editorListeners.add(cb);
  editors.forEach((e) => cb(e));
  return () => editorListeners.delete(cb);
};
export const registerEditor = (groupId: string, e: editor.IStandaloneCodeEditor) => {
  const isNew = editors.get(groupId) !== e;
  editors.set(groupId, e);
  if (isNew) editorListeners.forEach((cb) => cb(e));
};
export const unregisterEditor = (groupId: string) => editors.delete(groupId);
export const setActiveEditorGroup = (id: string) => (activeGroupId = id);
/** Set by EditorArea: true while the active group shows a viewer tab (image, audio ...), whose hidden Monaco must not receive editor actions. */
let viewerInFront: () => boolean = () => false;
export const setViewerInFront = (f: () => boolean) => { viewerInFront = f; };
/** == animstudio hook: while a Studio pane has focus the (hidden) Monaco editor must not receive editor actions (⌘D etc.). */
const suppressors = new Set<() => boolean>();
export const suppressEditorWhen = (f: () => boolean) => { suppressors.add(f); return () => { suppressors.delete(f); }; };
export const activeEditor = () => (viewerInFront() || [...suppressors].some((f) => f()) ? undefined : (activeGroupId ? editors.get(activeGroupId) : undefined) ?? [...editors.values()][0]);
export const focusEditor = () => activeEditor()?.focus();
/** Run a Monaco built-in command on the active editor (e.g. "editor.action.deleteLines"). */
export const triggerEditor = (id: string) => {
  const e = activeEditor();
  if (!e) return false;
  e.focus();
  e.trigger("atelier", id, null);
  return true;
};
export const getEditor = (groupId: string) => editors.get(groupId);
export const allEditors = () => [...editors.values()];
