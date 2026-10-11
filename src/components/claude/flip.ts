/**
 * Flip between working on files and working with Claude sessions (action `Claude.FlipFilesAI`, ⌃⌥A):
 *  files -> AI : left tool window becomes "AI Sessions" (the Project tool window's second view), the bottom Terminal shows and
 *                focuses the most recently used Claude session; with no session the sessions list gets focus.
 *  AI -> files : back to the Project view and the editor that had focus (its caret is untouched, the Monaco model is never closed).
 * State is per window (module scope = one webview per project window).
 */
import { focusToolWindow, isToolWindowFocused, layoutStore, setActive, showToolWindow } from "../../lib/layout";
import { focusEditor } from "../../editor/editorRegistry";
import { focusPane, getPane, tabOf, targetPane } from "../terminal/sessions";
import { clearAttn, isClaudePane, mruPane, paneForSession, setGoto, type Attn } from "./ai";

type Origin = "editor" | "project";
let origin: Origin = "editor";
let terminalWasHidden = false;
let lastFlip: "ai" | "files" | null = null;

export const flipState = () => ({ origin, terminalWasHidden, lastFlip });

/** Is focus on the AI side: the AI Sessions list, or a terminal pane that hosts a Claude session? */
export function inAiContext(): boolean {
  if (isToolWindowFocused("claude")) return true;
  const p = targetPane();
  return !!p && !p.quick && isToolWindowFocused("terminal") && isClaudePane(p.id);
}

export function focusClaudeTerminal(paneId: string) {
  focusPane(paneId); // activates its tab and focuses the pane once mounted
  showToolWindow("terminal");
}

const remember = () => {
  if (inAiContext()) return;
  origin = isToolWindowFocused("project") ? "project" : "editor";
  terminalWasHidden = layoutStore.get().active.bottom !== "terminal";
};

/** Focus the Ace terminal running this session, if any. */
export function focusSessionTerminal(host: string, sessionId: string): boolean {
  const id = paneForSession(host, sessionId);
  if (!id) return false;
  remember();
  focusClaudeTerminal(id);
  return true;
}

export const showAiView = () => setActive("left", "claude");
export const showFilesView = () => setActive("left", "project");

export function flipToAi() {
  remember();
  showAiView();
  const pane = mruPane();
  if (pane) focusClaudeTerminal(pane);
  else focusToolWindow("claude");
  lastFlip = "ai";
}

export function flipToFiles() {
  showFilesView();
  if (terminalWasHidden && layoutStore.get().active.bottom === "terminal") setActive("bottom", null);
  if (origin === "project") focusToolWindow("project");
  else focusEditor();
  lastFlip = "files";
}

export function flip() {
  if (inAiContext()) flipToFiles();
  else flipToAi();
}

// Bring a session forward from a notification / badge: AI view + its terminal (or the list for sessions running elsewhere).
setGoto((a: Attn | { host: string; sessionId?: string; paneId?: string; cwd: string }) => {
  const pane = a.paneId && getPane(a.paneId) && tabOf(a.paneId) ? a.paneId : a.sessionId ? paneForSession(a.host, a.sessionId) : undefined;
  remember();
  showAiView();
  if (pane) focusClaudeTerminal(pane);
  else focusToolWindow("claude");
  lastFlip = "ai";
  if ("key" in a) clearAttn(a.key);
});
