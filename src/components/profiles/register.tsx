// Profiles (Developer / Asset Dev): docs/PROFILES.md. Owns: profile store, tool-window view + action gate, Asset Bar, asset tree,
// Save to Git dialog, branch picker, Run Game, "newer version" watcher. Developer = nothing is filtered, nothing is replaced.
import { createRoot } from "react-dom/client";
import { registerAction, setActionGate, type Action } from "../../actions/registry";
import { rawToolWindows, setToolWindowView, getToolWindow, type ToolWindowDef } from "../../toolwindows/registry";
import { registerPopup } from "../shell/popups";
import { layoutStore, setActive } from "../../lib/layout";
import { AssetTree } from "./AssetTree";
import { AssetChanges } from "./AssetChanges";
import { BranchPopup, newBranchFlow, openBranches } from "./BranchPicker";
import { SavePopup, saveFlow } from "./SaveDialog";
import { SwitchProfilePopup, ProfileSettingsPopup, ProfileStatusWidget, openSwitchProfile, openProfileSettings } from "./ProfileMenu";
import { registerStatusWidget } from "../../toolwindows/registry";
import { NoticeHost } from "./NoticeHost";
import { activateActionId, gateAction, viewToolWindow, type GateResult } from "./gate";
import { getProfile, onProfileChange, setProfile, startProfiles, type Profile } from "./profile";
import { getLatest } from "./gitops";
import { runGame } from "./rungame";
import { startUpdates } from "./updates";
import { notAvailable } from "./notice";
import "./qa";
import "./profiles.css";

// ---- tool windows: Asset Dev shows only Assets (the Project window), Changes (Commit) and Run ----
const overrides = new WeakMap<ToolWindowDef, ToolWindowDef>();
const replace = (title: string, component: ToolWindowDef["component"]) => (tw: ToolWindowDef): ToolWindowDef => {
  let o = overrides.get(tw);
  if (!o) { o = { ...tw, title, component, headerActions: undefined }; overrides.set(tw, o); }
  return o;
};
const OVERRIDES: Record<string, (tw: ToolWindowDef) => ToolWindowDef> = {
  project: replace("Assets", ({ root }) => <AssetTree root={root} />),
  commit: replace("Changes", () => <AssetChanges />),
};
const applyView = (p: Profile) => setToolWindowView(p === "developer" ? null : (tw) => viewToolWindow(p, tw, OVERRIDES));

// ---- actions: Asset Dev blocks tool-window shortcuts and developer-only actions with a gentle notice ----
const hiddenWindowActions = (): Set<string> => {
  const p = getProfile();
  const s = new Set<string>();
  if (p === "developer") return s;
  for (const tw of rawToolWindows()) if (!viewToolWindow(p, tw, OVERRIDES)) s.add(activateActionId(tw));
  return s;
};
export function gate(a: Action): GateResult {
  const p = getProfile();
  if (p === "developer" && !a.profiles) return "ok";
  const r = gateAction(p, a, hiddenWindowActions());
  if (r === "blocked") notAvailable(a.title.replace(/ Tool Window$/, "").replace(/…$/, "") || "That");
  return r;
}
setActionGate(gate);

// ---- layout: keep only visible windows open in Asset Dev, restore the developer layout afterwards ----
let saved: Record<string, string | null> | null = null;
onProfileChange((p) => {
  applyView(p);
  document.documentElement.dataset.profile = p;
  const { active } = layoutStore.get();
  if (p === "asset") {
    saved = { ...active };
    for (const side of ["left", "right", "bottom"] as const) {
      const id = active[side];
      if (id && !getToolWindow(id)) layoutStore.set((s) => ({ active: { ...s.active, [side]: side === "left" ? "project" : null } }));
    }
  } else if (saved) {
    for (const side of ["left", "right", "bottom"] as const) if (saved[side] !== undefined && layoutStore.get().active[side] !== saved[side]) setActive(side, saved[side]);
    saved = null;
  }
});

// ---- popups + actions ----
registerPopup("AssetSave", SavePopup);
registerPopup("AssetBranches", BranchPopup);
registerPopup("SwitchProfile", SwitchProfilePopup);
registerStatusWidget({ id: "profile", side: "right", order: 1, component: ProfileStatusWidget });
registerPopup("ProfileSettings", ProfileSettingsPopup);

registerAction({ id: "SwitchProfile", title: "Switch Profile…", run: openSwitchProfile });
registerAction({ id: "Profile.Developer", title: "Switch Profile: Developer", run: () => void setProfile("developer") });
registerAction({ id: "Profile.Asset", title: "Switch Profile: Asset Dev", run: () => void setProfile("asset") });
registerAction({ id: "Profile.Settings", title: "Profile Settings…", run: openProfileSettings });
const asset = ["asset"];
registerAction({ id: "Assets.GetLatest", title: "Get Latest (Asset Dev)", profiles: asset, run: async () => void (await getLatest()) });
registerAction({ id: "Assets.Branch", title: "Switch Branch (Asset Dev)", profiles: asset, run: openBranches });
registerAction({ id: "Assets.NewBranch", title: "New Branch for My Work (Asset Dev)", profiles: asset, run: async () => void (await newBranchFlow()) });
registerAction({ id: "Assets.Save", title: "Save to Git (Asset Dev)", profiles: asset, run: async () => void (await saveFlow()) });
registerAction({ id: "Assets.RunGame", title: "Run Game (Asset Dev)", profiles: asset, run: runGame });

// ---- notices host + startup ----
const host = document.createElement("div");
host.id = "profiles-notices";
document.body.appendChild(host);
createRoot(host).render(<NoticeHost />);

void startProfiles().then(startUpdates);
