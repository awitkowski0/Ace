import { registerAction } from "../../actions/registry";
import { registerPopup } from "../shell/popups";
import { gitStore } from "../git/api";
import { NewWorktree } from "./NewWorktree";
import { SwitchWorktree, openNewWorktree, openSwitchWorktree } from "./SwitchWorktree";
import { startWorktrees } from "./store";

const inRepo = () => !!gitStore.get().status?.isRepo;

registerPopup("SwitchWorktree", SwitchWorktree);
registerPopup("NewWorktree", NewWorktree);

// ⌃⌥W is unbound in src/keymap/intellij-macos.json (checked); developer profile only (Asset Dev has "Other copies of this project" in its Branch picker)
registerAction({ id: "Git.Worktree.Switch", title: "Switch Worktree…", defaultKeys: ["control alt W"], profiles: ["developer"], isEnabled: inRepo, run: () => openSwitchWorktree() });
registerAction({ id: "Git.Worktree.New", title: "New Worktree…", profiles: ["developer"], isEnabled: inRepo, run: openNewWorktree });

startWorktrees();
