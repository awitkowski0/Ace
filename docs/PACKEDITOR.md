# Pack editor

A designer view for the files that make up a content pack, laid out like a scene editor: the file's structure on the left
(**Scene**), the thing itself in the middle, the selected part's properties on the right (**Inspector**). It is the
"Designer" half of the file's tab (Editor | Editor and Designer | Designer); Asset Dev opens these files in Designer.

The file stays the source of truth. Every designer change is an ordinary text edit of the open file (one undo step per
change, a drag is one step), visible in the code pane and the diff, saved with ⌘S like any edit. Every change made to the
text any other way, by typing, a script, a refactor or a bulk edit across many files, shows in the designer at once. Fine
tuning in the designer and broad changes in text mix freely.

| File | Opens as | What you can do |
|---|---|---|
| `data/<ns>/armors/**.json` | Suit | Model with every place the kit renders from (beams, visuals, projectiles, flight jets). Tier, flight setup, keybinds. Each ability's beam for this suit (`assets.beam`): colours, sizes, count, opacity, first/third-person offset; drag the offset in 3D. |
| `data/<ns>/abilities/**.js` | Ability | Where each render leaves the body (`from:`): point, bone, offset, relative; drag on a preview suit. Its command console (pages, desktop windows, widgets, theme), laid out like the game draws it: drag/resize windows, recolour the theme. Its radial wheel. |
| `data/<ns>/huds/*.js\|json` | HUD | Screen at a GUI scale with every element where `HudLayout` puts it (sample values). Drag to move, arrows nudge, add/delete Text, Bar, Image; anchors re-anchor in place. |
| `data/<ns>/flight_profiles/*.json` | Flight | Jets with their flames on a preview suit; anchor, when, aim, flame settings; inherited jets from `parent`. |
| `assets/<ns>/guide/<book>/<lang>/(entries\|categories)/**.json` | Guide | Pages in order with a page preview in the guide markup; every field of the page type (`GuideSchema`); retype, reorder, add, delete pages. |

Placement follows the game's own code: `AnchorsClient.bonePose` (render points), `FlightJets.OFFSETS` (jets),
`HudLayout.anchorX/anchorY` (HUD), `UiTokens.of` (console theme), `GuideMarkup.parse` (guide text). A suit's model is
`assets/<ns>/geo/armor/<id>.geo.json` (+ `textures/armor/<id>.png`), found in any resource root of the project.

Where a move leaves the body belongs to the ability script and is shared by every suit with that ability; a suit's own
render settings are its `assets`. The suit view says which is which and opens the ability for the shared part.

Code: `src/components/packeditor/` — `core/` is pure (JS builder-call scanner with in-place edits, anchors, HUD, console,
suit, guide models; unit tested), `ui/` the views. QA: `scripts/qa/packeditor.mjs`.
