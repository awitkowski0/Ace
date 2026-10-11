import { showToolWindow } from "../../lib/layout";
import { createSession } from "./sessions";

export { pty, type PtySpawnOpts } from "./pty";

/**
 * Cross-module contract (see docs/CONVENTIONS.md): opens/focuses the Terminal tool window and starts a
 * new tab. `command` runs in place of an interactive shell (remote: via login_wrap). Returns the tab id.
 */
export function openTerminal(opts: { host: string; cwd: string; command?: string; title?: string; login?: boolean }): string {
  const id = createSession(opts);
  showToolWindow("terminal");
  return id;
}

export { setTerminalActivator, type TerminalActivator } from "./activator";
