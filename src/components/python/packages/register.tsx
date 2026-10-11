// Python Packages window (docs/PYTHON.md). Lists/search/install/upgrade/uninstall for the selected interpreter; nothing runs until the window is shown.
import { lazy, Suspense } from "react";
import { registerToolWindow } from "../../../toolwindows/registry";
import { showToolWindow } from "../../../lib/layout";
import { registerQa } from "../qa";
import { currentInterpreter } from "../interpreter";
import { lookup, setPackagesOverride, pkgStore, refresh, requestOp, search, select, setMode, setQuery } from "./store";

const Win = lazy(() => import("./PackagesWindow").then((m) => ({ default: m.PackagesWindow })));

const PackageIcon = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
    <path d="M8 1.500l5.500 2.800v7.400L8 14.500l-5.500-2.800V4.300z" />
    <path d="M2.500 4.300L8 7.200l5.500-2.900M8 7.200v7.300" />
  </svg>
);

registerToolWindow({
  id: "pypackages",
  title: "Python Packages",
  icon: <PackageIcon />,
  side: "bottom",
  actionId: "ActivatePythonPackagesToolWindow",
  order: 12,
  component: () => <Suspense fallback={null}><Win /></Suspense>,
});

registerQa("packages", {
  open: () => { showToolWindow("pypackages"); return true; },
  /** reload and return the installed packages of the selected interpreter */
  list: async () => { await refresh(); for (let i = 0; i < 200 && pkgStore.get().loading; i++) await new Promise((r) => setTimeout(r, 100)); const s = pkgStore.get(); return { pkgs: s.pkgs, error: s.error, interp: s.interp, tool: s.tool }; },
  useOverride: (o: { host: string; cwd: string; python: string } | null) => setPackagesOverride(o),
  interp: () => currentInterpreter()?.path ?? null,
  lookup: (name: string) => lookup(name),
  search: async (q: string) => { await search(q); return pkgStore.get().hits; },
  select: (name: string, src: "installed" | "pypi" = "installed") => select(name, src),
  setQuery: (q: string) => setQuery(q),
  setMode: (m: "installed" | "pypi") => setMode(m),
  /** shows the confirmation dialog (exact command) and resolves after the command ran; `skipConfirm` bypasses only the dialog */
  requestOp: (kind: "install" | "upgrade" | "uninstall", name: string, version?: string, skipConfirm?: boolean) => requestOp(kind, name, version ?? null, { skipConfirm }),
  state: () => { const s = pkgStore.get(); return { count: s.pkgs.length, running: s.running, status: s.status, mode: s.mode, selected: s.selected, log: s.log, tool: s.tool }; },
});
