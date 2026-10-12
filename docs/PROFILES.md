# Profiles (Developer / Asset Dev)

A profile decides what Ace shows. Switch from the main toolbar's project widget menu, Settings > Profile, and
Find Action ("Switch Profile"). The choice is per user (app data, not the repo), with an optional per-project default
in `.ace/config.json` (`"profile": "asset"`), so a project can tell new teammates "open me as Asset Dev".

## Developer (default)
Today's Ace, unchanged. Nothing may regress for this profile.

## Asset Dev
For people making models/animations/textures who don't touch code. Clean, almost single-purpose:
- **Tool windows**: only Assets (project tree, filtered), Changes (asset-only commit), Run (game console). Hidden:
  terminal, Gradle, Python, Godot, Claude sessions, daemons, remote files, LSP problems, structure, debugger. Their
  shortcuts are inert (actions report "not available in Asset Dev"), not merely hidden.
- **Assets tree**: shows asset roots only (`**/assets/**`: geo, animations, textures, models, sounds, poses, lang, particles,
  `sounds.json`; `*.bbmodel` / `*.geo.bbmodel` anywhere; `data/<ns>/anim_controllers/**` and `data/<ns>/poses/**`, which asset devs
  edit even though they live under `data/`). Groups by kind (Armor / Items / Entities / Blocks), then flat groups for Sounds, Language,
  Poses, Particles, Animation controllers and Data files, and "Other" for the rest; thumbnails/kind icons; search box on top;
  "New animation", "New model from template", "New suit…", "Duplicate as…" in the context menu. Code files are not listed.
  Project-specific additions and exclusions: the `assets` section of `.ace/config.json` (below).
- **Editor**: opening a model/animation goes straight to the Studio (docs/ANIMSTUDIO.md), with the Editor|Studio text toggle hidden.
  JSON for lang/poses opens in a simple editor. Main toolbar simplified (no run-config dropdown, no VCS widget clutter).
- **Asset Bar** (big, labelled buttons in the main toolbar):
  1. **Get latest** — fetch + pull the current branch (rebase/ff-only); if local asset changes, autostash with a
     unique tagged stash and re-apply (never bare `git stash`); conflict → friendly dialog: keep mine / take theirs per file.
  2. **Branch ▾** — searchable list of local+remote branches; switching with changes offers "bring my changes" or
     "commit first"; "New branch for my work" (prefix `assets/<user>/`).
  3. **Save to Git (Commit)** — dialog listing ONLY changed asset files (code changes are shown greyed and excluded,
     with a warning), thumbnails, required message with a suggested one ("Add web_wall_hold animation"),
     checkbox "Push now" (default on). Commit uses git user config; push sets upstream. Optional "Open pull request"
     via `gh` when installed.
  4. **Run Game ▶ ▾** — runs the project's game task (Thematic: the Gradle client run task, discovered
     from the Gradle module; configurable in `.ace/config.json` `assetRun`), shows a slim console with a Stop button,
     and a status chip (building / running / crashed). Reuse the Gradle/run modules; don't duplicate daemon logic.
     The ▾ menu lists every client task the project offers (`assetRun.choices`, else the pinned `gradle.pinned` client tasks, parked
     ones last) with the one in use ticked; picking one is remembered per user, per project and per Minecraft version of the
     branch. "Automatic" (the default) follows the branch: `v1.20.1` / `v1.20.1-wolverine` run `:1.20.1:fabricRunClient`.
  5. **Status chip** — branch name, ↑/↓ commits ahead/behind, "N unsaved assets".
  6. **"Not on the latest" notice** — background quiet `git fetch` (on open, on window focus, every ~5 min while
     focused; never while unfocused). When the branch is behind its remote, show a non-blocking banner
     ("There's a newer version of <branch> — 3 updates from Sam. [Get latest] [Later]"), badge the Get latest button,
     and ask again before Run Game and Save to Git (Get latest & continue / Continue anyway). "Later" snoozes until
     the next new remote commit.
- **Version branches** (Thematic: `v1.20.1`, `v1.20.1-wolverine`): the "newer version" notice compares with the branch the
  work was started from (`assets.baseBranch`) instead of `origin/main`, and "New branch for my work" can use a project prefix
  (`assets.branchPrefix`, default `assets/<you>/`).
- **New suit…** (tree context menu): creates the model (armor rig), animation and texture (+ `_shiny`) for a suit in the project's
  suit folders (`assets.suitRoot`, else the assets/<ns> with the most `geo/armor` models). The texture is a copy of the selected
  suit's (or any suit's) to repaint. Opens the model in the Studio.
- Models, animations and `.bbmodel` files from the tree open straight in the Studio (docs/ANIMSTUDIO.md).
- Plain language everywhere (no "rebase", "HEAD", "upstream" in UI copy).

## Project settings for Asset Dev (`.ace/config.json`)
All optional; a malformed entry is ignored. A project that has none still works (built-in rules above). The file never sets the
profile for anybody unless it has `"profile": "asset"` (leave that out for repos the owner also develops in).
```jsonc
{
  "version": 1,
  "gradle": { "pinned": [ { "task": ":1.20.1:fabricRunClient", "name": "1.20.1 Fabric" }, ... ] },   // Run Game falls back to these
  "assetRun": {                                  // all optional
    "task": ":1.20.1:fabricRunClient", "args": "",   // ONE fixed task (disables version matching; the menu pick still wins)
    "choices": [ { "task": ":a:run", "name": "A", "args": "--offline", "branch": "^alpha" } ],  // replaces the pinned list in the menu
    "default": ":a:run"                          // when no choice's `branch` regex and no version in the branch name match
  },
  "assets": {
    "include": [ "tools/art/**/*.psd", { "glob": "**/data/*/blocks/**", "type": "data", "kind": "block" } ],  // extra files shown in the tree
    "hide": [ "**/assets/*/models/block/**", "cleaned_sounds/**" ],    // still assets (Save to Git includes them) but not listed
    "suitRoot": "src/packs/heroes/resources/assets/thematic",           // where "New suit…" writes (assets/<namespace> folder)
    "baseBranch": { "branch": "^(v\\d+(?:\\.\\d+)+)(?:-.+)?$", "base": "origin/$1" },  // branch -> the branch it was started from (array allowed)
    "branchPrefix": "{base}-{user}-"             // "New branch for my work" prefix; {user} = you, {base} = base branch without origin/
  }
}
```
- Globs are gitignore-like: `**` crosses folders, `*`/`?` stay in one; a pattern without `/` matches a name anywhere. Paths are
  project-relative. `include` `type` is one of model, animation, texture, sound, lang, pose, particle, controller, data (default:
  what the folders say, else data); `kind` is armor, item, entity or block. `build/`, `.gradle/`, `run/` and similar folders are never assets.
- Run Game order: the user's menu pick > `assetRun.task` > a choice whose `branch` matches > `assetRun.default` > the pinned task for the
  Minecraft version in the branch name (Fabric preferred, parked never automatic) > first non-parked Fabric pinned task > `versions/targets.json` > `runClient`.

## Implementation notes
- `src/components/profiles/` owns: profile store (`useProfile()`, `getProfile()`, `onProfileChange`), the Asset Bar,
  the asset tree, the asset commit dialog, the switcher UI. Shared touch points must be small, marked hooks:
  `toolwindows/registry.ts` (a `visibleIn?: Profile[]` filter / `isToolWindowAllowed(id)`), `actions/registry.ts`
  (`profiles?` gate), `App.tsx` toolbar slot. Prefer a central allowlist in profiles/ over editing every module.
- Git: reuse `src-tauri/src/git.rs` commands; add missing ones (pull --ff-only/rebase, push -u, branch list/switch,
  stash with message) inside git's own block, following CONVENTIONS.
- Asset rules/classification: `assets.ts` (pure; `assetConfig.ts` feeds it the repo config), Run Game choice logic: `gate.ts` (`pickClientTask`,
  `runOptions`, `branchVersion`). The base branch reaches Rust as the optional `base` argument of `git_incoming`.
- Tests: `assets.test.ts`, `thematic.test.ts` (a synthetic Thematic-shaped tree), `gate.test.ts`; `scripts/qa/assetmode.mjs` (tree, Run Game menu,
  version branches, New suit, Studio on a synthetic Thematic-like repo). Unit tests for asset-file classification and profile gating; QA suite `scripts/qa/profiles.mjs` against a
  scratch git repo with a bare remote (commit/push/pull/branch switch). Never run git write ops on real repos in tests.
