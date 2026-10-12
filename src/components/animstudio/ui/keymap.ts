/**
 * Animation Studio keymap: ONE data table (Blockbench v5.2.2 defaults, macOS mapping ctrl -> ⌘, see docs/BLOCKBENCH-PARITY.md 1.1/1.2/1.5).
 * Pure data (no React / DOM) so it can be unit-tested and rendered to docs/STUDIO-KEYMAP.md (`keymapMarkdown()`).
 * Registration (tools/actions.ts) walks this table; handlers are keyed by `action`.
 *
 * Context rule: a Studio key is only live while a Studio pane owns DOM focus and focus is not in a text field / Monaco
 * (gated in tools/actions.ts `studioKeysLive`). Outside the Studio Ace's IntelliJ keymap is untouched.
 */

export type KmMode = "edit" | "animate";
/**
 * implemented  the Studio handles the key (registered action `Studio.*`)
 * viewport     dispatched to the viewport API (ui/viewport/api.ts); a missing method is a logged stub
 * host         Ace itself provides it (same key or same effect); the Studio registers nothing
 * skipped      does not apply to Edit/Animate on Bedrock / GeckoLib / bbmodel (reason in `note`)
 * ace          Ace-only binding for a Studio feature whose old key collided with a Blockbench default
 */
export type KmStatus = "implemented" | "viewport" | "host" | "skipped" | "ace";

export interface KmEntry {
  /** Blockbench action id (or `ace.*` for Ace-only bindings) */
  id: string;
  name: string;
  /** Blockbench default as defined ("Ctrl+C", "LMB", "[Ctrl]+[Shift]+↑"); "" for Ace-only */
  bb: string;
  /** what the user presses on macOS (display) */
  mac: string;
  /** Ace keystroke syntax ("meta C", "shift UP", "SPACE"); [] for mouse input / skipped */
  keys: string[];
  modes: KmMode[];
  input: "key" | "mouse";
  status: KmStatus;
  /** Ace action id (`Studio.*`) for implemented / viewport / ace entries */
  action?: string;
  /** behaviour, modifier sub-behaviours, or the skip reason */
  note?: string;
}

const E: KmMode[] = ["edit"];
const A: KmMode[] = ["animate"];
const EA: KmMode[] = ["edit", "animate"];

type Opt = Partial<Pick<KmEntry, "action" | "note" | "input">>;
const row = (id: string, name: string, bb: string, mac: string, keys: string[], modes: KmMode[], status: KmStatus, o: Opt = {}): KmEntry => ({
  id, name, bb, mac, keys, modes, input: o.input ?? "key", status, action: o.action, note: o.note,
});
const mouse = (id: string, name: string, bb: string, modes: KmMode[], status: KmStatus, note: string): KmEntry =>
  row(id, name, bb, bb.replace(/Ctrl/g, "⌘").replace(/Shift/g, "⇧").replace(/Alt/g, "⌥").replace(/\+/g, ""), [], modes, status, { input: "mouse", note });

/** `[Ctrl]+[Shift]+K`: optional modifiers expand to the four combinations (Blockbench ignores them). */
const withMods = (k: string): string[] => [k, `shift ${k}`, `meta ${k}`, `meta shift ${k}`];

const PAINT = "Paint mode only";
const MESH = "Mesh / spline / armature editing: not available in Bedrock formats (parity doc section 5)";
const HOST = "Ace host";

export const STUDIO_KEYMAP: KmEntry[] = [
  // ------------------------------------------------------------------ edit / clipboard / history
  row("copy", "Copy", "Ctrl+C", "⌘C", ["meta C"], EA, "implemented", { action: "Studio.Copy", note: "Animate: copies the selected keyframes. Edit: copies the selected bones / cubes. The Shift variation (`multiple`) has no specified behaviour in the parity doc and is not implemented." }),
  row("cut", "Cut", "Ctrl+X", "⌘X", ["meta X"], EA, "implemented", { action: "Studio.Cut", note: "Copy + delete, same context rules as Copy." }),
  row("paste", "Paste", "Ctrl+V", "⌘V", ["meta V"], EA, "implemented", { action: "Studio.Paste", note: "Animate: keyframes at the playhead. Edit: bones / cubes under the selection (cubes into the selected bone)." }),
  row("undo", "Undo", "Ctrl+Z", "⌘Z", ["meta Z"], EA, "implemented", { action: "Studio.Undo", note: "Routed to the document's Monaco undo stack (one stop per command)." }),
  row("redo", "Redo", "Ctrl+Y", "⌘Y / ⌘⇧Z", ["meta Y", "meta shift Z"], EA, "implemented", { action: "Studio.Redo", note: "Blockbench binds Ctrl+Y; ⌘⇧Z added as the macOS convention." }),
  row("action_control", "Action Control", "F", "F", ["F"], EA, "implemented", { action: "Studio.ActionControl", note: "Searchable list of every Studio command (↑/↓ navigate, Enter run, Esc close). The old Studio 'F = frame selected' moved to ⌥F." }),
  row("select_all", "Select All", "Ctrl+A", "⌘A", ["meta A"], EA, "implemented", { action: "Studio.SelectAll", note: "Edit: all bones. Animate: all keyframes of the open animation." }),
  row("invert_selection", "Invert Selection", "Ctrl+I", "⌘I", ["meta I"], EA, "implemented", { action: "Studio.InvertSelection", note: "Edit: bones. Animate: keyframes." }),
  row("delete", "Delete", "Delete", "⌫", ["BACK_SPACE", "DELETE"], EA, "implemented", { action: "Studio.Delete", note: "Edit: selected cube, else selected bones (children are re-parented). Animate: selected keyframes. The `keep_vertices` Alt variation is mesh-only." }),
  row("duplicate", "Duplicate", "Ctrl+D", "⌘D", ["meta D"], EA, "implemented", { action: "Studio.Duplicate", note: "Edit: bone (with cubes + descendants) or cube. Animate: selected keyframes." }),
  row("rename", "Rename", "F2", "F2", ["F2"], EA, "implemented", { action: "Studio.Rename", note: "Inline rename of the selected bone in the outliner; in Animate with no bone selected, renames the open animation." }),
  row("confirm", "Confirm", "Enter", "Enter", [], EA, "host", { note: "Dialogs, outliner rename and number fields handle Enter themselves." }),
  row("cancel", "Cancel", "Esc", "Esc", ["ESCAPE"], EA, "implemented", { action: "Studio.Cancel", note: "Closes Action Control / tool panels, cancels a viewport gizmo drag (viewport API `cancelDrag`)." }),

  // ------------------------------------------------------------------ tools
  row("move_tool", "Move", "V", "V", ["V"], EA, "implemented", { action: "Studio.Tool.Move" }),
  row("resize_tool", "Resize", "S", "S", ["S"], EA, "implemented", { action: "Studio.Tool.Resize", note: "Not available in Pose mode (Blockbench lists edit / display / animate)." }),
  row("rotate_tool", "Rotate", "R", "R", ["R"], EA, "implemented", { action: "Studio.Tool.Rotate" }),
  row("pivot_tool", "Pivot Tool", "P", "P", ["P"], EA, "implemented", { action: "Studio.Tool.Pivot", note: "Disabled in Pose mode." }),
  row("vertex_snap_tool", "Vertex Snap", "X", "X", ["X"], E, "viewport", { action: "Studio.Tool.VertexSnap", note: "Viewport gizmo mode: calls viewport API `setTool('vertex_snap')`." }),
  row("stretch_tool", "Stretch", "Alt+S", "⌥S", ["alt S"], E, "viewport", { action: "Studio.Tool.Stretch", note: "Viewport gizmo mode (format feature `stretch_cubes`): viewport API `setTool('stretch')`." }),
  row("swap_tools", "Swap Tools", "Space", "Space", ["SPACE"], E, "implemented", { action: "Studio.SwapTools", note: "Edit: switches between the current and the previously used tool. The `hold` sub-keybind (hold Alt = alt tool) is not implemented: Alt already modifies viewport mouse gestures." }),

  // ------------------------------------------------------------------ edit mode: nudge, outliner
  row("move_up", "Move Up", "[Ctrl]+[Shift]+↑", "[⌘][⇧]↑", withMods("UP"), E, "implemented", { action: "Studio.Move.Up", note: "Nudges the selection by the snap step: 1 px, ⇧ 0.25, ⌘ 0.1, ⌘⇧ 0.025 (parity doc 1.4). Up/Down = vertical." }),
  row("move_down", "Move Down", "[Ctrl]+[Shift]+↓", "[⌘][⇧]↓", withMods("DOWN"), E, "implemented", { action: "Studio.Move.Down" }),
  row("move_left", "Move Left", "[Ctrl]+[Shift]+←", "[⌘][⇧]←", withMods("LEFT"), E, "implemented", { action: "Studio.Move.Left", note: "Relative to the viewport camera (viewport API `cameraYaw`; default camera when absent)." }),
  row("move_right", "Move Right", "[Ctrl]+[Shift]+→", "[⌘][⇧]→", withMods("RIGHT"), E, "implemented", { action: "Studio.Move.Right" }),
  row("move_forth", "Move Forth", "[Ctrl]+[Shift]+PgUp", "[⌘][⇧]PgUp", withMods("PAGE_UP"), E, "implemented", { action: "Studio.Move.Forth", note: "Away from the camera, horizontal." }),
  row("move_back", "Move Back", "[Ctrl]+[Shift]+PgDn", "[⌘][⇧]PgDn", withMods("PAGE_DOWN"), E, "implemented", { action: "Studio.Move.Back" }),
  row("add_group", "Add Group", "Ctrl+G", "⌘G", ["meta G"], E, "implemented", { action: "Studio.AddGroup", note: "New bone / group (child of the selected bone, else top level) at the selection's pivot." }),
  row("group_elements", "Group Elements", "Ctrl+Shift+G", "⌘⇧G", ["meta shift G"], E, "implemented", { action: "Studio.GroupElements", note: "Wraps the selected bones / cube in a new group (ungroup: context menu)." }),
  row("hide_everything_except_selection", "Hide Everything Except Selection", "I", "I", ["I"], E, "implemented", { action: "Studio.HideOthers", note: "Toggles: hides every bone but the selection; press again to show all. (The Studio's old 'I = insert keyframe' moved to Q.)" }),
  row("select_window", "Select...", "Ctrl+F", "⌘F", ["meta F"], E, "implemented", { action: "Studio.SelectWindow", note: "Prompts for a name pattern (`*` wildcards, case-insensitive) and selects matching bones / cubes." }),
  row("outliner_toggle", "Toggle More Options", "F4", "F4", ["F4"], EA, "implemented", { action: "Studio.OutlinerOptions", note: "Shows / hides the extra outliner columns (export, shade, auto UV, mirror UV)." }),
  row("create_collection", "Create Collection", "Ctrl+L", "⌘L", [], EA, "skipped", { note: "Collections (named element sets stored in .bbmodel `collections`) are not implemented; they do not affect Bedrock output." }),
  row("toggle_sidebars", "Toggle Sidebars", "Ctrl+B", "⌘B", ["meta B"], EA, "implemented", { action: "Studio.ToggleSidebars", note: "Hides / shows the outliner and properties panels." }),
  row("move_uv_to_cursor", "Move UV to Cursor", "Alt+U", "⌥U", [], E, "skipped", { note: "Needs the full UV editor (cursor-based UV placement); the Studio has a numeric UV panel only." }),

  // ------------------------------------------------------------------ animate
  row("add_keyframe", "Add Keyframe", "Q", "Q", ["Q"], A, "implemented", { action: "Studio.AddKeyframe", note: "Keys for the selected bones at the playhead (current pose values). Shift variation `reset_values` = ⇧Q inserts default values (0 / scale 1)." }),
  row("add_keyframe_reset", "Add Keyframe (reset values)", "Shift+Q", "⇧Q", ["shift Q"], A, "implemented", { action: "Studio.AddKeyframeReset" }),
  row("move_keyframe_back", "Move Keyframes Back", "←", "←", ["LEFT"], A, "implemented", { action: "Studio.KeyBack", note: "Moves the selected keyframes one snap step (1 tick) earlier." }),
  row("move_keyframe_forth", "Move Keyframes Forth", "→", "→", ["RIGHT"], A, "implemented", { action: "Studio.KeyForth" }),
  row("move_graph_keyframes_up", "Move Keyframe Graph Up", "[Ctrl]+[Shift]+↑", "[⌘][⇧]↑", withMods("UP"), A, "implemented", { action: "Studio.GraphUp", note: "Raises the value of the selected keyframes by 1 (scale: 0.1). Modifiers are ignored." }),
  row("move_graph_keyframes_down", "Move Keyframe Graph Down", "[Ctrl]+[Shift]+↓", "[⌘][⇧]↓", withMods("DOWN"), A, "implemented", { action: "Studio.GraphDown" }),
  row("timeline_graph_editor", "Toggle Graph Editor", "F3", "F3", ["F3"], A, "implemented", { action: "Studio.ToggleGraph" }),
  row("play_animation", "Play Animation", "Space", "Space", ["SPACE"], A, "implemented", { action: "Studio.PlayPause" }),
  row("jump_to_timeline_start", "Jump to Animation Start", "Home", "Home", ["HOME"], A, "implemented", { action: "Studio.JumpStart" }),
  row("jump_to_timeline_end", "Jump to Animation End", "End", "End", ["END"], A, "implemented", { action: "Studio.JumpEnd" }),
  row("timeline_frame_back", "Jump 1 Frame Back", ",", ",", ["COMMA"], EA, "implemented", { action: "Studio.FrameBack", note: "One tick (1/20 s). In Edit mode only when an animation is open (bbmodel). Replaces the Studio's old tick-step keys (same keys)." }),
  row("timeline_frame_forth", "Jump 1 Frame Forth", ".", ".", ["PERIOD"], EA, "implemented", { action: "Studio.FrameForth" }),
  row("add_marker", "Set Marker", "Ctrl+M", "⌘M", ["meta M"], A, "implemented", { action: "Studio.AddMarker", note: "Marker at the playhead (saved in .bbmodel animations; session-only for .animation.json)." }),
  row("set_animation_end", "Set Animation End", "Ctrl+End", "⌘End", ["meta END"], A, "implemented", { action: "Studio.SetAnimationEnd", note: "Animation length = playhead time." }),
  row("animation_controller_preview_mode", "Controller Preview", "Space", "Space", [], A, "skipped", { note: "Animation controllers (.animation_controllers.json) are not edited in the Studio." }),

  // ------------------------------------------------------------------ viewport (viewport agent's API)
  row("screenshot_model", "Screenshot Model", "Ctrl+P", "⌘P", ["meta P"], EA, "viewport", { action: "Studio.Screenshot", note: "viewport API `screenshot()`." }),
  row("view_mode", "View Mode", "Z", "Z", ["Z"], EA, "viewport", { action: "Studio.ViewMode", note: "Cycles textured / solid / wireframe...: viewport API `cycleViewMode()` (falls back to the wireframe toggle)." }),
  row("preview_checkerboard", "Checkerboard", "T", "T", ["T"], EA, "viewport", { action: "Studio.Checkerboard", note: "viewport API `toggleCheckerboard()`." }),
  row("pixel_grid", "Pixel Grid", "G", "G", ["G"], E, "viewport", { action: "Studio.PixelGrid", note: "viewport API `togglePixelGrid()`." }),
  row("toggle_camera_projection", "Toggle Camera Projection", "Num5", "Num5 / 5", ["5"], EA, "viewport", { action: "Studio.View.Projection", note: "Digit keys 1-9 share the numpad's key identity in Ace's dispatcher, so the top row works too." }),
  row("camera_initial", "Camera Angle: Initial", "Num1", "Num1 / 1", ["1"], EA, "viewport", { action: "Studio.View.Initial" }),
  row("camera_top", "Camera Angle: Top", "Num8", "Num8 / 8", ["8"], EA, "viewport", { action: "Studio.View.Top" }),
  row("camera_bottom", "Camera Angle: Bottom", "Num2", "Num2 / 2", ["2"], EA, "viewport", { action: "Studio.View.Bottom" }),
  row("camera_south", "Camera Angle: South", "Num4", "Num4 / 4", ["4"], EA, "viewport", { action: "Studio.View.South" }),
  row("camera_north", "Camera Angle: North", "Num6", "Num6 / 6", ["6"], EA, "viewport", { action: "Studio.View.North" }),
  row("camera_east", "Camera Angle: East", "Num7", "Num7 / 7", ["7"], EA, "viewport", { action: "Studio.View.East" }),
  row("camera_west", "Camera Angle: West", "Num9", "Num9 / 9", ["9"], EA, "viewport", { action: "Studio.View.West" }),
  mouse("preview_select", "Select", "LMB", EA, "viewport", "Ctrl = multi-select (toggle), Shift = group select, Alt = loop select. Viewport agent."),
  mouse("preview_rotate", "Rotate View", "LMB", EA, "viewport", "Orbit. Viewport agent."),
  mouse("preview_drag", "Drag View", "RMB", EA, "viewport", "Pan. Viewport agent."),
  mouse("preview_zoom", "Drag-to-Zoom View", "Shift+LMB", EA, "viewport", "Viewport agent."),
  mouse("preview_scroll_zoom", "Zoom View", "Wheel", EA, "viewport", "Viewport agent."),
  mouse("preview_area_select", "Area Select", "Ctrl+[Shift]+LMB", EA, "viewport", "Rectangle select, Shift adds. Viewport agent."),
  mouse("uv_editor_scroll_zoom", "Zoom UV/2D Editor", "Ctrl+Wheel", E, "skipped", "UV editor zoom: the Studio has no zoomable UV editor."),

  // ------------------------------------------------------------------ save / project / host
  row("save_project", "Save Project", "Ctrl+Alt+S", "⌘⌥S", ["meta alt S"], EA, "implemented", { action: "Studio.Save", note: "Saves the document (same as Ace's ⌘S, which stays live inside the Studio)." }),
  row("save_project_incremental", "Save Project With Increment", "Shift+Alt+S", "⇧⌥S", [], EA, "skipped", { note: "Incremental project saves do not exist in Ace; the file is saved in place." }),
  row("save_project_as", "Save Project As", "Ctrl+Shift+Alt+S", "⌘⇧⌥S", [], EA, "skipped", { note: "No Save As for Studio documents (use the Project tool window to copy / rename files)." }),
  row("export_over", "Save Model", "Ctrl+S", "⌘S", ["meta S"], EA, "host", { note: `${HOST}: Save All (⌘S), unchanged inside the Studio.` }),
  row("open_from_link", "Open Model from Link...", "Ctrl+S", "⌘S", [], EA, "skipped", { note: "Shares its key with Save Model in Blockbench; link import is not part of Ace." }),
  row("open_model", "Open Model", "Ctrl+O", "⌘O", [], EA, "host", { note: `${HOST}: ⌘O is IntelliJ's Go to Class; files open from the Project tool window.` }),
  row("close_project", "Close Project", "Ctrl+W", "⌘W", ["meta W"], EA, "host", { note: `${HOST}: closes the Studio tab (⌘W).` }),
  row("switch_tabs", "Switch Tabs", "Ctrl+Tab", "⌃Tab", [], EA, "host", { note: `${HOST}: editor tab switching.` }),
  row("open_dev_tools", "Open Dev Tools", "Ctrl+Shift+I", "⌘⇧I", [], EA, "host", { note: `${HOST}: not bound inside the Studio.` }),
  row("fullscreen", "Fullscreen", "F11", "F11", [], EA, "host", { note: `${HOST}: window handling.` }),
  row("import_texture", "Import Texture", "Ctrl+T", "⌘T", [], EA, "skipped", { note: "Texture management (import / create) belongs to Paint / texture mode; Ace resolves textures from the pack." }),
  row("create_texture", "Create Texture", "Ctrl+Shift+T", "⌘⇧T", [], EA, "skipped", { note: "Texture management: see import_texture." }),

  // ------------------------------------------------------------------ not applicable
  row("extrude_spline_selection", "Extrude Spline", "Shift+E", "⇧E", [], E, "skipped", { note: MESH }),
  row("create_face", "Create Face or Edge", "Shift+F", "⇧F", [], E, "skipped", { note: MESH }),
  row("extrude_mesh_selection", "Extrude Selection", "Shift+E", "⇧E", [], E, "skipped", { note: MESH }),
  row("inset_mesh_selection", "Inset Selection", "Shift+I", "⇧I", [], E, "skipped", { note: MESH }),
  row("merge_vertices", "Merge Vertices", "Shift+M", "⇧M", [], E, "skipped", { note: MESH }),
  row("loop_cut", "Loop Cut", "Shift+R", "⇧R", [], E, "skipped", { note: MESH }),
  row("add_armature_bone", "Add Armature Bone", "Shift+E", "⇧E", [], E, "skipped", { note: "Armature rigs are a Blockbench-side feature, not part of Bedrock geometry." }),
  row("paint_secondary_color", "Paint with Secondary Color", "[Shift]", "[⇧]", [], [], "skipped", { note: PAINT }),
  row("brush_tool", "Paint Brush", "B", "B", [], [], "skipped", { note: PAINT }),
  row("eraser", "Eraser", "E", "E", [], [], "skipped", { note: PAINT }),
  row("draw_shape_tool", "Draw Shape", "U", "U", [], [], "skipped", { note: PAINT }),
  row("gradient_tool", "Gradient Tool", "U", "U", [], [], "skipped", { note: PAINT }),
  row("selection_tool", "Selection Tool", "M", "M", [], [], "skipped", { note: PAINT }),
  row("move_layer_tool", "Move Layer", "Shift+V", "⇧V", [], [], "skipped", { note: PAINT }),
  row("painting_grid", "painting_grid", "G", "G", [], [], "skipped", { note: PAINT }),
  row("swap_colors", "Swap Colors", "X", "X", [], [], "skipped", { note: PAINT }),
  row("animated_texture_editor", "Flipbook Editor...", "←", "←", [], [], "skipped", { note: "Animated textures (flipbook) are not part of Bedrock geometry / animation files." }),

  // ------------------------------------------------------------------ timeline mouse (parity doc 1.5)
  mouse("timeline.scrub", "Scrub ruler", "LMB (Ctrl = no snap)", A, "implemented", "Click / drag on the ruler. Snaps to ticks unless Ctrl or ⌘ is held."),
  mouse("timeline.marker_drag", "Marker drag", "LMB (Ctrl = no snap)", A, "implemented", "Snaps to ticks unless Ctrl / ⌘."),
  mouse("timeline.hscroll", "Horizontal scroll", "Shift+Wheel", A, "implemented", ""),
  mouse("timeline.zoom", "Zoom timeline", "Ctrl+Wheel / pinch", A, "implemented", ""),
  mouse("timeline.vscroll", "Vertical scroll", "Wheel", A, "implemented", ""),
  mouse("timeline.key_select", "Select keyframe", "LMB (Shift = add)", A, "implemented", "Shift adds to the selection."),
  mouse("timeline.key_drag", "Drag keyframes", "LMB drag (Ctrl = stretch)", A, "implemented", "Moves selected keyframes; Ctrl / ⌘ stretches the group around its first key (Alt+Ctrl: around the midpoint); Alt alone duplicates (Studio extra)."),
  mouse("timeline.graph_drag", "Graph editor drag", "LMB drag (Shift = one axis, Ctrl = snap)", A, "implemented", "Shift constrains to time or value, Ctrl / ⌘ snaps time to ticks and value to 0.25."),
  mouse("timeline.box_select", "Box select", "LMB drag on empty (Shift = keep)", A, "implemented", "Shift keeps the previous selection."),
  mouse("timeline.speed_slider", "Playback speed slider", "Shift / Ctrl steps", A, "skipped", "The Studio uses a preset speed list (0.25x-2x) instead of a slider."),

  // ------------------------------------------------------------------ Ace-only (moved off Blockbench defaults)
  row("ace.breakdown", "Pose Between Frames", "", "⌥B", ["alt B"], A, "ace", { action: "Studio.Breakdown", note: "Was ⇧E (Blockbench: extrude / armature bone)." }),
  row("ace.paste_noise", "Paste with Noise…", "", "⌘⌥V", ["meta alt V"], A, "ace", { action: "Studio.PasteWithNoise", note: "Was ⌥⇧V." }),
  row("ace.add_noise", "Add Noise to Selection…", "", "⌘⌥N", ["meta alt N"], A, "ace", { action: "Studio.AddNoise", note: "New default key." }),
  row("ace.frame_selected", "Frame Selected", "", "⌥F", ["alt F"], EA, "ace", { action: "Studio.Frame", note: "Was F (Blockbench: Action Control). Viewport API `frame(selected)`." }),
];

/** Entries whose keys the Studio registers (as Ace actions). */
export const registeredEntries = (): KmEntry[] => STUDIO_KEYMAP.filter((e) => e.input === "key" && e.action && e.keys.length && e.status !== "host" && e.status !== "skipped");

/** Canonical key identity for conflict checks ("shift UP"). */
export const normKey = (k: string) => k.trim().replace(/\s+/g, " ").toLowerCase();

/** Pairs of registered entries that bind the same key in the same mode (must be empty). */
export function conflicts(table: KmEntry[] = STUDIO_KEYMAP): Array<[string, string, string, KmMode]> {
  const out: Array<[string, string, string, KmMode]> = [];
  const seen = new Map<string, string>();
  for (const e of table) {
    if (e.input !== "key" || !e.keys.length || e.status === "skipped" || e.status === "host") continue;
    for (const k of e.keys) for (const m of e.modes) {
      const id = `${m}|${normKey(k)}`;
      const prev = seen.get(id);
      if (prev && prev !== e.id) out.push([prev, e.id, k, m]);
      seen.set(id, e.id);
    }
  }
  return out;
}

const STATUS_LABEL: Record<KmStatus, string> = {
  implemented: "implemented", viewport: "viewport API", host: "Ace host", skipped: "skipped", ace: "Ace-only",
};
const modeLabel = (m: KmMode[]) => (m.length === 2 ? "Edit, Animate" : m.length === 1 ? (m[0] === "edit" ? "Edit" : "Animate") : "-");

/** Content of docs/STUDIO-KEYMAP.md (generated by the keymap test: `UPDATE_KEYMAP_DOC=1 pnpm vitest run ...keymap`). */
export function keymapMarkdown(table: KmEntry[] = STUDIO_KEYMAP): string {
  const L: string[] = [];
  const cnt = (s: KmStatus) => table.filter((e) => e.status === s).length;
  L.push("# Animation Studio keymap", "");
  L.push("<!-- GENERATED from src/components/animstudio/ui/keymap.ts - do not edit by hand. Regenerate: UPDATE_KEYMAP_DOC=1 pnpm vitest run src/components/animstudio/ui/keymap.test.ts -->", "");
  L.push("While a Studio pane has keyboard focus (and focus is not in a text field), Blockbench v5.2.2's default keybinds win (macOS: Ctrl is mapped to ⌘, as Blockbench does).");
  L.push("Outside the Studio, Ace's IntelliJ keymap is untouched. Source of truth for the defaults: `docs/BLOCKBENCH-PARITY.md` sections 1.1, 1.2, 1.5.", "");
  L.push(`Entries: ${table.length} (${cnt("implemented")} implemented, ${cnt("viewport")} via viewport API, ${cnt("host")} Ace host, ${cnt("skipped")} skipped, ${cnt("ace")} Ace-only).`, "");
  L.push("Digit keys 1-9 double as numpad keys (Ace's dispatcher does not tell Numpad1 from Digit1). Bare keys never fire in text inputs or Monaco.", "");
  const sect = (title: string, rows: KmEntry[], cols: "full" | "skip") => {
    if (!rows.length) return;
    L.push(`## ${title}`, "");
    if (cols === "full") {
      L.push("| Blockbench id | Name | Blockbench default | Studio on macOS | Modes | Status | Behaviour |", "|---|---|---|---|---|---|---|");
      for (const e of rows) L.push(`| \`${e.id}\` | ${e.name} | ${e.bb || "-"} | ${e.mac} | ${modeLabel(e.modes)} | ${STATUS_LABEL[e.status]} | ${(e.note ?? "").replace(/\|/g, "\\|")} |`);
    } else {
      L.push("| Blockbench id | Name | Blockbench default | Reason |", "|---|---|---|---|");
      for (const e of rows) L.push(`| \`${e.id}\` | ${e.name} | ${e.bb || "-"} | ${(e.note ?? "").replace(/\|/g, "\\|")} |`);
    }
    L.push("");
  };
  sect("Keyboard", table.filter((e) => e.input === "key" && (e.status === "implemented" || e.status === "viewport")), "full");
  sect("Ace-only bindings (moved off Blockbench defaults)", table.filter((e) => e.status === "ace"), "full");
  sect("Mouse and modifier behaviours", table.filter((e) => e.input === "mouse" && e.status !== "skipped"), "full");
  sect("Provided by the Ace host", table.filter((e) => e.status === "host"), "skip");
  sect("Skipped", table.filter((e) => e.status === "skipped"), "skip");
  L.push("## Commands without a default key", "");
  L.push("Reachable from Action Control (F), the outliner / timeline menus and Ace's Go to Action: flip animation X/Y/Z, mirror keyframes, bake animation, scale animation, set interpolation (linear / catmull-rom / bezier / step), bezier handle reset, snap keyframes to ticks, sort outliner, collapse / unfold groups, unlock all, toggle export / shade / auto UV / mirror UV, ungroup, delete marker.", "");
  return L.join("\n");
}
