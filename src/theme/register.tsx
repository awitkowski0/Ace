// Colour schemes: Settings > Appearance > Theme and Quick Switch Scheme (IntelliJ QuickChangeScheme, ⌃`).
import { registerAction } from "../actions/registry";
import { openPopup, registerPopup } from "../components/shell/popups";
import { SchemePopup, SettingsPopup } from "./ui";

registerPopup("Settings", SettingsPopup);
registerPopup("QuickChangeScheme", SchemePopup);
registerAction({ id: "ShowSettings", title: "Settings…", intellijId: "ShowSettings", defaultKeys: ["meta COMMA"], run: () => openPopup("Settings") });
registerAction({ id: "QuickChangeScheme", title: "Quick Switch Scheme…", intellijId: "QuickChangeScheme", defaultKeys: ["control BACK_QUOTE"], run: () => openPopup("QuickChangeScheme") });
