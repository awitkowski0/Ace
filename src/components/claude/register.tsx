import { registerToolWindow } from "../../toolwindows/registry";
import { registerAction } from "../../actions/registry";
import { showToolWindow } from "../../lib/layout";
import { SparkIcon } from "../shell/icons";
import { ClaudePanel } from "./ClaudePanel";
import { claudeStore, currentRoot, launch, refreshHost } from "./api";

registerToolWindow({
  id: "claude",
  title: "Claude",
  icon: <SparkIcon />,
  side: "right",
  actionId: "ActivateClaudeToolWindow",
  shortcut: "control alt C",
  order: 3,
  component: ClaudePanel,
});

registerAction({
  id: "Claude.NewSession",
  title: "Claude: New Session",
  run: () => {
    const r = currentRoot();
    if (r) launch.newSession(r.host, r.path);
  },
});
registerAction({
  id: "Claude.ResumeLast",
  title: "Claude: Resume Last Session for Project",
  run: async () => {
    const r = currentRoot();
    if (!r) return;
    if (!claudeStore.get().hosts[r.host]?.sessions.length) await refreshHost(r.host);
    const s = claudeStore.get().hosts[r.host]?.sessions.find((x) => x.cwd === r.path);
    if (s) launch.resume(s);
    else launch.continueLast(r.host, r.path);
  },
});
registerAction({ id: "Claude.ShowSessions", title: "Claude: Show Sessions", run: () => showToolWindow("claude") });
