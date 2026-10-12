---
name: spidey-clips
description: >-
  Author and validate the Spider-Man web clips in Thematic-Collections (armor animation files such as web_sling.animation.json) with the ace-studio tools - which bones the limb driver reads, the swing_pivot hinge table, trick and glide-flourish rules, variants, pose-set playback kinds, right-handed authoring with mirroring, and draw-upright perch/cling clips. Use whenever a clip under animations/armor/ or poses/web.json is created or changed.
when_to_use: >-
  web_sling, web_air, web_flip_*, web_twist_*, web_climb, web_cling, web_wall_hold, web_perch_*, swing_pivot, pose set, "spidey animation", tricks/flourishes, clip variants _1/_2, "the game rejects my clip".
---

# Spidey web clips

Applies to `.../assets/<ns>/animations/armor/*.animation.json` when a `poses/*.json` exists in the same source tree (main Thematic-Collections checkout: `src/common/resources/assets/thematic/animations/armor/web_sling.animation.json`, pose set `src/packs/heroes/resources/assets/thematic/poses/web.json`). The `ace-studio` validators encode the game's own `WebSlingAnimationsJsonTest`, so a clean `validate` means the test passes. Work with the `thematic-animation` loop (describe -> dry_run -> apply -> validate -> screenshot); this skill adds the rules.

Start every task with `clip_info file=... anim=<clip>` (role, playback kind, game states that use it, mirrored, aimed limbs, spin) and `list_pose_sets`. The pose set (`poses/web.json`: `modes[]` = which clip for which game state; `clips{}` = role/timeline/playback/aimed/mirrored/spin) is the source of truth for what a clip is for.

## What the game actually reads

- Only these rotations drive posing: `armorHead`, `armorRightArm`, `armorLeftArm`, `armorRightLeg`, `armorLeftLeg` - plus `swing_pivot` **position Y** (the hinge: the height the whole model turns about for lean, bank and flips). Everything else (position/scale channels, `armorBody` in pose-only clips) is ignored by the pose pass and only applies through playerAnimator playback for clips an ability broadcasts. **Exception: the wall crawl** (`web_crawl`, `web_ceiling_crawl` and their holds `web_wall_hold`, `web_ceiling_still`) plays drawn rotations AND the four limbs' position keys, timed to the stride. Position keys on any other pose-only clip are ignored in game (validator `position-ignored`, fix "Remove ignored position keys"). `describe_animation anim=` marks channels "not read by the limb driver".
- **A limb you key is a limb you own**: a limb with rotation keys is posed from them; a limb without a channel falls back to code (procedural). Delete a limb's channel to hand it back.
- **Aimed limbs** (`aimed` in the pose set, e.g. the web hand): pitch and yaw are overridden in game (they point at the anchor); only **roll** survives. Draw the arm anyway so the rig reads, but do not rely on its pitch/yaw.
- **Right-handed authoring**: clips with `mirrored: true` (web_climb, web_cling, web_hook, web_run, web_land ...) are drawn with the web in the **right** hand; the game generates the left version by swapping sides and flipping yaw and roll. Only draw those once. For clips that exist as explicit `_right`/`_left` pairs (web_sling_*, web_shoot_*, perch, wall_slide) build the left one with `mirror_clip` from the right one, then re-validate.
- Playback kinds (pose-set `playback`): **loop** (own length/rate, draw a cycle), **one_shot** (walked across the move; file length is a drawing aid), **stride** (one whole stride walked by DISTANCE - the crawl clips by the CrawlGait stride, run/climb/wall_run by vanilla's walk cycle; draw a cycle that ends where it began), **whole** (flips/twists: plays as drawn, no procedural pass). In Ace's labels: *plays as drawn* = whole + ability clips outside the pose set; *pose-set clip*; *stride clip*.
- A hard slingshot launch plays `web_flip_front` itself.

## Rules the validator enforces (details: [references/rules.md](references/rules.md))

1. **Tick grid**: every key time and `animation_length` on 0.05 s. `snap_to_ticks` fixes.
2. **Hinge (`swing_pivot`)**: every clip needs a `swing_pivot` position key at t=0 whose Y gives the right hinge: `hinge = 0.9 + Y/16` blocks above the feet. Default 0 (chest). Table: `web_climb` Y -14.4 (soles); `web_crawl`, `web_cling`, `web_wall_hold`, `web_hook` +6.4 (shoulders); `web_wall_run` -12; `web_perch_back` -3.2; everything else 0. Variants use their base. Missing/wrong -> `no-swing-pivot`/`wrong-hinge` (have `fix_id`s).
3. **Tricks** (flips/twists/cartwheels...): play once (`loop: false`), exact length in ticks - `web_flip_front|back`, `web_twist_left|right` **14**; `web_tuck` **10**; `web_cartwheel_left|right` **14**; `web_corkscrew_*`, `web_twist_dive_*` **18**. Table tricks (`web_tuck`, cartwheel, corkscrew, twist_dive) must NOT have an `armorBody` channel (the whole-body spin owns the trunk), must key every limb and the head at t=0 and at the end, ideally with limbs matching `web_air`'s first frame and `armorHead` (0,0,0) (a warning, not a rule: keep the user's own poses if they differ). The spin itself (rotateX, rotateZ, rotateY post-multiplied, about the tucked body's centre of mass plus the clip's `swing_pivot` offset) comes from the pose set's `spin`, not the clip - never animate the whole body's rotation yourself.
4. **Glide flourishes** `web_air_dive|spread|tuck`: play once, and usually start and end on `web_air`'s first frame (a warning only: never overwrite the user's own end poses to force a join); ease in over ~0.2 s, hold, ease back.
5. **Loops/one-shots**: `web_sling_right/left`, `web_zip`, `web_air`, `web_slingshot`, `web_climb` loop; `web_shoot_*`, `web_spin`, `web_kickoff`, flips/twists play once. A looping clip needs keys at 0 and at the length with equal values (`loop-open`). `web_spin` must be >= 22 ticks.
6. **Head rest**: in loop clips `armorHead` stays (0,0,0) (the head is counter-pitched procedurally).
7. **Arm raised**: `web_sling_right` right arm, `web_sling_left` left arm, `web_zip` both arms: pitch below -120 at t=0.
8. **Variants**: copy a clip as `<base>_1`, `_2` ... (consecutive from 1; the game stops at the first gap), **same length and same loop** as the base. Use `duplicate_animation`.
9. **Draw upright**: perch/cling/`web_wall_hold` are drawn upright (feet on the wall, head up it) - the game rotates the whole model toward the look direction. `web_wall_hold`: arms pitch below -120 and roll < 15; legs pitch within +-30 and roll < 25. Never author sideways/head-down versions.
10. Every clip named in the pose set must exist in the file (`missing-clip`); the `web` kit expects a fixed list of clips.

## Workflow for a new/changed clip

1. `clip_info` + `describe_animation anim=<similar clip>` to copy conventions; duplicate the nearest existing clip rather than starting from zero when one exists.
2. Edit with `set_keys`/`breakdown`/`set_easing` (dry_run first). Keep `swing_pivot` position key at t=0 and the hinge from the table.
3. `validate file=... anim=<clip>` (add `all_clips: true` to be strict); apply fixes; re-run until 0 errors. Run a final whole-file `validate` - variants and pose-set cross-checks live there.
4. If Ace is running: `studio_open` the file and clip, then `studio_screenshot frames=6`; check the silhouette, that aimed arms look sane (their pitch/yaw are overridden in game) and that loops close. Mirrored clips look swapped in game: the Studio's "As game applies" toggle (user-side; with "Live aim" for aimed limbs and a Pace slider for stride clips) shows that; the screenshot shows the clip as drawn.
5. If the clip is new, the pose set / ability script must reference it (`poses/web.json` `modes` and `clips`; `abilities/.../web_sling.js` `tether({clips})`). Those are data files outside this tool's scope: tell the user which entry to add, do not guess.
