import { ShellIcon } from "../../run/icons";
import { envRecord } from "../../run/util";
import type { ConfigType } from "../../run/types";
import { cwdOf, rootLoc } from "./common";

/** Generic command line run by the login shell on the project's host: works for any language, local or remote. */
export const shellType: ConfigType = {
  id: "shell", label: "Shell Command", icon: <ShellIcon />, order: 50, debuggable: false,
  fields: [
    { kind: "textarea", key: "command", label: "Command line", rows: 3, placeholder: "e.g. cargo run -- --verbose" },
    { kind: "path", key: "workingDir", label: "Working directory", dir: true, placeholder: "(project root)" },
    { kind: "env", key: "env", label: "Environment variables" },
  ],
  defaults: () => ({ command: "", workingDir: "", env: [] }),
  suggestName: (c) => {
    const first = String(c.command ?? "").trim().split(/\s+/).slice(0, 2).join(" ");
    return first ? first.slice(0, 40) : "Shell Command";
  },
  validate: (c) => (String(c.command ?? "").trim() ? null : "Command line is not specified"),
  resolve(cfg) {
    const root = rootLoc();
    const cwd = cwdOf(cfg, root.path);
    const command = String(cfg.command).trim();
    return { spec: { host: root.host, cwd, shell: command, env: envRecord(cfg.env) }, title: command.split(/\s+/)[0] ?? "shell", commandLine: `$ ${command}` };
  },
};
