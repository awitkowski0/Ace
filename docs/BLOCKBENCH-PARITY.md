# Blockbench Parity Reference

**Source read:** JannisX11/blockbench, tag `v5.2.2`, commit `c9ace42ef1b770bdadfe656729c7833b8feb37d2` (shallow clone, read-only; scripts/install/build not run).
**Scope:** Edit and Animate modes (Paint/Display only where they touch Edit/Animate), keybinds, viewport, reference images.
**Regenerate:** the keybind and feature tables were produced by regex extraction over `js/**/*.{js,ts}` plus `lang/en.json`. They are a faithful dump of `new Action / Tool / Toggle / BarSelect / KeybindItem` definitions with a `keybind:` property, not a full TypeScript parse. Dynamically built actions (loops, `addSubKeybind` calls, dialog-local `keyboard_actions`) are listed by hand in section 1.2.

## 0. Conventions and caveats

- **Keybind model** (`js/interface/keyboard.js`, class `Keybind`): fields `key` (keycode, or `1001` = wheel, `1010-1013` = slider drags), `ctrl`, `shift`, `alt`, `meta`. `true` = required, `false` = must be up, `null` = ignored ("any"). A `variations` map turns a modifier into a behaviour switch on the same key (for example `multi_select: 'ctrl'`).
- **macOS mapping:** when `isMac` is true the constructor converts `ctrl: true` into `meta` (⌘) and maps Delete (46) to Backspace (8) (`keyboard.js:52-58`). "Default on macOS" in the tables applies this rule. Note `Pressing.ctrl` is still the physical Ctrl key.
- **Name column:** from `lang/en.json`. Default name key is `action.<id>` (Actions and Tools) or `keybind.<id>` (KeybindItems), per `actions.ts:114` and `actions.ts:328`.
- **Mode column:** the `modes` list found in the action's definition. `global` means no mode restriction was found. Conditions are abridged.
- **Keycode legend:** LMB=1, MMB=2, RMB=3, Wheel=1001, Num0-9=96-105, F1-F12=112-123, Space=32, Enter=13, Esc=27, Delete=46, Tab=9, Home=36, End=35, PgUp=33, PgDn=34, arrows 37-40, `,`=188, `.`=190.

## 1. Keybinds and input

### 1.1 Default keybind table (109 Actions/Tools/Toggles/KeybindItems with a default)

Columns follow the request. "Default (as defined)" is the keybind in source. "Default on macOS" is what the user sees after the ctrl→⌘ mapping. `[X]` means the modifier is optional ("any").

| Action id | Name (en.json) | Kind | Default (as defined) | Default on macOS | Variations (modifier-modified behavior) | Mode | Condition (abridged) | Source |
|---|---|---|---|---|---|---|---|---|
| copy | Copy | Action | Ctrl+C | ⌘C |  multiple: 'shift'  | global | () => Clipbench.getCopyType(1, true) \|\| SharedActions.condition('co... | js/copy_paste.js:451 |
| cut | Cut | Action | Ctrl+X | ⌘X |  multiple: 'shift'  | global | () => Clipbench.getCopyType(1, true) \|\| SharedActions.condition('co... | js/copy_paste.js:469 |
| paste | Paste | Action | Ctrl+V | ⌘V |  multiple: 'shift'  | global | () => Clipbench.getCopyType(2, true) \|\| SharedActions.condition('pa... | js/copy_paste.js:487 |
| undo | Undo | Action | Ctrl+Z | ⌘Z |  | global | () => Project | js/undo.js:1044 |
| redo | Redo | Action | Ctrl+Y | ⌘Y |  | global | () => Project | js/undo.js:1053 |
| action_control | Action Control | Action | F | F |  | global |  | js/interface/action_control.js:150 |
| preview_select | Select | KeybindItem | LMB | LMB | multi_select: 'ctrl', group_select: 'shift', loop_select: 'alt' | global |  | js/interface/main_tools.ts:9 |
| preview_rotate | Rotate View | KeybindItem | LMB | LMB |  | global |  | js/interface/main_tools.ts:20 |
| preview_drag | Drag View | KeybindItem | RMB | RMB |  | global |  | js/interface/main_tools.ts:24 |
| preview_zoom | Drag-to-Zoom View | KeybindItem | Shift+LMB | ⇧LMB |  | global |  | js/interface/main_tools.ts:28 |
| preview_scroll_zoom | Zoom View | KeybindItem | Wheel | Wheel |  | global |  | js/interface/main_tools.ts:32 |
| uv_editor_scroll_zoom | Zoom UV/2D Editor | KeybindItem | Ctrl+Wheel | ⌘Wheel |  | global |  | js/interface/main_tools.ts:40 |
| preview_area_select | Area Select | KeybindItem | Ctrl+[Shift]+LMB | ⌘[⇧]LMB |  | global |  | js/interface/main_tools.ts:44 |
| confirm | Confirm | KeybindItem | Enter | Enter |  | global |  | js/interface/main_tools.ts:49 |
| cancel | Cancel | KeybindItem | Esc | Esc |  | global |  | js/interface/main_tools.ts:53 |
| move_tool | Move | Tool | V | V |  | edit,display,animate,pose |  | js/interface/main_tools.ts:59 |
| resize_tool | Resize | Tool | S | S |  | edit,display,animate |  | js/interface/main_tools.ts:71 |
| rotate_tool | Rotate | Tool | R | R |  | edit,display,animate,pose |  | js/interface/main_tools.ts:96 |
| pivot_tool | Pivot Tool | Tool | P | P |  | edit,animate |  | js/interface/main_tools.ts:108 |
| vertex_snap_tool | Vertex Snap | Tool | X | X |  | edit | {modes: ['edit']} | js/interface/main_tools.ts:119 |
| stretch_tool | Stretch | Tool | Alt+S | ⌥S |  | edit | {features: ['stretch_cubes'], modes: ['edit']} | js/interface/main_tools.ts:142 |
| swap_tools | Swap Tools | Action | Space | Space |  | edit,paint,display | {modes: ['edit', 'paint', 'display'], project: true} | js/interface/main_tools.ts:155 |
| open_dev_tools | Open Dev Tools | Action | Ctrl+Shift+I | ⌘⇧I |  | global | isApp | js/interface/main_tools.ts:255 |
| fullscreen | Fullscreen | Action | F11 | F11 |  | global | isApp | js/interface/main_tools.ts:268 |
| toggle_sidebars | Toggle Sidebars | Action | Ctrl+B | ⌘B |  | global | () => !Blockbench.isMobile && Mode.selected && !Mode.selected.hide_... | js/interface/main_tools.ts:296 |
| rename | Rename | Action | F2 | F2 |  | global |  | js/interface/shared_actions.ts:161 |
| delete | Delete | Action | Delete | ⌫ |  keep_vertices: 'alt'  | global | () => !Dialog.open | js/interface/shared_actions.ts:174 |
| duplicate | Duplicate | Action | Ctrl+D | ⌘D |  | global | () => SharedActions.condition('duplicate') | js/interface/shared_actions.ts:188 |
| select_all | Select All | Action | Ctrl+A | ⌘A |  | global | () => !Modes.display | js/interface/shared_actions.ts:197 |
| invert_selection | Invert Selection | Action | Ctrl+I | ⌘I |  | global |  | js/interface/shared_actions.ts:216 |
| save_project | Save Project | Action | Ctrl+Alt+S | ⌘⌥S |  | global | () => Project | js/formats/bbmodel.js:873 |
| save_project_incremental | Save Project With Increment | Action | Shift+Alt+S | ⇧⌥S |  | global | isApp ? (() => Project && Project.save_path) : false | js/formats/bbmodel.js:888 |
| save_project_as | Save Project As | Action | Ctrl+Shift+Alt+S | ⌘⇧⌥S |  | global | () => Project | js/formats/bbmodel.js:916 |
| paint_secondary_color | Paint with Secondary Color | KeybindItem | [Shift] | [⇧]— |  | global |  | js/texturing/painter.js:2847 |
| brush_tool | Paint Brush | Tool | B | B |  | paint |  | js/texturing/painter.js:2871 |
| eraser | Eraser | Tool | E | E |  | paint |  | js/texturing/painter.js:3156 |
| draw_shape_tool | Draw Shape | Tool | U | U |  | paint | {modes: ['paint']} | js/texturing/painter.js:3239 |
| gradient_tool | Gradient Tool | Tool | U | U |  | paint | {modes: ['paint']} | js/texturing/painter.js:3263 |
| selection_tool | Selection Tool | Tool | M | M |  create: '', add: 'shift', subtract: 'ctrl', intersect: '',  | paint |  | js/texturing/painter.js:3294 |
| move_layer_tool | Move Layer | Tool | Shift+V | ⇧V |  | paint |  | js/texturing/painter.js:3370 |
| painting_grid | painting_grid | Toggle | G | G |  | paint | {modes: ['paint']} | js/texturing/painter.js:3671 |
| swap_colors | Swap Colors | Action | X | X |  | paint | {modes: ['paint']} | js/texturing/color.js:944 |
| animated_texture_editor | Flipbook Editor... | Action | ← | ← |  | global | () => Format.animated_textures && Texture.selected?.frameCount > 1 | js/texturing/texture_flipbook.js:169 |
| import_texture | Import Texture | Action | Ctrl+T | ⌘T |  | global |  | js/texturing/textures.js:2457 |
| create_texture | Create Texture | Action | Ctrl+Shift+T | ⌘⇧T |  | global |  | js/texturing/textures.js:2504 |
| open_model | Open Model | Action | Ctrl+O | ⌘O |  | global |  | js/io/io.js:310 |
| open_from_link | Open Model from Link... | Action | Ctrl+S | ⌘S |  | global | () => Project | js/io/io.js:345 |
| export_over | Save Model | Action | Ctrl+S | ⌘S |  | global | () => Project | js/io/io.js:378 |
| close_project | Close Project | Action | Ctrl+W | ⌘W |  | global | () => !!Project | js/io/project.ts:1295 |
| switch_tabs | Switch Tabs | Action | Ctrl+Tab | ⌘Tab | reverse_order: 'shift' | global | () => ModelProject.all.length > 1 | js/io/project.ts:1407 |
| extrude_spline_selection | Extrude Spline | Action | Shift+E | ⇧E |  | edit | { | js/modeling/spline_editing.js:327 |
| create_face | Create Face or Edge | Action | Shift+F | ⇧F |  | edit | {modes: ['edit'], features: ['meshes'], method: () => (Mesh.selecte... | js/modeling/mesh_editing.js:362 |
| extrude_mesh_selection | Extrude Selection | Action | Shift+E | ⇧E |  | edit | { | js/modeling/mesh_editing.js:696 |
| inset_mesh_selection | Inset Selection | Action | Shift+I | ⇧I |  | edit | {modes: ['edit'], features: ['meshes'], method: () => (Mesh.selecte... | js/modeling/mesh_editing.js:1207 |
| move_up | Move Up | Action | [Ctrl]+[Shift]+↑ | [⇧]↑ |  | edit | {modes: ['edit'], method: () => (!open_menu && selected.length)} | js/modeling/transform.js:1782 |
| move_down | Move Down | Action | [Ctrl]+[Shift]+↓ | [⇧]↓ |  | edit | {modes: ['edit'], method: () => (!open_menu && selected.length)} | js/modeling/transform.js:1795 |
| move_left | Move Left | Action | [Ctrl]+[Shift]+← | [⇧]← |  | edit | {modes: ['edit'], method: () => (!open_menu && selected.length)} | js/modeling/transform.js:1808 |
| move_right | Move Right | Action | [Ctrl]+[Shift]+→ | [⇧]→ |  | edit | {modes: ['edit'], method: () => (!open_menu && selected.length)} | js/modeling/transform.js:1821 |
| move_forth | Move Forth | Action | [Ctrl]+[Shift]+PgUp | [⇧]PgUp |  | edit | {modes: ['edit'], method: () => (!open_menu && selected.length)} | js/modeling/transform.js:1834 |
| move_back | Move Back | Action | [Ctrl]+[Shift]+PgDn | [⇧]PgDn |  | edit | {modes: ['edit'], method: () => (!open_menu && selected.length)} | js/modeling/transform.js:1841 |
| merge_vertices | Merge Vertices | Action | Shift+M | ⇧M |  | edit | {modes: ['edit'], features: ['meshes'], method: () => (Mesh.selecte... | js/modeling/mesh/merge_split.ts:191 |
| loop_cut | Loop Cut | Action | Shift+R | ⇧R |  | edit | {modes: ['edit'], features: ['meshes'], method: () => (Mesh.selecte... | js/modeling/mesh/loop_cut.ts:3 |
| uv_maximize | Maximize UV | Action | — | — |  all_faces: 'shift'  | global | () => Modes.edit && UVEditor.isFaceUV() && Cube.selected.length | js/uv/uv.js:2175 |
| uv_turn_mapping | Turn Mapping | Action | — | — |  all_faces: 'shift'  | global | () => Modes.edit && UVEditor.isFaceUV() && Cube.selected.length | js/uv/uv.js:2191 |
| uv_auto | Auto UV | Action | — | — |  all_faces: 'shift'  | global | () => Modes.edit && ((UVEditor.isFaceUV() && Cube.selected.length) ... | js/uv/uv.js:2207 |
| uv_rel_auto | Relative Auto UV | Action | — | — |  all_faces: 'shift'  | global | () => Modes.edit && UVEditor.isFaceUV() && Cube.selected.length | js/uv/uv.js:2287 |
| uv_mirror_x | UV Mirror X | Action | — | — |  all_faces: 'shift'  | global | () => Modes.edit && UVEditor.isFaceUV() && UVEditor.hasElements() | js/uv/uv.js:2303 |
| uv_mirror_y | UV Mirror Y | Action | — | — |  all_faces: 'shift'  | global | () => Modes.edit && UVEditor.isFaceUV() && UVEditor.hasElements() | js/uv/uv.js:2325 |
| uv_rotate_left | Rotate UV Left | Action | — | — |  all_faces: 'shift'  | global | () => Modes.edit && Mesh.selected.length | js/uv/uv.js:2347 |
| uv_rotate_right | Rotate UV Right | Action | — | — |  all_faces: 'shift'  | global | () => Modes.edit && Mesh.selected.length | js/uv/uv.js:2363 |
| uv_transparent | Remove Face | Action | — | — |  all_faces: 'shift'  | global | () => Modes.edit && UVEditor.isFaceUV() && Cube.selected.length | js/uv/uv.js:2379 |
| uv_reset | Reset Face | Action | — | — |  all_faces: 'shift'  | global | () => Modes.edit && UVEditor.isFaceUV() && Cube.selected.length | js/uv/uv.js:2393 |
| auto_cullface | Enable Cullface | Action | — | — |  all_faces: 'shift'  | global | () => Modes.edit && UVEditor.isFaceUV() && Format.cullfaces && Cube... | js/uv/uv.js:2438 |
| move_uv_to_cursor | Move UV to Cursor | Action | Alt+U | ⌥U |  | edit | {modes: ['edit'], method: () => UVEditor.hasElements()} | js/uv/uv.js:2483 |
| screenshot_model | Screenshot Model | Action | Ctrl+P | ⌘P |  | global | () => !!Project | js/preview/screenshot.js:845 |
| view_mode | View Mode | BarSelect | Z | Z |  | global | () => Project && Toolbox && Toolbox.selected && (!Toolbox.selected.... | js/preview/preview.ts:2592 |
| preview_checkerboard | preview_checkerboard | Toggle | T | T |  | global |  | js/preview/preview.ts:2629 |
| pixel_grid | pixel_grid | Toggle | G | G |  | edit | {modes: ['edit']} | js/preview/preview.ts:2679 |
| focus_on_selection | Center View on Selection | Action | — | — |  rotate_only: 'shift', zoom: 'ctrl'  | global | () => !Format.image_editor | js/preview/preview.ts:2713 |
| toggle_camera_projection | Toggle Camera Projection | Action | Num5 | Num5 |  | global | _ => (!ReferenceImageMode.active \|\| !Modes.display) | js/preview/preview.ts:2782 |
| camera_initial | camera_initial | Action | Num1 | Num1 |  | global | _ => !Modes.display | js/preview/preview.ts:2791 |
| camera_top | camera_top | Action | Num8 | Num8 |  | global | _ => !Modes.display | js/preview/preview.ts:2803 |
| camera_bottom | camera_bottom | Action | Num2 | Num2 |  | global | _ => !Modes.display | js/preview/preview.ts:2815 |
| camera_south | camera_south | Action | Num4 | Num4 |  | global | _ => !Modes.display | js/preview/preview.ts:2827 |
| camera_north | camera_north | Action | Num6 | Num6 |  | global | _ => !Modes.display | js/preview/preview.ts:2839 |
| camera_east | camera_east | Action | Num7 | Num7 |  | global | _ => !Modes.display | js/preview/preview.ts:2851 |
| camera_west | camera_west | Action | Num9 | Num9 |  | global | _ => !Modes.display | js/preview/preview.ts:2863 |
| add_keyframe | Add Keyframe | Action | Q | Q |  reset_values: 'shift'  | animate | {modes: ['animate']} | js/animations/keyframe.js:843 |
| move_keyframe_back | Move Keyframes Back | Action | ← | ← |  | animate | {modes: ['animate'], method: () => (!open_menu && Timeline.selected... | js/animations/keyframe.js:873 |
| move_keyframe_forth | Move Keyframes Forth | Action | → | → |  | animate | {modes: ['animate'], method: () => (!open_menu && Timeline.selected... | js/animations/keyframe.js:888 |
| move_graph_keyframes_up | Move Keyframe Graph Up | Action | [Ctrl]+[Shift]+↑ | [⇧]↑ |  | animate | {modes: ['animate'], method: () => (!open_menu && Timeline.selected... | js/animations/keyframe.js:916 |
| move_graph_keyframes_down | Move Keyframe Graph Down | Action | [Ctrl]+[Shift]+↓ | [⇧]↓ |  | animate | {modes: ['animate'], method: () => (!open_menu && Timeline.selected... | js/animations/keyframe.js:926 |
| keyframe_column_create | Create Keyframe Column | Action | — | — |  all_channels: 'shift'  | global | () => Animator.open | js/animations/keyframe.js:1209 |
| timeline_graph_editor | Toggle Graph Editor | Toggle | F3 | F3 |  | animate | {modes: ['animate']} | js/animations/timeline.js:1920 |
| play_animation | Play Animation | Action | Space | Space |  | animate | {modes: ['animate'], selected: {animation_controller: false}} | js/animations/timeline.js:1964 |
| jump_to_timeline_start | Jump to Animation Start | Action | Home | Home |  | animate | {modes: ['animate']} | js/animations/timeline.js:2033 |
| jump_to_timeline_end | Jump to Animation End | Action | End | End |  | animate | {modes: ['animate']} | js/animations/timeline.js:2051 |
| timeline_frame_back | Jump 1 Frame Back | Action | , | , |  | animate,edit,paint | {modes: ['animate', 'edit', 'paint'], method: () => (Modes.animate ... | js/animations/timeline.js:2068 |
| timeline_frame_forth | Jump 1 Frame Forth | Action | . | . |  | animate,edit,paint | {modes: ['animate', 'edit', 'paint'], method: () => (Modes.animate ... | js/animations/timeline.js:2084 |
| add_marker | Set Marker | Action | Ctrl+M | ⌘M |  | animate | {modes: ['animate']} | js/animations/timeline.js:2231 |
| animation_controller_preview_mode | Controller Preview | BarSelect | Space | Space |  | animate | {modes: ['animate'], selected: {animation_controller: true}} | js/animations/animation_controllers.js:2322 |
| set_animation_end | Set Animation End | Action | Ctrl+End | ⌘End |  | animate | {modes: ['animate'], method: () => Animation.selected} | js/animations/animation.js:935 |
| create_collection | Create Collection | Action | Ctrl+L | ⌘L |  | edit,paint,animate | {modes: ['edit', 'paint', 'animate']} | js/outliner/collections.ts:600 |
| outliner_toggle | Toggle More Options | Toggle | F4 | F4 |  | global |  | js/outliner/outliner.js:949 |
| select_window | Select... | Action | Ctrl+F | ⌘F |  | global | () => Modes.edit \|\| Modes.paivnt | js/outliner/outliner.js:1105 |
| hide_everything_except_selection | Hide Everything Except Selection | Action | I | I |  | edit,paint | {modes: ['edit', 'paint']} | js/outliner/outliner.js:1204 |
| add_armature_bone | Add Armature Bone | Action | Shift+E | ⇧E |  | edit | { | js/outliner/types/armature_bone.ts:571 |
| add_group | Add Group | Action | Ctrl+G | ⌘G |  | global | () => Modes.edit | js/outliner/types/group.js:720 |
| group_elements | Group Elements | Action | Ctrl+Shift+G | ⌘⇧G |  | global | () => Modes.edit && (Outliner.selected.length \|\| Group.first_select... | js/outliner/types/group.js:765 |

### 1.2 Bindings not in the table above

| Item | Default | Mode / scope | Source | Notes |
|---|---|---|---|---|
| `swap_tools` sub-keybind `hold` | Alt (18) held | edit, paint, display | `js/interface/main_tools.ts:167`, `js/interface/keyboard.js:589-606,635,771,925` | Holding Alt switches to the alt tool (`Toolbox.original`) and restores on release. |
| `paste` sub-keybinds: outliner, face, mesh_selection, texture, image, animation, keyframe, display_slot | none (null) | context | `js/copy_paste.js:504-527` | Only reachable through the Paste action's context dispatch, or by user keymap assignment. |
| `selection_tool` variations | key M; Shift = add, Ctrl = subtract | paint (textured/material) | `js/texturing/painter.js:3294,3360` | Sub-keybinds per selection operation have no default key. |
| Number slider `increase` / `decrease` | none | any NumSlider | `js/interface/actions.ts:1118-1134, 1626-1643` | Only fires when the slider is in scope and its `condition` is true. |
| Enum/option sub-keybinds (`addSubKeybind(key, ...)` loop) | none | any BarSelect with options | `js/interface/actions.ts:1756` | |
| `preview_scroll_pan` | none | navigate | `js/interface/main_tools.ts:36-37`, `js/preview/OrbitControls.js:688-690` | Description says "two-finger trackpad panning". Bind it in the keybind dialog. |
| `paint_secondary_color` | key unset, `shift: null` | paint | `js/texturing/painter.js:2847`, `js/preview/preview.ts:1032` | Default has no key. The mouse keymap binds RMB. |
| `preview_area_select` | Ctrl + [Shift] + LMB | navigate | `js/interface/main_tools.ts:44`, `js/preview/preview.ts:1415-1425,1781-1782` | Shift during a Ctrl-drag extends the selection. |
| `stretch_tool` | Alt+S | edit, feature `stretch_cubes` | `js/interface/main_tools.ts:142` | |

**Dialog-local keyboard actions** (`keyboard_actions` in `Dialog` options; active only while that dialog is open, `js/interface/keyboard.js:822`):

| Dialog | Key | Behaviour | Source |
|---|---|---|---|
| Animated texture (Flipbook) editor, id `animated_texture_editor` | ← / → | previous / next frame | `js/texturing/texture_flipbook.js:307-325` |
| Same | Space | play/pause | same |
| Same | Ctrl+D, Delete, Ctrl+C, Ctrl+V | duplicate, delete, copy, paste frame | same, `:328-345` |
| Blend transition curve, id `blend_transition_edit` (animation controllers) | Ctrl+C, Ctrl+V | copy/paste curve points | `js/animations/animation_controllers.js:479-490` |
| Collection properties, id `collection_properties` | Delete | remove collection | `js/outliner/collections.ts:309-314` |

**Hard-coded keys** (not in the keybind system):

| Key | Behaviour | Source |
|---|---|---|
| Enter / Esc | Confirm/cancel outliner rename (`renaming` flag, `keyboard.js:729`), chat send, dialog confirm/cancel (`Keybinds.extra.confirm/cancel`, default 13 / 27) | `js/interface/keyboard.js:~725-745` |
| Esc during a gizmo drag | Cancels the transform (`Transformer.cancelMovement`) | `js/interface/keyboard.js:777` |
| Enter / Esc in knife tool | Apply / cancel knife cut (`KnifeToolContext`) | `js/interface/keyboard.js:~778-784` |
| Tab in a text field | Cycles visible `.tab_target` inputs (Shift reverses) | `js/interface/keyboard.js:690-700` |
| Plain keys and ←↑→↓ while a text input has focus | Not forwarded to actions (Ctrl/Meta combos still are) | `js/interface/keyboard.js:747-748` |
| Page Up / Page Down | `preventDefault` (no browser scroll) | `js/interface/keyboard.js:~683-686` |
| Up / Down | Action Control list navigation | `js/interface/action_control.js:114-120` |
| Left / Right / Up | Menu navigation | `js/interface/menu.ts:268-279` |
| Enter / Esc in NumSlider text | Commit / revert | `js/interface/actions.ts:1232-1241` |
| Shift (keydown) | Shows shift-tooltips (`.tooltip_shift`) | `js/interface/interface.js:496-506` |

**Keybind conflicts:** `Keybinds.no_overlap` uses `Condition.mutuallyExclusive`, so the same key can be reused across modes whose conditions cannot both be true (`js/interface/keyboard.js:544`). Conflicts are flagged in the keybind dialog via `TickUpdates.keybind_conflicts`.

### 1.3 Keymap presets

| Preset | Where | Entries | Unbound (`null`) | Notes |
|---|---|---|---|---|
| `default` | built into the table in 1.1 | 109 with a default | n/a | |
| `mouse` | `js/interface/keyboard.js:531-536` (code, not file) | 5 overrides | n/a | Rotate = MMB; Drag = Shift+MMB; Zoom = Ctrl+MMB; Area select = LMB; Paint secondary = RMB. |
| Blender (`keymaps/blender.bbkeymap`) | 273 entries | 273 | 180 | Move G, Rotate R, Resize S, Pivot P, Vertex snap X. Rotate = MMB; Drag = Shift+MMB; Zoom = Ctrl+MMB. |
| Cinema 4D (`keymaps/cinema4d.bbkeymap`) | 249 | 249 | 174 | Rotate = Alt+LMB; Drag = Alt+MMB; Zoom = Shift+LMB; Move = E; Resize = T; Rotate tool = R. |
| Maya (`keymaps/maya.bbkeymap`) | 249 | 249 | 176 | Rotate = Alt+LMB; Drag = Alt+MMB; Zoom = Alt+RMB; Move = W; Resize = R; Rotate tool = E. |

File format: `{"keys": {"<action id>": {"key": <code>, "ctrl": true, ...} | null}}`. `null` clears the binding. Import/export is in `js/interface/keybinding.ts`.

### 1.4 Mouse and viewport navigation (default bindings)

| Input | Action | Behaviour | Source |
|---|---|---|---|
| LMB drag on empty space | `preview_rotate` (key 1) | Orbit. If the press hits geometry in edit mode, it is a selection instead (`Canvas.raycast` check). | `js/preview/OrbitControls.js:601-606`, `js/preview/preview.ts:1032` |
| RMB drag | `preview_drag` (key 3) | Pan. | `js/preview/OrbitControls.js:611` |
| Shift + LMB drag | `preview_zoom` | Drag-to-zoom (dolly). | `js/preview/OrbitControls.js:620` |
| Wheel | `preview_scroll_zoom` (1001) | Dolly. Stops if a modifier combo is needed. | `js/preview/OrbitControls.js:685-694` |
| Wheel with `preview_scroll_pan` bound | pan by deltaX/deltaY | Used for trackpad two-finger pan. | `js/preview/OrbitControls.js:688-690` |
| Ctrl + wheel in UV/2D editor | `uv_editor_scroll_zoom` | Zoom the UV editor. | `js/interface/main_tools.ts:40`, `js/uv/uv.js:3091` |
| RMB drag in UV/2D editor | `preview_drag` | Pan. | `js/uv/uv.js:3224` |
| LMB click | `preview_select` | Select. Ctrl = multi-select (toggle), Shift = group select, Alt = loop select. | `js/interface/main_tools.ts:9-18`, `js/preview/preview.ts:1039-1041` |
| Ctrl + LMB drag (Shift optional) | `preview_area_select` | Rectangle selection. Shift adds to the selection. | `js/preview/preview.ts:1415-1425,1781-1782` |
| Arrow keys | none | `enableKeys = false`, so arrows do **not** pan the viewport. Arrows move elements/keyframes instead (1.5). | `js/preview/preview.ts:391`, `js/preview/OrbitControls.js:45` |
| Double-click | settings `double_click_switch_tools` (true) and `double_click_select_reference` (true) | Setting names only; the exact double-click behaviour was not traced. | `js/interface/setup_settings.js` (controls category, ~lines 155-160) |
| Mouse keymap preset | see 1.3 | Rotate MMB, Pan Shift+MMB, Zoom Ctrl+MMB. | `js/interface/keyboard.js:531-536` |

**Numpad camera keys** (defaults, all `!Modes.display`, `js/preview/preview.ts:2782-2863`): Num1 `camera_initial`, Num8 `camera_top`, Num2 `camera_bottom`, Num4 `camera_south`, Num6 `camera_north`, Num7 `camera_east`, Num9 `camera_west`, Num5 `toggle_camera_projection`. The action label is `Camera Angle: <name>`.

**Modifiers during transforms and gizmo drags:**

| Modifier | Effect | Source |
|---|---|---|
| none | Grid snap step = 1 unit (`edit_size` = 16 → 16/16) | `js/misc.js:46-56`, `js/interface/setup_settings.js:262` |
| Shift | Step = 16/`shift_size` (default 64) = 0.25 unit | same, `setup_settings.js:263` |
| Ctrl (Cmd on macOS) | Step = 16/`ctrl_size` (default 160) = 0.1 unit | same, `setup_settings.js:264` |
| Ctrl + Shift | Step = 16/`ctrl_shift_size` (default 640) = 0.025 unit | same, `setup_settings.js:265` |
| Rotation (no mod) | 2.5° snap | `js/modeling/transform.js:596-611` |
| Rotation Shift | 22.5° | same |
| Rotation Ctrl | 1° | same |
| Rotation Shift+Ctrl | 0.25° | same |
| Rotation with `Format.rotation_snap` | fixed 22.5° | same, `:598-599` |
| Alt during transform (non-swap) | bidirectional resize around the centre | `js/modeling/transform/edit_transform.js:316` |
| Alt during keyframe scale | scale around the range midpoint | `js/animations/timeline.js:1593` |
| Alt+S | Stretch tool (features `stretch_cubes`) | `js/interface/main_tools.ts:142` |
| Esc | Cancel a gizmo drag | `js/interface/keyboard.js:777` |

Snap defaults: `vertex_merge_distance` 0.1, `selection_tolerance` 10, `control_size` 10 (`setup_settings.js:55,~171-190,262-265`).

### 1.5 Timeline and keyframes (Animate mode)

**Mouse**

| Input | Behaviour | Source |
|---|---|---|
| LMB click or drag on the time ruler | Scrub. Snaps to the animation step unless Ctrl/Cmd is held. Ctrl disables snapping. | `js/animations/timeline.js:380-395` |
| Marker drag | Snaps unless Ctrl. | `js/animations/timeline.js:345-350` |
| Shift + wheel | Horizontal scroll. | `js/animations/timeline.js:565-566` |
| Ctrl + wheel (or trackpad pinch) | Zoom the timeline. | `js/animations/timeline.js:561-573` |
| Plain wheel | Vertical scroll. | `js/animations/timeline.js:581` |
| Click a keyframe | Select. Shift adds to the selection. | `js/animations/timeline.js:1256-1259,1437-1440` |
| Drag selected keyframes | Move in time. Ctrl stretches a group (when the graph editor is closed). | `js/animations/timeline.js:1253,1320-1337` |
| Graph editor drag | Shift constrains to one axis (time or value). Ctrl snaps time to the step and value to 0.25. | `js/animations/timeline.js:1477-1488` |
| Empty-area drag | Box select. Shift keeps the previous selection. | `js/animations/timeline.js:117` |
| Playback speed slider | Step while Shift held: 10 below 50, else 50. Step while Ctrl held: 1 below 500, else 10. | `js/animations/timeline.js:2001-2016` |

**Keys**

| Key | Action | Mode | Source |
|---|---|---|---|
| Space | `play_animation` (play/pause). In Animation Controller preview it is `animation_controller_preview_mode`. | animate | `js/animations/timeline.js:1964`, `animation_controllers.js:2322` |
| Home / End | Jump to start / end | animate | `timeline.js:2033,2051` |
| Ctrl+End | `set_animation_end` (end = current time) | animate | `js/animations/animation.js:935` |
| , / . | Frame back / forth | animate, edit, paint | `timeline.js:2068,2084` |
| ← / → | `move_keyframe_back/forth` (move selected keyframes back/forth in time) | animate | `js/animations/keyframe.js:873,888` |
| ↑ / ↓ | `move_graph_keyframes_up/down` (Ctrl/Shift ignored) | animate | `keyframe.js:916,926` |
| Q | `add_keyframe` (Shift variation = `reset_values`) | animate | `keyframe.js:843` |
| F3 | Toggle graph editor | animate | `timeline.js:1920` |
| Ctrl+M | `add_marker` at playhead | animate | `timeline.js:2231` |
| Ctrl+L | `create_collection` | edit, paint, animate | `outliner/collections.ts:600` |

**Keyframe data model** (`js/animations/keyframe.js`):
- `interpolation`: `linear`, `catmullrom`, `bezier`, `step` (`keyframe.js:626-631`). Bezier handles are `bezier_left_*` / `bezier_right_*` with `bezier_linked` (default true) (`keyframe.js:619-624`).
- Channels per animator: bone (`rotation`, `position`, `scale`, max 2 data points); armature bone (`position`, `rotation`, `scale`); null object (`position` only); effect animator (`particle`, `sound`, `timeline`) (`js/animations/timeline_animators.js:645-652,787-792,996-998,1146-1150`).
- Data points: `x`, `y`, `z` (MoLang), `effect`, `locator`, `script`, `bind_to_actor` (`keyframe.js:46-53`).

## 2. Viewport visual specification

All values are the defaults in v5.2.2 unless noted. Settings are in `js/interface/setup_settings.js`.

### 2.1 Colours and theme tokens

**Default theme** is `dark` (`js/interface/themes.ts:157`, `themes/dark.bbtheme`). Its tokens are in `DEFAULT_COLORS` (`js/interface/themes.ts:40-59`):

| Token | Value | Usage |
|---|---|---|
| `--color-ui` | #1e2127 | panel background |
| `--color-back` | #181b1f | canvas back, ground plane |
| `--color-dark` | #101316 | `#center` (viewport) background when not checkerboard |
| `--color-border` | #101316 | borders |
| `--color-selected` | #3b3e49 | selected list row |
| `--color-elevated` | #272a31 | raised surfaces |
| `--color-button` | #33383f | buttons |
| `--color-bright_ui` | #f4f3ff | |
| `--color-accent` | #3e90ff | accent, selection outline |
| `--color-frame` | #0f1012 | window frame / `meta theme-color` |
| `--color-text` | #cacad4 | body text |
| `--color-light` | #f4f3ff | |
| `--color-accent_text` | #000006 | text on accent |
| `--color-subtle_text` | #848891 | secondary text |
| `--color-grid` | #30333d | grid lines, north marker tint |
| `--color-wireframe` | #576f82 | wireframe mode |
| `--color-checkerboard` | #14171b | checkerboard background |

Viewport-only variables are set on `#preview` in `css/window.css:94-111`. These override the `:root` defaults in `css/setup.css:404-410` and are what the 3D scene actually uses (`js/interface/themes.ts:589-611` reads them with `getComputedStyle`):

| Variable | Value | Used for |
|---|---|---|
| `--color-solid` | #c1c1c1 | solid view mode |
| `--color-outline` | = accent (#3e90ff) | selection outline, gizmo hover |
| `--color-constant-outline` | #000000 | unselected outline (`constant_outlines`) |
| `--color-gizmohover` | = outline | hovered gizmo handle |
| `--color-ground` | = back (#181b1f) | ground plane |
| `--color-brush-outline` | #ffffff | brush cursor |
| `--color-axis-x` | #fd3043 | X axis, X gizmo |
| `--color-axis-y` | #26ec45 | Y axis, Y gizmo |
| `--color-axis-z` | #2d5ee8 | Z axis, Z gizmo |
| `--color-axis-u` / `-v` / `-w` | #23d4ed / #ff12ed / #ffd442 | spline/UV-space sliders |

The `setup.css` defaults (`--color-axis-x` #ff1242, `-y` #23d400, `-z` #0894ed) apply outside `#preview` only. Spline handles: `--color-spline-handle-mirrored` #ff1242, `-aligned` #F0B000, `-free` #00D123 (`css/setup.css:411-413`).

### 2.2 Background

| Item | Default | Source |
|---|---|---|
| Background mode | `checkerboard` (setting `preview_checkerboard` true) | `js/interface/setup_settings.js` (`preview_checkerboard`), `js/preview/preview.ts:2176-2179` |
| Checkerboard | background-colour #14171b; 30px tiles; 15px offset | `css/general.css:129-138` |
| Solid | `--color-dark` #101316 | `css/window.css:85` |
| Custom colour | stored in `StateMemory.viewport_background_color`, sets `--custom-preview-background` | `js/preview/preview.ts:2117-2210` |
| Renderer clear | 0x000000, alpha 0 (transparent canvas) | `js/preview/preview.ts:436` |
| Antialiasing | `antialiasing` true (requires restart) | `setup_settings.js` (`antialiasing`) |
| Background rendering | `background_rendering` true (renders when unfocused) | `setup_settings.js` |
| FPS limit | 144 | `setup_settings.js` (`fps_limit`) |

### 2.3 Grid, block grid, axes, north marker

Canvas grid is rebuilt in `Canvas.buildGrid()` (`js/preview/canvas.js:~215-330`). `block_size = Format.block_size ?? 16`.

| Element | Default | Details | Source |
|---|---|---|---|
| Base grid (`base_grid`) | on | `GridHelper(16, 16 / canvasGridSize())`. With `edit_size` 16 that is 16 divisions = 1-unit cells over a 16-unit block. | `canvas.js:294-300` |
| Large grid (`large_grid`) | on | `GridHelper(3*16, 3)`. Cells are 16 units, so it marks block boundaries. Size = `large_grid_size` (default 3, range 0-2000). | `canvas.js:277-290`, `setup_settings.js:240` |
| Full grid (`full_grid`) | off | Replaces both: `GridHelper(large_grid_size*16, size/canvasGridSize())`. | `canvas.js:255-262` |
| Grid colour | `gizmo_colors.grid` = `--color-grid` #30333d | Also used for north marker tint and large box. | `canvas.js:220-224`, `themes.ts:604` |
| Axis lines | origin along X (red) and Z (blue) at y=0.01; length = 16 (block size), or 8 when `centered_grid` (24 with full grid) | Y axis is not drawn. | `canvas.js:226-245` |
| North marker | `assets/north.png`, plane 2.4 units (base grid) or 5 units (full grid); nearest filter; alphaTest 0.2 | Position (8, 0, -1.44) when not centred. | `canvas.js:266-312,975-990` |
| Large box (`large_box`) | off | `EdgesGeometry` of `cube_size_limiter.box_marker_size` (default 48³). Bedrock block format uses 30³. | `canvas.js:~318-336`, `js/formats/bedrock/bedrock.js` (block_format `cube_size_limiter`) |
| Pixel grid (`pixel_grid`, UV/edit) | off | Edit: `g` toggle. | `preview.ts:2679`, `setup_settings.js` |
| Painting grid (`painting_grid`) | on | Paint mode `g`. | `setup_settings.js` |
| Image editor grid (`image_editor_grid_size`) | 16 | 2D editor. | `setup_settings.js` |
| Ground plane (`ground_plane`) | off | 4096-unit plane at y=-0.025, `--color-ground`, alphaTest 0.2, double-sided off. | `canvas.js:1045-1057`, `setup_settings.js` |
| Centred grid | per format (`centered_grid`); Bedrock = true | Bedrock grid origin is centred. | `js/formats/bedrock/bedrock.js:1577` |

### 2.4 Camera

| Item | Default | Source |
|---|---|---|
| Projection | perspective on start | `preview.ts` |
| FOV (`fov`) | 45 (range 1-120) | `setup_settings.js` (`fov`) |
| Perspective near / far | near 1 (`camera_near_plane`, 0.01-100); far 30000 | `preview.ts:340` |
| Ortho frustum | left/right/top/bottom ±8000; near -8000; far 12000; default zoom 0.5 | `preview.ts:342,345` |
| Min orbit distance | 1 | `preview.ts:355` |
| Max zoom distance (`maximum_zoom_distance`) | 4000 (min 16) | `setup_settings.js` |
| Rotate speed (`viewport_rotate_speed`) | 100 → 1.0 (range 10-1000) | `setup_settings.js`, `preview.ts:359` |
| Zoom speed (`viewport_zoom_speed`) | 100 → 1.5 | `setup_settings.js`, `preview.ts:358` |
| Pan key speed | 7 px | `OrbitControls.js:40` |
| Damping | off (0.25 factor when on) | `OrbitControls.js:33-34` |
| Polar limits | 0 to π | `OrbitControls.js:29-30` |
| Arrow-key orbit/pan | disabled | `preview.ts:391` |

**Default start camera** (`DefaultCameraPresets[0]`, `preview.ts:85-91`): perspective, position `[-40, 32, -40]` for `forward_direction` `-z` (default). Other forward directions: `+x` → `[40, 32, -40]`, `-x` → `[-40, 32, 40]`, `+z` → `[40, 32, 40]`. Positions scale by `block_size/16`. Target `[0, 12, 0]` (`block_size × 0.75`), `preview.ts:~93-100`.

**Ortho presets** (all `zoom: 0.5`, `locked_angle` set, `preview.ts:105-210`):

| Preset | Projection | Position | Target |
|---|---|---|---|
| top | ortho | [0, 512, 0] | [0, 0, 0] |
| bottom | ortho | [0, -512, 0] | [0, 0, 0] |
| south | ortho | [0, 0, 512] | [0, 0, 0] |
| north | ortho | [0, 0, -512] | [0, 0, 0] |
| east | ortho | [512, 0, 0] | [0, 0, 0] |
| west | ortho | [-512, 0, 0] | [0, 0, 0] |
| isometric_right | ortho | [-512, 512·0.8165+8, -512] | origin |
| isometric_left | ortho | [512, 512·0.8165+8, -512] | origin |
| true_isometric_right | ortho | [-512, 520, -512] | origin |
| true_isometric_left | ortho | [512, 520, -512] | origin |

The "Camera Angle" actions are generated from these.

### 2.5 Lighting and shading

Source: `js/preview/canvas.js:925-1000` (`Canvas.updateShading`, `:360-430`).

| Light | Type | Position | Intensity (shading on) | Notes |
|---|---|---|---|---|
| Sun (ambient) | `AmbientLight` #ffffff | attached to scene | 1.0 × (brightness/50) × 0.5 = 0.5 at defaults | `canvas.js:927-930,366-398` |
| top | `DirectionalLight` | (0, 100, 0) | 0.46 | `canvas.js:936-941` |
| bottom | `DirectionalLight` | (0, -100, 0) | -0.02 | `canvas.js:943-948` |
| north | `DirectionalLight` | (0, 0, -100) | 0.30 | `canvas.js:950-960` |
| south | `DirectionalLight` | (0, 0, 100) | 0.30 | same |
| west | `DirectionalLight` | (-100, 0, 0) | 0.10 | `canvas.js:962-972` |
| east | `DirectionalLight` | (100, 0, 0) | 0.10 | same |

Directional lights are not scaled by brightness. When shading is off, only the ambient Sun is added at intensity brightness/50 = 1.0.

- Settings: `shading` true; `brightness` 50 (range 0-400); `tone_mapping` `none` (Linear, Reinhard, Cineon, ACES Filmic); `render_sides` `auto` (front/double).
- Material view: one directional light, intensity 0.7 × brightness/50, positioned by `global_light_side` (six presets, e.g. `[60, 100, 20]`) (`canvas.js:375-388`).

### 2.6 Selection, hover and pivot

| Item | Default | Source |
|---|---|---|
| Selection outline | `LineBasicMaterial`, linewidth 2, colour `--color-outline` (#3e90ff), depthTest on | `canvas.js:43-50`, `themes.ts:606-608` |
| See-through outline (`seethrough_outline`) | off | `setup_settings.js` (`seethrough_outline`) |
| Unselected outline | linewidth 1, #000000, shown only with `constant_outlines` (off) | `canvas.js:52-55`, `setup_settings.js` (`constant_outlines`) |
| Highlight cubes (`highlight_cubes`) | on | `setup_settings.js` |
| Hover helper line | #A4A5CA, linewidth 2 | `canvas.js:191-196` |
| Hover helper vertex | point size 4 (no attenuation), #3e90ff | `canvas.js:198-203` |
| Pivot marker | two `AxesHelper(2)` (length 2 units), child of the element's mesh, shown only with Pivot Tool | `canvas.js:1030-1038,727-770`, `transform_gizmo.js` (translate mode visibility) |
| Onion skin | earlier `#a3363d`, later `#3995bf` | `canvas.js:205-206` |
| Brush outline | `--color-brush-outline` #ffffff | `css/window.css:106` |
| Cube marker colours (outliner tags) | 10 colours, `standard` / `pastel` | `js/marker_colors.ts:7-18` |

Marker colours (standard hex; pastel in parentheses): light_blue #58C0FF (#A2EBFF), yellow #F4D714 (#FFF899), orange #EC9218 (#F1BB75), red #FA565D (#FF9B97), purple #B55AF8 (#C5A6E8), blue #4D89FF (#A6C8FF), green #00CE71 (#7BFFA3), lime #AFFF62 (#BDFFA6), pink #F96BC5 (#FFA5D5), silver #C7D5F6 (#E0E9FB).

### 2.7 Transform gizmo

Source: `js/modeling/transform/transform_gizmo.js`, `js/preview/canvas.js:917`.

| Item | Value | Notes |
|---|---|---|
| Screen-constant size | `calculateControlScale(pos) × control_size × 0.74`, control_size default 10 (range 2-40) | `transform_gizmo.js:1099-1103`, `setup_settings.js:55` |
| Base size | `Transformer.setSize(0.5)` | `canvas.js:917` |
| Colours | X/Y/Z from `gizmo_colors.r/g/b` (= `--color-axis-x/y/z`); rotate rings from `gizmo_colors.outline` (#3e90ff) | `transform_gizmo.js:347-357,440-458` |
| Hover | colour → gizmo_hover, opacity 1 | `transform_gizmo.js:41-50` |
| Translate | cone `CylinderGeometry(0, 0.07, 0.2, 12)`, shaft line 0→1, plane handles 50×50 picker | `transform_gizmo.js:185,329-341` |
| Scale | box `0.15 × 0.06 × 0.15`, shaft 0→1, picker plane 0.4 | `transform_gizmo.js:401-414` |
| Rotate | rings radius 1 (torus tube 0.12, picker), trackball ring radius 1.2 | `transform_gizmo.js:576-587` |
| Spline handles | aligned #F0B000, mirrored #ff1242, free #00D123; joint box 0.15; picker 0.3 | `transform_gizmo.js:667-694`, `css/setup.css:411-413` |

### 2.8 Outliner icons (Material / Font Awesome names)

| Element | Icon | Source |
|---|---|---|
| Group (bone) | `folder` | `outliner/types/group.js:483` |
| Cube | `fa-cube` | `outliner/types/cube.js:989` |
| Mesh (Free format) | `far.fa-gem` | `outliner/types/mesh.js:996` |
| Spline mesh | `fas.fa-bezier-curve` | `outliner/types/spline_mesh.js:1534` |
| Texture mesh | `fa-puzzle-piece` | `outliner/types/texture_mesh.js:83` |
| Locator | `fa-anchor` | `outliner/types/locator.js:71` |
| Null object (IK) | `far.fa-circle` | `outliner/types/null_object.js:83` |
| Armature | `accessibility` | `outliner/types/armature.ts:230` |
| Armature bone | `humerus` | `outliner/types/armature_bone.ts:308` |
| Bounding box | `activity_zone` | `outliner/types/bounding_box.ts:24` |
| Billboard | `fa fas fa-bookmark` | `outliner/types/billboard.js:296` |
| Collection | takes the icon of its first type; group → `folder` | `outliner/collections.ts:282,832` |

Outliner colour tags are on by default (`outliner_colors` true).

## 3. Reference images

Core module: `js/preview/reference_images.ts` (1580 lines). Import entry points: `js/io/io.js:30,200` (drag-drop and file-open with `method == 'reference_image'`), drag handler registered at `reference_images.ts` via `Blockbench.addDragHandler('reference_image', ...)` (`js/io/io.js:~195-205`).

### 3.1 Adding

| Route | Details | Source |
|---|---|---|
| Action `add_reference_image` ("Add Reference Image") | File picker, extensions `png jpg jpeg bmp tiff tif gif mp4 wmv mov`. No default key. | `reference_images.ts:1388-1404` |
| Action `reference_image_from_clipboard` ("Paste Reference Image") | Image from clipboard, or a pasted URL. Named `Pasted`. No default key. | `reference_images.ts:1405-1430` |
| Drag and drop onto the viewport | Same extensions. Only when a project is open and no dialog is open. | `js/io/io.js:195-205` |
| Open-file route with `method == 'reference_image'` | Routes files to `importReferences`. | `js/io/io.js:30` |
| Import dialog | Shows a preview image, then: View Mode (Flat Image or 3D Plane; not offered in Image Editor), Layer (Behind Model / Above Model / Above Interface), "Add globally" checkbox. | `reference_images.ts` `ReferenceImageMode.importReferences()` |

Video references (mp4/wmv/mov) are `is_video`. They can sync to the timeline (`sync_to_timeline`, shown in the properties dialog only for video in Animation Mode, `reference_images.ts` properties form).

### 3.2 Scope: project, global, built-in

| Scope | Storage | Notes | Source |
|---|---|---|---|
| `project` ("Just this project") | `Project.reference_images` → `.bbmodel` key `reference_images` | Default for new references added to the project. | `reference_images.ts:225-234` (`addAsReference`, sets scope), `js/formats/bbmodel.js:362-370` (save), `:576-580` (load) |
| `global` ("All projects") | `StateMemory` key `global_reference_images` (app storage, not per-file) | Restored on start by `initReferenceImages`. Saved via `saveGlobalReferences`. Source image is embedded as PNG data URL in the desktop app. | `reference_images.ts:1237-1242,1369-1373`, `:192-203` (`getSaveCopy`) |
| `built_in` | code-defined | Display-mode reference overlays `inventory_nine`, `inventory_full`, `hud` (assets `./assets/*.png`). Shown only when the active display reference matches. Not editable. | `js/preview/preview.ts:2507-2540` |

The `.bbmodel` save skips references when `options.backup` is set, or when `reference_images: false` is passed (used by Share, `js/io/share.ts:188`, which has a "reference images" checkbox).

**Per-camera-view ("blueprint") attachment:** if a reference is created while an orthographic preset is selected, `enableBlueprintMode()` sets `view_mode: 'blueprint'`, `attached_side` = the view's angle, and resets position to (0,0). It is then visible only while that ortho view is active (`resolveCondition`, `reference_images.ts:205-212`). Blueprint layer name in UI: "Locked Blueprint" (`reference_image.blueprint`).

**Old per-preset background images:** not present in v5.2.2. No per-camera-preset image property was found (`DefaultCameraPresets` has no image field). Attached blueprints (above) and the built-in display overlays are the only camera-linked images.

### 3.3 Properties

Source of the property list: `reference_images.ts:1190-1218` (`new Property(ReferenceImage, ...)`), defaults in brackets. Dialog labels are from `lang/en.json`.

| Property (UI label) | Type | Default | Notes |
|---|---|---|---|
| `name` | string | "Reference" | |
| `source` (Image) | file path or data URL | | File picker only in the desktop app, for absolute paths. |
| `layer` (Layer) | `background` / `viewport` / `float` | `background` | Labels: **Behind Model** (`background`, z-index -1, in `.clamped_reference_images`), **Above Model** (`viewport`, z-index 1, in scene), **Above Interface** (`float`, in `work_screen`, overflow visible). Also `scene` label exists in lang but is not an option. |
| `scope` (Scope) | project / global / built_in | global in the property; project when added | See 3.2. |
| `view_mode` (View Mode) | `flat_image` / `plane` / `blueprint` | `flat_image` | **Flat Image**, **3D Plane** (positioned in 3D with rotation). Blueprint is set automatically. |
| `position` (Position) | vector2 | [0, 0] | Flat and blueprint. |
| `plane_position`, `plane_rotation` | vector3 | | 3D Plane only. Rotation preset sides: north, east, south, west, bottom, top, custom (`:664-703`). |
| `size` (Size) | vector2 | [400, 300] | Linked-ratio by default (`linked_ratio: true`). Auto aspect ratio until set manually. |
| `rotation` (Rotation) | number | 0 | Flat/blueprint only. |
| `flip_x`, `flip_y` | boolean | false | Buttons "X" and "Y" in the edit toolbar (`:652-661`). |
| `opacity` (Opacity) | 0-1 (UI 0-100) | 1 | Slider 0-100, step 1 (`:730-746`). |
| `visibility` (Visibility) | boolean | true | Hidden also when opacity < 0.1 (`:364`). |
| `sync_to_timeline` | boolean | true | Video only; in Animation Mode. |
| `cull_backface` (Hide Backside) | boolean | false | Plane only. |
| `clear_mode` (Clear Mode) | boolean | false | When not selected: `mixBlendMode: lighten` (flat) and `contrast(1.2)`; dark images are auto-inverted (`updateClearMode`, average RGB sum < 380). For light-on-dark line art. The lang key is "Clear Mode". There is no separate "clear depth" option in v5.2.2. |
| `attached_side` | string | north | Ortho view the blueprint is locked to. |
| `modes` | array of mode ids | [] (all) | "Enabled in Modes" submenu in the list (`:1444+`). |
| `is_blueprint` | boolean | false | Derived from `view_mode`. |

### 3.4 Editing UI

- **Selection** (`ReferenceImage.select()`) activates `ReferenceImageMode` (`activate()`). The toolbar (`toolbars.ts:29` `reference_images`) is appended to the work screen. The first visible reference is auto-selected.
- **On-canvas handles:** corner resize (linked ratio), rotation handle (`:573`), body drag to move, a layer toggle button (`flip_to_front`, `:633-650`), flip X / Y, rotation popover, opacity slider, visibility button (`:750`).
- **Context menu / list** `reference_image_list` ("Reference Images", `:1444+`): per reference, Visibility toggle, Enabled in Modes, Refresh, Delete, Properties (`propertiesDialog`, `:953-1017`).
- **Properties dialog** (title `data.reference_image`) has the fields in 3.3.
- **Clear / delete:** Delete key when a reference is selected in Reference Image Mode (`SharedActions.add('delete', ...)` near `reference_images.ts:1249`). Delete confirm dialog uses `message.delete_reference_image` (`reset()`/`delete()` area, ~line 876).
- **Toggle all:** `toggle_all_reference_images` ("Hide/Show All Reference Images", `:1431-1443`). No default key.
- **Edit entry point:** `edit_reference_images` ("Edit Reference Images", icon `wallpaper`, `:1377-1387`), also in the View menu (`js/interface/menu_bar.ts:587`).

### 3.5 Keybinds (reference images)

None have a default key (no `keybind:` in `reference_images.ts`). Delete is the shared Delete key. Everything else is menu or toolbar driven and can be bound in the keybind dialog.

### 3.6 Video references

`video_extensions` mp4, wmv, mov. Playback follows the timeline when `sync_to_timeline` is on (`Blockbench.on('display_animation_frame')` and `Blockbench.on('timeline_pause')` handlers near the end of `reference_images.ts`). Playback rate uses `Timeline.playback_speed/100`.

## 4. Feature inventory: Edit and Animate

Relevance key: **Bedrock** = affects `.geo.json` / `.animation.json` / Bedrock entity or block output; **Generic-only** = Mesh or Spline editing, which exists only in the Free/generic format (`meshes: true` in `js/formats/generic.ts:15`; Bedrock formats do not set it); **View** = viewport/UI only; **Editor** = editor-wide, format-neutral.

### 4.1 Major features, grouped (one-line descriptions)

| Area | Feature (id) | One-line description | Bedrock / GeckoLib | Source |
|---|---|---|---|---|
| Outliner | Groups (`add_group` Ctrl+G, `group_elements` Ctrl+Shift+G, `collapse_groups`, `unfold_groups`) | Bones in Bedrock; grouping and folding of the tree. | Bedrock (bones) | `outliner/types/group.js:720-822` |
| Outliner | Visibility / Lock / Export / Auto UV / Shade / Mirror UV toggles (`toggle_visibility`, `toggle_locked`, `toggle_export`, `toggle_autouv`, `toggle_shade`, `toggle_mirror_uv`) | Per-element flags. Export toggle controls whether a bone/cube is written. | Bedrock | `modeling/transform.js:1849-1876` |
| Outliner | Bone reset (`bone_reset_toggle`) | Reset bone transform. | Bedrock | `transform.js:2027` |
| Outliner | Edit Binding (`edit_bedrock_binding`) | Edit `bone` binding expression (Bedrock). | Bedrock | `group.js:833` |
| Outliner | Search / Select window / Sort / Unlock All / Move to | Find, select and organize elements. | Editor | `outliner/outliner.js:960-1105` |
| Outliner | Cube colours (`element_colors`) and marker colours | 10 outliner tag colours. | Editor | `outliner/outliner.js:1100`, `marker_colors.ts` |
| Outliner | Collections (`create_collection` Ctrl+L, `add_to_collection`, `set_collection_content_to_selection`) | Named sets of elements. | Editor | `outliner/collections.ts:600-627` |
| Outliner | Null objects and IK (`add_null_object`, `set_ik_target`, `set_ik_source`, `set_ik_pole`, `lock_ik_target_rotation`) | IK controllers. Bedrock export samples IK (`animation.sampleIK()`) into plain keyframes. | Bedrock (via sampling) | `outliner/types/null_object.js:83-369`, `js/formats/bedrock/bedrock_animation.js:529` |
| Outliner | Locators and bounding boxes (`add_locator`, `add_bounding_box`) | Locator points and collision boxes (format flags `locators`, `bounding_boxes`). | Bedrock | `outliner/types/locator.js:169`, `bounding_box.ts:514`, `bedrock.js:1586-1588` |
| Outliner | Armature and armature bones (`add_armature`, `add_armature_bone` E+Shift) | Armature rig with bones and per-bone channels. | Check (Blockbench-side rig) | `outliner/types/armature.ts:282`, `armature_bone.ts:571` |
| Cube tools | Move (V), Resize (S), Rotate (R), Pivot (P) tools | Core transform gizmos. Ctrl and Shift change snap step (1.4). | Bedrock | `js/interface/main_tools.ts:59-115` |
| Cube tools | Vertex Snap (X) and Snap Mode | Snap elements to vertices of others. | Bedrock | `main_tools.ts:119`, `transform.js:877` |
| Cube tools | Stretch (Alt+S) | Stretch cubes (feature `stretch_cubes`). | Bedrock | `main_tools.ts:142` |
| Cube tools | Transform space / Rotation space / Pivot space (`transform_space`, `rotation_space`, `transform_pivot_space`) | Local vs global space for move, rotate and pivot. | Bedrock | `transform.js:830-861` |
| Cube tools | Per-element position and pivot sliders (`position_slider_per_element`, `origin_slider_direct_values`) | Edit numeric values for each element. | Bedrock | `transform.js:1049,1507` |
| Cube tools | Flip X/Y/Z (`flip_x/y/z`) and flip-in-place (`flip_in_place_x/y/z`) | Mirror elements across an axis, optionally in place. | Bedrock | `transform.js:1675-1726` |
| Cube tools | Rotate 90° about X/Y/Z (`rotate_*_cw/ccw`) | Quarter-turn rotation. | Bedrock | `transform.js:1620-1665` |
| Cube tools | Center X/Y/Z, Center Lateral, Center Pivot, Center Individual Pivots | Centre elements and pivots. | Bedrock | `transform.js:1737-1975` |
| Cube tools | Arrow and PgUp/PgDn nudges (`move_up/down/left/right/forth/back`) | Nudge selection by the snap step. Modifiers are ignored in the binding. | Bedrock | `transform.js:1782-1841` |
| Cube tools | Remove Blank Faces, Set Cullfaces Automatically | Clean up faces. | Bedrock | `transform.js:2041,2101` |
| Cube tools | Inflate slider (`slider_inflate`) | Grow or shrink cubes uniformly. | Bedrock | `js/modeling/transform.js:1168` |
| Cube tools | Mirror Modeling (`mirror_modeling`, `allow_element_mirror_modeling`, `apply_mirror_modeling`) | Edit one side and mirror to the other. | Check (cubes likely; verify) | `modeling/mirror_modeling.ts:814-857` |
| Cube tools | Scale (`scale`) | Scale the model by a factor. | Bedrock | `modeling/scale.ts:281` |
| Cube tools | Add Element / Add Group / Duplicate / Delete / Rename | Element lifecycle. | Bedrock | `outliner/outliner.js:929`, `shared_actions.ts:161-216` |
| UV editor | Auto UV (`uv_auto`), Relative Auto UV (`uv_rel_auto`), UV Project from View (`uv_project_from_view`), Maximize, Turn Mapping | Box-UV layout helpers. | Bedrock (box UV) | `uv/uv.js:2156-2287` |
| UV editor | Mirror X/Y, Rotate Left/Right, Remove Face, Reset Face, Apply to All Faces, Face Tint | Per-face UV edits. "Affect all faces" is a Shift variation on most. | Bedrock | `uv/uv.js:2303-2454` |
| UV editor | Cullface and Enable Cullface (`cullface`, `auto_cullface`) | Per-face cullface. | Bedrock | `uv/uv.js:2419-2438` |
| UV editor | Move UV to Cursor (Alt+U), Merge UV Vertices, Connect UV Faces, Snap UV to Pixels, Cycle UV / Cycle Invert | UV-space editing helpers. | Bedrock | `uv/uv.js:2483-2704` |
| UV editor | Display All Elements overlay (`edit_mode_uv_overlay`), Move Texture with UV | Show all UVs; move texture with UV. | View | `uv/uv.js:2727-2747` |
| Viewport | View modes (`view_mode`, Z): textured, solid, colored_solid, wireframe, uv, normal, material | Shading and display variants. | View | `preview/preview.ts:2592` |
| Viewport | Checkerboard (T), Pixel grid (G, edit), Toggle shading, Toggle all grids, Toggle ground plane, Split screen | Viewport display toggles. | View | `preview.ts:2629-2692` |
| Viewport | Center View on Selection (`focus_on_selection`), camera angles (Num keys), Toggle camera projection (Num5) | Camera framing and presets. | View | `preview.ts:2713-2863` |
| Viewport | Screenshot Model (Ctrl+P), Advanced Screenshot, Record GIF, Timelapse | Capture. | View | `preview/screenshot.js:845-915` |
| Timeline | Play (Space), Looped Playback, Jump to Start/End (Home/End), Frame back/forth (,/.) | Playback and navigation. | Bedrock (animation) | `animations/timeline.js:1920-2084` |
| Timeline | Set Range Start/End, Disable Range | Playback range (loop/preview window). | Editor | `timeline.js:2100-2118` |
| Timeline | Bring Up / Add All / Fold All / Clear Timeline | Channel list management. | Editor | `timeline.js:2131-2168` |
| Timeline | Filter Channels (`timeline_focus`), Timeline Setups (save/apply) | Channel filtering and saved views. | Editor | `timeline.js:2190-2292` |
| Timeline | Markers (`add_marker`, Ctrl+M) | Labelled time markers; drag snaps unless Ctrl. | Editor | `timeline.js:2231`, `:345-350` |
| Timeline | Graph Editor (F3), Display Other Graphs, Include Other Graphs, Include Zero Line | Value-over-time editing with optional other channels and zero line. | Bedrock (animation) | `timeline.js:1920-1955` |
| Timeline | Playback speed (`change_animation_speed`, speed slider with Shift/Ctrl steps) | Animation playback rate. | Editor | `animation.js:1181`, `timeline.js:2001-2016` |
| Keyframes | Add Keyframe (Q; Shift = reset values), Previous/Next Keyframe | Create and step through keyframes. | Bedrock | `keyframe.js:843-976` |
| Keyframes | Interpolation (`keyframe_interpolation`): linear, catmullrom, bezier, step | Curve type per keyframe. Bezier handles, linked by default. **Bedrock export bakes any bezier segment into sampled keyframes at the animation snap interval** (`1 / animation.snapping`). | Bedrock (bezier is baked on export) | `keyframe.js:626-631,619-624,1069`, `js/formats/bedrock/bedrock_animation.js:475-490` |
| Keyframes | Bezier handle link (`keyframe_bezier_linked`), Reset Keyframe, Reset Handles | Handle editing. | Bedrock (bezier) | `keyframe.js:1049-1109` |
| Keyframes | Uniform Scaling (`keyframe_uniform`) | Scale keyframe values together. | Bedrock | `keyframe.js:1034` |
| Keyframes | Round Keyframe Values, Resolve Keyframe (expressions), Reverse Keyframes | Value clean-up and reversal. | Bedrock | `keyframe.js:1130-1174` |
| Keyframes | Keyframe column (`keyframe_column_create`, Shift = all channels), Select column, Select before/after playhead | Multi-channel key creation and selection. | Bedrock | `keyframe.js:1209-1282` |
| Keyframes | Copy / Paste keyframes (Ctrl+C / Ctrl+V; paste sub-keybind `keyframe`) | Clipboard for keyframes. | Bedrock | `js/copy_paste.js:504-527` |
| Keyframes | Animation presets (`apply_animation_preset`, `save_animation_preset`) | Reusable keyframe presets. | Editor | `timeline_animators.js:1155-1204` |
| Keyframes | Keyframe data: `effect`, `locator`, `script`, `bind_to_actor`, MoLang `x/y/z` | Effect and locator keyframes carry extra fields. | Bedrock | `keyframe.js:46-53` |
| Effects | Animate Effects (`select_effect_animator`); channels particle, sound, timeline | Particle, sound and timeline event keyframes. Created on demand from the timeline, and on import of Bedrock animations that contain effects. | Bedrock only | `timeline.js:2177-2188`, `timeline_animators.js:1146-1150`, `formats/bedrock/bedrock_animation.js:274-314` |
| Animations | Add / Create Group / Search / Import / Export / Save All | Animation list management. | Bedrock (.animation.json) | `animation.js:946-1669` |
| Animations | Merge Animation, Optimize Animation, Retarget Animations | Combine, simplify, or retarget animations. | Bedrock | `animation.js:1249-1552` |
| Animations | Bake Inverse Kinematics (`bake_ik_animation`) | Converts IK to plain keyframes. | Bedrock | `animation.js:1060` |
| Animations | Bake Animation Pose into Model (`bake_animation_into_model`) | Bakes the current animated pose into the model (action label only; body not traced). | Bedrock | `animation.js:1120` |
| Animations | Mirror Animating (`mirror_animating`) and Flip Animation (`flip_animation`) | Mirror or flip an animation across an axis. | Bedrock | `animations/mirror_animating.ts:195,219` |
| Animations | Copy Animation Pose (`copy_animation_pose`) | Copy the current animation pose (action label only; body not traced). | Bedrock | `animations/animation_mode.js:978` |
| Animations | Onion Skin (`animation_onion_skin`, selective variant), Motion Trails (`toggle_motion_trails`, `lock_motion_trail`) | Ghost frames and trajectory lines. | View | `animations/animation_mode.js:932-960`, `preview/preview.ts:2671` |
| Animations | Create Variable Placeholder, View Built-in Variables | MoLang variable helpers. | Bedrock (MoLang) | `animations/animation_mode.js:1016-1081` |
| Animations | Animation Controllers (`add_animation_controller`, `add_animation_controller_state`, controller preview on Space) | State machines for `.animation_controllers.json`. Blend transition curves edited in a dialog. | Bedrock (controllers) | `animations/animation_controllers.js:2298-2322,479` |
| Animations | Bedrock Animation Mode (`bedrock_animation_mode`) | Bedrock attachable preview mode. | Bedrock (attachables) | `formats/bedrock/attachable_preview.js:342` |
| Animations | Looped / hold / once loop modes | Per-animation `loop`: `once`, `loop`, `hold` (`animation.js:26,453`). | Bedrock | `animation.js:26,57,273-275,453,520-540` |
| Animations | Animation properties (molang): `anim_time_update`, `blend_weight`, `start_delay`, `loop_delay` | Bedrock animation fields exposed in the animation settings. | Bedrock | `animation.js:775-778` |
| Animations | Animation snapping (per-animation `snapping`, default setting `animation_snap` = 24) | Keyframe snap step for the timeline. | Editor | `timeline.js:308-310`, `setup_settings.js:285` |
| Animations | Animation snapping during drag (Ctrl = no snap) | Timeline time snapping. | Editor | `timeline.js:350,383` |

### 4.2 Full generated list (Edit and Animate actions)

Generated from `js/**` (`new Action/Tool/Toggle/BarSelect` with `modes` in `edit`/`animate`, or global ones in animation, outliner, modeling, uv, preview, and shared-action files). Paint, Display and Java/OptiFine/FBX/OBJ/glTF/Minecraft skin/IO files are excluded. Use this to audit coverage. Classification: "Generic-only" for Mesh/Spline files, "Bedrock" for cube/group/UV/animation/keyframe files, "View" for preview files, "Editor" otherwise.

| Feature (en.json label) | Action id | Mode | Default key (source) | Source | Relevance |
|---|---|---|---|---|---|
| Copy | `copy` | global | key: 'c', ctrl: true | js/copy_paste.js:451 | Bedrock (cube/group/UV) |
| Cut | `cut` | global | key: 'x', ctrl: true | js/copy_paste.js:469 | Bedrock (cube/group/UV) |
| Paste | `paste` | global | key: 'v', ctrl: true | js/copy_paste.js:487 | Bedrock (cube/group/UV) |
| Undo | `undo` | global | key: 'z', ctrl: true | js/undo.js:1044 | Editor |
| Redo | `redo` | global | key: 'y', ctrl: true | js/undo.js:1053 | Editor |
| Edit History... | `edit_history` | global | — | js/undo.js:1062 | Editor |
| Move | `move_tool` | edit,display,animate,pose | key: 'v' | js/interface/main_tools.ts:59 | Editor |
| Resize | `resize_tool` | edit,display,animate | key: 's' | js/interface/main_tools.ts:71 | Editor |
| Rotate | `rotate_tool` | edit,display,animate,pose | key: 'r' | js/interface/main_tools.ts:96 | Editor |
| Pivot Tool | `pivot_tool` | edit,animate | key: 'p' | js/interface/main_tools.ts:108 | Editor |
| Vertex Snap | `vertex_snap_tool` | edit | key: 'x' | js/interface/main_tools.ts:119 | Editor |
| Stretch | `stretch_tool` | edit | key: 's', alt: true | js/interface/main_tools.ts:142 | Editor |
| Swap Tools | `swap_tools` | edit,paint,display | key: 32 | js/interface/main_tools.ts:155 | Editor |
| Randomize Marker Colors | `randomize_marker_colors` | edit | — | js/interface/main_tools.ts:197 | Editor |
| Rename | `rename` | global | key: 113 | js/interface/shared_actions.ts:161 | Bedrock (cube/group/UV) |
| Delete | `delete` | global | key: 46 | js/interface/shared_actions.ts:174 | Bedrock (cube/group/UV) |
| Duplicate | `duplicate` | global | key: 'd', ctrl: true | js/interface/shared_actions.ts:188 | Bedrock (cube/group/UV) |
| Select All | `select_all` | global | key: 'a', ctrl: true | js/interface/shared_actions.ts:197 | Bedrock (cube/group/UV) |
| Unselect All | `unselect_all` | global | — | js/interface/shared_actions.ts:207 | Bedrock (cube/group/UV) |
| Invert Selection | `invert_selection` | global | key: 'i', ctrl: true | js/interface/shared_actions.ts:216 | Bedrock (cube/group/UV) |
| Bedrock Animation Mode | `bedrock_animation_mode` | animate | — | js/formats/bedrock/attachable_preview.js:342 | Editor |
| Add Spline | `add_spline` | edit | — | js/modeling/spline_editing.js:274 | Generic-only |
| Extrude Spline | `extrude_spline_selection` | edit | key: 'e', shift: true | js/modeling/spline_editing.js:327 | Generic-only |
| Apply Rotation | `apply_spline_rotation` | edit | — | js/modeling/spline_editing.js:440 | Generic-only |
| Merge Splines | `merge_splines` | edit | — | js/modeling/spline_editing.js:459 | Generic-only |
| Divide Spline Segment | `divide_spline_curve` | edit | — | js/modeling/spline_editing.js:470 | Generic-only |
| Split Spline | `split_spline` | edit | — | js/modeling/spline_editing.js:533 | Generic-only |
| Mirror Modeling | `mirror_modeling` | edit | — | js/modeling/mirror_modeling.ts:814 | Editor |
| Allow Mirror Modeling | `allow_element_mirror_modeling` | edit | — | js/modeling/mirror_modeling.ts:837 | Editor |
| Apply Mirror Modeling | `apply_mirror_modeling` | edit | — | js/modeling/mirror_modeling.ts:857 | Editor |
| Create Face or Edge | `create_face` | edit | key: 'f', shift: true | js/modeling/mesh_editing.js:362 | Generic-only |
| Convert to Mesh | `convert_to_mesh` | edit | — | js/modeling/mesh_editing.js:528 | Generic-only |
| Apply Rotation | `apply_mesh_rotation` | edit | — | js/modeling/mesh_editing.js:638 | Generic-only |
| Invert Face | `invert_face` | edit | — | js/modeling/mesh_editing.js:658 | Generic-only |
| Switch Face Crease | `switch_face_crease` | edit | — | js/modeling/mesh_editing.js:676 | Generic-only |
| Extrude Selection | `extrude_mesh_selection` | edit | key: 'e', shift: true | js/modeling/mesh_editing.js:696 | Generic-only |
| Solidify Faces | `solidify_mesh_selection` | edit | — | js/modeling/mesh_editing.js:1040 | Generic-only |
| Inset Selection | `inset_mesh_selection` | edit | key: 'i', shift: true | js/modeling/mesh_editing.js:1207 | Generic-only |
| Dissolve Edges | `dissolve_edges` | edit | — | js/modeling/mesh_editing.js:1342 | Generic-only |
| Transform Space | `transform_space` | edit,animate | — | js/modeling/transform.js:830 | Bedrock (cube/group/UV) |
| Rotation Space | `rotation_space` | edit,animate,pose | — | js/modeling/transform.js:848 | Bedrock (cube/group/UV) |
| Pivot Transform Space | `transform_pivot_space` | edit,animate | — | js/modeling/transform.js:861 | Bedrock (cube/group/UV) |
| Snap Mode | `vertex_snap_mode` | global | — | js/modeling/transform.js:877 | Bedrock (cube/group/UV) |
| Move Individual Positions | `position_slider_per_element` | global | — | js/modeling/transform.js:1049 | Bedrock (cube/group/UV) |
| Move Pivot Values Directly | `origin_slider_direct_values` | global | — | js/modeling/transform.js:1507 | Bedrock (cube/group/UV) |
| rotate_x_cw | `rotate_x_cw` | global | — | js/modeling/transform.js:1620 | Bedrock (cube/group/UV) |
| rotate_x_ccw | `rotate_x_ccw` | global | — | js/modeling/transform.js:1629 | Bedrock (cube/group/UV) |
| rotate_y_cw | `rotate_y_cw` | global | — | js/modeling/transform.js:1638 | Bedrock (cube/group/UV) |
| rotate_y_ccw | `rotate_y_ccw` | global | — | js/modeling/transform.js:1647 | Bedrock (cube/group/UV) |
| rotate_z_cw | `rotate_z_cw` | global | — | js/modeling/transform.js:1656 | Bedrock (cube/group/UV) |
| rotate_z_ccw | `rotate_z_ccw` | global | — | js/modeling/transform.js:1665 | Bedrock (cube/group/UV) |
| flip_x | `flip_x` | edit,animate | — | js/modeling/transform.js:1675 | Bedrock (cube/group/UV) |
| flip_y | `flip_y` | edit,animate | — | js/modeling/transform.js:1685 | Bedrock (cube/group/UV) |
| flip_z | `flip_z` | edit,animate | — | js/modeling/transform.js:1695 | Bedrock (cube/group/UV) |
| flip_in_place_x | `flip_in_place_x` | edit | — | js/modeling/transform.js:1706 | Bedrock (cube/group/UV) |
| flip_in_place_y | `flip_in_place_y` | edit | — | js/modeling/transform.js:1716 | Bedrock (cube/group/UV) |
| flip_in_place_z | `flip_in_place_z` | edit | — | js/modeling/transform.js:1726 | Bedrock (cube/group/UV) |
| center_x | `center_x` | global | — | js/modeling/transform.js:1737 | Bedrock (cube/group/UV) |
| center_y | `center_y` | global | — | js/modeling/transform.js:1748 | Bedrock (cube/group/UV) |
| center_z | `center_z` | global | — | js/modeling/transform.js:1759 | Bedrock (cube/group/UV) |
| Center Lateral | `center_lateral` | global | — | js/modeling/transform.js:1770 | Bedrock (cube/group/UV) |
| Move Up | `move_up` | edit | key: 38, ctrl: null, shift: null | js/modeling/transform.js:1782 | Bedrock (cube/group/UV) |
| Move Down | `move_down` | edit | key: 40, ctrl: null, shift: null | js/modeling/transform.js:1795 | Bedrock (cube/group/UV) |
| Move Left | `move_left` | edit | key: 37, ctrl: null, shift: null | js/modeling/transform.js:1808 | Bedrock (cube/group/UV) |
| Move Right | `move_right` | edit | key: 39, ctrl: null, shift: null | js/modeling/transform.js:1821 | Bedrock (cube/group/UV) |
| Move Forth | `move_forth` | edit | key: 33, ctrl: null, shift: null | js/modeling/transform.js:1834 | Bedrock (cube/group/UV) |
| Move Back | `move_back` | edit | key: 34, ctrl: null, shift: null | js/modeling/transform.js:1841 | Bedrock (cube/group/UV) |
| Toggle Visibility | `toggle_visibility` | global | — | js/modeling/transform.js:1849 | Bedrock (cube/group/UV) |
| Toggle Lock | `toggle_locked` | global | — | js/modeling/transform.js:1854 | Bedrock (cube/group/UV) |
| Toggle Export | `toggle_export` | global | — | js/modeling/transform.js:1859 | Bedrock (cube/group/UV) |
| Toggle Auto UV | `toggle_autouv` | edit | — | js/modeling/transform.js:1864 | Bedrock (cube/group/UV) |
| Toggle Shading | `toggle_shade` | global | — | js/modeling/transform.js:1870 | Bedrock (cube/group/UV) |
| Mirror UV | `toggle_mirror_uv` | global | — | js/modeling/transform.js:1876 | Bedrock (cube/group/UV) |
| Update Auto UV | `update_autouv` | global | — | js/modeling/transform.js:1897 | Bedrock (cube/group/UV) |
| toggle_stretch_linked | `toggle_stretch_linked` | global | — | js/modeling/transform.js:1911 | Bedrock (cube/group/UV) |
| Center Pivot | `origin_to_geometry` | edit,animate | — | js/modeling/transform.js:1917 | Bedrock (cube/group/UV) |
| Center Individual Pivots | `center_individual_pivots` | edit,animate | — | js/modeling/transform.js:1975 | Bedrock (cube/group/UV) |
| Reset Bone | `bone_reset_toggle` | global | — | js/modeling/transform.js:2027 | Bedrock (cube/group/UV) |
| Remove Blank Faces | `remove_blank_faces` | global | — | js/modeling/transform.js:2041 | Bedrock (cube/group/UV) |
| Set Cullfaces Automatically | `auto_set_cullfaces` | global | — | js/modeling/transform.js:2101 | Bedrock (cube/group/UV) |
| Set Vertex Weights | `set_vertex_weights` | edit | — | js/modeling/mesh/set_vertex_weights.ts:5 | Generic-only |
| Knife Tool | `knife_tool` | edit | — | js/modeling/mesh/knife_tool.js:720 | Generic-only |
| Merge Vertices | `merge_vertices` | edit | key: 'm', shift: true | js/modeling/mesh/merge_split.ts:191 | Generic-only |
| Merge Meshes | `merge_meshes` | edit | — | js/modeling/mesh/merge_split.ts:226 | Generic-only |
| Split Mesh | `split_mesh` | edit | — | js/modeling/mesh/merge_split.ts:276 | Generic-only |
| Loop Cut | `loop_cut` | edit | key: 'r', shift: true | js/modeling/mesh/loop_cut.ts:3 | Generic-only |
| Proportional Editing | `proportional_editing` | edit | — | js/modeling/mesh/proportional_edit.ts:103 | Generic-only |
| Add Mesh | `add_mesh` | edit | — | js/modeling/mesh/add_mesh.ts:449 | Generic-only |
| Seam Tool | `seam_tool` | edit | — | js/modeling/mesh/seam_tool.ts:3 | Generic-only |
| UV Grid | `uv_grid` | global | — | js/uv/uv.js:2156 | Bedrock (cube/group/UV) |
| Maximize UV | `uv_maximize` | global | — | js/uv/uv.js:2175 | Bedrock (cube/group/UV) |
| Turn Mapping | `uv_turn_mapping` | global | — | js/uv/uv.js:2191 | Bedrock (cube/group/UV) |
| Auto UV | `uv_auto` | global | — | js/uv/uv.js:2207 | Bedrock (cube/group/UV) |
| UV Project from View | `uv_project_from_view` | global | — | js/uv/uv.js:2223 | Bedrock (cube/group/UV) |
| Relative Auto UV | `uv_rel_auto` | global | — | js/uv/uv.js:2287 | Bedrock (cube/group/UV) |
| UV Mirror X | `uv_mirror_x` | global | — | js/uv/uv.js:2303 | Bedrock (cube/group/UV) |
| UV Mirror Y | `uv_mirror_y` | global | — | js/uv/uv.js:2325 | Bedrock (cube/group/UV) |
| Rotate UV Left | `uv_rotate_left` | global | — | js/uv/uv.js:2347 | Bedrock (cube/group/UV) |
| Rotate UV Right | `uv_rotate_right` | global | — | js/uv/uv.js:2363 | Bedrock (cube/group/UV) |
| Remove Face | `uv_transparent` | global | — | js/uv/uv.js:2379 | Bedrock (cube/group/UV) |
| Reset Face | `uv_reset` | global | — | js/uv/uv.js:2393 | Bedrock (cube/group/UV) |
| Apply To All Faces | `uv_apply_all` | global | — | js/uv/uv.js:2409 | Bedrock (cube/group/UV) |
| Cullface | `cullface` | global | — | js/uv/uv.js:2419 | Bedrock (cube/group/UV) |
| Enable Cullface | `auto_cullface` | global | — | js/uv/uv.js:2438 | Bedrock (cube/group/UV) |
| Tint | `face_tint` | global | — | js/uv/uv.js:2454 | Bedrock (cube/group/UV) |
| Move UV to Cursor | `move_uv_to_cursor` | edit | alt: true, key: 'u' | js/uv/uv.js:2483 | Bedrock (cube/group/UV) |
| Merge UV Vertices | `merge_uv_vertices` | global | — | js/uv/uv.js:2504 | Bedrock (cube/group/UV) |
| Connect UV Faces | `connect_uv_faces` | global | — | js/uv/uv.js:2539 | Bedrock (cube/group/UV) |
| Snap UV to Pixels | `snap_uv_to_pixels` | global | — | js/uv/uv.js:2630 | Bedrock (cube/group/UV) |
| Cycle UV | `uv_cycle` | global | — | js/uv/uv.js:2678 | Bedrock (cube/group/UV) |
| Cycle Invert UV | `uv_cycle_invert` | global | — | js/uv/uv.js:2704 | Bedrock (cube/group/UV) |
| Display All Elements | `edit_mode_uv_overlay` | edit | — | js/uv/uv.js:2727 | Bedrock (cube/group/UV) |
| Move Texture with UV | `move_texture_with_uv` | edit | — | js/uv/uv.js:2747 | Bedrock (cube/group/UV) |
| Preview Scene | `preview_scene` | global | — | js/preview/preview_scenes.ts:1004 | View |
| Preview Models | `preview_models` | global | — | js/preview/preview_scenes.ts:1038 | View |
| View Mode | `view_mode` | global | key: 'z' | js/preview/preview.ts:2592 | View |
| preview_checkerboard | `preview_checkerboard` | global | key: 't' | js/preview/preview.ts:2629 | View |
| uv_checkerboard | `uv_checkerboard` | global | — | js/preview/preview.ts:2635 | View |
| Checkerboard | `image_editor_checkerboard` | global | — | js/preview/preview.ts:2641 | View |
| toggle_shading | `toggle_shading` | global | — | js/preview/preview.ts:2649 | View |
| toggle_all_grids | `toggle_all_grids` | global | — | js/preview/preview.ts:2656 | View |
| toggle_ground_plane | `toggle_ground_plane` | global | — | js/preview/preview.ts:2664 | View |
| toggle_motion_trails | `toggle_motion_trails` | animate | — | js/preview/preview.ts:2671 | View |
| pixel_grid | `pixel_grid` | edit | key: 'g' | js/preview/preview.ts:2679 | View |
| Split Screen | `split_screen` | global | — | js/preview/preview.ts:2692 | View |
| Center View on Selection | `focus_on_selection` | global | — | js/preview/preview.ts:2713 | View |
| Toggle Camera Projection | `toggle_camera_projection` | global | key: 101 | js/preview/preview.ts:2782 | View |
| camera_initial | `camera_initial` | global | key: 97 | js/preview/preview.ts:2791 | View |
| camera_top | `camera_top` | global | key: 104 | js/preview/preview.ts:2803 | View |
| camera_bottom | `camera_bottom` | global | key: 98 | js/preview/preview.ts:2815 | View |
| camera_south | `camera_south` | global | key: 100 | js/preview/preview.ts:2827 | View |
| camera_north | `camera_north` | global | key: 102 | js/preview/preview.ts:2839 | View |
| camera_east | `camera_east` | global | key: 103 | js/preview/preview.ts:2851 | View |
| camera_west | `camera_west` | global | key: 105 | js/preview/preview.ts:2863 | View |
| Add Keyframe | `add_keyframe` | animate | key: 'q' | js/animations/keyframe.js:843 | Bedrock (animation) |
| Move Keyframes Back | `move_keyframe_back` | animate | key: 37 | js/animations/keyframe.js:873 | Bedrock (animation) |
| Move Keyframes Forth | `move_keyframe_forth` | animate | key: 39 | js/animations/keyframe.js:888 | Bedrock (animation) |
| Move Keyframe Graph Up | `move_graph_keyframes_up` | animate | key: 38, ctrl: null, shift: null | js/animations/keyframe.js:916 | Bedrock (animation) |
| Move Keyframe Graph Down | `move_graph_keyframes_down` | animate | key: 40, ctrl: null, shift: null | js/animations/keyframe.js:926 | Bedrock (animation) |
| Previous Keyframe | `previous_keyframe` | animate | — | js/animations/keyframe.js:936 | Bedrock (animation) |
| Next Keyframe | `next_keyframe` | animate | — | js/animations/keyframe.js:976 | Bedrock (animation) |
| Uniform Scaling | `keyframe_uniform` | global | — | js/animations/keyframe.js:1034 | Bedrock (animation) |
| Link Bézier Handles | `keyframe_bezier_linked` | global | — | js/animations/keyframe.js:1049 | Bedrock (animation) |
| Interpolation | `keyframe_interpolation` | global | — | js/animations/keyframe.js:1069 | Bedrock (animation) |
| Reset Keyframe | `reset_keyframe` | global | — | js/animations/keyframe.js:1089 | Bedrock (animation) |
| Reset Keyframe Handles | `reset_keyframe_handles` | global | — | js/animations/keyframe.js:1109 | Bedrock (animation) |
| Round Keyframe Values | `round_keyframe_values` | global | — | js/animations/keyframe.js:1130 | Bedrock (animation) |
| Resolve Keyframe | `resolve_keyframe_expressions` | global | — | js/animations/keyframe.js:1156 | Bedrock (animation) |
| Reverse Keyframes | `reverse_keyframes` | global | — | js/animations/keyframe.js:1174 | Bedrock (animation) |
| Create Keyframe Column | `keyframe_column_create` | global | — | js/animations/keyframe.js:1209 | Bedrock (animation) |
| Select Keyframe Column | `keyframe_column_select` | global | — | js/animations/keyframe.js:1262 | Bedrock (animation) |
| Select Keyframes Before Playhead | `keyframe_select_before_playhead` | global | — | js/animations/keyframe.js:1272 | Bedrock (animation) |
| Select Keyframes After Playhead | `keyframe_select_after_playhead` | global | — | js/animations/keyframe.js:1282 | Bedrock (animation) |
| Apply Animation Preset | `apply_animation_preset` | global | — | js/animations/timeline_animators.js:1155 | Bedrock (animation) |
| Save Animation Preset... | `save_animation_preset` | global | — | js/animations/timeline_animators.js:1204 | Bedrock (animation) |
| Toggle Graph Editor | `timeline_graph_editor` | animate | key: 114 | js/animations/timeline.js:1920 | Bedrock (animation) |
| Display Other Graphs | `graph_editor_other_graphs` | animate | — | js/animations/timeline.js:1937 | Bedrock (animation) |
| Include Other Graphs | `graph_editor_include_other_graphs` | animate | — | js/animations/timeline.js:1946 | Bedrock (animation) |
| Include Zero Line | `graph_editor_zero_line` | animate | — | js/animations/timeline.js:1955 | Bedrock (animation) |
| Play Animation | `play_animation` | animate | key: 32 | js/animations/timeline.js:1964 | Bedrock (animation) |
| Looped Playback | `looped_animation_playback` | animate | — | js/animations/timeline.js:1982 | Bedrock (animation) |
| Jump to Animation Start | `jump_to_timeline_start` | animate | key: 36 | js/animations/timeline.js:2033 | Bedrock (animation) |
| Jump to Animation End | `jump_to_timeline_end` | animate | key: 35 | js/animations/timeline.js:2051 | Bedrock (animation) |
| Jump 1 Frame Back | `timeline_frame_back` | animate,edit,paint | key: 188 | js/animations/timeline.js:2068 | Bedrock (animation) |
| Jump 1 Frame Forth | `timeline_frame_forth` | animate,edit,paint | key: 190 | js/animations/timeline.js:2084 | Bedrock (animation) |
| Set Timeline Range Start | `set_timeline_range_start` | animate | — | js/animations/timeline.js:2100 | Bedrock (animation) |
| Set Timeline Range End | `set_timeline_range_end` | animate | — | js/animations/timeline.js:2109 | Bedrock (animation) |
| Disable Timeline Range | `disable_timeline_range` | animate | — | js/animations/timeline.js:2118 | Bedrock (animation) |
| Bring Up All Animators | `bring_up_all_animations` | animate | — | js/animations/timeline.js:2131 | Bedrock (animation) |
| Add All to Timeline | `add_all_to_timeline` | animate | — | js/animations/timeline.js:2145 | Bedrock (animation) |
| Fold All Animators | `fold_all_animations` | animate | — | js/animations/timeline.js:2157 | Bedrock (animation) |
| Clear Timeline | `clear_timeline` | animate | — | js/animations/timeline.js:2168 | Bedrock (animation) |
| Animate Effects | `select_effect_animator` | animate | — | js/animations/timeline.js:2177 | Bedrock (animation) |
| Filter Channels | `timeline_focus` | animate | — | js/animations/timeline.js:2190 | Bedrock (animation) |
| Set Marker | `add_marker` | animate | ctrl: true, key: 'm' | js/animations/timeline.js:2231 | Bedrock (animation) |
| Timeline Setups | `timeline_setups` | animate | — | js/animations/timeline.js:2260 | Bedrock (animation) |
| Save Timeline Setup... | `save_timeline_setup` | animate | — | js/animations/timeline.js:2292 | Bedrock (animation) |
| Add Animation Controller | `add_animation_controller` | animate | — | js/animations/animation_controllers.js:2298 | Bedrock (animation) |
| Add Animation Controller State | `add_animation_controller_state` | animate | — | js/animations/animation_controllers.js:2310 | Bedrock (animation) |
| Controller Preview | `animation_controller_preview_mode` | animate | key: 32 | js/animations/animation_controllers.js:2322 | Bedrock (animation) |
| Mirror Animating | `mirror_animating` | animate | — | js/animations/mirror_animating.ts:195 | Bedrock (animation) |
| Flip Animation | `flip_animation` | animate | — | js/animations/mirror_animating.ts:219 | Bedrock (animation) |
| Set Animation End | `set_animation_end` | animate | ctrl: true, key: 35 | js/animations/animation.js:935 | Bedrock (animation) |
| Add Animation | `add_animation` | animate | — | js/animations/animation.js:946 | Bedrock (animation) |
| Create Animation Group | `create_animation_group` | animate | — | js/animations/animation.js:959 | Bedrock (animation) |
| Import Animations | `load_animation_file` | animate | — | js/animations/animation.js:972 | Bedrock (animation) |
| Export Animations... | `export_animation_file` | global | — | js/animations/animation.js:980 | Bedrock (animation) |
| Save All Animations | `save_all_animations` | global | — | js/animations/animation.js:1029 | Bedrock (animation) |
| Bake Inverse Kinematics | `bake_ik_animation` | global | — | js/animations/animation.js:1060 | Bedrock (animation) |
| Bake Animation Pose into Model | `bake_animation_into_model` | animate | — | js/animations/animation.js:1120 | Bedrock (animation) |
| Change Animation Speed... | `change_animation_speed` | animate | — | js/animations/animation.js:1181 | Bedrock (animation) |
| Merge Animation | `merge_animation` | global | — | js/animations/animation.js:1249 | Bedrock (animation) |
| Optimize Animation | `optimize_animation` | animate | — | js/animations/animation.js:1405 | Bedrock (animation) |
| Retarget Animations | `retarget_animators` | global | — | js/animations/animation.js:1552 | Bedrock (animation) |
| Search Animations | `search_animations` | global | — | js/animations/animation.js:1669 | Bedrock (animation) |
| Lock Motion Trail | `lock_motion_trail` | global | — | js/animations/animation_mode.js:932 | Bedrock (animation) |
| Animation Onion Skin | `animation_onion_skin` | animate | — | js/animations/animation_mode.js:946 | Bedrock (animation) |
| Copy Animation Pose | `copy_animation_pose` | global | — | js/animations/animation_mode.js:978 | Bedrock (animation) |
| Create Variable Placeholder | `create_variable_placeholder` | animate | — | js/animations/animation_mode.js:1016 | Bedrock (animation) |
| View Built-in Variables | `view_built_in_variables` | animate | — | js/animations/animation_mode.js:1081 | Bedrock (animation) |
| Create Collection | `create_collection` | edit,paint,animate | key: 'l', ctrl: true | js/outliner/collections.ts:600 | Bedrock (cube/group/UV) |
| Set Collection Content to Selected | `set_collection_content_to_selection` | global | — | js/outliner/collections.ts:613 | Bedrock (cube/group/UV) |
| Add Selected to Collection | `add_to_collection` | global | — | js/outliner/collections.ts:627 | Bedrock (cube/group/UV) |
| Add Element | `add_element` | edit | — | js/outliner/outliner.js:929 | Bedrock (cube/group/UV) |
| Toggle More Options | `outliner_toggle` | global | key: 115 | js/outliner/outliner.js:949 | Bedrock (cube/group/UV) |
| Search Outliner | `search_outliner` | global | — | js/outliner/outliner.js:960 | Bedrock (cube/group/UV) |
| Move to | `move_to_group` | global | — | js/outliner/outliner.js:1039 | Bedrock (cube/group/UV) |
| Sort Outliner | `sort_outliner` | global | — | js/outliner/outliner.js:1073 | Bedrock (cube/group/UV) |
| Unlock All | `unlock_everything` | global | — | js/outliner/outliner.js:1085 | Bedrock (cube/group/UV) |
| Cube Colors | `element_colors` | global | — | js/outliner/outliner.js:1100 | Bedrock (cube/group/UV) |
| Select... | `select_window` | global | key: 'f', ctrl: true | js/outliner/outliner.js:1105 | Bedrock (cube/group/UV) |
| Hide Everything Except Selection | `hide_everything_except_selection` | edit,paint | key: 'i' | js/outliner/outliner.js:1204 | Bedrock (cube/group/UV) |
| Add Group | `add_group` | global | key: 'g', ctrl: true | js/outliner/types/group.js:720 | Bedrock (cube/group/UV) |
| Group Elements | `group_elements` | global | key: 'g', ctrl: true, shift: true | js/outliner/types/group.js:765 | Bedrock (cube/group/UV) |
| Collapse Groups | `collapse_groups` | global | — | js/outliner/types/group.js:811 | Bedrock (cube/group/UV) |
| Unfold Groups | `unfold_groups` | global | — | js/outliner/types/group.js:822 | Bedrock (cube/group/UV) |
| Edit Binding... | `edit_bedrock_binding` | global | — | js/outliner/types/group.js:833 | Bedrock (cube/group/UV) |
| Resolve Group | `resolve_group` | edit | — | js/outliner/types/group.js:921 | Bedrock (cube/group/UV) |
| UV Mode | `cube_uv_mode` | global | — | js/outliner/types/cube.js:1718 | Bedrock (cube/group/UV) |
| Transparency Render Order | `element_render_order` | global | — | js/outliner/types/cube.js:1742 | Bedrock (cube/group/UV) |

## 5. Bedrock/GeckoLib-relevant facts to carry into Atelier

- **Mesh and Spline editing is not available for Bedrock.** Mesh elements (`create_face`, `extrude_mesh_selection`, `loop_cut`, `merge_vertices`, knife, seams, proportional editing) and spline tools are gated by `meshes` in the generic format (`js/formats/generic.ts:15`). The Bedrock entity and block formats do not set it (`js/formats/bedrock/bedrock.js:1555-1640`). Cube editing, UV, groups, locators, bounding boxes, animation, controllers and effects are the Bedrock surface.
- **Bedrock bezier keyframes are baked on export** into samples at `1 / animation.snapping` (`js/formats/bedrock/bedrock_animation.js:475-490`). Keyframe interpolation is therefore an editor-side feature, not a file-format one, for bezier.
- **IK is sampled on Bedrock export** (`sampleIK`, `bedrock_animation.js:529`). IK nulls are editor-only.
- **Effect (particle, sound, timeline) keyframes are Bedrock-only** (`EffectAnimator`, `timeline_animators.js:1146-1150`).
- **Animation loop modes** are `once`, `loop`, `hold` (`animation.js:26,57`). Animation-level MoLang fields are `anim_time_update`, `blend_weight`, `start_delay`, `loop_delay` (`animation.js:775-778`).
- **Reference images are editor-only.** They are saved into `.bbmodel` (`reference_images` key) and app-global storage. They are not written to Bedrock JSON.
- **Viewport defaults that matter for parity with Bedrock:** Bedrock formats set `centered_grid: true` (`bedrock.js:1577`), so the grid origin is the centre; the block-format box marker is 30³ (`bedrock.js`, block format `cube_size_limiter`).

## 6. Not covered or not verified

- Paint and Display modes are only covered where they touch Edit/Animate (for example `swap_tools`, `timeline_frame_*`). Paint tools are listed in the keybind table only.
- Gizmo geometry, camera and lighting numbers come from the constructors and `updateShading`. They were not checked against a running build, so pixel-level appearance is unverified.
- The feature list in 4.2 is derived from `new Action/Tool/Toggle/BarSelect` definitions. Menu entries that only reference an id, plugin-registered actions, and dynamically generated items (for example Animation presets, collection menus, camera angle entries) are not all enumerated.
- The "one-line description" column in 4.2 is the en.json label, not a rewritten description. Section 4.1 holds hand-written descriptions for the major features.
- `~` in a line reference means the cited range is approximate. Exact line numbers were checked for the camera, keyboard, reference-image import and settings citations.
- Keymap preset diffs were counted by entry, not by per-key diff against the default table.


## 7. Edit-mode layout, UV editor, Textures panel, selection (read from v5.2.2, re-implemented in Ace)

**Source read:** `js/interface/panels.ts`, `js/uv/uv.js`, `js/texturing/textures.js`, `js/outliner/element_panel.ts`, `js/outliner/outliner.js`, `js/outliner/abstract/outliner_element.ts`, `js/outliner/types/group.js`, `js/outliner/types/cube.js`, `js/preview/preview.ts`, `js/misc.js` (shallow clone, read only, deleted afterwards).

### 7.1 Default panel layout (Panel `default_position`)
| Mode | Left bar (sidebar_index) | Right bar (sidebar_index) |
|---|---|---|
| Edit | UV (1, height 500, min 200), Textures (4, growable) | Transform sliders `transform` (1), Element properties `element` (2, attached to transform), Outliner (8) |
| Paint | UV, Textures (moves to the right bar in 2D paint), Layers | Color, Outliner |
| Animate | Animations (0), Keyframe (4), Variable placeholders (10) | Bone (3), Outliner (8); Timeline in the bottom slot |
Tool row (Toolbox) sits above the viewport; modes are tabs in the menu row. Panels are draggable between slots; sizes are saved per layout.

### 7.2 UV editor (`UVEditor`)
- Title bar shows the UV resolution ("W x H"); face bar (North East South West Up Down, selected + `disabled` when `texture === null`) only for per-face cubes; viewport; toolbar at the BOTTOM (`uv_editor`: move texture with UV, apply to all faces, maximize, auto UV, project from view, remove face, mirror X, mirror Y, rotation, mirror UV for box UV); slider bar above it.
- Faces whose texture is not the active one are not drawn (`face.getTexture() == texture`). Only selected elements are shown by default (`display_uv`).
- A face is dragged by `mousedown`: Shift / Ctrl add it to the face selection (and the drag still starts); the selected faces of ALL mappable elements move together. Box-UV islands move `uv_offset` by whole pixels (`Math.floor`). Selected faces show 4 side + 4 corner resize handles; resize moves the stored coordinate matching the visual side (inverted rects swap sides).
- Snapping: `step = canvasGridSize(shift, ctrl) / UVEditor.grid`, i.e. 1 px, Shift 0.25, Ctrl/Cmd 0.1, both 0.025 (`edit_size` 16, `shift_size` 64, `ctrl_size` 160, `ctrl_shift_size` 640); `grid = texture px per UV unit` when `auto_grid`. Box UV always snaps to 1 (no fine modifiers). UV clamping is a setting (off by default).
- Navigation: Ctrl/Cmd + wheel (or trackpad pinch = `ctrlKey` wheel) zooms at the cursor (`n = 0.15 * zoom`, damped for small deltas, snaps to 1); plain wheel scrolls; MMB / RMB drag pans (snaps to centre); texture grid only drawn when a texture pixel is wider than 5 screen px.
- Mirror X/Y flip the selected faces' uv; for box UV, Mirror X toggles `mirror_uv` (swaps east/west and mirrors every face). Rotation (`face.rotation` 0/90/180/270) exists for formats with `uv_rotation` (bbmodel yes, Bedrock geometry no).

### 7.3 Textures panel
List with thumbnail, name and size; toolbar import / create / group / append / search; per-texture visibility; context menu includes "Apply to selection" (selected faces) and "Apply to all faces"; drop png files to import. `.bbmodel` textures are saved with `name, path?, relative_path, folder, namespace, id, group, scope, width, height, uv_width, uv_height, particle, use_as_default, layers_enabled, sync_to_project, file_format, render_mode, render_sides, wrap_mode, pbr_channel, fps, frame_time, frame_order_type, frame_order, frame_interpolate, visible, internal, saved, uuid, source (data URL when internal)`; faces store `texture` as an index into that array (`null` = disabled face, key absent = untextured).

### 7.4 Selection
- Outliner click (`OutlinerElement.select` / `Group.select`): plain = only this (a group selects all its children); Ctrl/Cmd toggles (unselecting a child also unselects its parent groups); Shift selects the RANGE between the last selected node and the clicked one among the same parent's children (else it adds); `Group.select` with Shift on a non-sibling adds the group.
- Viewport (`preview_select`): click selects the cube; Ctrl/Cmd = `multi_select` toggle; Shift = `group_select` (selects the cube's parent group, climbing to its parent when already selected, and ADDS to the selection); Alt = loop select (meshes only). `preview_area_select` = Ctrl/Cmd + drag, Shift extends.
- Elements cannot be selected in Animate mode (groups only).
