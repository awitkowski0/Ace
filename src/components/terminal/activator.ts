/**
 * Optional hook (Python venv activation): called with every terminal spawn the pane is about to make; a returned path of
 * `<venv>/bin/activate` is sourced once at the first prompt of a local interactive shell. Unset = no change in behaviour.
 */
export type TerminalActivator = (o: { host: string; cwd: string; command?: string }) => string | undefined | null | Promise<string | undefined | null>;
let activator: TerminalActivator | null = null;
export const setTerminalActivator = (fn: TerminalActivator | null) => { activator = fn; };
export const terminalActivate = (o: { host: string; cwd: string; command?: string }): string | undefined | Promise<string | undefined> => {
  if (!activator || o.host !== "local" || o.command) return undefined;
  try {
    const r = activator(o);
    return r instanceof Promise ? r.then((v) => v ?? undefined, () => undefined) : (r ?? undefined);
  } catch { return undefined; }
};
