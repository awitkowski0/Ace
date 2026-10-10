// Owned by the git agent: replace the placeholder below with the real component (keep this file's registrations).
import { registerToolWindow } from "../../toolwindows/registry";
import { BranchIcon } from "../shell/icons";
import { Placeholder } from "../shell/Placeholder";

registerToolWindow({
  id: "git",
  title: "Git",
  icon: <BranchIcon />,
  side: "bottom",
  shortcut: "meta 9",
  actionId: "ActivateVersionControlToolWindow",
  order: 12,
  component: () => <Placeholder name="Git" />,
});
