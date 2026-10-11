/** Viewer actions (image zoom etc.). Context "editor": live while focus is in an editor group; only enabled when the active viewer supports them. */
import { registerAction } from "../../actions/registry";
import { activeController, type ViewerController } from "./controllers";

const def = (id: string, title: string, key: keyof ViewerController, defaultKeys?: string[], intellijId?: string) =>
  registerAction({
    id, title, intellijId, defaultKeys, context: "editor",
    isEnabled: () => !!activeController()?.[key],
    run: () => (activeController()?.[key] as (() => void) | undefined)?.(),
  });

def("Images.Editor.ZoomIn", "Zoom In", "zoomIn", ["meta EQUALS"]);
def("Images.Editor.ZoomOut", "Zoom Out", "zoomOut", ["meta MINUS"]);
def("Images.Editor.ActualSize", "Actual Size", "actualSize", undefined, "Images.Editor.ActualSize");
def("Images.Editor.FitZoom", "Fit Image to Window", "fit", ["meta 0"]);
def("Images.Editor.ToggleGrid", "Show Pixel Grid", "toggleGrid", undefined, "Images.Editor.ToggleGrid");
def("Viewer.FrameAll", "Frame All", "frameAll");
