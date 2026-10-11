/** One game <-> Ace remote-debugger connection (Ace listens, the game dials with --remote-debug). Request/response helpers on top of the raw messages. */
import type { UnlistenFn } from "../../lib/ipc";
import { newId } from "../python/api";
import { godotApi, type DbgMsg } from "./api";

type Waiter = { cmd: string; resolve(d: unknown[]): void; reject(e: Error): void; timer: ReturnType<typeof setTimeout> };

/** Links with a connected game (debug sessions and run sessions with live reload). */
export const liveLinks = new Set<GameLink>();
export const onLiveChange = new Set<() => void>();
const changed = () => onLiveChange.forEach((f) => f());

export class GameLink {
  readonly id = newId("gdbg");
  /** scripts modified after this time (ms since epoch) have not been sent to the game yet */
  sinceMs = Date.now();
  port = 0;
  connected = false;
  closed = false;
  /** last messages (debug aid for tests) */
  readonly trace: string[] = [];
  onMessage: (m: DbgMsg) => void = () => {};
  onConnect: () => void = () => {};
  onClose: () => void = () => {};
  private waiters: Waiter[] = [];
  private un: UnlistenFn[] = [];

  async open(): Promise<number> {
    this.un.push(await godotApi.onDbg(this.id, (m) => this.recv(m)));
    this.un.push(await godotApi.onConn(this.id, () => { this.connected = true; liveLinks.add(this); changed(); this.onConnect(); }));
    this.un.push(await godotApi.onClosed(this.id, () => this.handleClosed()));
    this.port = await godotApi.dbgListen(this.id);
    return this.port;
  }

  private recv(m: DbgMsg) {
    this.trace.push(m.cmd);
    if (this.trace.length > 200) this.trace.shift();
    const i = this.waiters.findIndex((w) => w.cmd === m.cmd);
    if (i >= 0) {
      const [w] = this.waiters.splice(i, 1);
      clearTimeout(w.timer);
      w.resolve(Array.isArray(m.data) ? m.data : []);
      return;
    }
    try { this.onMessage(m); } catch (e) { console.error("godot link handler", m.cmd, e); }
  }

  send(cmd: string, data: unknown[] = [], thread = 1) {
    if (this.closed) return Promise.resolve();
    return godotApi.dbgSend(this.id, cmd, data, thread).catch(() => {});
  }

  /** Waits for the next message `cmd` (consumed here, not delivered to onMessage). */
  expect(cmd: string, ms = 10000): Promise<unknown[]> {
    return new Promise((resolve, reject) => {
      const w: Waiter = { cmd, resolve, reject, timer: setTimeout(() => { this.waiters = this.waiters.filter((x) => x !== w); reject(new Error(`no '${cmd}' answer from the game`)); }, ms) };
      this.waiters.push(w);
    });
  }

  private handleClosed() {
    if (this.closed) return;
    this.dispose();
    this.onClose();
  }

  private dispose() {
    this.closed = true;
    this.connected = false;
    if (liveLinks.delete(this)) changed();
    this.un.splice(0).forEach((u) => u());
    for (const w of this.waiters) { clearTimeout(w.timer); w.reject(new Error("the game disconnected")); }
    this.waiters = [];
  }

  close() {
    if (this.closed) return;
    this.dispose();
    void godotApi.dbgClose(this.id).catch(() => {});
  }
}

/** Ask every connected game (debug and run sessions) to reload the scripts changed on disk since it connected / last reloaded.
 * Godot's `reload_scripts` takes the res:// paths as its arguments. Returns how many scripts were sent (distinct). */
export async function reloadScriptsEverywhere(projectDir: string): Promise<number> {
  const sent = new Set<string>();
  for (const l of [...liveLinks]) {
    if (!l.connected) continue;
    const since = l.sinceMs;
    const paths = await godotApi.changedScripts(projectDir, since);
    l.sinceMs = Date.now();
    if (!paths.length) continue;
    await l.send("reload_scripts", paths);
    paths.forEach((p) => sent.add(p));
  }
  return sent.size;
}
