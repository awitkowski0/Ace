import { createStore } from "../lib/store";
import { basename, fs, locKey, type Location } from "../lib/ipc";
import { languageFor } from "./languages";
import { confirmDialog } from "../components/shell/dialogs";

export interface Doc {
  key: string;
  loc: Location;
  name: string;
  language: string;
  initial: string; // content at load (Monaco model default value)
  saved: string; // last saved/loaded content
  dirty: boolean;
  error?: string;
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
}

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

export async function openFile(loc: Location, groupId: string = S().activeGroup) {
  const key = locKey(loc);
  if (!S().docs[key]) {
    try {
      const text = await fs.readFile(loc);
      const name = basename(loc.path);
      const doc: Doc = { key, loc, name, language: languageFor(name), initial: text, saved: text, dirty: false };
      editorStore.set((s) => ({ docs: { ...s.docs, [key]: doc } }));
    } catch (e) {
      const name = basename(loc.path);
      const doc: Doc = { key, loc, name, language: "plaintext", initial: "", saved: "", dirty: false, error: String(e) };
      editorStore.set((s) => ({ docs: { ...s.docs, [key]: doc } }));
    }
  }
  const g = S().groups[groupId] ?? activeGroup();
  patchGroup(g.id, { tabs: g.tabs.includes(key) ? g.tabs : [...g.tabs, key], active: key });
  editorStore.set((s) => ({ activeGroup: g.id, recent: [key, ...s.recent.filter((k) => k !== key)].slice(0, 50) }));
}

export function activateTab(groupId: string, key: string) {
  patchGroup(groupId, { active: key });
  editorStore.set((s) => ({ activeGroup: groupId, recent: [key, ...s.recent.filter((k) => k !== key)] }));
}
export const setActiveGroup = (id: string) => editorStore.get().activeGroup !== id && editorStore.set({ activeGroup: id });
export const setCursor = (line: number, col: number) => editorStore.set({ cursor: { line, col } });

export function setDirtyFromText(key: string, text: string) {
  const d = S().docs[key];
  if (!d) return;
  const dirty = text !== d.saved;
  if (dirty !== d.dirty) editorStore.set((s) => ({ docs: { ...s.docs, [key]: { ...d, dirty } } }));
}

export async function saveDoc(key: string) {
  const d = S().docs[key];
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
  if (!d || d.dirty || d.error) return;
  const text = await fs.readFile(d.loc).catch(() => null);
  if (text === null || text === d.saved) return;
  editorStore.set((s) => ({ docs: { ...s.docs, [key]: { ...s.docs[key], saved: text, dirty: false } } }));
  setText(key, text);
}

export async function closeTab(groupId: string, key: string) {
  const d = S().docs[key];
  const openElsewhere = Object.values(S().groups).some((g) => g.id !== groupId && g.tabs.includes(key));
  if (d?.dirty && !openElsewhere) {
    const ok = await confirmDialog({ title: "Unsaved Changes", message: `Discard changes to ${d.name}?`, okLabel: "Discard" });
    if (!ok) return;
  }
  const g = S().groups[groupId];
  if (!g) return;
  const idx = g.tabs.indexOf(key);
  const tabs = g.tabs.filter((t) => t !== key);
  const active = g.active === key ? (tabs[Math.min(idx, tabs.length - 1)] ?? null) : g.active;
  patchGroup(groupId, { tabs, active });
  if (!openElsewhere) {
    editorStore.set((s) => {
      const { [key]: _, ...docs } = s.docs;
      return { docs, recent: s.recent.filter((k) => k !== key) };
    });
    disposeModel(key);
  }
  if (tabs.length === 0 && Object.keys(S().groups).length > 1) removeGroup(groupId);
}
export const closeActiveTab = () => {
  const g = activeGroup();
  if (g?.active) closeTab(g.id, g.active);
};

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
