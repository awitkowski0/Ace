# Animation Studio (Blockbench-class editor for .geo.json / .animation.json / .bbmodel)

Clicking a `*.geo.json`, `*.animation.json` or `*.bbmodel` opens **one editor** — the Studio — as an editable tab.
Same UI for all three; what changes is which panels have content (a geo alone = Model mode, an animation file =
Animate mode with a preview rig, a bbmodel = both). It must feel like part of Ace (Nord, 24px rows, 13px UI,
IntelliJ-style toolbars), not an embedded foreign app. Blockbench is the UX reference (outliner, viewport gizmos,
timeline/dope sheet, graph editor, onion skin) — re-implement, don't copy its GPL code.

Primary customer: Thematic-Collections (Minecraft Fabric, `~/IdeaProjects/Thematic-Collections` = the MAIN checkout, which
holds the Spider-Man work and is edited live by another session). Never write into those repos from tests: tests and QA read
temp copies (`webKitCopy()` in `core/testutil.ts`, the fixtures in `scripts/qa/animstudio.mjs`) and skip when the files are
missing; only the stale `-spidey` worktree's `git status` is compared before/after.

## Integration (decided)
- Registry: `.bbmodel` is already a `dual`; add `dual` providers with `suffix: ".geo.json"` and `".animation.json"`,
  id `animstudio`, `defaultMode: "preview"`, `previewLabel: "Studio"`. The `.bbmodel` provider switches to `animstudio` too
  (old BbmodelView stays as fallback code only).
- **Monaco owns the text.** The Studio is the dual preview pane. Every Studio edit is a command that produces new text
  and is applied to the Monaco model with `pushEditOperations` (one undo stop per command; drags coalesce into one
  stop on mouse-up). So ⌘S, dirty dot, close-confirm, Editor|Studio toggle and ⌘Z/⌘⇧Z come from the existing editor.
  When focus is in the Studio, ⌘Z/⌘⇧Z are routed to that model's undo/redo via `context:"editor"` actions whose
  `isEnabled` is true only while a Studio is the active controller (verify Monaco keeps ⌘Z otherwise; update
  monacoPolicy EXTERNAL_IMPLEMENTED/audit test if needed).
- Text→Studio: parse on text change (textBus, debounced). Studio keeps selection/camera/playhead across re-parses
  (match by bone name / animation name / keyframe time).
- Code lives in `src/components/animstudio/` (owned by this module). Shared-file touches: `editor/viewers/registry.ts`
  (providers), `editor/viewers/ViewerHost.tsx` (lazy import), `src/modules.ts` (register line), `src/qa/harness.ts`
  (`anim` hook line), `docs/SPEC.md` ownership line. No Rust needed.

## Format layer (`animstudio/format/`) — pure TS, unit-tested against real files
Facts from Thematic (src/, excluding build copies: 1338 geo, 267 animation files, 4+3 bbmodels):
- **geo**: format_version "1.12.0" (2× "1.21.0"). One `minecraft:geometry` entry; description = identifier,
  texture_width/height, visible_bounds_*. Bones: name, parent, pivot, rotation, cubes. Cubes: origin, size, uv,
  pivot+rotation, inflate, mirror. uv is per-face `{north:{uv,uv_size}}` (negative uv_size = flipped) or box-uv `[u,v]`.
  Zero-thickness cubes exist (`size:[0,24,24]`). Bedrock coords: Y-up, 1/16 block, origin = min corner, absolute pivots,
  rotation order Bedrock (apply like Blockbench: ZYX, X/Y negated vs three.js — verify against bbmodel loader).
- **animation**: format_version "1.8.0"; optional top keys `geckolib_format_version`/`azurelib_format_version`/`AzureLib_format_version`
  (preserve). Per animation: loop (true | false | "hold_on_last_frame" | absent), animation_length, bones,
  override_previous_animation, sound_effects, `_comment`. Names may be `animation.x.y` or bare.
  Channel shapes (all must parse AND re-emit in the same shape unless edited): keyframe map `{"0.0": v}`; constant array;
  bare `{"vector":[..]}`; single keyframe object with easing; string arrays like `["linear","linear","linear"]`
  (treat as opaque, preserve); scalar number (scale). Keyframe value shapes: array, `{vector}`, `{vector,easing}`,
  `{vector,easing,easingArgs}`, `{post,lerp_mode}`, `{pre,post,lerp_mode}`, `{pre,post}`. lerp_mode catmullrom|linear.
  Easings: the GeckoLib set (linear, step, easeIn/Out/InOut × Sine/Quad/Cubic/Quart/Quint/Expo/Circ/Back/Elastic/Bounce), with easingArgs.
  Vector components may be molang strings: none in Thematic today, but parse numbers-or-string and evaluate a small
  molang subset (numbers, + - * /, math.sin/cos/abs/clamp/lerp, query.anim_time, query.life_time) for preview.
  Keys are strings; whole seconds written "0.0", else minimal decimals ("0.0833", "4.5833").
- **bbmodel** (format 4.x/5.0, model_format azure_model/bedrock/modded_entity): elements (cubes; meshes counted+skipped
  in viewport but preserved), outliner, groups, textures (embedded data URLs), `animations[]` with Blockbench animators
  (`animators[uuid].keyframes[] {channel, data_points[{x,y,z}], time, interpolation, bezier_*}`). Edit animations
  and bones; preserve every unknown key.
- **Faithful save**: only touched subtrees are re-serialized. Detect per file: minified vs pretty, indent (2/4/tab),
  trailing newline, key order. Emit numbers minimally (no `1.0000001`; round to 4 dp for times, 3–4 dp for values,
  integers bare). A no-op open→save must be byte-identical — test this on EVERY Thematic geo/animation file
  (read-only, from the vitest test, skipped if the repo path is absent).
- Sampling (`sample(anim, bone, channel, t)`): Bedrock/GeckoLib semantics — linear/step/catmullrom (needs neighbours),
  pre/post, easing applies to the segment ending at the eased key (GeckoLib rule), hold_on_last_frame, loop wrap.
  Files under `assets/<ns>/animations/armor/` use the player/armor reader's rules instead (`core/playersample.ts`: earlier-key easing, tick-floored times, no scale, shortest-way rotation); `clipSemantics(path)` picks, the timeline chip overrides.

## Studio UI (`animstudio/ui/`)
Layout (resizable, remembers per user): toolbar · left **Outliner** (bones tree, cubes, visibility/lock eye toggles,
search) · center **Viewport** · right **Properties** (bone pivot/rotation, cube origin/size/inflate/uv, keyframe
value/easing/lerp) · bottom **Timeline**. Modes in toolbar: **Edit** (geometry) | **Animate** | **Pose**.
- Viewport (three.js via existing `scene3d.ts` pattern, render-on-demand, animate loop only while playing/dragging):
  textured cubes (nearest filter), bone pivots, selection outline, transform gizmo with Blockbench tool keys (V move, S resize/scale, R rotate, P pivot) active only while the
  Studio has focus (context-gated so they never reach Monaco), local/global space,
  snapping (1px / 1px-at-0.25 with ⇧ / 22.5° with ⇧), grid, wireframe, X-ray, front/side/top/persp views
  (numpad-free: toolbar), frame selected (F), ground plane, Minecraft player scale reference.
- Edit mode layout (Blockbench Edit): left sidebar **UV editor** (top) + **Textures** (below), right sidebar **Element** fields above the **Outliner**, tool row above the viewport, mode tabs in the top bar; Animate / Pose keep Animations + Keyframe left, Outliner + bone fields right. Panel sizes are remembered per mode (`animstudio.h.<mode>` ...). UV editor: drag face rectangles / box-UV islands / resize handles (pixel snapping, Shift 0.25, Cmd 0.1), zoom (Cmd+wheel) and pan (wheel, RMB drag), face tabs, mirror / rotate / box-UV toggle; edits are core commands, one undo stop per drag. Textures: .bbmodel = real `textures[]` (embedded data URLs) + per-face `texture`; geo = preview layers (default + `<stem>_*.png` variants, stackable, persisted in Ace app data per file; the game renders one texture). Multi-select exactly like Blockbench (ui/selection.ts, tests in selection.test.ts): Cmd toggles, Shift range-selects, groups select their children, viewport Cmd/Shift click + Cmd-drag area; transforms, Properties (mixed values blank), UV editor, delete / duplicate / copy-paste act on the whole selection.
- Edit mode: add/delete/duplicate/rename/reparent bones (drag in outliner), add/move/resize cubes, inflate, mirror,
  box-uv/per-face UV view (simple UV panel with the texture), texture assignment.
- Animate mode: animation list (add/rename/duplicate/delete, loop, length), **Timeline** with dope sheet (rows per
  bone × channel, diamonds, box-select, drag to retime with 0.05s snap = 1 tick, ⌥-drag duplicate, copy/paste,
  delete), **Graph editor** tab (curves per axis, drag values, easing preview), playhead scrub, play/pause (Space),
  loop toggle, speed (0.25–2×), FPS/tick ruler (seconds + ticks @20tps), auto-key toggle (gizmo edits create keys at
  playhead), **onion skin** (prev/next N frames, ghost meshes), keyframe property editor (vector, easing+args, lerp,
  pre/post split).
- **Pose between frames (Breakdown)**: pick two frames A and B (default: keys around the playhead; or two selected
  keyframes; or any two times typed in). Slider 0–1 (allow −0.5..1.5 overshoot) shows a live blended pose; rotations
  blended via quaternion slerp converted back to euler nearest the previous key (no wrap jumps), positions/scales lerp;
  optional "follow curve" (use the easing between A and B instead of linear). Applies to selected bones (default all
  animated). Commit = insert keys at playhead (or at a chosen time). Also "Push to neighbours"/"Relax" (exaggerate or
  soften current key relative to A/B) like Blender's pose breakdowner. Shortcut + toolbar button.
- **Copy with noise**: copy selected keys (or a time range), then "Paste with noise…" dialog: paste count (repeat
  N times, every Δt or at playhead), per-channel amplitude (rotation °, position px, scale %), per-axis enable,
  noise type (smooth Perlin over time / random per key), frequency, seed (+ re-roll button, live preview before
  commit), keep first/last key exact (so loops stay seamless), apply to other bones (mirror L↔R option: swap
  armorLeft*↔armorRight*, flip yaw/roll). Also "Add noise to selection" in place. Deterministic for a given seed.
- Model/rig resolution for previews: for `geo/<kind>/X.geo.json` look for `animations/<kind>/X.animation.json` and
  `textures/<kind>/X.png` by walking up to the `assets/<ns>/` root. Armor animation files are a shared clip library
  (not name-paired) → preview on a built-in **Player rig** (armorHead/Body/RightArm/LeftArm/RightLeg/LeftLeg, Steve
  proportions, model scale 0.9375) with a "Preview model…" picker (any geo; remembered per file in `.ace/`
  workspace state, not in the repo). Bone aliases bipedX ↔ armorX resolved for display.

## Spidey-aware mode (Thematic web/pose clips)
Turned on automatically when the animation file is under `animations/armor/` and a `poses/*.json` exists in the
same pack tree. Pose-set JSON: `{default, modes[{mode, when, clip, right, left, cling, starts_with, ticks}], clips{name:{role,
timeline, playback: loop|one_shot|stride|whole, aimed[], mirrored, spin{axis,turns,ticks}}}}`; keys starting `_` ignored.
The game side is a port with file:line citations in `core/spidey/game.ts` (pinned by `game.test.ts`); the Java is read-only
reference in the main checkout (`src/common/java/bond/thematic/api/content/pose/**`, `animation/AnimationApplier.java`,
`core/data/gson/GeckoLibSerializer.java`, `content/movement/CrawlGait.java`, `docs/authoring-web-animations.md`).

**Axes.** There is no extra axis conversion between a file and the game: `GeckoLibSerializer` negates X/Y of head/torso on load
(`:294-299`) and `AnimationApplier` negates them back (`:52-56`), so ModelPart rotation = file rotation (radians) for every bone;
positions get Y flipped (`:288-293`) and are added to the part's pivot. The renderer shows a ModelPart through `scale(-1,-1,1)`,
i.e. BODY frame (x right, y up, z BEHIND) = (-x,-y,z) for rotation and position - exactly Ace's Blockbench scene map (x = -file x,
rotations (-x,-y,z) ZYX, positions (-x,+y,+z)). So the normal view and "As game applies" show the same limb transforms; what
"As game applies" changes is *which* channels the game reads and the code-driven parts below.

**Three playback kinds** (label in every Animations row, badges on the selected one; derived from the pose set's `playback`, not names):
1. *plays as drawn* - `playback: whole` (flips, twists, cartwheels, corkscrews, tuck, glide flourishes) and ability clips that are not
   in the pose set: the animation system plays rotations AND positions, the limb driver stays out.
2. *pose-set clip* - loop / one_shot: rotations as drawn, `aimed` limbs' pitch + yaw replaced by live aim (roll stays the clip's),
   `swing_pivot` Y = the height the whole model turns about (lean, bank, flips). Positions: clips an ability also broadcasts keep them
   (ordinary playback, `LimbDriver.java:91,629`); pose-only clips ignore them; **only the wall crawl** (`web_crawl`, `web_ceiling_crawl` and
   their holds `web_wall_hold`, `web_ceiling_still`) plays drawn rotations AND the four limbs' positions timed to the stride
   (`LimbDriver.java:990-1002,1627-1664`; head/body positions still ignored).
3. *stride clip* - walked by distance, one clip per stride: the crawl clips by `CrawlGait.stride(pace)` = max(0.5 + 2.5 pace, 4 pace) blocks
   (`CrawlGait.java:109`), `web_run` / `web_climb` / `web_wall_run` by vanilla's walk cycle (`LimbDriver.java:892`).
Other uses: the slingshot's hard launch plays `web_flip_front` (`TrickInput.java:277`).

- Bones the limb driver reads: rotation of armorHead, armorRightArm, armorLeftArm, armorRightLeg, armorLeftLeg; `swing_pivot` position Y.
  Pose-only clips dim every other channel (positions: "ignored in game"); broadcast and drawn clips dim nothing. Aimed limbs: the
  rotation row reads "roll" in the dope sheet, X/Y are greyed in the inspector and faint in the graph, and the rotate gizmo only
  offers roll (tooltip: "Code-driven pitch/yaw").
- **Limb preview** ("As game applies", state `asGameApplies`): mirrored clips previewed L<->R swapped; limbs with no channel ghosted
  (procedural); position keys of pose-only clips dropped (warning `position-ignored`, quick-fix "Remove ignored position keys");
  **Live aim** chip: aimed limbs point at a draggable web-anchor marker (pitch/yaw = `LimbDriver.aimFrom` + shoulder range, roll = clip's).
- **Spin preview**: whole body turns per the clip's `spin` over `spin.ticks` (else the clip length) about the hinge the game uses: the
  tucked body's live centre of mass (`TrickHinge`, limbs only) PLUS the clip's `swing_pivot` Y offset (`TetherClient.java:2455-2470`), pinned
  where the first frame put it (`BodyAttitudeRenderer.java:44-52`). Rotation = Rx*Rz*Ry (`BodyAttitude.java:158`), angular speed =
  smoothstepped FLIP / TWIST profiles (`:301-331`). Lean / bank / the live-physics tuck are not previewable (untilted body).
- **Stride pace**: in Animate mode a stride clip shows a *Pace* slider (blocks/s) in the timeline header; play walks the phase by
  distance (`phase += dist / strideBlocks(speed)`), the walked distance is shown. Scrubbing still works.
- **Live validators** (Problems strip in the Studio + gutter marks in timeline), mirroring WebSlingAnimationsJsonTest field by field
  (`javaparity.test.ts` runs a port of the Java test on the real file and compares): key times on 0.05s (`off-grid`,
  `length-off-grid`, `key-past-length`); loops end on their first key (`loop-open`); no >180° step (`rotation-wrap`); every clip has `swing_pivot` with a t=0
  key and the expected hinge (web_climb -14.4; web_crawl/web_cling/web_wall_hold/web_hook +6.4; web_wall_run -12; web_perch_back -3.2; else 0);
  table tricks (web_tuck 10, web_cartwheel_* 14, web_corkscrew_*/web_twist_dive_* 18 ticks) ...; glide flourishes; variants; every
  clip named in the pose set exists; unknown bone names warn. In the web kit file (>= 5 pose-set clips present) EVERY clip is checked like the Java test does;
  in other files only the clips a pose set names. Quick-fixes where obvious ("Snap keys to ticks", "Copy web_air first frame to start/end",
  "Add swing_pivot key", "Remove ignored position keys").
- **Anchor mode** (from tools/blockbench/thematic_anchor.js): moving one key shifts every key of that bone+channel by
  the same delta.
- Draw-upright hint for perch/cling clips (doc rule).

## Feel, perf, tests
- Must open the largest Thematic geo in < 300 ms parse and 60 fps orbit; idle = no rAF.
- Keys: Blockbench v5.2.2 defaults (⌘ for Ctrl) while a Studio pane has focus: single data table `ui/keymap.ts`, generated `docs/STUDIO-KEYMAP.md`
  (Space/Home/End/Q/F3/⌘M..., V S R P, arrows, F2, ⌘G...). Ace-only features moved off collisions: ⌥B pose-between-frames, ⌘⌥V paste with noise, ⌘⌥N add noise, ⌥F frame selected.
- Unit tests: format round-trip on all Thematic files (byte-identical), sampler vs hand-computed GeckoLib values,
  breakdown/noise determinism, validators against a read-only temp copy of the main checkout's `web_sling.animation.json` (errors must equal what the Java test would fail on: `javaparity.test.ts`).
- QA harness: `__qa.anim()` hooks; suite `scripts/qa/animstudio.mjs` with fixtures written to a scratch dir (open geo,
  animation, bbmodel; scrub; add key; breakdown; noise paste; ⌘S writes fixture; ⌘Z restores). Never the real keyboard.

## Claude integration: MCP server + skills (plugin)
- **`ace-studio` MCP server** (`tools/ace-mcp/`, Node stdio, bundled to one JS file from `src/components/animstudio/core`
  + profiles' pure asset helpers, no app needed). Tools (file-based, work on local paths; every write goes through core
  commands so files stay byte-faithful, and returns a short diff summary):
  - discover: `list_assets` (by kind/search), `describe_model` (bones/cubes tree), `describe_animation` (clips, length,
    loop, bones×channels, key times), `find_preview_model`, `list_pose_sets`, `clip_info`.
  - inspect: `sample_pose(file, anim, t)`, `get_keys`, `validate` (spidey + generic problems with fix ids).
  - edit animations: `add_animation`, `duplicate_animation`, `set_loop/length`, `set_keys` (bulk upsert), `delete_keys`,
    `move_keys` (anchor mode option), `set_easing`, `breakdown` (pose between frames → insert keys), `push_relax`,
    `paste_with_noise` / `add_noise` (seeded; returns seed), `mirror_clip`, `snap_to_ticks`, `apply_fix`.
  - edit geo: `add_bone`, `set_bone`, `reparent_bone`, `add_cube`, `set_cube`, `delete_*`.
  - `dry_run: true` on every write returns the would-be diff without writing.
- **Live bridge (when Ace is running):** extra tools `studio_open(file, anim?, t?)`, `studio_state` (open file,
  selection, playhead), `studio_screenshot` (viewport PNG, optionally a strip of N frames), `studio_set_time/select`.
  Ace exposes a per-user local socket (not the QA automation socket); edits made via MCP while the file is open in
  Ace go through the Studio (Monaco undo stack) instead of disk so ⌘Z undoes Claude's edit.
- **Asset git tools** (Asset Dev parity): `asset_status`, `get_latest`, `save_assets_to_git(message, files, push)`,
  `switch_branch`, `run_game` (via Ace when running). Writes that publish (commit/push) require the skill to confirm with
  the user first.
- **Skills** (Claude Code plugin `ace-studio`: `.claude-plugin/plugin.json`, `.mcp.json`, `skills/*/SKILL.md`):
  `thematic-animation` (formats, bone names, tick grid, easing semantics, how to animate with the tools, preview loop:
  edit → validate → screenshot), `spidey-clips` (pose sets, driver-read channels, hinge table, trick/flourish rules,
  draw upright, mirrored right-handed authoring), `asset-git` (safe get-latest/commit flow for asset devs).
  Installed via a local marketplace; Claude sessions launched from Ace get it automatically.
