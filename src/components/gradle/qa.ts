/** Test hooks (`await __qa.gradle()`) for scripts/qa/gradle.mjs. */
import { gradleStore, reloadGradle } from "./model";
import { getPins, gradleUi, pinTask, runTask, unpinAt, unpinTask } from "./ops";
import { expandAll, collapseAll, openMenu, toggleRow } from "./GradleWindow";
import { visibleRows } from "./tree";
import { repoConfigStore } from "../../lib/repoConfig";
import { javaQa } from "./java/qa";

export const gradleQa = {
  java: javaQa,
  state: () => { const s = gradleStore.get(); return { detected: s.detected, status: s.status, fromCache: s.fromCache, error: s.error, discoveries: s.discoveries, lastMs: s.lastMs, offline: s.offline, name: s.model?.name ?? null, version: s.model?.gradleVersion ?? null, daemonPid: s.model?.daemonPid ?? null, projects: s.model?.projects.map((p) => p.path) ?? [] }; },
  model: () => gradleStore.get().model,
  rows: () => [...document.querySelectorAll<HTMLElement>(".gj-row")].map((e) => ({ id: e.dataset.row, kind: e.dataset.kind, text: e.querySelector(".gj-label")?.textContent, depth: Math.round(parseFloat(e.style.paddingLeft) / 16), title: e.title })),
  visible: () => visibleRows(gradleStore.get().model, getPins(), gradleUi.get().open).map((r) => r.id),
  expandAll, collapseAll, toggle: toggleRow,
  select: (id: string) => { const r = visibleRows(gradleStore.get().model, getPins(), gradleUi.get().open).find((x) => x.id === id); if (!r) throw new Error("no row " + id); gradleUi.set({ selected: r }); },
  selected: () => gradleUi.get().selected?.id ?? null,
  menu: (id: string) => { const r = visibleRows(gradleStore.get().model, getPins(), gradleUi.get().open).find((x) => x.id === id); if (!r) throw new Error("no row " + id); openMenu(10, 10, r); },
  pins: () => getPins(),
  pin: (task: string, args = "", name = "") => pinTask(task, args, name),
  unpin: (task: string, args = "") => unpinTask(task, args),
  unpinAt,
  run: (task: string, args = "") => runTask(task, args),
  reload: () => reloadGradle(),
  repo: () => repoConfigStore.get(),
};
