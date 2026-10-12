import { createStore } from "../lib/store";
import { basename, fs, locKey, type Location } from "../lib/ipc";
import { languageFor } from "./languages";
import { confirmDialog } from "../components/shell/dialogs";
import type { DiffSpec } from "../components/git/diff";
import { decide, refine, type DualId, type ViewerId } from "./viewers/registry";

export interface Doc {
  key: string;
  kind?: "file" | "diff"; // default "file"
  diff?: DiffSpec; // kind === "diff"
  pinned?: boolean;
  loc: Location;
  name: string;
  language: string;
  initial: string; // content at load (Monaco model default value)
  saved: string; // last saved/loaded content
  dirty: boolean;
  error?: string;
  /** bytes-only viewer tab (image, audio, ...): no Monaco model, `initial`/`saved` are empty */
  viewer?: ViewerId;
  /** text doc that also has a rendered view (Markdown, CSV, SVG, ...) */
  dual?: DualId;
  /** bumped on external change so viewers reload their bytes */
  rev?: number;
  size?: number;
}
export interface Group {
  id: string;
  tabs: string[];
  active: string | null;
}
export type LayoutNode = { type: "group"; id: string } | { type: "split"; dir: "row" | "column"; children: LayoutNode[] };

interface EditorState {
  docs: Record<string, Doc>;
  groups: Record<string, Group>;
  layout: LayoutNode;
  activeGroup: string;
  cursor: { line: number; col: number };
  recent: string[]; // doc keys, most recent first
  /** one-shot "put the caret here once the model is mounted" request (consumed by EditorArea) */
  reveal: RevealRequest | null;
}
export interface RevealRequest {
  key: string;
  line: number;
  col: number;
  /** select `select` characters from line:col, or up to {endLine,endCol} */
  select?: number | { endLine: number; endCol: number };
  nonce: number;
}
export interface OpenOptions {
  line?: number | null;
  col?: number | null;
  select?: RevealRequest["select"];
  group?: string;
  /** do not record the jump in navigation history (Back/Forward uses this itself) */
  noHistory?: boolean;
}

/** IntelliJ default "Tab limit". Oldest unpinned, clean tab is closed when a group exceeds it. */
export const MAX_TABS = 10;

let seq = 1;
const newId = () => `g${seq++}`;
const first = newId();

export const editorStore = createStore<EditorState>({
  docs: {},
  groups: { [first]: { id: first, tabs: [], active: null } },
  layout: { type: "group", id: first },
  activeGroup: first,
  cursor: { line: 1, col: 1 },
  recent: [],
  reveal: null,
});

// ---- hooks the (lazy) Monaco layer installs ----
let getText: (key: string) => string | undefined = () => undefined;
let setText: (key: string, text: string) => void = () => {};
let disposeModel: (key: string) => void = () => {};
export const installModelBridge = (b: { getText: typeof getText; setText: typeof setText; dispose: typeof disposeModel }) => {
  getText = b.getText;
  setText = b.setText;
  disposeModel = b.dispose;
};

const S = () => editorStore.get();
const activeGroup = () => S().groups[S().activeGroup];
export const activeDocKey = () => activeGroup()?.active ?? null;

function patchGroup(id: string, g: Partial<Group>) {
  editorStore.set((s) => ({ groups: { ...s.groups, [id]: { ...s.groups[id], ...g } } }));
}

// ---- navigation history (Back / Forward, ⌘[ ⌘]) ----
interface NavEntry { key: string; loc: Location; line: number; col: number }
const navBack: NavEntry[] = [];
const navFwd: NavEntry[] = [];
const NAV_MAX = 100;

export function currentPosition(): NavEntry | null {
  const key = activeDocKey();
  const d = key ? S().docs[key] : undefined;
  if (!key || !d || d.kind === "diff" || d.error) return null;
  if (d.viewer) return { key, loc: d.loc, line: 1, col: 1 };
  return { key, loc: d.loc, line: S().cursor.line, col: S().cursor.col };
}
/** Record the current caret position as a navigation-history entry (call before programmatic jumps). */
export function markNavigation() { recordJump(); }
function recordJump() {
  const p = currentPosition();
  if (!p) return;
  const last = navBack[navBack.length - 1];
  if (last && last.key === p.key && Math.abs(last.line - p.line) < 1) return;
  navBack.push(p);
  if (navBack.length > NAV_MAX) navBack.shift();
  navFwd.length = 0;
}
export const navigationHistory = () => ({ back: [...navBack], forward: [...navFwd] });
export const canGoBack = () => navBack.length > 0;
export const canGoForward = () => navFwd.length > 0;
async function goTo(e: NavEntry) {
  await openFile(e.loc, { line: e.line, col: e.col, noHistory: true });
}
export async function navigateBack() {
  const e = navBack.pop();
  if (!e) return;
  const cur = currentPosition();
  if (cur) navFwd.push(cur);
  await goTo(e);
}
export async function navigateForward() {
  const e = navFwd.pop();
  if (!e) return;
  const cur = currentPosition();
  if (cur) navBack.push(cur);
  await goTo(e);
}

let revealSeq = 1;

/**
 * Open a file in a tab and (optionally) put the caret at line:col (1-based), selecting `select` characters / a range.
 * The returned promise resolves once the tab is active; the caret move happens as soon as the Monaco model is mounted
 * (EditorArea consumes `reveal`), so callers need no polling.
 *   openFile(loc)                                  plain open
 *   openFile(loc, { line: 12, col: 5 })            go to
 *   openFile(loc, { line: 12, col: 5, select: 8 }) go to + select 8 chars (search results)
 * Passing a group id string as 2nd arg is still supported.
 */
export async function openFile(loc: Location, arg?: string | OpenOptions) {
  const opts: OpenOptions = typeof arg === "string" ? { group: arg } : (arg ?? {});
  const key = locKey(loc);
  if (!opts.noHistory && (opts.line || activeDocKey() !== key)) recordJump();
  if (!S().docs[key]) await loadDoc(loc, key);
  const g = S().groups[opts.group ?? S().activeGroup] ?? activeGroup();
  addTab(g.id, key);
  editorStore.set((s) => ({
    activeGroup: g.id,
    recent: [key, ...s.recent.filter((k) => k !== key)].slice(0, 50),
    reveal: opts.line && !S().docs[key]?.viewer ? { key, line: opts.line, col: opts.col ?? 1, select: opts.select, nonce: revealSeq++ } : s.reveal,
  }));
  enforceTabLimit(g.id);
}

/** Read a file into a Doc: a viewer tab for binary/media types, a text doc (possibly with a rendered view) otherwise. */
async function loadDoc(loc: Location, key: string, forceText = false) {
  const name = basename(loc.path);
  try {
    let d = decide(name, loc.path);
    if (forceText && (d.viewer === "binary" || d.viewer === "toolarge")) d = { needsProbe: false };
    let size: number | undefined;
    if (!d.viewer) {
      // local probes are one tiny read; remote ones cost an ssh round trip, so only sniff unknown types there
      const probe = loc.host === "local" || d.needsProbe ? await Promise.resolve(fs.probe?.(loc)).catch(() => null) : null;
      size = probe?.size;
      d = refine(d, probe ?? null, forceText);
    }
    if (d.viewer) {
      const doc: Doc = { key, loc, name, language: "plaintext", initial: "", saved: "", dirty: false, viewer: d.viewer, rev: 0, size };
      editorStore.set((s) => ({ docs: { ...s.docs, [key]: doc } }));
      return;
    }
    const text = await fs.readFile(loc);
    const doc: Doc = { key, loc, name, language: languageFor(name), initial: text, saved: text, dirty: false, dual: d.dual, size };
    editorStore.set((s) => ({ docs: { ...s.docs, [key]: doc } }));
  } catch (e) {
    const doc: Doc = { key, loc, name, language: "plaintext", initial: "", saved: "", dirty: false, error: String(e) };
    editorStore.set((s) => ({ docs: { ...s.docs, [key]: doc } }));
  }
}
/** "Open anyway" on the too-large placeholder: reload the same tab as text. */
export async function openAsText(key: string) {
  const d = S().docs[key];
  if (d) await loadDoc(d.loc, key, true);
}

/** Insert `key` as the active tab (after pinned tabs when new). */
function addTab(groupId: string, key: string) {
  const g = S().groups[groupId];
  if (!g) return;
  patchGroup(groupId, { tabs: g.tabs.includes(key) ? g.tabs : [...g.tabs, key], active: key });
}

/** IntelliJ "Tab limit": close the least recently used clean, unpinned tab(s) beyond MAX_TABS. */
function enforceTabLimit(groupId: string) {
  for (;;) {
    const g = S().groups[groupId];
    if (!g || g.tabs.length <= MAX_TABS) return;
    const { docs, recent } = S();
    const victims = g.tabs
      .filter((k) => k !== g.active && !docs[k]?.pinned && !docs[k]?.dirty)
      .sort((a, b) => (recent.indexOf(b) === -1 ? 1e9 : recent.indexOf(b)) - (recent.indexOf(a) === -1 ? 1e9 : recent.indexOf(a)));
    if (!victims.length) return;
    forceCloseTab(groupId, victims[0]);
  }
}

export function activateTab(groupId: string, key: string) {
  if (S().groups[groupId]?.active !== key || S().activeGroup !== groupId) recordJump();
  patchGroup(groupId, { active: key });
  const isFile = S().docs[key]?.kind !== "diff";
  editorStore.set((s) => ({ activeGroup: groupId, recent: isFile ? [key, ...s.recent.filter((k) => k !== key)] : s.recent }));
}
export const setActiveGroup = (id: string) => editorStore.get().activeGroup !== id && editorStore.set({ activeGroup: id });
export const setCursor = (line: number, col: number) => editorStore.set({ cursor: { line, col } });
export const consumeReveal = (nonce: number) => S().reveal?.nonce === nonce && editorStore.set({ reveal: null });

// ---- diff tabs ----
/** Diff tab ⌘S hook: DiffView's modified-side controller registers here. */
export interface DiffController { getRight(): string; setReadOnly?(ro: boolean): void }
const diffControllers = new Map<string, DiffController>();
export const registerDiffController = (key: string, c: DiffController) => { diffControllers.set(key, c); return () => diffControllers.delete(key); };

/** Open a side-by-side diff as an editor tab (IntelliJ parity). Re-opening the same diff focuses its tab. */
export function openDiff(spec: DiffSpec, groupId: string = S().activeGroup) {
  const key = `diff:${spec.title}|${spec.leftLabel}|${spec.rightLabel}`;
  if (!S().docs[key]) {
    const doc: Doc = {
      key, kind: "diff", diff: spec, loc: spec.openLoc ?? { host: "diff", path: spec.title },
      name: spec.name, language: "plaintext", initial: "", saved: "", dirty: false,
    };
    editorStore.set((s) => ({ docs: { ...s.docs, [key]: doc } }));
  }
  const g = S().groups[groupId] ?? activeGroup();
  addTab(g.id, key);
  editorStore.set({ activeGroup: g.id });
  enforceTabLimit(g.id);
}
export function setDiffDirty(key: string, dirty: boolean) {
  const d = S().docs[key];
  if (d && d.dirty !== dirty) editorStore.set((s) => ({ docs: { ...s.docs, [key]: { ...d, dirty } } }));
}

export function setDirtyFromText(key: string, text: string) {
  const d = S().docs[key];
  if (!d) return;
  const dirty = text !== d.saved;
  if (dirty !== d.dirty) editorStore.set((s) => ({ docs: { ...s.docs, [key]: { ...d, dirty } } }));
}

export async function saveDoc(key: string) {
  const d = S().docs[key];
  if (d?.kind === "diff") {
    // ⌘S in a diff tab saves the right (working-tree) side back to its file
    const c = diffControllers.get(key);
    if (!c || !d.diff?.openLoc || !d.dirty) return;
    const text = c.getRight();
    await fs.writeFile(d.diff.openLoc, text);
    editorStore.set((s) => ({ docs: { ...s.docs, [key]: { ...s.docs[key], saved: text, dirty: false } } }));
    await reloadIfChanged(locKey(d.diff.openLoc));
    return;
  }
  const text = getText(key);
  if (!d || text === undefined || d.error) return;
  await fs.writeFile(d.loc, text);
  editorStore.set((s) => ({ docs: { ...s.docs, [key]: { ...s.docs[key], saved: text, dirty: false } } }));
}
export async function saveAll() {
  await Promise.all(Object.values(S().docs).filter((d) => d.dirty).map((d) => saveDoc(d.key)));
}

/** External change: reload clean docs; leave dirty ones alone. */
export async function reloadIfChanged(key: string) {
  const d = S().docs[key];
  if (d?.viewer) {
    editorStore.set((s) => ({ docs: { ...s.docs, [key]: { ...s.docs[key], rev: (d.rev ?? 0) + 1 } } }));
    return;
  }
  if (!d || d.dirty || d.error) return;
  const text = await fs.readFile(d.loc).catch(() => null);
  if (text === null || text === d.saved) return;
  editorStore.set((s) => ({ docs: { ...s.docs, [key]: { ...s.docs[key], saved: text, initial: text, dirty: false } } })); // initial: a model evicted from a background tab is recreated from it
  setText(key, text);
}

/** Close without prompting (caller guarantees the doc is clean or already confirmed). */
function forceCloseTab(groupId: string, key: string) {
  const g = S().groups[groupId];
  if (!g) return;
  const openElsewhere = Object.values(S().groups).some((x) => x.id !== groupId && x.tabs.includes(key));
  const tabs = g.tabs.filter((t) => t !== key);
  // IntelliJ default: closing the active tab activates the most recently used remaining tab
  const mru = S().recent.find((k) => tabs.includes(k));
  const idx = g.tabs.indexOf(key);
  const active = g.active === key ? (mru ?? tabs[Math.min(idx, tabs.length - 1)] ?? null) : g.active;
  patchGroup(groupId, { tabs, active });
  if (!openElsewhere) {
    editorStore.set((s) => {
      const { [key]: _, ...docs } = s.docs;
      return { docs, recent: s.recent.filter((k) => k !== key) };
    });
    diffControllers.delete(key);
    disposeModel(key);
  }
  if (tabs.length === 0 && Object.keys(S().groups).length > 1) removeGroup(groupId);
}

export async function closeTab(groupId: string, key: string, opts: { force?: boolean } = {}) {
  const d = S().docs[key];
  if (d?.pinned && !opts.force) return; // pinned tabs survive ⌘W / middle-click (unpin first)
  const openElsewhere = Object.values(S().groups).some((g) => g.id !== groupId && g.tabs.includes(key));
  if (d?.dirty && !openElsewhere) {
    const ok = await confirmDialog({ title: "Unsaved Changes", message: `Discard changes to ${d.name}?`, okLabel: "Discard" });
    if (!ok) return;
  }
  forceCloseTab(groupId, key);
}
export const closeActiveTab = () => {
  const g = activeGroup();
  if (g?.active) closeTab(g.id, g.active);
};
/** Tab context menu: Close Others / Close All / Close Tabs to the Right (pinned tabs are kept). */
export async function closeOthers(groupId: string, key: string) {
  for (const t of S().groups[groupId]?.tabs.filter((t) => t !== key) ?? []) await closeTab(groupId, t);
}
export async function closeAllTabs(groupId: string) {
  for (const t of [...(S().groups[groupId]?.tabs ?? [])]) await closeTab(groupId, t);
}
export async function closeTabsToRight(groupId: string, key: string) {
  const tabs = S().groups[groupId]?.tabs ?? [];
  for (const t of tabs.slice(tabs.indexOf(key) + 1)) await closeTab(groupId, t);
}
/** Pinned tabs move to the front, in their previous relative order. */
export function togglePin(key: string) {
  const d = S().docs[key];
  if (!d) return;
  editorStore.set((s) => ({ docs: { ...s.docs, [key]: { ...s.docs[key], pinned: !d.pinned } } }));
  for (const g of Object.values(S().groups)) {
    if (!g.tabs.includes(key)) continue;
    const pinned = g.tabs.filter((t) => S().docs[t]?.pinned);
    patchGroup(g.id, { tabs: [...pinned, ...g.tabs.filter((t) => !pinned.includes(t))] });
  }
}
/** Cycle the active group's tabs (NextTab / PreviousTab). */
export function cycleTab(delta: 1 | -1) {
  const g = activeGroup();
  if (!g || g.tabs.length < 2 || !g.active) return;
  const i = g.tabs.indexOf(g.active);
  activateTab(g.id, g.tabs[(i + delta + g.tabs.length) % g.tabs.length]);
}

function mapNode(n: LayoutNode, f: (n: LayoutNode) => LayoutNode | null): LayoutNode | null {
  const r = f(n);
  if (r !== n) return r;
  if (n.type === "split") {
    const children = n.children.map((c) => mapNode(c, f)).filter((c): c is LayoutNode => !!c);
    if (children.length === 0) return null;
    if (children.length === 1) return children[0];
    return { ...n, children };
  }
  return n;
}

function removeGroup(id: string) {
  const layout = mapNode(S().layout, (n) => (n.type === "group" && n.id === id ? null : n)) ?? S().layout;
  const { [id]: _, ...groups } = S().groups;
  const activeGroupId = S().activeGroup === id ? firstGroupId(layout) : S().activeGroup;
  editorStore.set({ layout, groups, activeGroup: activeGroupId });
}
const firstGroupId = (n: LayoutNode): string => (n.type === "group" ? n.id : firstGroupId(n.children[0]));

/** right => side-by-side (IntelliJ SplitVertically); down => stacked (SplitHorizontally). */
export function splitActive(where: "right" | "down") {
  const g = activeGroup();
  if (!g) return;
  const id = newId();
  const dir = where === "right" ? "row" : "column";
  const ng: Group = { id, tabs: g.active ? [g.active] : [], active: g.active };
  const insert = (n: LayoutNode): LayoutNode | null => {
    if (n.type === "group" && n.id === g.id) return { type: "split", dir, children: [n, { type: "group", id }] };
    if (n.type === "split" && n.dir === dir) {
      const i = n.children.findIndex((c) => c.type === "group" && c.id === g.id);
      if (i >= 0) {
        const children = [...n.children];
        children.splice(i + 1, 0, { type: "group", id });
        return { ...n, children };
      }
    }
    return n;
  };
  editorStore.set((s) => ({
    groups: { ...s.groups, [id]: ng },
    layout: mapNode(s.layout, insert) ?? s.layout,
    activeGroup: id,
  }));
}
