# Animation Studio core (pure TS)

No React, no three.js. Import from `./core` (`index.ts`). Everything is immutable and synchronous.

## Document model
```ts
import { parseDoc, serialize, minimalEdit, docKindForPath, getAnimations, getGeo, getBb } from "./core";
let doc = parseDoc(monacoText, docKindForPath(path)!);   // "geo" | "animation" | "bbmodel"
doc = addKeyframe(doc, { anim, bone, channel: "rotation", time: 0.5 });  // every command: (doc, args) => newDoc (pure; throws on bad names)
const text = serialize(doc);                              // untouched subtrees are byte-identical to the original text
const edit = minimalEdit(monacoText, text);               // {start,end,text}: apply as ONE pushEditOperations => one undo stop
```
Re-parse (`parseDoc`) when Monaco's text changes; typed views (`getAnimations(doc)`, `getGeo(doc)`, `getBb(doc)`) are memoised per doc.
`serialize` keeps minified/pretty, indent, newline, key order, and lays out edited containers in the style of the container they replace
(inline `[0, 0, 0]` vs one-per-line, `{vector,easing}` multi-line…). Numbers: integers bare, 4 dp (geo 5 dp), times `"0.0"`/`"0.0833"`.

Typed views: `Animation {name, loop, length?, bones: Map<bone, {rotation?,position?,scale?: Channel}>}`,
`Channel {shape: keys|array|vector|scalar|opaque, keys: Keyframe[]}`, `Keyframe {time, value:[Comp×3], pre?, easing?, easingArgs?, lerp?}`
(`Comp` = number or molang string). bbmodel animations are converted to the same model (`getAnimations` works for all kinds).
Geo: `getGeo(doc).geometries[i].bones[].cubes[]`; bbmodel: `getBb(doc)` (elements, group tree, textures, animations).

## Commands (doc.ts)
- Keys: `addKeyframe`, `insertKeys`, `deleteKeyframes`, `moveKeyframes({delta, anchor})`, `retimeKeyframe`, `patchKeyframes`,
  `setKeyValue`, `setKeyEasing`, `setKeyLerp`, `setKeyPrePost`, `snapKeysToTicks`, `insertPoseKeys`. Keys are addressed by `KeyRef {bone, channel, time}`.
- Animations: `addAnimation`, `renameAnimation`, `deleteAnimation`, `duplicateAnimation`, `setLoop`, `setLength`, `renameAnimBone`, `deleteAnimBone`.
- Geo: `addBone`, `deleteBone({cascade})`, `renameBone`, `reparentBone`, `setBone`, `addCube`, `deleteCube`, `moveCube`, `resizeCube`, `setCube`,
  `setPivot`, `setRotation`, `setInflate`, `setMirror`, `setUv` (bone when no `index`, else cube). bbmodel geometry (core/bbedit.ts, file-space like ui/model.ts rigFromBb): `addBbGroup`, `deleteBbGroup`, `reparentBbGroup`, `setBbGroup`, `addBbCube`, `deleteBbCube`, `setBbCube`, `moveBbCube`, `renameBbGroup`, `sortBbOutliner`, `sortGeoBones`.
- UV (core/uv.ts, pure): `boxUvRects`, `boxUvIsland`, `cubeFaceRects`, `uvSnapStep`/`snapDelta`, `moveRect`/`resizeRect`/`flipRect*`, `applyUvDrag(base, drag, dx, dy)`, `flipUv`, `boxToFaces`/`facesToBox`.
- Textures (core/textures.ts): bbmodel `addBbTexture`, `removeBbTexture`, `setBbTexture`, `setBbFaceTexture`, `bbTextureInfos`; per-face `setBbFaces` / `setBbBoxUv` (bbedit.ts); PNG helpers; geo preview layers `discoverVariants` / `mergeGeoTextures` (state persisted by the UI in app data).
- Animation tools (core/animtools.ts): `setKeyInterpolation`, `setBezierHandles`, `bakeAnimation`, `scaleAnimation`, `flipAnimation`, `mirrorKeys`, markers (`addMarker`/`moveMarker`/`setMarker`/`deleteMarker`/`getMarkers`, bbmodel only).
- Animation commands also work on bbmodel docs (keyframes become Blockbench `animators[].keyframes[]`).

## Sampling / tools
- `sampleChannel(anim, bone, channel, t)`, `samplePose(anim, t)` (GeckoLib semantics, see header of sample.ts; docs under `animations/armor/` use the player rules of playersample.ts, chosen by `parseDoc(text, kind, clipSemantics(path))` and stamped on each Animation as `anim.semantics`; `t` is wrapped by loop mode unless `{wrap:false}`),
  `evalMolang`, `applyEasing`, `EASING_NAMES`.
- `breakdown(doc, anim, {bones, tA, tB, factor, followCurve})` → `Pose`; `pushRelax(doc, anim, {t, amount})`; commit with `insertPoseKeys` / `insertBreakdown`.
- `copyKeys` → `Clipboard`; `previewPasteWithNoise(clip, opts)` (live preview) / `pasteWithNoise(doc, anim, clip, opts)`; `addNoise(keys, opts)` / `applyNoise(doc, anim, refs, opts)`.
- `PLAYER_RIG`, `playerRigGeometry()`, `canonicalBone` (bipedX↔armorX), `transformPoint`; `spinPreview(anim, spin, time, clipLength)` (game-exact whole-body spin: hinge = TrickHinge centre of mass + `swing_pivot`, Rx*Rz*Ry, smoothstepped profiles), `trickAngle`, `centreOfMass` (geometry helper).

## Spidey mode (spidey/)
```ts
if (isArmorAnimationPath(path)) {
  const found = await findPoseSets(path, { listDir, readFile });      // FsLike; searches the same src tree
  const sets = found.map((f) => f.set);
  const problems = validateSpidey(doc, sets);       // {severity, code, anim, bone?, channel?, time?, message, fix?: {title, apply(doc)=>Doc}}
  const info = clipInfos(getAnimations(doc), sets); // role/playback/usedByStates/mirrored/aimed/spin/poseOnly per clip
}
```
Validators only raise errors for clips named by a pose set (and their `_N` variants); generic checks (tick grid, >180° steps, unknown bones) on other clips are warnings.
`channelUse(info, bone, channel)` tells the UI what the game does with a channel (dim / aimed pitch+yaw / tooltip); `isChannelDriverRead` is the limb driver's own set.
`spidey/game.ts` is the port of the game code (file:line citations): file -> ModelPart -> body-frame conversion, `playbackKind` (drawn / pose / stride), `positionUse`, `crawlClipNames`, stride gaits (`crawlStrideBlocks`, `walkStrideBlocks`, `stridePhase`), spin math (`TRICK_AXES`, `trickAngle`, `trickRotation`, `trickCentre`, `spinFrame`) and live aim (`aimAngles` = `LimbDriver.aimFrom`). `ClipInfo` carries `kind`, `kindLabel`, `positions`, `strideGait`, `extraUses`.
Warnings: `position-ignored` (fix: remove those keys).

Tests: `pnpm vitest run src/components/animstudio` (the real-file suites skip when the Thematic repos are absent).
