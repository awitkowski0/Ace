/** window.__qa helpers (installed only under ATELIER_AUTOMATION=1). See docs/CONVENTIONS.md "Automation harness". */
import { key, tap } from "./keys";
import { editorStore, openFile } from "../editor/store";
import { activeEditor } from "../editor/editorRegistry";
import { projectStore, openProject } from "../lib/project";
import { layoutStore, focusedToolWindowId } from "../lib/layout";
import { listActions } from "../actions/registry";
import { getBindings } from "../actions/keymap";
import { local, invoke } from "../lib/ipc";
import { searchText } from "../components/search/api";
import { openPopup, closePopup } from "../components/shell/popups";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const raf = () => new Promise<number>((r) => requestAnimationFrame(r));
/** resolves after the frame that follows the next rAF has been presented (rAF callback -> next task). */
const afterPaint = () =>
  new Promise<void>((res) =>
    requestAnimationFrame(() => {
      const ch = new MessageChannel();
      ch.port1.onmessage = () => res();
      ch.port2.postMessage(0);
    }),
  );

async function waitFor(what: string | (() => unknown), ms = 5000) {
  const t0 = performance.now();
  const check = () => (typeof what === "string" ? document.querySelector(what) : what());
  for (;;) {
    const v = await check();
    if (v) return v === true ? true : typeof what === "string" ? true : v;
    if (performance.now() - t0 > ms) throw new Error(`waitFor timeout (${ms}ms): ${typeof what === "string" ? what : what.toString().slice(0, 120)}`);
    await sleep(15);
  }
}

function focusedArea(): string {
  const ae = document.activeElement as HTMLElement | null;
  if (!ae || ae === document.body) return "none";
  if (ae.closest(".popup")) return "popup";
  const tw = focusedToolWindowId();
  if (tw) return `toolwindow:${tw}`;
  if (ae.closest(".monaco-editor")) return "editor";
  if (ae.closest("[data-dialog], .dialog")) return "dialog";
  return `other:${ae.tagName.toLowerCase()}${ae.className ? "." + String(ae.className).split(" ")[0] : ""}`;
}

function state() {
  const e = editorStore.get();
  const pop = document.querySelector<HTMLElement>(".popup");
  const ed = activeEditor();
  const pos = ed?.getPosition();
  return {
    project: projectStore.get().root,
    tabs: Object.values(e.groups).map((g) => ({
      group: g.id,
      active: g.active,
      tabs: g.tabs.map((k) => ({ key: k, name: e.docs[k]?.name, dirty: !!e.docs[k]?.dirty })),
    })),
    dirty: Object.values(e.docs).filter((d) => d.dirty).map((d) => d.key),
    activeGroup: e.activeGroup,
    toolWindows: layoutStore.get().active,
    focused: focusedArea(),
    popup: pop ? { open: true, text: pop.innerText.slice(0, 160), placeholder: pop.querySelector("input")?.getAttribute("placeholder") ?? null } : { open: false },
    cursor: pos ? { line: pos.lineNumber, col: pos.column } : e.cursor,
    monacoWidget: (() => { const w = document.querySelector<HTMLElement>(".quick-input-widget, .monaco-quick-input-widget"); return w && w.style.display !== "none" && w.offsetHeight > 0 ? w.innerText.slice(0, 120) : null; })(),
    editorFocused: !!ed?.hasTextFocus(),
  };
}

function actions() {
  const keysByAction = new Map<string, string[]>();
  for (const [seq, ids] of getBindings().exact) for (const id of ids) keysByAction.set(id, [...(keysByAction.get(id) ?? []), seq]);
  return listActions().map((a) => ({ id: a.id, title: a.title, keys: keysByAction.get(a.id) ?? [], enabled: a.isEnabled ? !!a.isEnabled() : true }));
}

async function type(text: string) {
  const ae = document.activeElement as HTMLElement | null;
  if (ae?.closest(".monaco-editor")) {
    const ed = activeEditor();
    if (!ed) throw new Error("no active editor");
    ed.trigger("keyboard", "type", { text });
    return;
  }
  if (ae && (ae instanceof HTMLInputElement || ae instanceof HTMLTextAreaElement)) {
    const proto = ae instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
    const set = Object.getOwnPropertyDescriptor(proto, "value")!.set!;
    set.call(ae, ae.value + text);
    ae.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
    return;
  }
  throw new Error(`type(): focused element not typeable (${ae?.tagName})`);
}

async function openFileQa(path: string) {
  await openFile(local(path));
  await waitFor(() => activeEditor()?.getModel(), 8000);
}

/** Open file and measure until the editor shows its content and a frame was presented. */
async function measureOpen(path: string) {
  const t0 = performance.now();
  await openFile(local(path));
  await waitFor(() => {
    const m = activeEditor()?.getModel();
    return m && m.uri.toString().includes(encodeURI(path.split("/").pop()!).replace(/%20/g, "%20")) ? m : null;
  }, 8000);
  await afterPaint();
  return performance.now() - t0;
}

/** Keystroke-to-paint: type one char via Monaco, time to the frame that follows. Returns sorted stats over n runs. */
async function measureKeystroke(n = 50) {
  const ed = activeEditor();
  if (!ed) throw new Error("no editor");
  ed.focus();
  await sleep(100);
  const samples: number[] = [];
  for (let i = 0; i < n; i++) {
    await sleep(30);
    const t0 = performance.now();
    ed.trigger("keyboard", "type", { text: "x" });
    await afterPaint();
    samples.push(performance.now() - t0);
  }
  // undo our typing (leaves doc as it was; never saved)
  for (let i = 0; i < n; i++) ed.trigger("qa", "undo", null);
  samples.sort((a, b) => a - b);
  const q = (p: number) => samples[Math.min(samples.length - 1, Math.floor(p * samples.length))];
  return { n, min: samples[0], p50: q(0.5), p95: q(0.95), max: samples[samples.length - 1] };
}

/** Search Everywhere: type `q` into the open popup, time until a result row mentions it. */
async function measureSearchEverywhere(q: string, tabText = "All") {
  openPopup("SearchEverywhere");
  await waitFor(".popup .se-input", 3000);
  await sleep(400);
  const input = document.querySelector<HTMLInputElement>(".popup .se-input")!;
  input.focus();
  const rowHit = () => [...document.querySelectorAll<HTMLElement>(".popup .se-row .se-label")].some((e) => e.innerText.toLowerCase().includes(q.toLowerCase()));
  const t0 = performance.now();
  await type(q);
  await waitFor(rowHit, 5000);
  const ms = performance.now() - t0;
  const rows = document.querySelectorAll(".popup .se-row").length;
  closePopup();
  await sleep(100);
  return { ms, rows, tab: tabText };
}

/** Find in Files via the backend stream; time to first batch and to done. */
function measureFindInFiles(query: string, mask = "") {
  const root = projectStore.get().root!;
  return new Promise<{ firstMs: number | null; doneMs: number; total: number; backendMs: number }>((resolve) => {
    const t0 = performance.now();
    let first: number | null = null;
    searchText(root, { query, caseSensitive: false, words: false, regex: false, mask }, (m, done, info) => {
      if (first === null && m.length) first = performance.now() - t0;
      if (done) resolve({ firstMs: first, doneMs: performance.now() - t0, total: info.total, backendMs: info.elapsedMs });
    });
  });
}

/** Open `dir` as project, expand its child dir `sub`, report render time + DOM rows vs logical rows. */
async function measureTree(dir: string, sub: string) {
  await openProject(local(dir));
  await waitFor(".tree-row", 8000);
  const row = () => [...document.querySelectorAll<HTMLElement>(".tree-row")].find((r) => r.querySelector(".tree-name")?.textContent === sub);
  await waitFor(row, 8000);
  const t0 = performance.now();
  row()!.click();
  await waitFor(() => (document.querySelector<HTMLElement>(".tree > div")?.offsetHeight ?? 0) > 5000, 15000);
  await afterPaint();
  const ms = performance.now() - t0;
  const inner = document.querySelector<HTMLElement>(".tree > div")!;
  return { ms, domRows: document.querySelectorAll(".tree-row").length, logicalRows: Math.round(inner.offsetHeight / 24) };
}

export function installQaHarness() {
  (window as any).__qa = {
    key, tap, type, sleep, waitFor, state, actions, raf, afterPaint,
    openFile: openFileQa, invoke, afterPaintX: afterPaint, measureSearchEverywhere, measureFindInFiles, measureTree, searchText, openProject: (p: string) => openProject(local(p)), measureOpen, measureKeystroke,
    editor: () => activeEditor(),
    version: 1,
  };
}
