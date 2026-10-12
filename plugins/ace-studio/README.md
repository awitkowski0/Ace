# ace-studio (Claude Code plugin for Ace)

MCP server + skills for Ace's Animation Studio and Asset Dev flow.

- **MCP server `ace-studio`** (`server/ace-mcp.mjs`, a single bundled Node file built from `tools/ace-mcp/` + the Studio core): ~40 tools to read/edit `.geo.json` / `.animation.json` / `.bbmodel` byte-faithfully (all writes support `dry_run` and return a compact diff), validate Thematic spidey clips, and run asset git flows. When Ace is running it also exposes `studio_open`, `studio_state`, `studio_screenshot`, `studio_set_time`, `studio_select`, and edits to files that are open in Ace go into the editor buffer (undoable) instead of disk.
- **Skills**: `thematic-animation`, `spidey-clips`, `asset-git`.

## Safety
The server only touches paths under its allowed roots: `--root <dir>` args, `ACE_MCP_ROOTS` (colon separated), default = the directory Claude was started in. `save_assets_to_git` refuses unless `confirm: true`, which the skill tells Claude to set only after asking you.

## Sessions started from Ace
Claude sessions launched from Ace (AI Sessions view, or `claude` typed in an Ace terminal) are started with `--plugin-dir plugins/ace-studio`, so the plugin is active there with nothing installed. (Local sessions only; see "mc" below.)

## Install for all your Claude Code sessions (optional, manual)
Nothing in `~/.claude` is changed unless you run these:

```sh
claude plugin validate /Users/alexw/IdeaProjects/Ace/plugins
claude plugin marketplace add /Users/alexw/IdeaProjects/Ace/plugins
claude plugin install ace-studio@ace-local
# update after rebuilding the server:
claude plugin update ace-studio@ace-local   # or /reload-plugins inside a session
```

Try without installing: `claude --plugin-dir /Users/alexw/IdeaProjects/Ace/plugins/ace-studio`.

Remove: `claude plugin uninstall ace-studio@ace-local && claude plugin marketplace remove ace-local`.

## mc (remote host)
Not wired: the bundle (`plugins/ace-studio`) would have to exist on mc and `node` would have to be on mc's login PATH. To use it there, copy the directory (`rsync -a plugins/ace-studio mc:~/ace-studio-plugin`) and start Claude with `claude --plugin-dir ~/ace-studio-plugin`; the live bridge tools are unavailable on mc (the socket is local to your Mac).

## Rebuild
`pnpm build:mcp` (bundles `tools/ace-mcp/src/index.ts` with esbuild into `tools/ace-mcp/dist/ace-mcp.mjs` and copies it to `plugins/ace-studio/server/ace-mcp.mjs`). Tests: `pnpm vitest run tools/ace-mcp`.

## Live bridge
Ace listens on `$TMPDIR/ace-studio-<uid>.sock` (mode 0600, JSON lines; override with `ACE_STUDIO_SOCK`). This is separate from the QA automation socket. Ops: `ping`, `file_text`, `apply_text`, `open`, `state`, `screenshot`, `set_time`, `select`, `run_game`. The MCP server checks every few seconds and shows/hides the `studio_*` tools accordingly.
