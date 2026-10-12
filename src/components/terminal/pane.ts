/** One terminal surface: xterm + pty + Ghostty-style behaviours (OSC 7/8/9/52/133/777, search, links, clipboard, images). */
import { isMod } from "../../lib/platform";
import { Terminal, type IMarker } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebLinksAddon } from "@xterm/addon-web-links";
import type { WebglAddon } from "@xterm/addon-webgl";
import { fs, invoke, local, type Location } from "../../lib/ipc";
import { projectStore } from "../../lib/project";
import { openFile } from "../../editor/store";
import { confirmDialog } from "../shell/dialogs";
import { pty } from "./pty";
import { terminalActivate } from "./activator";
import { runSpawnHook } from "./spawnHook";
import { openExternal } from "./external";
import { base64ToUtf8, clipboardRead, clipboardWrite, isUnsafePaste, utf8ToBase64 } from "./clipboard";
import { filePathLinks } from "./links";
import { desktopNotify, qaHooks } from "./notify";
import { getSettings, settingsStore, type TermSettings } from "./settings";
import { NORD, resolveTheme } from "./themes";
import { onSchemeChange } from "../../theme";

export interface PaneSpec { host: string; cwd: string; command?: string; login?: boolean; fontSize?: number }
interface Block { prompt: IMarker; out?: IMarker; end?: IMarker; endAtCol0?: boolean; exit?: number }

/** Late-bound by the session model (avoids an import cycle). */
export const paneHooks: {
  onFocus: (p: Pane) => void;
  onExit: (p: Pane, code: number | null) => void;
  menu: (p: Pane, x: number, y: number) => void;
} = { onFocus() {}, onExit() {}, menu() {} };

let paneSeq = 0;
let homePromise: Promise<string | undefined> | null = null;
const home = () => (homePromise ??= fs.home().catch(() => undefined));

/** Does this output chunk start a sixel (DCS) or iTerm2 inline image (OSC 1337;File=)? */
export function wantsImages(b: Uint8Array): boolean {
  let i = b.indexOf(0x1b);
  while (i >= 0 && i + 1 < b.length) {
    const c = b[i + 1];
    if (c === 0x50) return true;
    if (c === 0x5d && b[i + 2] === 0x31 && b[i + 3] === 0x33 && b[i + 4] === 0x33 && b[i + 5] === 0x37 && b[i + 6] === 0x3b) return true;
    i = b.indexOf(0x1b, i + 1);
  }
  return false;
}

export class Pane {
  readonly id = `p${Date.now().toString(36)}${(paneSeq++).toString(36)}`;
  readonly host: string;
  readonly command?: string;
  readonly login?: boolean;
  readonly startCwd: string;
  /** last directory reported by the shell (OSC 7); falls back to the start directory */
  cwd: string;
  cwdFromShell = false;
  title = "";
  defaultTitle = "";
  exited = false;
  bell = false;
  running = false; // a command is executing (OSC 133 C..D)
  lastExit: number | null = null;
  fontOverride: number | null;
  readonly term: Terminal;
  readonly fit = new FitAddon();
  readonly searchAddon = new SearchAddon();
  readonly el: HTMLDivElement;
  readonly host_: HTMLDivElement;
  search = { open: false, query: "", caseSensitive: false, regex: false, index: -1, count: 0 };
  /** QA/diagnostics */
  imagesLoaded = false;
  glActive = false;
  writes: string[] | null = null;
  blocks: Block[] = [];
  opened = false;
  spawned = false;
  disposed = false;
  quick = false;
  private gl: WebglAddon | null = null;
  private glLost = false;
  private held: Uint8Array[] | null = null;
  private pendingAck = 0;
  private unlisten: Array<() => void> = [];
  private selTimer: number | undefined;
  private themeSeq = 0;
  private fitRaf = 0;
  onChange: () => void = () => {};

  constructor(spec: PaneSpec) {
    const s = getSettings();
    this.host = spec.host;
    this.command = spec.command;
    this.login = spec.login;
    this.startCwd = this.cwd = spec.cwd;
    this.fontOverride = spec.fontSize ?? null;
    this.term = new Terminal({
      fontFamily: s.fontFamily,
      fontSize: this.fontOverride ?? s.fontSize,
      lineHeight: s.lineHeight,
      cursorBlink: s.cursorBlink,
      cursorStyle: s.cursorStyle,
      scrollback: s.scrollback,
      allowProposedApi: true,
      macOptionIsMeta: s.optionAsAlt,
      theme: NORD,
      linkHandler: { activate: (e, uri) => { if (isMod(e)) void this.openUri(uri); }, allowNonHttpProtocols: true },
    });
    this.el = document.createElement("div");
    this.el.className = "term-pane";
    this.host_ = document.createElement("div");
    this.host_.className = "term-host";
    this.el.appendChild(this.host_);
    this.el.style.setProperty("--term-pad", `${s.padding}px`);

    const t = this.term;
    t.loadAddon(this.fit);
    t.loadAddon(this.searchAddon);
    t.loadAddon(new Unicode11Addon());
    t.unicode.activeVersion = "11";
    t.loadAddon(new WebLinksAddon((e, uri) => { if (isMod(e)) void this.openUri(uri); }));
    t.registerLinkProvider(filePathLinks(t, {
      host: () => this.host,
      cwd: () => this.cwd,
      project: () => projectStore.get().root,
      home,
      open: (loc, line, col) => void openFile(loc, { line: line ?? 1, col: col ?? 1 }),
    }));
    this.searchAddon.onDidChangeResults((r) => {
      this.search.index = r.resultIndex;
      this.search.count = r.resultCount;
      this.onChange();
    });

    // ---- escape sequences ----
    t.parser.registerOscHandler(7, (d) => this.osc7(d));
    t.parser.registerOscHandler(52, (d) => (void this.osc52(d), true));
    t.parser.registerOscHandler(133, (d) => this.osc133(d));
    t.parser.registerOscHandler(9, (d) => this.osc9(d));
    t.parser.registerOscHandler(777, (d) => this.osc777(d));
    t.onTitleChange((x) => { this.title = x; this.onChange(); });
    t.onBell(() => this.ringBell());
    t.onData((d) => {
      if (this.writes) { this.writes.push(d); if (this.writes.length > 200) this.writes.shift(); }
      void pty.write(this.id, d).catch(() => {});
    });
    t.onResize(({ cols, rows }) => void pty.resize(this.id, cols, rows).catch(() => {}));
    t.onSelectionChange(() => {
      if (!getSettings().copyOnSelect) return;
      clearTimeout(this.selTimer);
      this.selTimer = window.setTimeout(() => { const sel = t.getSelection(); if (sel) void clipboardWrite(sel); }, 120);
    });
    t.attachCustomKeyEventHandler((e) => this.keyHandler(e));

    // ---- DOM events ----
    this.el.addEventListener("paste", (e) => {
      const text = (e as ClipboardEvent).clipboardData?.getData("text/plain");
      if (text === undefined) return;
      e.preventDefault();
      e.stopPropagation();
      void this.pasteText(text);
    }, true);
    this.el.addEventListener("focusin", () => { this.bell = false; paneHooks.onFocus(this); this.onChange(); });
    this.el.addEventListener("keydown", () => { if (getSettings().mouseHideWhileTyping) this.el.classList.add("hide-mouse"); }, true);
    this.el.addEventListener("mousemove", () => this.el.classList.remove("hide-mouse"));
    this.el.addEventListener("contextmenu", (e) => { e.preventDefault(); paneHooks.menu(this, e.clientX, e.clientY); });
    this.el.addEventListener("mousedown", () => paneHooks.onFocus(this), true);

    void this.applyTheme();
  }

  // ---------------------------------------------------------------- lifecycle
  /** Element is in the DOM and visible: open xterm once, size it, then start the shell. */
  async attach() {
    if (this.disposed) return;
    if (!this.opened) {
      this.opened = true;
      this.term.open(this.host_);
    }
    this.refit();
    void this.enableGl();
    if (this.spawned) return;
    this.spawned = true;
    const un1 = await pty.onData(this.id, (b) => this.onBytes(b));
    const un2 = await pty.onExit(this.id, (code) => {
      this.exited = true;
      this.running = false;
      if (code === 0 || code === null) paneHooks.onExit(this, code);
      else {
        this.term.write(`\r\n\x1b[90m[Process exited with code ${code}]\x1b[0m\r\n`);
        this.onChange();
      }
    });
    this.unlisten.push(un1, un2);
    if (this.disposed) return this.unlistenAll();
    try {
      let activate = getSettings().shellIntegration ? terminalActivate({ host: this.host, cwd: this.startCwd, command: this.command }) : undefined;
      if (activate instanceof Promise) {
        activate = await activate;
        if (this.disposed) return this.unlistenAll();
      }
      let hookFile: string | undefined;
      try {
        hookFile = (await runSpawnHook({ host: this.host, cwd: this.startCwd, command: this.command, id: this.id })) ?? undefined;
      } catch { /* notifications are optional */ }
      if (this.disposed) return this.unlistenAll();
      await pty.spawn({
        host: this.host, cwd: this.startCwd, command: this.command, login: this.login,
        cols: this.term.cols, rows: this.term.rows, id: this.id, shellIntegration: getSettings().shellIntegration,
        activate, hookFile,
      });
    } catch (e) {
      this.exited = true;
      this.term.write(`\x1b[31mFailed to start terminal: ${String(e)}\x1b[0m\r\n`);
      this.onChange();
    }
  }

  private onBytes(b: Uint8Array) {
    if (this.held) { this.held.push(b); return; }
    if (!this.imagesLoaded && getSettings().images && wantsImages(b)) {
      this.held = [b];
      void this.loadImages().finally(() => {
        const h = this.held ?? [];
        this.held = null;
        for (const x of h) this.feed(x);
      });
      return;
    }
    this.feed(b);
  }
  private feed(b: Uint8Array) {
    this.term.write(b, () => {
      this.pendingAck += b.length;
      if (this.pendingAck >= 128 * 1024) {
        const n = this.pendingAck;
        this.pendingAck = 0;
        void pty.ack(this.id, n).catch(() => {});
      }
    });
  }
  /** Feed bytes as if the shell printed them (tests, local messages). */
  inject(data: string | Uint8Array) {
    if (typeof data === "string") data = new TextEncoder().encode(data);
    this.onBytes(data);
  }

  private async loadImages() {
    try {
      const { ImageAddon } = await import("@xterm/addon-image");
      this.term.loadAddon(new ImageAddon({ sixelSupport: true, sixelScrolling: true, iipSupport: true, storageLimit: 32, enableSizeReports: true }));
      this.imagesLoaded = true;
    } catch {
      /* no inline images */
    }
  }

  private async enableGl() {
    if (this.gl || this.disposed || !this.opened || !this.el.isConnected) return;
    this.glLost = false;
    try {
      const { WebglAddon } = await import("@xterm/addon-webgl");
      if (this.disposed || this.gl) return;
      const gl = new WebglAddon();
      gl.onContextLoss(() => { try { gl.dispose(); } catch {} this.gl = null; this.glActive = false; this.glLost = true; });
      this.term.loadAddon(gl);
      this.gl = gl;
      this.glActive = true;
    } catch {
      this.glLost = true; // DOM renderer
    }
  }
  private disableGl() {
    try { this.gl?.dispose(); } catch {}
    this.gl = null;
    this.glActive = false;
  }

  /** Visible panes use WebGL; hidden ones drop their GPU context (DOM renderer) so many tabs stay cheap. */
  setVisible(v: boolean) {
    if (this.disposed) return;
    if (v) void this.enableGl();
    else this.disableGl();
  }

  refit() {
    cancelAnimationFrame(this.fitRaf);
    this.fitRaf = requestAnimationFrame(() => {
      if (this.disposed || !this.opened || this.host_.clientWidth < 10 || this.host_.clientHeight < 10) return;
      try { this.fit.fit(); } catch {}
    });
  }

  focus() { this.term.focus(); }

  dispose(kill = true) {
    if (this.disposed) return;
    this.disposed = true;
    if (kill) void pty.kill(this.id).catch(() => {});
    this.unlistenAll();
    this.disableGl();
    try { this.term.dispose(); } catch {}
    this.el.remove();
  }
  private unlistenAll() { this.unlisten.forEach((f) => f()); this.unlisten = []; }

  // ---------------------------------------------------------------- settings / theme
  applySettings(s: TermSettings) {
    const o = this.term.options;
    o.fontFamily = s.fontFamily;
    o.fontSize = this.fontOverride ?? s.fontSize;
    o.lineHeight = s.lineHeight;
    o.cursorBlink = s.cursorBlink;
    o.cursorStyle = s.cursorStyle;
    o.scrollback = s.scrollback;
    o.macOptionIsMeta = s.optionAsAlt;
    this.el.style.setProperty("--term-pad", `${s.padding}px`);
    void this.applyTheme(s);
    this.refit();
  }
  async applyTheme(s: Pick<TermSettings, "theme" | "colorOverrides"> = getSettings(), override?: string) {
    const seq = ++this.themeSeq;
    const th = await resolveTheme(override ? { theme: override, colorOverrides: s.colorOverrides } : s);
    if (seq !== this.themeSeq || this.disposed) return;
    this.term.options.theme = th;
    this.el.style.setProperty("--term-bg", th.background ?? "#2e3440");
  }
  get fontSize() { return this.term.options.fontSize ?? getSettings().fontSize; }
  setFontSize(n: number | null) {
    this.fontOverride = n === null ? null : Math.min(60, Math.max(6, n));
    this.term.options.fontSize = this.fontOverride ?? getSettings().fontSize;
    this.refit();
    this.onChange();
  }

  // ---------------------------------------------------------------- keys
  private keyHandler(e: KeyboardEvent): boolean {
    if (e.type !== "keydown") return true;
    const send = (s: string) => { e.preventDefault(); this.sendText(s); return false; };
    if (e.metaKey && !e.ctrlKey && !e.altKey) {
      if (e.code === "ArrowLeft" && !e.shiftKey) return send("\x01");
      if (e.code === "ArrowRight" && !e.shiftKey) return send("\x05");
      if (e.code === "Backspace") return send("\x15");
      return false; // everything else with ⌘ belongs to the keymap, never to the shell
    }
    if (e.altKey && !e.metaKey && !e.ctrlKey && !e.shiftKey) {
      if (e.code === "ArrowLeft") return send("\x1bb");
      if (e.code === "ArrowRight") return send("\x1bf");
    }
    return true;
  }
  sendText(s: string) {
    if (this.writes) this.writes.push(s);
    void pty.write(this.id, s).catch(() => {});
  }

  // ---------------------------------------------------------------- clipboard
  async pasteText(text: string) {
    if (!text) return;
    if (getSettings().pasteProtection && isUnsafePaste(text, this.term.modes.bracketedPasteMode)) {
      const shown = text.length > 700 ? text.slice(0, 700) + "\n…" : text;
      const ok = await confirmDialog({
        title: "Paste Potentially Unsafe Text?",
        message: `This text contains a newline or control characters, so pasting it could run commands immediately.\n\n${shown}`,
        okLabel: "Paste",
      });
      setTimeout(() => this.focus(), 20);
      if (!ok) return;
    }
    this.term.paste(text);
  }
  async pasteFromClipboard() { await this.pasteText(await clipboardRead()); }
  copySelection(): boolean {
    const sel = this.term.getSelection();
    if (!sel) return false;
    void clipboardWrite(sel);
    return true;
  }

  private async osc52(data: string) {
    const i = data.indexOf(";");
    const sel = (i > 0 ? data.slice(0, i) : "c") || "c";
    const pd = data.slice(i + 1);
    const s = getSettings();
    if (pd === "?") {
      if (s.clipboardRead === "deny") return;
      if (s.clipboardRead === "ask") {
        const ok = await confirmDialog({ title: "Allow Clipboard Read?", message: "An application in this terminal wants to read your clipboard.", okLabel: "Allow" });
        setTimeout(() => this.focus(), 20);
        if (!ok) return;
      }
      this.sendText(`\x1b]52;${sel};${utf8ToBase64(await clipboardRead())}\x07`);
      return;
    }
    if (s.clipboardWrite === "deny") return;
    let text: string;
    try { text = base64ToUtf8(pd); } catch { return; }
    if (s.clipboardWrite === "ask") {
      const ok = await confirmDialog({ title: "Allow Clipboard Write?", message: `An application in this terminal wants to copy ${text.length} characters to your clipboard.`, okLabel: "Allow" });
      setTimeout(() => this.focus(), 20);
      if (!ok) return;
    }
    await clipboardWrite(text);
  }

  // ---------------------------------------------------------------- OSC handlers
  private osc7(d: string) {
    const m = /^file:\/\/[^/]*(\/.*)$/.exec(d);
    if (m) {
      try { this.cwd = decodeURIComponent(m[1]); } catch { this.cwd = m[1]; }
      this.cwdFromShell = true;
    }
    return true;
  }
  private osc133(d: string) {
    const t = this.term;
    const kind = d[0];
    const mark = () => t.registerMarker(0);
    if (kind === "A") {
      const m = mark();
      if (m) {
        this.blocks.push({ prompt: m });
        if (this.blocks.length > 400) this.blocks.splice(0, this.blocks.length - 400);
      }
    } else if (kind === "C") {
      const b = this.blocks[this.blocks.length - 1];
      const m = mark();
      if (b && m) b.out = m;
      this.running = true;
      this.onChange();
    } else if (kind === "D") {
      const b = this.blocks[this.blocks.length - 1];
      const m = mark();
      if (b && b.out && m) {
        b.end = m;
        b.endAtCol0 = t.buffer.active.cursorX === 0;
        const n = parseInt(d.split(";")[1] ?? "", 10);
        b.exit = Number.isNaN(n) ? undefined : n;
        this.lastExit = b.exit ?? null;
      }
      this.running = false;
      this.onChange();
    }
    return true;
  }
  private osc9(d: string) {
    if (/^\d+;/.test(d)) return true; // ConEmu extensions (progress, ...)
    void this.notify(this.title || "Terminal", d);
    return true;
  }
  private osc777(d: string) {
    const p = d.split(";");
    if (p[0] === "notify") void this.notify(p[1] || this.title || "Terminal", p.slice(2).join(";"));
    return true;
  }
  async notify(title: string, body: string) {
    if (!getSettings().notifications) return false;
    return desktopNotify(title, body);
  }
  private ringBell() {
    if (!getSettings().bellVisual) return;
    this.bell = !this.el.contains(document.activeElement) || !document.hasFocus();
    this.el.classList.remove("bell-flash");
    void this.el.offsetWidth;
    this.el.classList.add("bell-flash");
    this.onChange();
  }

  // ---------------------------------------------------------------- links
  async openUri(uri: string) {
    if (qaHooks.openUrl) return qaHooks.openUrl(uri);
    if (/^file:\/\//i.test(uri)) {
      try { void openFile(local(decodeURIComponent(new URL(uri).pathname))); } catch {}
      return;
    }
    await openExternal(uri);
  }

  // ---------------------------------------------------------------- prompt marks (OSC 133)
  private liveBlocks() { return this.blocks.filter((b) => !b.prompt.isDisposed && b.prompt.line >= 0); }
  /** Scroll to the previous (-1) / next (+1) shell prompt relative to the viewport top. */
  jumpToPrompt(dir: -1 | 1): boolean {
    const top = this.term.buffer.active.viewportY;
    const lines = this.liveBlocks().map((b) => b.prompt.line).sort((a, b) => a - b);
    const target = dir < 0 ? [...lines].reverse().find((l) => l < top) : lines.find((l) => l > top);
    if (target === undefined) {
      if (dir > 0) this.term.scrollToBottom();
      return false;
    }
    this.term.scrollToLine(target);
    return true;
  }
  /** Select the output of the last finished (or running) command. */
  selectLastOutput(): boolean {
    const t = this.term;
    const b = [...this.liveBlocks()].reverse().find((x) => x.out && !x.out.isDisposed);
    if (!b?.out) return false;
    const buf = t.buffer.active;
    let start = b.out.line;
    let end = b.end && !b.end.isDisposed ? (b.endAtCol0 ? b.end.line - 1 : b.end.line) : buf.baseY + buf.cursorY;
    while (end > start && !buf.getLine(end)?.translateToString(true).trim()) end--;
    while (start < end && !buf.getLine(start)?.translateToString(true).trim()) start++;
    if (end < start) return false;
    t.selectLines(start, end);
    return true;
  }

  // ---------------------------------------------------------------- search
  private searchOpts() {
    return {
      caseSensitive: this.search.caseSensitive, regex: this.search.regex,
      decorations: {
        matchBackground: "#4c566a", matchBorder: "#ebcb8b", matchOverviewRuler: "#ebcb8b",
        activeMatchBackground: "#d08770", activeMatchBorder: "#ebcb8b", activeMatchColorOverviewRuler: "#d08770",
      },
    };
  }
  openSearch() { this.search.open = true; this.onChange(); }
  closeSearch() {
    this.search.open = false;
    this.search.index = -1;
    this.search.count = 0;
    this.searchAddon.clearDecorations();
    this.term.clearSelection();
    this.onChange();
    this.focus();
  }
  setSearch(q: string, o?: { caseSensitive?: boolean; regex?: boolean }) {
    Object.assign(this.search, { query: q }, o ?? {});
    if (!q) { this.searchAddon.clearDecorations(); this.search.index = -1; this.search.count = 0; this.onChange(); return; }
    this.searchAddon.findNext(q, { ...this.searchOpts(), incremental: true });
  }
  searchNext() { if (this.search.query) this.searchAddon.findNext(this.search.query, this.searchOpts()); }
  searchPrev() { if (this.search.query) this.searchAddon.findPrevious(this.search.query, this.searchOpts()); }

  // ---------------------------------------------------------------- process state
  async isBusy(): Promise<boolean> {
    if (this.exited) return false;
    if (this.running) return true;
    return invoke<boolean>("pty_busy", { id: this.id }).catch(() => false);
  }
  /** Current directory for "new tab / split inherits cwd": OSC 7 when available, else the foreground process's cwd. */
  async currentCwd(): Promise<string> {
    if (this.cwdFromShell || this.host !== "local") return this.cwd;
    return (await invoke<string | null>("pty_cwd", { id: this.id }).catch(() => null)) ?? this.cwd;
  }
  location(): Location { return { host: this.host, path: this.cwd }; }
}

// apply setting changes to every live pane
export function watchSettings(forEach: (f: (p: Pane) => void) => void) {
  let prev = getSettings();
  settingsStore.subscribe(() => {
    const next = getSettings();
    if (next === prev) return;
    prev = next;
    forEach((p) => p.applySettings(next));
  });
  window.matchMedia?.("(prefers-color-scheme: dark)").addEventListener?.("change", () => forEach((p) => void p.applyTheme()));
  onSchemeChange(() => forEach((p) => void p.applyTheme())); // IDE colour scheme switched: re-theme panes that follow it
}
