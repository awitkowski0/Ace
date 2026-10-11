/** Terminal model: tabs, each a split tree of panes. Lives outside React so shells survive the tool window being hidden. */
import { createStore } from "../../lib/store";
import { hideToolWindow, showToolWindow } from "../../lib/layout";
import { confirmDialog, promptDialog } from "../shell/dialogs";
import { showContextMenu } from "../shell/contextMenu";
import { Pane, paneHooks, watchSettings, type PaneSpec } from "./pane";
import { cycle, equalize, findSplit, layoutSplits, leaf, leaves, neighbor, removeLeaf, resizePane, resizeTarget, setRatio, splitLeaf, type Dir, type Direction, type Node } from "./splitTree";
import { getSettings } from "./settings";

export interface Tab { id: string; custom?: string; root: Node; focus: string; zoom: string | null }

export const termStore = createStore<{ tabs: Tab[]; active: string | null; version: number }>({ tabs: [], active: null, version: 0 });
export const quickStore = createStore<{ open: boolean; pane: Pane | null }>({ open: false, pane: null });

const panes = new Map<string, Pane>();
export const getPane = (id: string) => panes.get(id);
export const allPanes = () => [...panes.values(), ...(quickStore.get().pane ? [quickStore.get().pane!] : [])];
export const getTab = (id: string | null) => termStore.get().tabs.find((t) => t.id === id);
export const activeTab = () => getTab(termStore.get().active);
const bump = () => termStore.set((s) => ({ version: s.version + 1 }));
let tabSeq = 0;
let wantFocusId: string | null = null;
let wantFocusAt = 0;
/** Focus request that the next mounted pane with this id should honour (valid for 2 s). */
const setWant = (id: string | null) => { wantFocusId = id; wantFocusAt = Date.now(); };
export const takeWantFocus = (id: string) => {
  const ok = wantFocusId === id && Date.now() - wantFocusAt < 2000;
  if (wantFocusId === id) wantFocusId = null;
  return ok;
};

const updateTab = (id: string, f: (t: Tab) => Partial<Tab>) =>
  termStore.set((s) => ({ tabs: s.tabs.map((t) => (t.id === id ? { ...t, ...f(t) } : t)) }));

paneHooks.onFocus = (p) => {
  const t = tabOf(p.id);
  if (!t) return;
  if (t.focus !== p.id) updateTab(t.id, () => ({ focus: p.id }));
};
paneHooks.onExit = (p) => {
  if (p.quick) { quickStore.set({ pane: null, open: false }); p.dispose(false); return; }
  void removePane(p.id, false);
};
watchSettings((f) => allPanes().forEach(f));

export function tabOf(paneId: string): Tab | undefined {
  return termStore.get().tabs.find((t) => leaves(t.root).includes(paneId));
}
export const focusedPane = (): Pane | undefined => {
  const t = activeTab();
  return t ? panes.get(t.focus) : undefined;
};
/** The pane that has DOM focus (including the quick terminal), else the active tab's focused pane. */
export function targetPane(): Pane | undefined {
  const ae = document.activeElement;
  if (ae) for (const p of allPanes()) if (p.el.contains(ae)) return p;
  return focusedPane();
}
export const isQuick = (p: Pane | undefined) => !!p?.quick;

const baseName = (p: string) => p.replace(/\/+$/, "").slice(p.lastIndexOf("/") + 1) || p;
export const defaultCwdName = baseName;

function newPane(spec: PaneSpec, title?: string): Pane {
  const p = new Pane(spec);
  p.onChange = bump;
  const same = [...panes.values()].filter((x) => x.host === spec.host && !x.command).length;
  p.defaultTitle = title ?? (spec.command ? spec.command.split(/\s+/)[0] : spec.host === "local" ? "Local" : spec.host) + (!title && !spec.command && same ? ` (${same + 1})` : "");
  panes.set(p.id, p);
  return p;
}

export function tabTitle(t: Tab): string {
  if (t.custom) return t.custom;
  const p = panes.get(t.focus);
  return p?.title || p?.defaultTitle || "Terminal";
}
/** Re-render subscribers (tab badges that live outside this model, e.g. Claude's "waiting" dots). */
export const bumpTerm = bump;
/** Late-bound by the Claude module: badge shown on a terminal tab (null = none). */
export const tabDecor: { badge: (t: Tab) => { text: string; title: string; kind: string } | null } = { badge: () => null };
/** Is this pane's terminal on screen right now (tool window showing, its tab active, split not hidden by zoom)? */
export function paneVisible(id: string): boolean {
  const p = panes.get(id);
  const t = tabOf(id);
  if (!p || !t || termStore.get().active !== t.id) return false;
  if (t.zoom && t.zoom !== id) return false;
  return p.el.isConnected && !!p.el.closest('.toolwindow[data-toolwindow="terminal"]');
}
export const tabHasBell = (t: Tab) => leaves(t.root).some((id) => panes.get(id)?.bell);

// ------------------------------------------------------------------ tabs
/** New tab with one shell. Returns the tab id (cross-module contract `openTerminal`). */
export function createSession(o: { host: string; cwd: string; command?: string; title?: string; login?: boolean }, at?: number): string {
  const p = newPane({ host: o.host, cwd: o.cwd, command: o.command, login: o.login });
  return addTab(p, o.title, at);
}
function addTab(p: Pane, custom?: string, at?: number, root?: Node, focus?: string): string {
  const id = `tab${++tabSeq}`;
  const tab: Tab = { id, custom, root: root ?? leaf(p.id), focus: focus ?? p.id, zoom: null };
  setWant(tab.focus);
  termStore.set((s) => {
    const tabs = [...s.tabs];
    tabs.splice(at ?? tabs.length, 0, tab);
    return { tabs, active: id };
  });
  return id;
}
/** ⌘T: a new tab in the focused shell's directory (on the same host). */
export async function newTabInherit(): Promise<string | null> {
  const f = targetPane();
  const root = lastRoot;
  if (!f || f.quick) return createSession({ host: root.host, cwd: root.path });
  const cwd = await f.currentCwd();
  return createSession({ host: f.host, cwd });
}
let lastRoot = { host: "local", path: "~" };
export const setLastRoot = (r: { host: string; path: string }) => (lastRoot = r);
export const getLastRoot = () => lastRoot;

export function setActive(id: string) {
  const t = getTab(id);
  if (!t) return;
  setWant(t.focus);
  termStore.set({ active: id });
}
export function selectTab(delta: number) {
  const { tabs, active } = termStore.get();
  if (!tabs.length) return;
  const i = tabs.findIndex((t) => t.id === active);
  setActive(tabs[(i + delta + tabs.length) % tabs.length].id);
}
export function gotoTab(n: number) {
  const { tabs } = termStore.get();
  const t = n < 0 ? tabs[tabs.length - 1] : tabs[n - 1];
  if (t) setActive(t.id);
}
export function moveTab(delta: number, id = termStore.get().active) {
  const tabs = [...termStore.get().tabs];
  const i = tabs.findIndex((t) => t.id === id);
  const j = Math.min(tabs.length - 1, Math.max(0, i + delta));
  if (i < 0 || i === j) return;
  [tabs[i], tabs[j]] = [tabs[j], tabs[i]];
  termStore.set({ tabs });
}
export async function renameTabPrompt(id: string) {
  const t = getTab(id);
  if (!t) return;
  const v = await promptDialog({ title: "Rename Tab", initial: tabTitle(t) });
  if (v !== null) updateTab(id, () => ({ custom: v.trim() || undefined }));
  setTimeout(() => getPane(getTab(id)?.focus ?? "")?.focus(), 20);
}
export const renameTab = (id: string, title: string) => updateTab(id, () => ({ custom: title.trim() || undefined }));

// ------------------------------------------------------------------ closing (+ undo)
interface SLeaf { t: "leaf"; host: string; cwd: string; command?: string; login?: boolean; fontSize?: number }
type SNode = SLeaf | { t: "split"; dir: Dir; ratio: number; a: SNode; b: SNode };
type Closed =
  | { kind: "tab"; at: number; custom?: string; root: SNode; focusIdx: number; when: number }
  | { kind: "split"; tabId: string; sibling: string; dir: Dir; leaf: SLeaf; when: number };
const closed: Closed[] = [];
const UNDO_MS = 5 * 60_000;
export const undoDepth = () => closed.filter((c) => Date.now() - c.when < UNDO_MS).length;

async function snap(n: Node): Promise<SNode> {
  if (n.t === "leaf") {
    const p = panes.get(n.pane)!;
    return { t: "leaf", host: p.host, cwd: await p.currentCwd(), command: p.command, login: p.login, fontSize: p.fontOverride ?? undefined };
  }
  return { t: "split", dir: n.dir, ratio: n.ratio, a: await snap(n.a), b: await snap(n.b) };
}
function build(n: SNode, ids: string[]): Node {
  if (n.t === "leaf") {
    const p = newPane({ host: n.host, cwd: n.cwd, command: n.command, login: n.login, fontSize: n.fontSize });
    ids.push(p.id);
    return leaf(p.id);
  }
  const a = build(n.a, ids);
  const b = build(n.b, ids);
  return { t: "split", id: `r${++tabSeq}`, dir: n.dir, ratio: n.ratio, a, b };
}

async function confirmBusy(ps: Pane[], what: string): Promise<boolean> {
  if (!getSettings().confirmClose) return true;
  const busy = (await Promise.all(ps.map((p) => p.isBusy()))).some(Boolean);
  if (!busy) return true;
  const ok = await confirmDialog({ title: `Close ${what}?`, message: "A process is still running in this terminal. Closing it will terminate the process.", okLabel: "Close" });
  setTimeout(() => focusedPane()?.focus(), 20);
  return ok;
}

export async function closeTab(id: string, o: { confirm?: boolean } = { confirm: true }): Promise<boolean> {
  const t = getTab(id);
  if (!t) return false;
  const ps = leaves(t.root).map((x) => panes.get(x)!).filter(Boolean);
  if (o.confirm !== false && !(await confirmBusy(ps, ps.length > 1 ? "Tab" : "Terminal"))) return false;
  const at = termStore.get().tabs.findIndex((x) => x.id === id);
  const root = await snap(t.root);
  closed.push({ kind: "tab", at, custom: t.custom, root, focusIdx: Math.max(0, leaves(t.root).indexOf(t.focus)), when: Date.now() });
  dropTab(id);
  return true;
}
function dropTab(id: string) {
  const t = getTab(id);
  if (!t) return;
  for (const pid of leaves(t.root)) { panes.get(pid)?.dispose(); panes.delete(pid); }
  const { tabs, active } = termStore.get();
  const i = tabs.findIndex((x) => x.id === id);
  const rest = tabs.filter((x) => x.id !== id);
  const next = active === id ? rest[Math.min(i, rest.length - 1)]?.id ?? null : active;
  if (next && next !== active) setWant(getTab(next)?.focus ?? null);
  termStore.set({ tabs: rest, active: next });
  if (!rest.length && document.querySelector('.toolwindow[data-toolwindow="terminal"]')) hideToolWindow("terminal");
}

/** ⌘W: closes the focused split, or the tab when it is the last split. */
export async function closeSurface(id?: string, o: { confirm?: boolean } = { confirm: true }): Promise<boolean> {
  const p = id ? panes.get(id) : targetPane();
  if (!p) return false;
  if (p.quick) { hideQuick(true); return true; }
  const t = tabOf(p.id);
  if (!t) return false;
  if (leaves(t.root).length === 1) return closeTab(t.id, o);
  if (o.confirm !== false && !(await confirmBusy([p], "Split"))) return false;
  const sib = siblingOf(t.root, p.id);
  const dir = parentDir(t.root, p.id);
  const sl = (await snap(leaf(p.id))) as SLeaf;
  if (sib && dir) closed.push({ kind: "split", tabId: t.id, sibling: sib, dir, leaf: sl, when: Date.now() });
  await removePane(p.id, true);
  return true;
}
function parentDir(n: Node, pane: string): Dir | null {
  if (n.t === "leaf") return null;
  if ((n.a.t === "leaf" && n.a.pane === pane) || (n.b.t === "leaf" && n.b.pane === pane)) return n.dir;
  return parentDir(n.a, pane) ?? parentDir(n.b, pane);
}
function siblingOf(n: Node, pane: string): string | null {
  if (n.t === "leaf") return null;
  if (n.a.t === "leaf" && n.a.pane === pane) return leaves(n.b)[0];
  if (n.b.t === "leaf" && n.b.pane === pane) return leaves(n.a).slice(-1)[0];
  return siblingOf(n.a, pane) ?? siblingOf(n.b, pane);
}

/** Remove one pane from its tab (the shell exited, or the split was closed). */
async function removePane(id: string, kill: boolean) {
  const p = panes.get(id);
  const t = tabOf(id);
  if (!p || !t) return;
  const l = leaves(t.root);
  const root = removeLeaf(t.root, id);
  if (!root) { p.dispose(kill); panes.delete(id); dropTab(t.id); return; }
  const nl = leaves(root);
  const focus = t.focus === id ? nl[Math.min(l.indexOf(id), nl.length - 1)] : t.focus;
  p.dispose(kill);
  panes.delete(id);
  if (t.focus === id) setWant(focus);
  updateTab(t.id, () => ({ root, focus, zoom: t.zoom === id ? null : t.zoom }));
}

export async function undoClose(): Promise<boolean> {
  while (closed.length) {
    const c = closed.pop()!;
    if (Date.now() - c.when > UNDO_MS) continue;
    if (c.kind === "tab") {
      const ids: string[] = [];
      const root = build(c.root, ids);
      addTab(panes.get(ids[0])!, c.custom, Math.min(c.at, termStore.get().tabs.length), root, ids[Math.min(c.focusIdx, ids.length - 1)]);
      showToolWindow("terminal");
      return true;
    }
    const t = getTab(c.tabId);
    if (t && panes.has(c.sibling) && leaves(t.root).includes(c.sibling)) {
      const p = newPane({ host: c.leaf.host, cwd: c.leaf.cwd, fontSize: c.leaf.fontSize });
      setWant(p.id);
      updateTab(t.id, (x) => ({ root: splitLeaf(x.root, c.sibling, p.id, c.dir), focus: p.id, zoom: null }));
      termStore.set({ active: t.id });
      return true;
    }
    // the tab it belonged to is gone: bring the shell back as a tab
    createSession({ host: c.leaf.host, cwd: c.leaf.cwd });
    return true;
  }
  return false;
}

// ------------------------------------------------------------------ splits
export async function splitPane(dir: Dir, from?: Pane): Promise<string | null> {
  const f = from ?? targetPane();
  if (!f || f.quick) return null;
  const t = tabOf(f.id);
  if (!t) return null;
  const cwd = await f.currentCwd();
  const p = newPane({ host: f.host, cwd, fontSize: f.fontOverride ?? undefined });
  setWant(p.id);
  updateTab(t.id, (x) => ({ root: splitLeaf(x.root, f.id, p.id, dir), focus: p.id, zoom: null }));
  return p.id;
}
export function focusPane(id: string) {
  const p = panes.get(id);
  const t = tabOf(id);
  if (!p || !t) return;
  setWant(id);
  if (termStore.get().active !== t.id) termStore.set({ active: t.id });
  if (t.focus !== id) updateTab(t.id, () => ({ focus: id }));
  if (p.opened && p.el.isConnected) { setWant(null); p.focus(); }
}
export function gotoSplit(to: "previous" | "next" | Direction) {
  const t = activeTab();
  if (!t) return;
  const cur = targetPane()?.id ?? t.focus;
  const target = to === "next" ? cycle(t.root, cur, 1) : to === "previous" ? cycle(t.root, cur, -1) : neighbor(t.root, cur, to);
  if (t.zoom && target && target !== t.zoom) updateTab(t.id, () => ({ zoom: null }));
  if (target) focusPane(target);
}
export function equalizeSplits() {
  const t = activeTab();
  if (t) updateTab(t.id, (x) => ({ root: equalize(x.root) }));
}
/** Move a divider by `px` pixels (Ghostty resize_split). */
export function resizeSplit(dir: Direction, px = 10) {
  const t = activeTab();
  const host = document.querySelector<HTMLElement>(".term-splits");
  if (!t || !host) return;
  const cur = targetPane()?.id ?? t.focus;
  const target = resizeTarget(t.root, cur, dir);
  const sp = target && layoutSplits(t.root).find((s) => s.id === target.id);
  if (!sp) return;
  const extent = (target.dir === "row" ? host.clientWidth * sp.rect.w : host.clientHeight * sp.rect.h) || 1;
  updateTab(t.id, (x) => ({ root: resizePane(x.root, cur, dir, px / extent) }));
}
export function setSplitRatio(tabId: string, splitId: string, ratio: number) {
  updateTab(tabId, (x) => ({ root: setRatio(x.root, splitId, ratio) }));
}
export const splitRatio = (tabId: string, splitId: string) => {
  const t = getTab(tabId);
  return t ? findSplit(t.root, splitId)?.ratio : undefined;
};
export function toggleZoom() {
  const t = activeTab();
  if (!t || leaves(t.root).length < 2) return;
  const cur = targetPane()?.id ?? t.focus;
  setWant(cur);
  updateTab(t.id, (x) => ({ zoom: x.zoom ? null : cur, focus: cur }));
}

// ------------------------------------------------------------------ quick terminal
let quickPrev: Element | null = null;
export function toggleQuick() {
  const { open } = quickStore.get();
  if (open) return hideQuick(true);
  let p = quickStore.get().pane;
  if (!p || p.disposed) {
    p = new Pane({ host: "local", cwd: lastRoot.host === "local" ? lastRoot.path : "~" });
    p.quick = true;
    p.defaultTitle = "Quick Terminal";
    p.onChange = bump;
  }
  quickPrev = document.activeElement;
  quickStore.set({ open: true, pane: p });
}
/** Hide the drop-down. `restore`: give focus back to where it was (toggle / ⌘W); autohide leaves focus where the user put it. */
export function hideQuick(restore = true) {
  quickStore.set({ open: false });
  const prev = quickPrev;
  quickPrev = null;
  if (restore) setTimeout(() => { if (prev instanceof HTMLElement && prev.isConnected) prev.focus(); else focusedPane()?.focus(); }, 30);
}

// ------------------------------------------------------------------ context menu
paneHooks.menu = (p, x, y) => {
  const has = p.term.hasSelection();
  showContextMenu(x, y, [
    { label: "Copy", shortcut: "⌘C", disabled: !has, run: () => p.copySelection() },
    { label: "Paste", shortcut: "⌘V", run: () => void p.pasteFromClipboard() },
    { label: "Select All", shortcut: "⌘A", run: () => p.term.selectAll() },
    { label: "", separator: true },
    { label: "Find…", shortcut: "⌘F", run: () => { p.openSearch(); } },
    { label: "Clear Screen", shortcut: "⌘K", run: () => p.term.clear() },
    ...(p.quick ? [] : [
      { label: "", separator: true },
      { label: "Split Right", shortcut: "⌘D", run: () => void splitPane("row", p) },
      { label: "Split Down", shortcut: "⇧⌘D", run: () => void splitPane("col", p) },
      { label: "Close Split", shortcut: "⌘W", run: () => void closeSurface(p.id) },
    ]),
  ]);
};
