import { registerToolWindow } from "../../toolwindows/registry";
import { registerAction } from "../../actions/registry";
import { openRemoteProject } from "../../lib/project";
import { CloudIcon } from "../shell/icons";
import { RemoteFiles } from "./RemoteFiles";

registerToolWindow({
  id: "remote-files",
  title: "Remote Files",
  icon: <CloudIcon />,
  side: "left",
  actionId: "ActivateRemoteFilesToolWindow",
  order: 2,
  component: () => <RemoteFiles />,
});

registerAction({ id: "OpenRemoteProject", title: "Open Remote Project…", run: openRemoteProject });
