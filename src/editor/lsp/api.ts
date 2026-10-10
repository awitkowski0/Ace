/** Eager facade: loads the monaco-dependent manager only when an LSP language is actually in use. */
import { editorStore } from "../store";
import { SERVER_FOR_LANGUAGE } from "./servers";
import { statusStore } from "./state";

const mgr = () => import("./manager");

export const lsp = {
  gotoDeclaration: () => mgr().then((m) => m.gotoDeclaration()),
  findUsages: () => mgr().then((m) => m.findUsages()),
  rename: () => mgr().then((m) => m.renameSymbol()),
  symbols: () => mgr().then((m) => m.documentSymbols()),
  codeActions: () => mgr().then((m) => m.codeActions()),
  retry: () => mgr().then((m) => m.retryNow()),
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
