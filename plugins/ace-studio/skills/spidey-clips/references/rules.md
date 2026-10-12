# Spidey rules, tables and validator codes

Source of truth in code: `src/components/animstudio/core/spidey/validate.ts`, `clips.ts`, `trick.ts`; game doc: main Thematic-Collections checkout `docs/authoring-web-animations.md`; the Java is ported with citations in `core/spidey/game.ts`.

## Hinge (`swing_pivot` position Y at t=0)
`Y = (hinge_blocks - 0.9) * 16`.
| hinge (blocks) | Y px | clips |
| --- | --- | --- |
| 0.9 (default, chest) | 0 | everything not listed |
| 0.0 (soles) | -14.4 | web_climb |
| 1.3 (shoulders) | +6.4 | web_crawl, web_cling, web_wall_hold, web_hook |
| 0.15 | -12 | web_wall_run |
| 0.7 | -3.2 | web_perch_back |
Other reference points: hips about -6. The key may be animated (hinge moves during the clip), but the t=0 key must match the table.

## Tick lengths
| clip | ticks | seconds |
| --- | --- | --- |
| web_flip_front, web_flip_back, web_twist_left, web_twist_right | 14 | 0.7 |
| web_tuck | 10 | 0.5 |
| web_cartwheel_left/right | 14 | 0.7 |
| web_corkscrew_left/right, web_twist_dive_left/right | 18 | 0.9 |
| web_spin | >= 22 (the volley) | >= 1.1 |

## Clip classes
- LOOP: web_sling_right, web_sling_left, web_zip, web_air, web_slingshot, web_climb
- ONE-SHOT: web_shoot_right, web_shoot_left, web_spin, web_kickoff, plus tricks web_flip_front/back, web_twist_left/right
- POSE-ONLY (limb driver only, never broadcast): web_land, web_hook, web_hang, web_run, web_wall_run, web_perch_right/left/back, web_wall_slide_right/left, web_ceiling_crawl, web_ceiling_still
- GLIDE FLOURISHES: web_air_dive, web_air_spread, web_air_tuck
- TABLE TRICKS: web_tuck, web_cartwheel_*, web_corkscrew_*, web_twist_dive_*

## Whole-body spin (preview in the Studio; set in the pose set, never keyed)
BodyAttitude: rotation = Rx * Rz * Ry (rotateX, rotateZ, rotateY post-multiplied), body frame x right / y up / z behind. Hinge = the tucked body's live centre of mass (TrickHinge: head .08, trunk .46, arm .05, leg .18 over the five limbs' angles) PLUS the clip's swing_pivot Y offset, pinned where the first frame put it. Axes (pitch, yaw, roll signs): front_flip (-1,0,0), back_flip (+1,0,0), twist_left/right (0,+-1,0), cartwheel_left/right (0,0,+-1), corkscrew_* (+1,+-1,0), twist_dive_* (-1,+-1,0). Speed profiles, smoothstepped between knots: FLIP {0:0, .15:.35, .30:1.7, .65:1.7, .80:.7, 1:0}; TWIST (pure twists) {0:0, .10:.6, .20:1.5, .70:1.5, .85:.6, 1:0}. Runs over `spin.ticks` (else the clip length).

## Validator codes (`validate`)
error-level for clips named by the pose set (and their `_N` variants), or for every clip when the file is the web kit (>= 5 pose-set clips present, like WebSlingAnimationsJsonTest), or with `all_clips: true`:
`length-off-grid`, `off-grid`, `key-past-length`, `rotation-wrap`, `loop-open`, `no-swing-pivot`, `wrong-hinge`, `variant-length`, `variant-loop`, `variant-gap`, `trick-loops`, `trick-length`, `trick-body`, `playback-loop`, `playback-once`, `head-rest`, `arm-raised`, `spin-short`, `hold-upright`, `missing-clip`, `should-loop`, `should-play-once`. Warnings: `unknown-bone`, `opaque-channel`, `no-table-entry`, `pose-set`, `position-ignored` (fix: remove those keys), `trick-ends`, `flourish-ends` (advisory: the user may deliberately leave a clip's ends off `web_air`'s first frame).
Fixable via `apply_fix fix_id=...`: off-grid/length-off-grid (snap), loop-open (copy first key to end), no-swing-pivot, wrong-hinge, trick-ends/flourish-ends (copy `web_air` first frame).

## Game states -> clip (from poses/web.json `modes`, first match wins)
yielding(dodge) > spinning(web_spin) > hanging(web_hang) > striking > slingshot(web_slingshot) > landing(web_land) > wall_running(web_climb/web_cling) > wall_slide(web_wall_slide_right/left) > wall_crawl_run(web_wall_run) > wall_perch(web_perch_right/left/back) > wall_ceiling(web_ceiling_crawl/still) > wall_crawling(web_crawl/web_wall_hold) > line_on_ground(web_run) > line_hooked(web_hook) > line_zip(web_zip) > line_climbing(web_climb/web_cling) > line(web_sling_right/left) > shooting(web_shoot_right/left) > on_ground(web_run) > airborne(web_air). Always read the live file with `list_pose_sets`; it may differ.

## Timeline meaning
`web_sling_*`: gathers into an apex tuck as the arc slows (the tuck is physics, draw the swing). `web_air`: draw the spread-eagle; the dive fold is the fall's. `web_cling` is optional (falls back to web_climb's first frame).
