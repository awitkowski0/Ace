/**
 * Reference-image model operations for one Studio (docs/BLOCKBENCH-PARITY.md section 3).
 *
 * Where each scope lives (never in a Thematic repo):
 *  - `.bbmodel` project scope  -> the file's own `reference_images` key, written through the core command `setBbReferenceImages`
 *    (one Monaco undo stop, so Cmd+Z undoes it and the rest of the file stays byte-identical).
 *  - `.geo.json` / `.animation.json` project scope -> Ace app data (`pstore`, keyed by the file path): `refimages.json` holds the
 *    properties, every image is copied into app data as its own `refimg_<id>` entry (the source file is never referenced again).
 *  - global scope ("All projects") -> the same pstore under a fixed pseudo-root, like Blockbench's `global_reference_images`.
 */
import { createStore, useStore, type Store } from "../../../../lib/store";
import { fs, invoke, type Location } from "../../../../lib/ipc";
import { makeRef, readBbReferenceImages, refToJson, refFromJson, setBbReferenceImages, type RefImage } from "../../core";
import type { StudioApi } from "../state";
import { handles } from "../studios";

// ---------------------------------------------------------------- per-studio UI state (dialogs)

export interface PendingImport { name: string; source: string; w: number; h: number; viewMode: "flat_image" | "plane"; layer: RefImage["layer"]; global: boolean }
export interface RefUi { importing: PendingImport | null; props: boolean }
const uis = new WeakMap<StudioApi, Store<RefUi>>();
export function refUi(api: StudioApi): Store<RefUi> {
  let s = uis.get(api);
  if (!s) uis.set(api, (s = createStore<RefUi>({ importing: null, props: false })));
  return s;
}
export const useRefUi = (api: StudioApi) => useStore(refUi(api));

// ---------------------------------------------------------------- helpers

const handleOf = (api: StudioApi) => { for (const h of handles) if (h.api === api) return h; return null; };
const hostOf = (api: StudioApi) => { const k = handleOf(api)?.docKey ?? "local:"; return k.slice(0, k.indexOf(":")) || "local"; };
const GLOBAL_ROOT: Location = { host: "local", path: "ace:global-reference-images" };
const STORE = "refimages";
const fnv = (s: string) => { let h = 0xcbf29ce4 >>> 0, h2 = 0x84222325 >>> 0; for (let i = 0; i < s.length; i++) { h = Math.imul(h ^ s.charCodeAt(i), 0x01000193) >>> 0; h2 = Math.imul(h2 + s.charCodeAt(i), 0x01000193) >>> 0; } return h.toString(16).padStart(8, "0") + h2.toString(16).padStart(8, "0"); };

const pget = (root: Location, name: string) => invoke<string | null>("pstore_get", { root, name }).catch(() => null);
const pset = (root: Location, name: string, json: string) => invoke<void>("pstore_set", { root, name, json });

/** Persist `list` (refs of one scope) into a pstore root: properties file + one entry per image. */
async function saveStore(root: Location, list: RefImage[]) {
  const out: Record<string, unknown>[] = [];
  for (const r of list) {
    let source = r.source;
    if (source.startsWith("data:")) {
      const id = fnv(source);
      if (!imageSaved.has(root.path + id)) { await pset(root, `refimg_${id}`, source); imageSaved.add(root.path + id); }
      source = `img:${id}`;
    }
    out.push({ ...refToJson(r), source });
  }
  await pset(root, STORE, JSON.stringify({ version: 1, reference_images: out }, null, 1));
}
const imageSaved = new Set<string>();

async function loadStore(root: Location): Promise<RefImage[]> {
  const t = await pget(root, STORE);
  if (!t) return [];
  let j: { reference_images?: unknown[] };
  try { j = JSON.parse(t); } catch { return []; }
  const out: RefImage[] = [];
  for (const raw of j.reference_images ?? []) {
    const r = refFromJson(raw);
    if (!r) continue;
    if (r.source.startsWith("img:")) {
      const id = r.source.slice(4);
      const data = await pget(root, `refimg_${id}`);
      if (!data) continue;
      imageSaved.add(root.path + id);
      r.source = data;
    }
    out.push(r);
  }
  return out;
}

// ---------------------------------------------------------------- global scope (shared by every Studio of this window)

let globalRefs: RefImage[] = [];
let globalLoaded: Promise<void> | null = null;
export function loadGlobalRefs(): Promise<void> {
  return (globalLoaded ??= loadStore(GLOBAL_ROOT).then((l) => { globalRefs = l.map((r) => ({ ...r, scope: "global" as const })); }));
}

// ---------------------------------------------------------------- state sync

const projectRefs = (api: StudioApi) => api.store.get().refs.filter((r) => r.scope !== "global");
const globalOf = (l: RefImage[]) => l.filter((r) => r.scope === "global");

/** Load project + global references into the store (called once per Studio by the viewport). */
export async function loadRefs(api: StudioApi): Promise<void> {
  const s = api.store.get();
  await loadGlobalRefs();
  let project: RefImage[] = [];
  if (s.doc?.kind === "bbmodel") project = readBbReferenceImages(s.doc);
  else project = (await loadStore({ host: hostOf(api), path: s.path })).map((r) => ({ ...r, scope: "project" as const }));
  api.store.set({ refs: [...project, ...globalRefs.map((r) => ({ ...r }))], refSel: null });
}

/** Re-read the `.bbmodel` project references after the text changed (undo/redo/external edit). */
export function syncBbRefs(api: StudioApi): void {
  const s = api.store.get();
  if (!s.doc || s.doc.kind !== "bbmodel") return;
  const fromDoc = readBbReferenceImages(s.doc).map((r) => ({ ...r, scope: "project" as const }));
  const cur = projectRefs(api);
  if (JSON.stringify(fromDoc.map(refToJson)) === JSON.stringify(cur.map(refToJson))) return;
  api.store.set((st) => ({ refs: [...fromDoc, ...globalOf(st.refs)], refSel: st.refSel && [...fromDoc, ...globalOf(st.refs)].some((r) => r.uuid === st.refSel) ? st.refSel : null }));
}

/**
 * Replace the reference list. `final` = persist now (pointer-up / discrete edits); while dragging pass final=false so the live
 * view updates without touching the file.
 */
export function setRefs(api: StudioApi, next: RefImage[], label: string, final = true): void {
  api.store.set({ refs: next });
  if (!final) return;
  const s = api.store.get();
  const proj = next.filter((r) => r.scope !== "global");
  if (s.doc?.kind === "bbmodel") {
    try { api.commit(setBbReferenceImages(s.doc, proj), label); } catch { /* unparsable doc: keep in memory only */ }
  } else {
    void saveStore({ host: hostOf(api), path: s.path }, proj).catch(() => {});
  }
  const globals = globalOf(next);
  if (JSON.stringify(globals.map(refToJson)) !== JSON.stringify(globalRefs.map(refToJson))) {
    globalRefs = globals;
    void saveStore(GLOBAL_ROOT, globals).catch(() => {});
    for (const h of handles) if (h.api !== api) h.api.store.set((st) => ({ refs: [...st.refs.filter((r) => r.scope !== "global"), ...globals.map((r) => ({ ...r }))] }));
  }
}

export function updateRef(api: StudioApi, uuid: string, patch: Partial<RefImage>, label = "Edit Reference Image", final = true): void {
  const next = api.store.get().refs.map((r) => (r.uuid === uuid ? { ...r, ...patch } : r));
  // scope change moves the image between stores: re-order so project refs come first
  setRefs(api, next, label, final);
}

/** Entering Reference Image mode clears the model selection, so Delete / gizmo keys can only ever act on the reference. */
const CLEAR_SEL = { bones: [] as string[], cube: null, cubes: [] as Array<{ bone: string; index: number }> };
export function selectRef(api: StudioApi, uuid: string | null, edit = true): void {
  api.store.set(uuid && edit ? { refSel: uuid, refEdit: true, ...CLEAR_SEL } : { refSel: uuid });
}

export function toggleRefEditMode(api: StudioApi): void {
  const s = api.store.get();
  if (s.refEdit) { api.store.set({ refEdit: false }); return; }
  api.store.set({ refEdit: true, refSel: s.refSel ?? s.refs.find((r) => r.visibility)?.uuid ?? s.refs[0]?.uuid ?? null, ...CLEAR_SEL });
}
export function toggleAllRefs(api: StudioApi): void { api.store.set({ refsHidden: !api.store.get().refsHidden }); }

/** Delete key in Reference Image mode: removes the selected reference. Returns false when there is nothing to delete here. */
export function deleteSelectedRef(api: StudioApi): boolean {
  const s = api.store.get();
  if (!s.refEdit || !s.refSel) return false;
  deleteRef(api, s.refSel);
  return true;
}
export function deleteRef(api: StudioApi, uuid: string): void {
  const s = api.store.get();
  const next = s.refs.filter((r) => r.uuid !== uuid);
  api.store.set({ refSel: s.refSel === uuid ? null : s.refSel });
  setRefs(api, next, "Delete Reference Image");
}

// ---------------------------------------------------------------- adding

export const IMAGE_EXT = ["png", "jpg", "jpeg", "bmp", "tiff", "tif", "gif"];
export const IMAGE_ACCEPT = IMAGE_EXT.map((e) => "." + e).join(",");

function loadSize(src: string): Promise<[number, number]> {
  return new Promise((res) => {
    const i = new Image();
    i.onload = () => res([i.naturalWidth || 1, i.naturalHeight || 1]);
    i.onerror = () => res([400, 300]);
    i.src = src;
  });
}
const blobToDataUrl = (b: Blob) => new Promise<string>((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result)); r.onerror = () => rej(r.error); r.readAsDataURL(b); });
const mimeOf = (name: string) => ({ png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", bmp: "image/bmp", gif: "image/gif", tif: "image/tiff", tiff: "image/tiff" } as Record<string, string>)[name.split(".").pop()!.toLowerCase()] ?? "image/png";
const fit = (w: number, h: number): [number, number] => { const k = 400 / Math.max(w, h); return [Math.round(w * k), Math.round(h * k)]; };

/** Create the reference immediately (no dialog). Inside an ortho preset it becomes a blueprint of that view (Blockbench `enableBlueprintMode`). */
export async function addRefFromDataUrl(api: StudioApi, source: string, o: Partial<RefImage> & { name?: string } = {}): Promise<RefImage> {
  const s = api.store.get();
  const [w, h] = await loadSize(source);
  const sideOf: Record<string, RefImage["attached_side"]> = { front: "north", back: "south", right: "east", left: "west", side: "west", top: "top", bottom: "bottom" };
  const blueprint = s.ortho && s.view !== "persp" && !!sideOf[s.view];
  const ref = makeRef(source, {
    name: "Reference", size: fit(w, h),
    ...(blueprint && o.view_mode !== "plane" ? { view_mode: "blueprint" as const, attached_side: sideOf[s.view], position: [0, 0] as [number, number] } : {}),
    ...o,
  });
  setRefs(api, [...s.refs.filter((r) => r.scope !== "global"), ref, ...s.refs.filter((r) => r.scope === "global")].sort((a, b) => Number(a.scope === "global") - Number(b.scope === "global")), "Add Reference Image");
  api.store.set({ refSel: ref.uuid, refEdit: true, refsHidden: false, ...CLEAR_SEL });
  return ref;
}

/** Open the import dialog for an image (drag-drop / picker / clipboard all end here, like Blockbench's `importReferences`). */
export async function openImport(api: StudioApi, source: string, name: string): Promise<void> {
  const [w, h] = await loadSize(source);
  refUi(api).set({ importing: { name, source, w, h, viewMode: "flat_image", layer: "background", global: false } });
}
export async function confirmImport(api: StudioApi): Promise<RefImage | null> {
  const p = refUi(api).get().importing;
  if (!p) return null;
  refUi(api).set({ importing: null });
  return addRefFromDataUrl(api, p.source, { name: p.name, layer: p.layer, view_mode: p.viewMode === "plane" ? "plane" : undefined, scope: p.global ? "global" : "project" } as Partial<RefImage>);
}

export async function addRefFromFile(api: StudioApi, file: File | { name: string; bytes: ArrayBuffer }): Promise<void> {
  const name = file.name.replace(/\.[^.]+$/, "");
  const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
  if (!IMAGE_EXT.includes(ext)) return;
  const blob = file instanceof File ? file : new Blob([file.bytes], { type: mimeOf(file.name) });
  await openImport(api, await blobToDataUrl(blob), name || "Reference");
}
/** Tauri file-drop (absolute paths on this machine). */
export async function addRefFromPath(api: StudioApi, path: string): Promise<void> {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const bytes = await fs.readBytes({ host: "local", path });
  await addRefFromFile(api, { name, bytes });
}
export function addRefFromPicker(api: StudioApi): void {
  const inp = document.createElement("input");
  inp.type = "file"; inp.accept = IMAGE_ACCEPT; inp.multiple = true;
  inp.style.display = "none";
  document.body.appendChild(inp);
  inp.onchange = async () => { for (const f of Array.from(inp.files ?? [])) await addRefFromFile(api, f); inp.remove(); };
  inp.oncancel = () => inp.remove();
  inp.click();
}
export async function addRefFromClipboard(api: StudioApi): Promise<boolean> {
  try {
    const items = await navigator.clipboard.read();
    for (const it of items) {
      const type = it.types.find((t) => t.startsWith("image/"));
      if (type) { await openImport(api, await blobToDataUrl(await it.getType(type)), "Pasted"); return true; }
    }
    const text = (await navigator.clipboard.readText()).trim();
    if (/^(data:image\/|https?:\/\/)/.test(text)) { await openImport(api, text, "Pasted"); return true; }
  } catch { /* clipboard denied / empty */ }
  return false;
}

/** Image dimensions of a reference (for the linked-ratio resize); cached. */
const sizes = new Map<string, [number, number]>();
export async function naturalSize(src: string): Promise<[number, number]> {
  const k = src.length + ":" + src.slice(-48);
  let v = sizes.get(k);
  if (!v) sizes.set(k, (v = await loadSize(src)));
  return v;
}
