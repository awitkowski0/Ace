---
name: thematic-animation
description: >-
  Create and edit Minecraft Bedrock/GeckoLib animation and model assets (.animation.json, .geo.json, .bbmodel) for Thematic-Collections with the ace-studio MCP tools - add clips, set/move/ease keyframes, breakdown poses, paste with noise, mirror L/R, validate, and screenshot the result in Ace's Animation Studio. Use for any request to animate, pose, retime, loop, mirror, humanize or fix animation/geo files.
when_to_use: >-
  "make a new idle/swing/pose clip", "add keyframes", "ease this", "fix the loop", "mirror the left arm version", "add noise so it looks organic", "is this animation valid", editing any *.animation.json / *.geo.json.
---

# Animating with the ace-studio tools

Edit animation/geo files through the **ace-studio MCP tools**, never by hand-editing the JSON text: the tools go through the Studio's document core, so only the touched keys change and the file stays byte-faithful (indent, key order, `"0.0"` time spelling).

## The loop (always)

1. **Look.** `describe_animation` (clip list) -> `describe_animation anim=<clip>` (bones x channels, key times) or `get_keys` / `sample_pose t=...`. For models `describe_model`. If the user means "what I have open", call `studio_state` (live Ace only).
2. **Plan in poses, not numbers.** Decide the key poses and their times first (see "Timing"), then write them.
3. **Edit with `dry_run: true` first.** Every write tool takes `dry_run`; it returns a compact diff + a key-count delta and writes nothing. Read the diff; then repeat the call without `dry_run`.
4. **Validate.** `validate file=<f> anim=<clip>`. Fix errors (use `apply_fix` with the `fix_id` when offered); warnings are judgment calls.
5. **Look at it** if Ace is running (the `studio_*` tools exist): `studio_open file=... anim=...` then `studio_screenshot frames=6` (a left-to-right strip over the whole clip) or `t=<s>` for one pose. Judge silhouette, arm/leg symmetry, whether the motion reads; adjust and re-shoot. Without Ace, use `sample_pose` at key times and reason from numbers; say that you could not view it.
6. Report: what changed (clip, keys), validation result, and anything you could not check. Edits made while the file is open in Ace land in the editor buffer, unsaved - tell the user to save (or that Cmd+Z undoes them).

Do not commit or push unless asked; for that use the `asset-git` skill. Armor clips for the Spider-Man web kit also need `spidey-clips`.

## Units and grid (get these right)

- Times are **seconds**. The game runs **20 ticks/s**: put every key and `animation_length` on **0.05 s** multiples (0.05, 0.10, ... 0.25 ...). Off-grid times are truncated to a tick in game, so a 0.22 key plays as 0.20. `snap_to_ticks` repairs a clip.
- Rotation = **degrees** (Euler [x, y, z]; x = pitch, y = yaw, z = roll). Position = **px** (1 px = 1/16 block). Scale = multiplier (1 = normal).
- Do not let consecutive rotation keys jump by more than 180 deg on an axis (it spins the long way): use 350 -> 370, not 350 -> 10.
- `loop: true` cycles: the last key (at `animation_length`) must equal the first key (t=0) for every bone/channel that has 2+ keys. `loop: false` plays once; `"hold_on_last_frame"` freezes at the end.
- Durations: a snappy beat is 2-4 ticks (0.10-0.20 s), a normal move 6-12 ticks, a full cycle 16-40 ticks.

## Easing semantics (two readers)

Thematic reads `.animation.json` through two different readers, and the easing rule differs. Ace picks the rule from the file path (`sample_pose` and the Studio show which one; the Studio timeline chip lets you switch):
- **Geo / GeckoLib** (guns, items, entity and suit geo models; the default): the easing written on key N shapes the **segment that ENDS at key N**. To ease *out of* a pose, put the easing on the next key.
- **Player / armor** (files under `assets/<ns>/animations/armor/`, read by `GeckoLibSerializer` for the player clip path): the easing on key N shapes the segment **LEAVING** key N (the earlier key), the reverse of the rule above. Key times floor to whole ticks, scale is not read, `lerp_mode: catmullrom` becomes linear for rotation and inOutSine for position, `easingArgs` are ignored, rotation takes the shortest way round, and a looping clip is `animation_length` + 1 tick long. Blockbench/GeckoLib ease names (`easeInOutSine`, `linear`, ...) work on both paths (case-insensitive; unknown names become linear). The Studio chip lists what the player reader ignores (scale channels, non-numeric components).
- The rest of this section describes the geo rule.
- Names: `linear`, `step` (easing_args[0] steps, default 2), and `easeIn|easeOut|easeInOut` + `Sine|Quad|Cubic|Quart|Quint|Expo|Circ|Back|Elastic|Bounce`. `lerp: catmullrom` makes a smooth spline through neighbouring keys (needs a key on each side). Unknown names silently become linear.
- A pose that *holds* needs two identical keys. A channel with a single key at t=0 is a constant.
- Typical: anticipation -> `easeInOutSine`/`easeInQuad`; fast hit -> `easeOutCubic`; settle -> `easeOutBack` (args = overshoot); loops -> `easeInOutSine` on every key keeps seams smooth.

## Timing and feel

- Anticipation (small opposite move, 2-3 ticks) -> action (fast) -> follow-through/overshoot (2-4 ticks) -> settle. Offset limbs by 1-2 ticks (overlap) instead of moving everything on the same key.
- Use `breakdown` to build the in-between pose of two key poses (factor 0.5 = halfway; 1.2 overshoots) and insert it at a time in between; `push_relax` exaggerates (>0) or softens (<0) an existing pose against its neighbours.
- Organic repeats: `paste_with_noise` (copy a window, paste N times with seeded smooth noise; `keep_ends: true` keeps loops seamless) or `add_noise` in place. Note the returned `seed` so the user can reproduce or re-roll.
- Left/right versions: author the right-hand version and `mirror_clip` it (swaps Left<->Right bones, negates yaw/roll and X position). Do not re-key by hand.

## Rig quick facts

Player/armor rig bones: `armorHead`, `armorBody`, `armorRightArm`, `armorLeftArm`, `armorRightLeg`, `armorLeftLeg` (aliases `bipedHead` ... map to the same), plus the non-rendering `swing_pivot` (position Y only, see `spidey-clips`). Right = -X side. Pivots (px, Y up): head/body (0,24,0), arms (+-5,22,0), legs (+-1.9,12,0). Rotate limbs about their pivot; position channels move the whole part and are rarely needed for armor clips. Full format/rig/tool reference: [references/reference.md](references/reference.md).

## Tool recipes

- New clip: `add_animation` (name, length, loop) -> `set_keys` with one entry per bone/channel/time -> `snap_to_ticks` if unsure -> `validate`.
- Retime: `move_keys` (select bone/time window, `delta`), or `anchor: true` to shift a whole bone+channel.
- Smooth a section: `set_easing` with `select: {bone, from, to}`.
- Variant: `duplicate_animation name=web_air new_name=web_air_1` (variants keep the base's length and loop).
- Geometry: `describe_model`, then `add_bone`/`set_bone`/`add_cube`/`set_cube` (Bedrock coords, Y up, absolute pivots, origin = min corner).

If a tool errors, read the message: it names the available clips/bones. Never write outside the allowed roots; files outside are refused.
