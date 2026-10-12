/** Test hooks (`await __qa.profiles()`) for scripts/qa/profiles.mjs and the Developer-unchanged check. */
import { listActions, getAction } from "../../actions/registry";
import { listToolWindows, rawToolWindows } from "../../toolwindows/registry";
import { gitStore, refreshNow } from "../git/api";
import { getProfile, profileStore, setProfile } from "./profile";
import { gate } from "./register";
import { qaAnswers, noticeStore } from "./notice";
import { getLatest, listBranches, saveToGit, switchBranch, newBranch, gx, assetChanges } from "./gitops";
import { checkNow, updatesStore, behindCount, ensureLatest } from "./updates";
import { chooseRunTask, discoverRun, gameStore, runGame, stopGame } from "./rungame";
import { saveFlow } from "./SaveDialog";
import { projectStore } from "../../lib/project";
import { classifyAsset } from "./assets";

export const profilesQa = {
  get: () => getProfile(),
  state: () => profileStore.get(),
  set: (p: "developer" | "asset") => setProfile(p),
  /** tool windows the UI shows right now vs everything registered */
  toolWindows: () => listToolWindows().map((t) => `${t.id}:${t.title}`),
  rawToolWindows: () => rawToolWindows().map((t) => `${t.id}:${t.title}`),
  /** every registered action with what the gate does to it (Developer must be all "ok") */
  actions: () => listActions().map((a) => {
    const g = a.profiles ? "profile-only" : (() => { const r = gate(a); return typeof r === "string" ? r : "redirect:" + r.redirect; })();
    return `${a.id}=${g}`;
  }),
  hasAction: (id: string) => !!getAction(id),
  actionIds: () => listActions().filter((a) => !a.profiles && !/^(Profile\.|SwitchProfile)/.test(a.id)).map((a) => a.id),
  gateOf: (id: string) => { const a = getAction(id); if (!a) return null; const r = gate(a); return typeof r === "string" ? r : "redirect:" + r.redirect; },
  /** scripted answers for the next choice dialogs (labels or values) */
  answers: (...a: string[]) => { qaAnswers.length = 0; qaAnswers.push(...a); },
  notices: () => ({ toasts: noticeStore.get().toasts.map((t) => t.text), balloon: noticeStore.get().balloon?.text ?? null, actions: noticeStore.get().balloon?.actions.map((a) => a.label) ?? [] }),
  clickBalloon: async (label: string) => { await noticeStore.get().balloon?.actions.find((a) => a.label === label)?.run(); },
  git: () => { const s = gitStore.get().status; return s && { branch: s.branch, upstream: s.upstream, ahead: s.ahead, behind: s.behind, changes: s.changes.map((c) => `${c.kind}:${c.path}`) }; },
  refresh: () => refreshNow(),
  assetChanges: () => assetChanges(gitStore.get().status?.changes ?? []).map((c) => c.path),
  classify: (p: string) => classifyAsset(p),
  getLatest, listBranches, switchBranch: (n: string, remote = false) => switchBranch(n, remote, saveFlow), newBranch, saveFlow,
  save: (message: string, paths: string[], push = true, pr = false) => {
    const ch = (gitStore.get().status?.changes ?? []).filter((c) => paths.includes(c.path));
    return saveToGit({ message, changes: ch, push, pr });
  },
  checkNow, updates: () => ({ ...updatesStore.get(), behind: behindCount() }), ensureLatest,
  incoming: () => gx.incoming(projectStore.get().root!),
  discoverRun, chooseRunTask, runGame, stopGame, game: () => gameStore.get(),
};
