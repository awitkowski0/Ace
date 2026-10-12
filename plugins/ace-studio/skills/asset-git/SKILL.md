---
name: asset-git
description: >-
  Safely get the latest, switch branches, and save (commit/push) asset changes - models, animations, textures, poses, lang, sounds - in a Thematic/Minecraft project using the ace-studio git tools (asset_status, get_latest, switch_branch, save_assets_to_git, run_game). Use when an artist or animator asks to update, sync, branch, commit, push or test their asset work.
when_to_use: >-
  "get latest", "pull", "save my animation to git", "commit and push my assets", "new branch for my work", "am I behind", "run the game to test".
---

# Asset git (Asset Dev flow)

These tools mirror Ace's Asset Bar: plain-language, asset-only git for people who do not touch code. Prefer them over raw `git` for this workflow - they never use a bare `git stash`/`stash pop` (local changes are set aside in a uniquely tagged stash and put back by commit id) and they refuse code files.

## Safe order

1. `asset_status` - branch, ahead/behind, changed **assets** vs other (code) files, a suggested commit message. Show the user the short version.
2. `get_latest` before starting work, before `run_game`, and before saving if the branch is behind. It fetches, fast-forwards (rebasing unshared commits if needed), and restores local changes. On a conflict it aborts cleanly and tells the user to resolve it in Ace's Changes view - do not try to resolve conflicts yourself.
3. Work (see `thematic-animation`, `spidey-clips`); validate before saving.
4. `save_assets_to_git` - **publishing**. Procedure:
   a. Call it **without** `confirm` to get the PREVIEW (files, branch, whether it would push).
   b. Show the user the exact file list, the commit message and whether it pushes. **Ask them to confirm.** Only after an explicit yes, call again with `confirm: true`. Never set `confirm: true` on your own initiative, never infer consent from earlier instructions to "finish the task".
   c. Message: short, imperative, describing the asset ("Add web_wall_hold animation"); use the suggested one unless the user words it.
   d. `push: true` only if the user wants it shared; if the branch is behind, run `get_latest` first.
5. `switch_branch` to move between branches (local changes come along); `create: true` for a new branch - suggest `assets/<name>/<topic>`. Do not create or switch branches unprompted.
6. `run_game` starts the game through Ace (needs Ace running) to test an asset in game.

## Don'ts
- Do not commit code, configs or docs through this flow (the tool refuses non-assets); if the user also changed code, say so and leave it to them / the Developer flow.
- Do not run `git push --force`, `git reset --hard`, `git checkout -- .`, `git stash pop` or delete branches, and do not edit `.git`. If the situation needs them, explain and let the user decide.
- Do not touch other people's staged changes: the tool commits exactly the listed paths and leaves everything else as it was.
- Do not write into repositories the user did not point you at (files outside the allowed roots are refused).

If the tool says the network is unreachable or authentication failed, relay that plainly (check internet / GitHub sign-in) instead of retrying in a loop.
