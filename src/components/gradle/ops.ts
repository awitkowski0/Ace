/** Gradle window operations: pinning (persisted in .ace/config.json -> gradle.pinned), running tasks through the Run infra. */
import { ensureConfig, addConfig, newConfig, ctxFor } from "../run/configs";
import { startRun, type Session } from "../run/sessions";
import { openPopup } from "../shell/popups";
import { repoConfigStore, setRepoSection, useRepoSection } from "../../lib/repoConfig";
import { createStore } from "../../lib/store";
import { gradleStore } from "./model";
import { pinKey, pinsOf, type Pin, type Row } from "./tree";

export const getPins = (): Pin[] => pinsOf(repoConfigStore.get().raw.gradle);
export const usePins = (): Pin[] => pinsOf(useRepoSection("gradle"));

export async function setPins(pins: Pin[]) {
  const cur = repoConfigStore.get().raw.gradle;
  const base = cur && typeof cur === "object" && !Array.isArray(cur) ? (cur as Record<string, unknown>) : {};
  await setRepoSection("gradle", { ...base, pinned: pins });
}
export const isPinned = (task: string, args?: string) => getPins().some((p) => pinKey(p) === pinKey({ task, args: args || undefined }));

export async function pinTask(task: string, args = "", name = "") {
  if (isPinned(task, args)) return;
  const p: Pin = { task };
  if (args.trim()) p.args = args.trim();
  if (name.trim()) p.name = name.trim();
  await setPins([...getPins(), p]);
}
export async function unpinTask(task: string, args = "") {
  const k = pinKey({ task, args: args || undefined });
  await setPins(getPins().filter((p) => pinKey(p) !== k));
}
export async function unpinAt(i: number) {
  await setPins(getPins().filter((_, j) => j !== i));
}
export async function editPinArgs(i: number, args: string) {
  const pins = getPins().map((p, j) => {
    if (j !== i) return p;
    const q = { ...p };
    if (args.trim()) q.args = args.trim(); else delete q.args;
    return q;
  });
  await setPins(pins);
}
export async function movePin(i: number, to: number) {
  const pins = getPins();
  if (i < 0 || i >= pins.length || to < 0 || to >= pins.length || i === to) return;
  const [p] = pins.splice(i, 1);
  pins.splice(to, 0, p);
  await setPins(pins);
}

const defaultName = (task: string, args: string) => `${gradleStore.get().model?.name ?? "gradle"} [${task}${args ? " " + args : ""}]`;

/** Run a task in the Run tool window as a temporary Gradle run configuration. */
export async function runTask(task: string, args = "", name = ""): Promise<Session | null> {
  const cfg = ensureConfig({ type: "gradle", name: name || defaultName(task, args), tasks: task, args, workingDir: "", env: [], temporary: true });
  return startRun(cfg.id, "run");
}
/** "Create Run Configuration": a permanent configuration + the Edit Configurations dialog. */
export function createRunConfiguration(task: string, args = "") {
  const ctx = ctxFor();
  if (!ctx) return;
  addConfig(newConfig("gradle", ctx, { name: defaultName(task, args), tasks: task, args, temporary: false }), true);
  openPopup("EditRunConfigurations");
}

/** Window UI state shared with the keyboard actions. */
export const gradleUi = createStore<{ selected: Row | null; open: Set<string>; rev: number }>({ selected: null, open: new Set(), rev: 0 });
