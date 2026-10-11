// Python language intelligence (docs/PYTHON.md): basedpyright/pyright through the shared LSP manager, ruff diagnostics,
// Reformat Code / Optimize Imports, "Install basedpyright" hint. Heavy parts load only for a Python project with a .py document open.
import { registerStatusWidget } from "../../../toolwindows/registry";
import { getAction, registerAction } from "../../../actions/registry";
import { activeEditor, triggerEditor } from "../../../editor/editorRegistry";
import { editorStore } from "../../../editor/store";
import { pyStore } from "../interpreter";
import { registerQa } from "../qa";
import { LangNoteWidget } from "./ui";
import { wireServer, installBasedpyright, installChoice, runInstall, lastLaunch } from "./server";
import { notify } from "./note";

const impl = () => import("./impl");
const mgr = () => import("../../../editor/lsp/manager");

wireServer();
registerStatusWidget({ id: "python-lang-note", side: "right", order: 19, component: LangNoteWidget });

const isPyEditor = () => activeEditor()?.getModel()?.getLanguageId() === "python";

// builtin editor actions register after the modules: wrap ReformatCode on the next tick (Python models only, all others unchanged)
setTimeout(() => {
  const prev = getAction("ReformatCode");
  registerAction({
    id: "ReformatCode", intellijId: "ReformatCode", title: "Reformat Code", context: "editor", defaultKeys: prev?.defaultKeys,
    isEnabled: () => !!activeEditor(),
    run: () => { if (isPyEditor()) return impl().then((m) => m.reformat()).then(() => undefined); if (prev?.run) return prev.run(); triggerEditor("editor.action.formatDocument"); },
  });
}, 0);
registerAction({
  id: "OptimizeImports", intellijId: "OptimizeImports", title: "Optimize Imports", context: "editor", isEnabled: isPyEditor,
  run: () => impl().then((m) => m.optimizeImports()).then(() => undefined),
});
registerAction({ id: "Ace.InstallBasedpyright", title: "Install basedpyright…", isEnabled: () => pyStore.get().active, run: () => void installBasedpyright() });

// start the monaco-side features once a .py document exists in a Python project
let started = false;
const maybeStart = () => {
  if (started || !pyStore.get().active) return;
  if (!Object.values(editorStore.get().docs).some((d) => d.language === "python" && !d.error)) return;
  started = true;
  void impl().then((m) => m.startLang());
};
editorStore.subscribe(maybeStart);
pyStore.subscribe(maybeStart);
maybeStart();

registerQa("lang", {
  /** make sure the lazy parts are loaded */
  start: async () => { (await impl()).startLang(); return true; },
  sessions: async () => (await mgr()).qaHooks.sessions(),
  completion: async (path: string, line: number, col: number, trigger?: string) => (await mgr()).qaHooks.completion(path, line, col, trigger),
  hover: async (path: string, line: number, col: number) => (await mgr()).qaHooks.hover(path, line, col),
  definition: async (path: string, line: number, col: number) => (await mgr()).qaHooks.definition(path, line, col),
  references: async (path: string, line: number, col: number) => (await mgr()).qaHooks.references(path, line, col),
  signature: async (path: string, line: number, col: number) => (await mgr()).qaHooks.signature(path, line, col),
  rename: async (path: string, line: number, col: number, name: string) => (await mgr()).qaHooks.rename(path, line, col, name),
  symbols: async (path: string) => (await mgr()).qaHooks.symbols(path),
  reformat: async () => (await impl()).reformat(),
  optimizeImports: async () => (await impl()).optimizeImports(),
  ruffStats: async () => ({ ...(await impl()).ruffStats }),
  diagnostics: async (path: string) => { const { diagStore } = await import("../../../editor/lsp/state"); return (diagStore.get().byUri[path] ?? []).map((d) => ({ owner: d.owner ?? "lsp", source: d.source ?? null, code: d.code ?? null, line: d.range.start.line + 1, col: d.range.start.character + 1, severity: d.severity, message: d.message, fix: d.fix?.title ?? null })); },
  tools: async () => (await impl()).qaTools,
  trackedPaths: async () => (await impl()).trackedPaths(),
  note: () => document.querySelector('[data-testid="py-lang-note"]')?.textContent ?? null,
  installChoice: () => installChoice(),
  installDialog: () => { void installBasedpyright(); return true; },
  runInstall: (argv: string[]) => runInstall(argv),
  lastLaunch: () => { const l = lastLaunch.value; return l ? { serverId: l.serverId, bin: l.bin, pathPrepend: l.pathPrepend } : null; },
  notify,
});
