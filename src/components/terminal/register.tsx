// Owned by the terminal agent: replace the placeholder below with the real component (keep this file's registrations).
import { registerToolWindow } from "../../toolwindows/registry";
import { TerminalIcon } from "../shell/icons";
import { Placeholder } from "../shell/Placeholder";

registerToolWindow({
  id: "terminal",
  title: "Terminal",
  icon: <TerminalIcon />,
  side: "bottom",
  shortcut: "alt F12",
  actionId: "ActivateTerminalToolWindow",
  order: 10,
  component: () => <Placeholder name="Terminal" />,
});
