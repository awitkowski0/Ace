import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { createStore } from "../../lib/store";
import { pty } from "./api";
import { openExternal } from "./external";

export interface Session {
  id: string;
  title: string;
  host: string;
  cwd: string;
  command?: string;
  login?: boolean;
  exited: boolean;
  term: Terminal;
  fit: FitAddon;
  el: HTMLDivElement;
  opened: boolean;
  spawned: boolean;
  unlisten: Array<() => void>;
}

export const NORD = {
  background: "#2e3440", foreground: "#d8dee9", cursor: "#d8dee9", cursorAccent: "#2e3440",
  selectionBackground: "#434c5e", selectionInactiveBackground: "#3b4252",
  black: "#3b4252", red: "#bf616a", green: "#a3be8c", yellow: "#ebcb8b",
  blue: "#81a1c1", magenta: "#b48ead", cyan: "#88c0d0", white: "#e5e9f0",
  brightBlack: "#4c566a", brightRed: "#bf616a", brightGreen: "#a3be8c", brightYellow: "#ebcb8b",
  brightBlue: "#81a1c1", brightMagenta: "#b48ead", brightCyan: "#8fbcbb", brightWhite: "#eceff4",
};

// Sessions live here (not in React) so they survive the tool window being hidden.
const map = new Map<string, Session>();
export const termStore = createStore<{ tabs: string[]; active: string | null; version: number }>({ tabs: [], active: null, version: 0 });
export const getSession = (id: string) => map.get(id);
const bump = () => termStore.set((s) => ({ version: s.version + 1 }));

let counter = 0;
const baseName = (p: string) => p.replace(/\/+$/, "").slice(p.lastIndexOf("/") + 1) || p;

export function createSession(o: { host: string; cwd: string; command?: string; title?: string; login?: boolean }): string {
  const id = `t${Date.now().toString(36)}${(counter++).toString(36)}`;
  const term = new Terminal({
    fontFamily: '"JetBrains Mono", Menlo, monospace',
    fontSize: 13,
    lineHeight: 1.15,
    cursorBlink: true,
    scrollback: 10000,
    allowProposedApi: true,
    macOptionIsMeta: true,
    theme: NORD,
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.loadAddon(new WebLinksAddon((e, uri) => { e.preventDefault(); void openExternal(uri); }));
  const u11 = new Unicode11Addon();
  term.loadAddon(u11);
  term.unicode.activeVersion = "11";
  const el = document.createElement("div");
  el.className = "term-host";
  const same = [...map.values()].filter((s) => s.host === o.host && !o.command).length;
  const title = o.title ?? (o.command ? o.command.split(/\s+/)[0] : o.host === "local" ? "Local" : o.host) + (!o.title && !o.command && same ? ` (${same + 1})` : "");
  const s: Session = { id, title, host: o.host, cwd: o.cwd, command: o.command, login: o.login, exited: false, term, fit, el, opened: false, spawned: false, unlisten: [] };
  map.set(id, s);
  termStore.set((st) => ({ tabs: [...st.tabs, id], active: id }));
  return id;
}

async function loadRenderer(s: Session) {
  try {
    const { WebglAddon } = await import("@xterm/addon-webgl");
    const gl = new WebglAddon();
    gl.onContextLoss(() => {
      gl.dispose();
      void loadCanvas(s);
    });
    s.term.loadAddon(gl);
  } catch {
    void loadCanvas(s);
  }
}
async function loadCanvas(s: Session) {
  try {
    const { CanvasAddon } = await import("@xterm/addon-canvas");
    s.term.loadAddon(new CanvasAddon());
  } catch {
    /* DOM renderer */
  }
}

/** Called when the session's element is in the DOM and visible: opens xterm, then spawns the pty at the right size. */
export async function attach(s: Session) {
  if (!s.opened) {
    s.opened = true;
    s.term.open(s.el);
    void loadRenderer(s);
    s.term.onData((d) => void pty.write(s.id, d).catch(() => {}));
    s.term.onResize(({ cols, rows }) => void pty.resize(s.id, cols, rows).catch(() => {}));
    s.term.onTitleChange(() => {});
  }
  try { s.fit.fit(); } catch {}
  if (s.spawned) return;
  s.spawned = true;
  // Flow control: ack bytes once xterm has consumed them (batched), so Rust pauses the child when we lag.
  let pendingAck = 0;
  const un1 = await pty.onData(s.id, (b) => {
    s.term.write(b, () => {
      pendingAck += b.length;
      if (pendingAck >= 128 * 1024) {
        const n = pendingAck;
        pendingAck = 0;
        void pty.ack(s.id, n).catch(() => {});
      }
    });
  });
  const un2 = await pty.onExit(s.id, (code) => {
    s.exited = true;
    if (code === 0 || code === null) closeSession(s.id, false);
    else {
      s.term.write(`\r\n\x1b[90m[Process exited with code ${code}]\x1b[0m\r\n`);
      bump();
    }
  });
  s.unlisten.push(un1, un2);
  if (!map.has(s.id)) return un1(), un2();
  try {
    await pty.spawn({ host: s.host, cwd: s.cwd, command: s.command, login: s.login, cols: s.term.cols, rows: s.term.rows, id: s.id });
  } catch (e) {
    s.exited = true;
    s.term.write(`\x1b[31mFailed to start terminal: ${String(e)}\x1b[0m\r\n`);
    bump();
  }
}

export function closeSession(id: string, kill = true) {
  const s = map.get(id);
  if (!s) return;
  map.delete(id);
  if (kill) void pty.kill(id).catch(() => {});
  s.unlisten.forEach((f) => f());
  try { s.term.dispose(); } catch {}
  s.el.remove();
  termStore.set((st) => {
    const i = st.tabs.indexOf(id);
    const tabs = st.tabs.filter((t) => t !== id);
    const active = st.active === id ? (tabs[Math.min(i, tabs.length - 1)] ?? null) : st.active;
    return { tabs, active };
  });
}

export function renameSession(id: string, title: string) {
  const s = map.get(id);
  if (s && title.trim()) {
    s.title = title.trim();
    bump();
  }
}
export const setActive = (id: string) => termStore.set({ active: id });
export const defaultCwdName = baseName;
