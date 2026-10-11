// Interpreters (docs/PYTHON.md): status-bar widget + switcher popup, Add Python Interpreter dialog, terminal venv activation.
import { registerStatusWidget } from "../../../toolwindows/registry";
import { registerAction } from "../../../actions/registry";
import { openPopup, registerPopup } from "../../shell/popups";
import { pyStore, setInterpreter } from "../interpreter";
import { registerQa } from "../qa";
import { Suspense, lazy } from "react";
import type { PopupProps } from "../../shell/popups";
import { InterpreterWidget } from "./widget";
import { DIALOG_ID, POPUP_ID } from "./ids";
import { activationFor, installTerminalActivation } from "./terminal";
import { createCondaAndUse, createVenvAndUse, refreshInterpreters, setTerminalActivate, terminalActivateSetting, useExistingInterpreter } from "./ops";
import { widgetText } from "./logic";

registerStatusWidget({ id: "python-interpreter", side: "right", order: 20, component: InterpreterWidget });
// the popup and the dialog (and their CSS-free React code) load on first use
const loadUi = () => import("./ui").then(async (m) => { await m.homeReady; return m; });
const LazyPopup = lazy(() => loadUi().then((m) => ({ default: m.InterpreterPopup })));
const LazyDialog = lazy(() => loadUi().then((m) => ({ default: m.AddInterpreterDialog })));
registerPopup(POPUP_ID, (p: PopupProps) => <Suspense fallback={null}><LazyPopup {...p} /></Suspense>);
registerPopup(DIALOG_ID, (p: PopupProps) => <Suspense fallback={null}><LazyDialog {...p} /></Suspense>);

const isPy = () => pyStore.get().active;
registerAction({
  id: "Ace.SelectPythonInterpreter", title: "Select Python Interpreter", isEnabled: isPy,
  run: () => {
    const el = document.querySelector<HTMLElement>('[data-testid="py-interp-widget"]');
    const r = el?.getBoundingClientRect();
    openPopup(POPUP_ID, r ? { right: r.right, top: r.top } : undefined);
  },
});
registerAction({ id: "Ace.AddPythonInterpreter", title: "Add Python Interpreter", isEnabled: isPy, run: () => openPopup(DIALOG_ID, { tab: "venv" }) });

installTerminalActivation();

const slim = (i: { name: string; path: string; kind: string; project: boolean; version: string }) => ({ name: i.name, path: i.path, kind: i.kind, project: i.project, version: i.version });
registerQa("interp", {
  list: () => pyStore.get().interpreters.map(slim),
  current: () => { const c = pyStore.get().current; return c ? slim(c) : null; },
  state: () => { const s = pyStore.get(); return { active: s.active, loading: s.loading, explicit: s.explicit, probe: s.probe ? { prefix: s.probe.prefix, version: s.probe.version, sitePackages: s.probe.sitePackages } : null, tools: s.tools, rev: s.rev, error: s.error }; },
  widgetText: () => document.querySelector('[data-testid="py-interp-widget"]')?.textContent ?? null,
  expectedWidgetText: () => widgetText(pyStore.get()),
  switchTo: async (path: string) => { const i = pyStore.get().interpreters.find((x) => x.path === path); if (!i) throw new Error("unknown interpreter " + path); await setInterpreter(i); return true; },
  useExisting: async (path: string) => slim(await useExistingInterpreter(path)),
  createVenv: async (dir: string, o: { base?: string; systemSite?: boolean } = {}) => slim(await createVenvAndUse({ dir, ...o })),
  createConda: async (dir: string, pythonVersion?: string) => slim(await createCondaAndUse({ dir, pythonVersion })),
  refresh: async () => { await refreshInterpreters(); return pyStore.get().interpreters.length; },
  openPopup: (tab?: string) => (tab ? openPopup(DIALOG_ID, { tab }) : document.querySelector<HTMLElement>('[data-testid="py-interp-widget"]')?.click()),
  popupRows: () => [...document.querySelectorAll<HTMLElement>('[data-testid="py-interp-popup"] .pyi-row, [data-testid="py-interp-popup"] .pyi-sec')].map((e) => ({ text: e.textContent, sec: e.classList.contains("pyi-sec"), selected: e.classList.contains("selected"), interp: e.dataset.interp ?? null, act: e.dataset.act ?? null })),
  activation: (cwd: string) => activationFor(cwd),
  terminalActivate: () => terminalActivateSetting.get().on,
  setTerminalActivate,
});
