// Owned by the remote-files agent: replace the placeholder below with the real component (keep this file's registrations).
import { registerToolWindow } from "../../toolwindows/registry";
import { CloudIcon } from "../shell/icons";
import { Placeholder } from "../shell/Placeholder";

registerToolWindow({
  id: "remote-files",
  title: "Remote Files",
  icon: <CloudIcon />,
  side: "left",
  actionId: "ActivateRemoteFilesToolWindow",
  order: 2,
  component: () => <Placeholder name="Remote Files" />,
});
