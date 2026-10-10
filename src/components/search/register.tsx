// Search & navigation module. Popups: SearchEverywhere, GotoFile, GotoSymbol, GotoAction, FindInPath,
// ReplaceInPath, RecentFiles, Switcher. Tool window: Find (pinned results).
import "./search.css";
import { registerToolWindow } from "../../toolwindows/registry";
import { registerPopup, openPopup } from "../shell/popups";
import { SearchIcon } from "../shell/icons";
import { registerAction } from "../../actions/registry";
import { makeSearchPopup } from "./SearchPopup";
import { makeFindPopup } from "./FindInPath";
import { makeRecent } from "./RecentFiles";
import { FindPanel } from "./FindToolWindow";

registerToolWindow({
  id: "find",
  title: "Find",
  icon: <SearchIcon />,
  side: "bottom",
  shortcut: "meta 3",
  actionId: "ActivateFindToolWindow",
  order: 9,
  component: FindPanel,
});

registerPopup("SearchEverywhere", makeSearchPopup("All", "Search Everywhere"));
registerPopup("GotoFile", makeSearchPopup("Files", "Go to File"));
registerPopup("GotoSymbol", makeSearchPopup("Symbols", "Go to Symbol"));
registerPopup("GotoClass", makeSearchPopup("Classes", "Go to Class"));
registerPopup("GotoAction", makeSearchPopup("Actions", "Find Action"));
registerPopup("FindInPath", makeFindPopup(false));
registerPopup("ReplaceInPath", makeFindPopup(true));
registerPopup("RecentFiles", makeRecent(false));
registerPopup("Switcher", makeRecent(true));

const popupAction = (id: string, title: string, keys: string[]) =>
  registerAction({ id, intellijId: id, title, defaultKeys: keys, run: () => openPopup(id) });
popupAction("GotoSymbol", "Go to Symbol…", ["alt meta O"]);
popupAction("GotoClass", "Go to Class…", ["meta O"]);
popupAction("ReplaceInPath", "Replace in Files…", ["meta shift R"]);
