/**
 * StudioApi implementation: the Monaco model of the document is the single source of truth. `commit()` serializes a core
 * Doc, computes a minimal edit against the live model text and applies it with `pushEditOperations` (one undo stop; drags
 * coalesce between beginGesture/endGesture). Also: the registry of mounted Studios (focus-gated actions) and text sync.
 */
import { monaco } from "../../../editor/monacoSetup";
import { getEditor } from "../../../editor/editorRegistry";
import { setPrefs } from "../../../editor/viewers/io";
import { effectiveSemantics } from "./semantics";
import { getAnimations, getGeo, minimalEdit, parseDoc, serialize, findKey, type Doc, type DocKind } from "../core";
import { createStudioStore, type StudioApi, type StudioState } from "./state";
import { boneNamesOf } from "./model";
import { handles, type StudioHandle } from "./studios";

export const modelUri = (key: string) => {
  const i = key.indexOf(":");
  const host = key.slice(0, i);
  const path = key.slice(i + 1);
  return host === "local" ? monaco.Uri.file(path) : monaco.Uri.from({ scheme: "ssh", authority: host, path });
};
const LF = monaco.editor.EndOfLinePreference.LF;
const lf = (s: string) => (s.indexOf("\r") >= 0 ? s.replace(/\r\n/g, "\n") : s);

/** (line, column) of an LF-text offset, independent of the model's EOL setting. */
function posOf(text: string, off: number): { line: number; col: number } {
  let line = 1;
  let last = -1;
  for (let i = text.indexOf("\n"); i >= 0 && i < off; i = text.indexOf("\n", i + 1)) { line++; last = i; }
  return { line, col: off - last };
}

/** Make state consistent with a freshly parsed doc: selection pruned to names that still exist, animation re-picked. */
export function reconcile(s: StudioState, doc: Doc): Partial<StudioState> {
  const out: Partial<StudioState> = {};
  if (doc.kind !== "geo") {
    const anims = getAnimations(doc);
    if (!s.anim || !anims.some((a) => a.name === s.anim)) out.anim = anims[0]?.name ?? null;
    const a = anims.find((x) => x.name === (out.anim ?? s.anim));
    if (a && s.keys.length) {
      const keys = s.keys.filter((k) => !!findKey(a, k));
      if (keys.length !== s.keys.length) out.keys = keys;
    }
  }
  const names = new Set(boneNamesOf(doc, s.rig?.source === "player"));
  if (names.size) {
    const bones = s.bones.filter((b) => names.has(b));
    if (bones.length !== s.bones.length) out.bones = bones;
    if (s.cube && !names.has(s.cube.bone)) out.cube = null;
    else if (s.cube && doc.kind === "geo") {
      const b = getGeo(doc).geometries[0]?.bones.find((x) => x.name === s.cube!.bone);
      if (!b || !b.cubes[s.cube.index]) out.cube = null;
    }
  }
  return out;
}

export function createStudioHandle(o: { docKey: string; path: string; groupId: string; kind: DocKind }): StudioHandle {
  const store = createStudioStore(o.path);
  const getModel = () => monaco.editor.getModel(modelUri(o.docKey));
  let lastText: string | null = null;
  let gesture = 0;
  const labels: string[] = [];
  const root: StudioHandle["root"] = { current: null };

  const setDoc = (d: Doc) => store.set((s) => {
    const sem = effectiveSemantics(s);
    const doc = (d.semantics ?? "geo") === sem ? d : { ...d, semantics: sem === "geo" ? undefined : sem }; // commits keep the user's semantics choice
    return { doc, parseError: null, ...reconcile(s, doc) };
  });

  const syncFromText = (raw: string) => {
    const text = lf(raw);
    if (text === lastText) return;
    lastText = text;
    try {
      setDoc(parseDoc(text, o.kind, effectiveSemantics(store.get())));
    } catch (e) {
      store.set({ parseError: String((e as Error).message ?? e) });
    }
  };

  const endGesture = () => {
    if (gesture === 0) return;
    gesture = 0;
    getModel()?.pushStackElement();
  };

  const api: StudioApi = {
    store,
    commit(next, label) {
      labels.push(label);
      if (labels.length > 200) labels.shift();
      const model = getModel();
      if (!model) { setDoc(next); return; }
      const cur = model.getValue(LF);
      const text = lf(serialize(next));
      if (text !== cur) {
        const e = minimalEdit(cur, text);
        const a = posOf(cur, e.start);
        const b = posOf(cur, e.end);
        if (!gesture) model.pushStackElement();
        model.pushEditOperations([], [{ range: new monaco.Range(a.line, a.col, b.line, b.col), text: e.text }], () => null);
        if (!gesture) model.pushStackElement();
      }
      lastText = text;
      setDoc(next);
    },
    beginGesture() {
      if (gesture) return;
      gesture = 1;
      getModel()?.pushStackElement();
    },
    endGesture,
    undo() {
      endGesture();
      const m = getModel();
      if (!m) return;
      m.undo();
      syncFromText(m.getValue(LF));
    },
    redo() {
      endGesture();
      const m = getModel();
      if (!m) return;
      m.redo();
      syncFromText(m.getValue(LF));
    },
    revealInText(t) {
      setPrefs(o.docKey, { mode: "split" });
      const m = getModel();
      if (!m) return;
      const needle = t.bone ? `"${t.bone}"` : t.anim ? `"${t.anim}"` : "";
      if (!needle) return;
      const hit = m.findMatches(needle, false, false, true, null, false, 1)[0];
      if (!hit) return;
      setTimeout(() => {
        const ed = getEditor(o.groupId);
        if (!ed) return;
        ed.setSelection(hit.range);
        ed.revealRangeInCenter(hit.range);
      }, 60);
    },
  };

  const h: StudioHandle = {
    api, docKey: o.docKey, groupId: o.groupId, kind: o.kind, root,
    syncFromText,
    text: () => getModel()?.getValue(LF) ?? lastText ?? "",
    viewport: { current: null },
    labels,
    dispose() { endGesture(); handles.delete(h); },
  };
  handles.add(h);
  return h;
}
