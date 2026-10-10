import { registerToolWindow } from "../../toolwindows/registry";
import { registerAction } from "../../actions/registry";
import { registerPopup, openPopup } from "../shell/popups";
import { BranchIcon } from "../shell/icons";
import { showToolWindow, isToolWindowFocused } from "../../lib/layout";
import { CommitIcon } from "./icons";
import { CommitPanel, doCommit, selectedChange, toggleAmend } from "./CommitPanel";
import { GitPanel } from "./GitPanel";
import { BranchesPopup } from "./BranchesPopup";
import { DiffPopup } from "./DiffPopup";
import { fetchAll, gitStore, pushCurrent, refreshAll, startGit, updateProject } from "./api";
import { openChangeDiff } from "./diff";
import { installGutter, toggleBlame } from "./gutter";
import "./git.css";

const inRepo = () => !!gitStore.get().status?.isRepo;

registerToolWindow({
  id: "commit",
  title: "Commit",
  icon: <CommitIcon />,
  side: "left",
  shortcut: "meta 0",
  actionId: "ActivateCommitToolWindow",
  order: 11,
  component: CommitPanel,
});

registerToolWindow({
  id: "git",
  title: "Git",
  icon: <BranchIcon />,
  side: "bottom",
  shortcut: "meta 9",
  actionId: "ActivateVersionControlToolWindow",
  order: 12,
  component: GitPanel,
});

registerPopup("GitBranches", BranchesPopup);
registerPopup("GitDiff", DiffPopup);

registerAction({ id: "CheckinProject", title: "Commit…", intellijId: "CheckinProject", defaultKeys: ["meta K"], run: () => showToolWindow("commit") });
registerAction({ id: "Vcs.UpdateProject", title: "Update Project", intellijId: "Vcs.UpdateProject", defaultKeys: ["meta T"], isEnabled: inRepo, run: () => void updateProject() });
registerAction({ id: "Vcs.Push", title: "Push…", intellijId: "Vcs.Push", defaultKeys: ["meta shift K"], isEnabled: inRepo, run: () => void pushCurrent() });
registerAction({ id: "Vcs.ToggleAmendCommitMode", title: "Amend Commit", intellijId: "Vcs.ToggleAmendCommitMode", defaultKeys: ["control alt M"], isEnabled: inRepo, run: toggleAmend });
registerAction({ id: "Git.Branches", title: "Git Branches…", isEnabled: inRepo, run: () => openPopup("GitBranches") });
registerAction({ id: "Git.Fetch", title: "Git Fetch", isEnabled: inRepo, run: () => void fetchAll() });
registerAction({ id: "Git.Refresh", title: "Git Refresh", run: () => void refreshAll() });
registerAction({ id: "Git.Commit", title: "Git Commit", isEnabled: inRepo, run: () => void doCommit(false) });
registerAction({ id: "Git.Annotate", title: "Annotate with Git Blame", isEnabled: inRepo, run: toggleBlame });
// ⌘D is "duplicate line" in the editor; only claim it while the Commit window is focused.
registerAction({
  id: "Diff.ShowDiff",
  title: "Show Diff",
  intellijId: "Diff.ShowDiff",
  defaultKeys: ["meta D"],
  isEnabled: () => isToolWindowFocused("commit") && !!selectedChange(),
  run: () => { const c = selectedChange(); if (c) openChangeDiff(c); },
});

installGutter();
startGit();
