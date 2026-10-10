// Owned by the claude agent: replace the placeholder below with the real component (keep this file's registrations).
import { registerToolWindow } from "../../toolwindows/registry";
import { SparkIcon } from "../shell/icons";
import { Placeholder } from "../shell/Placeholder";

registerToolWindow({
  id: "claude",
  title: "Claude",
  icon: <SparkIcon />,
  side: "left",
  actionId: "ActivateClaudeToolWindow",
  shortcut: "alt meta C",
  order: 3,
  component: () => <Placeholder name="Claude" />,
});
