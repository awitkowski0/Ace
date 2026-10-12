# Animation Studio keymap

<!-- GENERATED from src/components/animstudio/ui/keymap.ts - do not edit by hand. Regenerate: UPDATE_KEYMAP_DOC=1 pnpm vitest run src/components/animstudio/ui/keymap.test.ts -->

While a Studio pane has keyboard focus (and focus is not in a text field), Blockbench v5.2.2's default keybinds win (macOS: Ctrl is mapped to ⌘, as Blockbench does).
Outside the Studio, Ace's IntelliJ keymap is untouched. Source of truth for the defaults: `docs/BLOCKBENCH-PARITY.md` sections 1.1, 1.2, 1.5.

Entries: 111 (53 implemented, 20 via viewport API, 7 Ace host, 27 skipped, 4 Ace-only).

Digit keys 1-9 double as numpad keys (Ace's dispatcher does not tell Numpad1 from Digit1). Bare keys never fire in text inputs or Monaco.

## Keyboard

| Blockbench id | Name | Blockbench default | Studio on macOS | Modes | Status | Behaviour |
|---|---|---|---|---|---|---|
| `copy` | Copy | Ctrl+C | ⌘C | Edit, Animate | implemented | Animate: copies the selected keyframes. Edit: copies the selected bones / cubes. The Shift variation (`multiple`) has no specified behaviour in the parity doc and is not implemented. |
| `cut` | Cut | Ctrl+X | ⌘X | Edit, Animate | implemented | Copy + delete, same context rules as Copy. |
| `paste` | Paste | Ctrl+V | ⌘V | Edit, Animate | implemented | Animate: keyframes at the playhead. Edit: bones / cubes under the selection (cubes into the selected bone). |
| `undo` | Undo | Ctrl+Z | ⌘Z | Edit, Animate | implemented | Routed to the document's Monaco undo stack (one stop per command). |
| `redo` | Redo | Ctrl+Y | ⌘Y / ⌘⇧Z | Edit, Animate | implemented | Blockbench binds Ctrl+Y; ⌘⇧Z added as the macOS convention. |
| `action_control` | Action Control | F | F | Edit, Animate | implemented | Searchable list of every Studio command (↑/↓ navigate, Enter run, Esc close). The old Studio 'F = frame selected' moved to ⌥F. |
| `select_all` | Select All | Ctrl+A | ⌘A | Edit, Animate | implemented | Edit: all bones. Animate: all keyframes of the open animation. |
| `invert_selection` | Invert Selection | Ctrl+I | ⌘I | Edit, Animate | implemented | Edit: bones. Animate: keyframes. |
| `delete` | Delete | Delete | ⌫ | Edit, Animate | implemented | Edit: selected cube, else selected bones (children are re-parented). Animate: selected keyframes. The `keep_vertices` Alt variation is mesh-only. |
| `duplicate` | Duplicate | Ctrl+D | ⌘D | Edit, Animate | implemented | Edit: bone (with cubes + descendants) or cube. Animate: selected keyframes. |
| `rename` | Rename | F2 | F2 | Edit, Animate | implemented | Inline rename of the selected bone in the outliner; in Animate with no bone selected, renames the open animation. |
| `cancel` | Cancel | Esc | Esc | Edit, Animate | implemented | Closes Action Control / tool panels, cancels a viewport gizmo drag (viewport API `cancelDrag`). |
| `move_tool` | Move | V | V | Edit, Animate | implemented |  |
| `resize_tool` | Resize | S | S | Edit, Animate | implemented | Not available in Pose mode (Blockbench lists edit / display / animate). |
| `rotate_tool` | Rotate | R | R | Edit, Animate | implemented |  |
| `pivot_tool` | Pivot Tool | P | P | Edit, Animate | implemented | Disabled in Pose mode. |
| `vertex_snap_tool` | Vertex Snap | X | X | Edit | viewport API | Viewport gizmo mode: calls viewport API `setTool('vertex_snap')`. |
| `stretch_tool` | Stretch | Alt+S | ⌥S | Edit | viewport API | Viewport gizmo mode (format feature `stretch_cubes`): viewport API `setTool('stretch')`. |
| `swap_tools` | Swap Tools | Space | Space | Edit | implemented | Edit: switches between the current and the previously used tool. The `hold` sub-keybind (hold Alt = alt tool) is not implemented: Alt already modifies viewport mouse gestures. |
| `move_up` | Move Up | [Ctrl]+[Shift]+↑ | [⌘][⇧]↑ | Edit | implemented | Nudges the selection by the snap step: 1 px, ⇧ 0.25, ⌘ 0.1, ⌘⇧ 0.025 (parity doc 1.4). Up/Down = vertical. |
| `move_down` | Move Down | [Ctrl]+[Shift]+↓ | [⌘][⇧]↓ | Edit | implemented |  |
| `move_left` | Move Left | [Ctrl]+[Shift]+← | [⌘][⇧]← | Edit | implemented | Relative to the viewport camera (viewport API `cameraYaw`; default camera when absent). |
| `move_right` | Move Right | [Ctrl]+[Shift]+→ | [⌘][⇧]→ | Edit | implemented |  |
| `move_forth` | Move Forth | [Ctrl]+[Shift]+PgUp | [⌘][⇧]PgUp | Edit | implemented | Away from the camera, horizontal. |
| `move_back` | Move Back | [Ctrl]+[Shift]+PgDn | [⌘][⇧]PgDn | Edit | implemented |  |
| `add_group` | Add Group | Ctrl+G | ⌘G | Edit | implemented | New bone / group (child of the selected bone, else top level) at the selection's pivot. |
| `group_elements` | Group Elements | Ctrl+Shift+G | ⌘⇧G | Edit | implemented | Wraps the selected bones / cube in a new group (ungroup: context menu). |
| `hide_everything_except_selection` | Hide Everything Except Selection | I | I | Edit | implemented | Toggles: hides every bone but the selection; press again to show all. (The Studio's old 'I = insert keyframe' moved to Q.) |
| `select_window` | Select... | Ctrl+F | ⌘F | Edit | implemented | Prompts for a name pattern (`*` wildcards, case-insensitive) and selects matching bones / cubes. |
| `outliner_toggle` | Toggle More Options | F4 | F4 | Edit, Animate | implemented | Shows / hides the extra outliner columns (export, shade, auto UV, mirror UV). |
| `toggle_sidebars` | Toggle Sidebars | Ctrl+B | ⌘B | Edit, Animate | implemented | Hides / shows the outliner and properties panels. |
| `add_keyframe` | Add Keyframe | Q | Q | Animate | implemented | Keys for the selected bones at the playhead (current pose values). Shift variation `reset_values` = ⇧Q inserts default values (0 / scale 1). |
| `add_keyframe_reset` | Add Keyframe (reset values) | Shift+Q | ⇧Q | Animate | implemented |  |
| `move_keyframe_back` | Move Keyframes Back | ← | ← | Animate | implemented | Moves the selected keyframes one snap step (1 tick) earlier. |
| `move_keyframe_forth` | Move Keyframes Forth | → | → | Animate | implemented |  |
| `move_graph_keyframes_up` | Move Keyframe Graph Up | [Ctrl]+[Shift]+↑ | [⌘][⇧]↑ | Animate | implemented | Raises the value of the selected keyframes by 1 (scale: 0.1). Modifiers are ignored. |
| `move_graph_keyframes_down` | Move Keyframe Graph Down | [Ctrl]+[Shift]+↓ | [⌘][⇧]↓ | Animate | implemented |  |
| `timeline_graph_editor` | Toggle Graph Editor | F3 | F3 | Animate | implemented |  |
| `play_animation` | Play Animation | Space | Space | Animate | implemented |  |
| `jump_to_timeline_start` | Jump to Animation Start | Home | Home | Animate | implemented |  |
| `jump_to_timeline_end` | Jump to Animation End | End | End | Animate | implemented |  |
| `timeline_frame_back` | Jump 1 Frame Back | , | , | Edit, Animate | implemented | One tick (1/20 s). In Edit mode only when an animation is open (bbmodel). Replaces the Studio's old tick-step keys (same keys). |
| `timeline_frame_forth` | Jump 1 Frame Forth | . | . | Edit, Animate | implemented |  |
| `add_marker` | Set Marker | Ctrl+M | ⌘M | Animate | implemented | Marker at the playhead (saved in .bbmodel animations; session-only for .animation.json). |
| `set_animation_end` | Set Animation End | Ctrl+End | ⌘End | Animate | implemented | Animation length = playhead time. |
| `screenshot_model` | Screenshot Model | Ctrl+P | ⌘P | Edit, Animate | viewport API | viewport API `screenshot()`. |
| `view_mode` | View Mode | Z | Z | Edit, Animate | viewport API | Cycles textured / solid / wireframe...: viewport API `cycleViewMode()` (falls back to the wireframe toggle). |
| `preview_checkerboard` | Checkerboard | T | T | Edit, Animate | viewport API | viewport API `toggleCheckerboard()`. |
| `pixel_grid` | Pixel Grid | G | G | Edit | viewport API | viewport API `togglePixelGrid()`. |
| `toggle_camera_projection` | Toggle Camera Projection | Num5 | Num5 / 5 | Edit, Animate | viewport API | Digit keys 1-9 share the numpad's key identity in Ace's dispatcher, so the top row works too. |
| `camera_initial` | Camera Angle: Initial | Num1 | Num1 / 1 | Edit, Animate | viewport API |  |
| `camera_top` | Camera Angle: Top | Num8 | Num8 / 8 | Edit, Animate | viewport API |  |
| `camera_bottom` | Camera Angle: Bottom | Num2 | Num2 / 2 | Edit, Animate | viewport API |  |
| `camera_south` | Camera Angle: South | Num4 | Num4 / 4 | Edit, Animate | viewport API |  |
| `camera_north` | Camera Angle: North | Num6 | Num6 / 6 | Edit, Animate | viewport API |  |
| `camera_east` | Camera Angle: East | Num7 | Num7 / 7 | Edit, Animate | viewport API |  |
| `camera_west` | Camera Angle: West | Num9 | Num9 / 9 | Edit, Animate | viewport API |  |
| `save_project` | Save Project | Ctrl+Alt+S | ⌘⌥S | Edit, Animate | implemented | Saves the document (same as Ace's ⌘S, which stays live inside the Studio). |

## Ace-only bindings (moved off Blockbench defaults)

| Blockbench id | Name | Blockbench default | Studio on macOS | Modes | Status | Behaviour |
|---|---|---|---|---|---|---|
| `ace.breakdown` | Pose Between Frames | - | ⌥B | Animate | Ace-only | Was ⇧E (Blockbench: extrude / armature bone). |
| `ace.paste_noise` | Paste with Noise… | - | ⌘⌥V | Animate | Ace-only | Was ⌥⇧V. |
| `ace.add_noise` | Add Noise to Selection… | - | ⌘⌥N | Animate | Ace-only | New default key. |
| `ace.frame_selected` | Frame Selected | - | ⌥F | Edit, Animate | Ace-only | Was F (Blockbench: Action Control). Viewport API `frame(selected)`. |

## Mouse and modifier behaviours

| Blockbench id | Name | Blockbench default | Studio on macOS | Modes | Status | Behaviour |
|---|---|---|---|---|---|---|
| `preview_select` | Select | LMB | LMB | Edit, Animate | viewport API | Ctrl = multi-select (toggle), Shift = group select, Alt = loop select. Viewport agent. |
| `preview_rotate` | Rotate View | LMB | LMB | Edit, Animate | viewport API | Orbit. Viewport agent. |
| `preview_drag` | Drag View | RMB | RMB | Edit, Animate | viewport API | Pan. Viewport agent. |
| `preview_zoom` | Drag-to-Zoom View | Shift+LMB | ⇧LMB | Edit, Animate | viewport API | Viewport agent. |
| `preview_scroll_zoom` | Zoom View | Wheel | Wheel | Edit, Animate | viewport API | Viewport agent. |
| `preview_area_select` | Area Select | Ctrl+[Shift]+LMB | ⌘[⇧]LMB | Edit, Animate | viewport API | Rectangle select, Shift adds. Viewport agent. |
| `timeline.scrub` | Scrub ruler | LMB (Ctrl = no snap) | LMB (⌘ = no snap) | Animate | implemented | Click / drag on the ruler. Snaps to ticks unless Ctrl or ⌘ is held. |
| `timeline.marker_drag` | Marker drag | LMB (Ctrl = no snap) | LMB (⌘ = no snap) | Animate | implemented | Snaps to ticks unless Ctrl / ⌘. |
| `timeline.hscroll` | Horizontal scroll | Shift+Wheel | ⇧Wheel | Animate | implemented |  |
| `timeline.zoom` | Zoom timeline | Ctrl+Wheel / pinch | ⌘Wheel / pinch | Animate | implemented |  |
| `timeline.vscroll` | Vertical scroll | Wheel | Wheel | Animate | implemented |  |
| `timeline.key_select` | Select keyframe | LMB (Shift = add) | LMB (⇧ = add) | Animate | implemented | Shift adds to the selection. |
| `timeline.key_drag` | Drag keyframes | LMB drag (Ctrl = stretch) | LMB drag (⌘ = stretch) | Animate | implemented | Moves selected keyframes; Ctrl / ⌘ stretches the group around its first key (Alt+Ctrl: around the midpoint); Alt alone duplicates (Studio extra). |
| `timeline.graph_drag` | Graph editor drag | LMB drag (Shift = one axis, Ctrl = snap) | LMB drag (⇧ = one axis, ⌘ = snap) | Animate | implemented | Shift constrains to time or value, Ctrl / ⌘ snaps time to ticks and value to 0.25. |
| `timeline.box_select` | Box select | LMB drag on empty (Shift = keep) | LMB drag on empty (⇧ = keep) | Animate | implemented | Shift keeps the previous selection. |

## Provided by the Ace host

| Blockbench id | Name | Blockbench default | Reason |
|---|---|---|---|
| `confirm` | Confirm | Enter | Dialogs, outliner rename and number fields handle Enter themselves. |
| `export_over` | Save Model | Ctrl+S | Ace host: Save All (⌘S), unchanged inside the Studio. |
| `open_model` | Open Model | Ctrl+O | Ace host: ⌘O is IntelliJ's Go to Class; files open from the Project tool window. |
| `close_project` | Close Project | Ctrl+W | Ace host: closes the Studio tab (⌘W). |
| `switch_tabs` | Switch Tabs | Ctrl+Tab | Ace host: editor tab switching. |
| `open_dev_tools` | Open Dev Tools | Ctrl+Shift+I | Ace host: not bound inside the Studio. |
| `fullscreen` | Fullscreen | F11 | Ace host: window handling. |

## Skipped

| Blockbench id | Name | Blockbench default | Reason |
|---|---|---|---|
| `create_collection` | Create Collection | Ctrl+L | Collections (named element sets stored in .bbmodel `collections`) are not implemented; they do not affect Bedrock output. |
| `move_uv_to_cursor` | Move UV to Cursor | Alt+U | Needs the full UV editor (cursor-based UV placement); the Studio has a numeric UV panel only. |
| `animation_controller_preview_mode` | Controller Preview | Space | Animation controllers (.animation_controllers.json) are not edited in the Studio. |
| `uv_editor_scroll_zoom` | Zoom UV/2D Editor | Ctrl+Wheel | UV editor zoom: the Studio has no zoomable UV editor. |
| `save_project_incremental` | Save Project With Increment | Shift+Alt+S | Incremental project saves do not exist in Ace; the file is saved in place. |
| `save_project_as` | Save Project As | Ctrl+Shift+Alt+S | No Save As for Studio documents (use the Project tool window to copy / rename files). |
| `open_from_link` | Open Model from Link... | Ctrl+S | Shares its key with Save Model in Blockbench; link import is not part of Ace. |
| `import_texture` | Import Texture | Ctrl+T | Texture management (import / create) belongs to Paint / texture mode; Ace resolves textures from the pack. |
| `create_texture` | Create Texture | Ctrl+Shift+T | Texture management: see import_texture. |
| `extrude_spline_selection` | Extrude Spline | Shift+E | Mesh / spline / armature editing: not available in Bedrock formats (parity doc section 5) |
| `create_face` | Create Face or Edge | Shift+F | Mesh / spline / armature editing: not available in Bedrock formats (parity doc section 5) |
| `extrude_mesh_selection` | Extrude Selection | Shift+E | Mesh / spline / armature editing: not available in Bedrock formats (parity doc section 5) |
| `inset_mesh_selection` | Inset Selection | Shift+I | Mesh / spline / armature editing: not available in Bedrock formats (parity doc section 5) |
| `merge_vertices` | Merge Vertices | Shift+M | Mesh / spline / armature editing: not available in Bedrock formats (parity doc section 5) |
| `loop_cut` | Loop Cut | Shift+R | Mesh / spline / armature editing: not available in Bedrock formats (parity doc section 5) |
| `add_armature_bone` | Add Armature Bone | Shift+E | Armature rigs are a Blockbench-side feature, not part of Bedrock geometry. |
| `paint_secondary_color` | Paint with Secondary Color | [Shift] | Paint mode only |
| `brush_tool` | Paint Brush | B | Paint mode only |
| `eraser` | Eraser | E | Paint mode only |
| `draw_shape_tool` | Draw Shape | U | Paint mode only |
| `gradient_tool` | Gradient Tool | U | Paint mode only |
| `selection_tool` | Selection Tool | M | Paint mode only |
| `move_layer_tool` | Move Layer | Shift+V | Paint mode only |
| `painting_grid` | painting_grid | G | Paint mode only |
| `swap_colors` | Swap Colors | X | Paint mode only |
| `animated_texture_editor` | Flipbook Editor... | ← | Animated textures (flipbook) are not part of Bedrock geometry / animation files. |
| `timeline.speed_slider` | Playback speed slider | Shift / Ctrl steps | The Studio uses a preset speed list (0.25x-2x) instead of a slider. |

## Commands without a default key

Reachable from Action Control (F), the outliner / timeline menus and Ace's Go to Action: flip animation X/Y/Z, mirror keyframes, bake animation, scale animation, set interpolation (linear / catmull-rom / bezier / step), bezier handle reset, snap keyframes to ticks, sort outliner, collapse / unfold groups, unlock all, toggle export / shade / auto UV / mirror UV, ungroup, delete marker.
