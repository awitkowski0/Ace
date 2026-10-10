import { registerToolWindow } from "../../toolwindows/registry";
import { FolderIcon } from "../shell/icons";
import { ProjectTree } from "./ProjectTree";

registerToolWindow({
  id: "project",
  title: "Project",
  icon: <FolderIcon />,
  side: "left",
  shortcut: "meta 1",
  actionId: "ActivateProjectToolWindow",
  order: 0,
  component: ({ root }) => <ProjectTree root={root} />,
});
