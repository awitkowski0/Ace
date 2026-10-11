import { registerToolWindow, type ToolWindowProps } from "../../toolwindows/registry";
import { registerAction } from "../../actions/registry";
import { selectGroupTab } from "../shell/toolGroups";
import { SparkIcon } from "../shell/icons";
import { showContextMenu } from "../shell/contextMenu";
import { ClaudePanel } from "./ClaudePanel";
import { claudeStore, currentRoot, launch, refreshHost } from "./api";
import { aiSettings, attnList, gotoAttention, installAi, nextAttention, updateAiSettings, type AiSettings } from "./ai";
import { flip, flipToAi, flipToFiles } from "./flip";

// "AI Sessions" is the second view of the left Project tool window (IntelliJ's Project view switcher: header tabs + one stripe
// button; see TOOL_GROUPS). It replaces the old right-hand Claude window: one place for files and sessions, and the flip action
// moves between them without the sessions list taking screen space on the other side of the editor.
registerToolWindow({
  id: "claude",
  title: "AI Sessions",
  icon: <SparkIcon />,
  side: "left",
  actionId: "ActivateClaudeToolWindow",
  shortcut: "control alt C",
  order: 1,
  component: ClaudePanel,
  headerActions: AiHeaderActions,
});

const TOGGLES: Array<[keyof AiSettings, string]> = [
  ["notifyDone", "Notify when Claude finishes"],
  ["notifyQuestion", "Notify when Claude needs input"],
  ["onlyWhenUnfocused", "Only when Ace is in the background or the session is not on screen"],
  ["sound", "Play a sound"],
  ["hooks", "Report from sessions started in Ace (hooks)"],
  ["watchProject", "Also watch other Claude sessions of this project (transcripts)"],
  ["jumpOnActivate", "Jump to the session when Ace is activated by its notification"],
];

function settingsMenu(x: number, y: number) {
  const s = aiSettings.get();
  showContextMenu(x, y, [
    ...TOGGLES.map(([k, label]) => ({ label: (s[k] ? "✓ " : "   ") + label, run: () => updateAiSettings({ [k]: !s[k] } as Partial<AiSettings>) })),
    { label: "", separator: true },
    { label: "Flip Files / AI Sessions", shortcut: "⌃⌥A", run: flip },
  ]);
}

function AiHeaderActions(_: ToolWindowProps) {
  return (
    <button className="icon-btn sm" title="AI notification settings" data-ai-settings onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); settingsMenu(r.left, r.bottom + 2); }}>
      ⚙
    </button>
  );
}

installAi();

registerAction({
  id: "Claude.FlipFilesAI",
  title: "Flip Between Files and AI Sessions",
  // ⌃⌥A: free in the IntelliJ macOS keymap JSON, no Ghostty/terminal key uses ⌃⌥, global so it works from the editor, the tree,
  // the AI list and the terminal alike. A is for AI; the sibling ⌃⌥C already opens the sessions.
  defaultKeys: ["control alt A"],
  run: flip,
});
registerAction({ id: "Claude.ShowFiles", title: "Claude: Back to Files (Project and Editor)", run: flipToFiles });
registerAction({ id: "Claude.ShowAiSessions", title: "Claude: Show AI Sessions and Last Session", run: flipToAi });
registerAction({
  id: "Claude.GotoWaiting",
  title: "Claude: Go to Session Needing Attention",
  isEnabled: () => attnList().length > 0,
  run: () => { const a = nextAttention(); if (a) gotoAttention(a); },
});
for (const [k, label] of TOGGLES) {
  registerAction({ id: `Claude.Toggle.${k}`, title: `Claude: Toggle "${label}"`, run: () => updateAiSettings({ [k]: !aiSettings.get()[k] } as Partial<AiSettings>) });
}

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
registerAction({ id: "Claude.ShowSessions", title: "Claude: Show Sessions", run: () => selectGroupTab("claude") });
