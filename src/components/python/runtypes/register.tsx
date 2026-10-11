// Python run configuration types, the context provider (⌃⇧R) and the gutter run markers. Nothing here runs until the user acts.
import { projectStore } from "../../../lib/project";
import { registerConfigType, registerContextProvider, ensureConfig } from "../../run/configs";
import { setRunMarkerProvider, type RunMarker } from "../../run/hooks";
import { startRun } from "../../run/sessions";
import type { EditorContext } from "../../run/types";
import { pyStore } from "../interpreter";
import { computeMarkers, configFor, targetAt, type MarkerInfo, type PyTarget } from "./context";
import { pythonType, moduleType } from "./python";
import { pytestType, unittestType } from "./pytest";
import { shellType } from "./shell";

[pythonType, moduleType, pytestType, unittestType, shellType].forEach(registerConfigType);

const rootPath = () => projectStore.get().root?.path ?? "";
const opts = () => ({ rootPath: rootPath(), hasPytest: pyStore.get().probe?.modules?.pytest !== false });
const SCRIPT: PyTarget = { kind: "script", chain: [], unittestStyle: false };

registerContextProvider((ctx: EditorContext) => {
  if (!ctx.loc.path.endsWith(".py") || !rootPath()) return null;
  return configFor(ctx.loc.path, targetAt(ctx.loc.path, ctx.text, ctx.line), opts());
});

const cfgOf = (path: string, m: MarkerInfo) => configFor(path, m.force ? SCRIPT : m.target, opts());

setRunMarkerProvider((model) => {
  const path = model.uri.path;
  if (!path.endsWith(".py") || !rootPath()) return [];
  return computeMarkers(path, model.getValue()).map((m): RunMarker => {
    const go = (mode: "run" | "debug") => () => void startRun(ensureConfig(cfgOf(path, m)).id, mode);
    return { line: m.line, kind: m.kind, label: `Run '${cfgOf(path, m).name}'`, run: go("run"), debug: go("debug") };
  });
});
