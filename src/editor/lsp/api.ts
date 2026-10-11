/** Eager facade: loads the monaco-dependent manager only when an LSP language is actually in use. */
import { editorStore } from "../store";
import { invoke, listen, fs } from "../../lib/ipc";
import { projectStore } from "../../lib/project";
import { SERVER_FOR_LANGUAGE } from "./servers";
import { godotPaused, lspSettings, statusStore } from "./state";

const mgr = () => import("./manager");

export const lsp = {
  gotoDeclaration: () => mgr().then((m) => m.gotoDeclaration()),
  findUsages: () => mgr().then((m) => m.findUsages()),
  rename: () => mgr().then((m) => m.renameSymbol()),
  symbols: () => mgr().then((m) => m.documentSymbols()),
  codeActions: () => mgr().then((m) => m.codeActions()),
  retry: () => mgr().then((m) => m.retryNow()),
  /** stop + start the sessions of a language (Python: interpreter changed / server installed). No-op until the manager is loaded. */
  restartLanguage: (lang: string) => (booting ? mgr().then((m) => m.restartLanguage(lang)) : undefined),
};

export function activeDoc() {
  const s = editorStore.get();
  return s.docs[s.groups[s.activeGroup]?.active ?? ""];
}
export const activeServerId = () => SERVER_FOR_LANGUAGE[activeDoc()?.language ?? ""];
/** True when the active file's language server is connected. */
export const activeServerReady = () => {
  const id = activeServerId();
  return !!id && statusStore.get().servers[id]?.state === "ready";
};

let booting = false;
export function bootWhenNeeded() {
  const check = () => {
    if (booting) return;
    if (Object.values(editorStore.get().docs).some((d) => !d.error && d.loc.host === "local" && d.language in SERVER_FOR_LANGUAGE)) {
      booting = true;
      mgr().then((m) => m.boot());
    }
  };
  editorStore.subscribe(check);
  check();
}

/**
 * Godot's headless editor takes 10-17s to start. When the project root has project.godot, start it at low priority
 * once the UI has been idle for a moment, so the first .gd file opens against a ready server.
 */
let warmedRoot = "";
export function prewarmGodotWhenIdle() {
  let timer: number | undefined;
  const check = () => {
    const root = projectStore.get().root;
    if (!root || root.host !== "local" || root.path === warmedRoot || !lspSettings.get().autoGodot) return;
    clearTimeout(timer);
    timer = window.setTimeout(() => {
      const idle = (window as any).requestIdleCallback as undefined | ((f: () => void, o?: { timeout: number }) => void);
      const go = async () => {
        const cur = projectStore.get().root;
        if (!cur || cur.path !== root.path || warmedRoot === root.path) return;
        const st = await fs.stat({ host: "local", path: root.path + "/project.godot" }).catch(() => null);
        if (!st?.isFile) return;
        warmedRoot = root.path;
        invoke("lsp_prewarm", { root: root.path }).catch(() => { warmedRoot = ""; });
      };
      if (idle) idle(() => void go(), { timeout: 5000 });
      else void go();
    }, 2500);
  };
  projectStore.subscribe(check);
  check();
}

/**
 * Tell the backend whether a .gd editor is focused (active tab is GDScript in a focused window): the backend suspends the
 * headless Godot after 20 s without LSP traffic unless this is true, and resumes it as soon as it becomes true.
 */
export function trackGodotFocus() {
  let last: boolean | undefined;
  const check = () => {
    const f = document.hasFocus() && activeDoc()?.language === "gdscript";
    if (f === last) return;
    last = f;
    invoke("lsp_godot_focus", { focused: f }).catch(() => {});
  };
  editorStore.subscribe(check);
  window.addEventListener("focus", check);
  window.addEventListener("blur", check);
  void listen<boolean>("lsp://godot-paused", (e) => godotPaused.set({ paused: !!e.payload }));
  check();
}
