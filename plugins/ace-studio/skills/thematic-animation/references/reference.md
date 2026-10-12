# ace-studio reference

## File formats
- **geo** (`*.geo.json`): `format_version` "1.12.0"; one `minecraft:geometry` entry: `description` (identifier, texture_width/height, visible_bounds_*), `bones[]` {name, parent, pivot, rotation, cubes[]}. Cube: origin (min corner), size, uv (box `[u,v]` or per-face `{north:{uv,uv_size}}`, negative uv_size = flipped), pivot+rotation, inflate, mirror. Zero-thickness cubes exist. Coordinates: Y up, 1/16 block, absolute pivots.
- **animation** (`*.animation.json`): `format_version` "1.8.0" (+ optional geckolib/azurelib version keys, preserved). Per clip: `loop` (true | false | "hold_on_last_frame" | absent), `animation_length`, `bones`, `override_previous_animation`, `sound_effects`. Names are `animation.x.y` or bare (Thematic armor: bare, e.g. `web_air`).
- Channel shapes the tools read and re-emit unchanged unless edited: keyframe map `{"0.0": [x,y,z]}`, constant array `[x,y,z]`, bare `{"vector":[..]}`, single keyframe object with easing, scalar (scale), opaque string arrays (kept, not previewed). Key values: array, `{vector}`, `{vector,easing}`, `{vector,easing,easingArgs}`, `{post,lerp_mode}`, `{pre,post,lerp_mode}`. Vector components may be molang strings.
- Key spelling: whole seconds "0.0", else minimal decimals ("0.0833", "4.5833").
- **bbmodel**: Blockbench project; animation edits work (keyframes become animator keyframes); geometry editing is limited to renaming groups. Unknown keys are preserved.

## Sampling rules (what `sample_pose` and the viewport do)
- Geo rule (default): key i defines the segment from key i-1 to key i; the first key holds its value from t=0. Easing/easingArgs on key i apply to the segment ending at i.
- Player rule (files under `assets/<ns>/animations/armor/`, Thematic's `GeckoLibSerializer` + `KeyframeAnimationPlayer`; `sample_pose` picks it from the path): the easing on key i shapes the segment LEAVING i; times floor to ticks; scale is ignored; catmullrom = linear (rotation) / inOutSine (position); easingArgs ignored; shortest-way rotation; before the first key the value eases from rest (0) with inOutSine; a loop lasts animation_length + 1 tick and the last key blends toward the first; ease names are the usual Blockbench ones (case-insensitive, unknown = linear), same as geo.
- `{pre, post}`: pre is the value just before the key (a hard step when pre != post); `lerp_mode` acts as that key's easing.
- Loop: `loop:true` wraps t modulo length; otherwise clamps at the end.
- Molang subset: numbers, + - * /, math.sin/cos/abs/clamp/lerp, query.anim_time, query.life_time.

## Tools (ace-studio MCP)
Read: `list_assets`, `describe_model`, `describe_animation`, `find_preview_model`, `list_pose_sets`, `clip_info`, `sample_pose`, `get_keys`, `validate`.
Animation edits: `add_animation`, `duplicate_animation`, `rename_animation`, `delete_animation`, `set_loop`, `set_length`, `set_keys`, `delete_keys`, `move_keys`, `set_easing`, `breakdown`, `push_relax`, `paste_with_noise`, `add_noise`, `mirror_clip`, `snap_to_ticks`, `apply_fix`.
Geo edits: `add_bone`, `set_bone`, `rename_bone`, `reparent_bone`, `delete_bone`, `add_cube`, `set_cube`, `delete_cube`.
Asset git: `asset_status`, `get_latest`, `save_assets_to_git` (needs confirm), `switch_branch`, `run_game`.
Live (Ace running only): `studio_open`, `studio_state`, `studio_screenshot`, `studio_set_time`, `studio_select`.

Key selection for delete/move/ease/noise: `keys: [{bone, channel, time}]` or `select: {bone|bones, channel|channels, from, to}` (`{}` = all keys of the clip).

## Validation codes
Generic (warnings outside pose-set clips, errors inside): `off-grid`, `length-off-grid`, `key-past-length`, `rotation-wrap` (>180 deg step), `unknown-bone`, `opaque-channel`, `loop-open`. Spidey/pose-set codes are listed in the spidey-clips skill.

## Edit routing
If the file is open in Ace, tools read the live editor buffer and apply the change to it (one undo step, unsaved); otherwise they read/write the file on disk atomically. Output always says which.
