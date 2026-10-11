/**
 * Optional hook (Claude notifications): called before every pty spawn; a returned path is the hook channel file the shell / `claude`
 * command reports to (sent to Rust as `hookFile`). Unset or undefined = no change in behaviour.
 */
export type SpawnHook = (o: { host: string; cwd: string; command?: string; id: string }) => string | undefined | null | Promise<string | undefined | null>;
let hook: SpawnHook | null = null;
export const setSpawnHook = (h: SpawnHook | null) => { hook = h; };
export const runSpawnHook = (o: Parameters<SpawnHook>[0]) => (hook ? hook(o) : undefined);
