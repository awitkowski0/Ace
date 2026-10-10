# Terminal (Ghostty feature parity on xterm.js)

The Terminal tool window (⌥F12) is xterm.js + `portable-pty`. This document lists what it takes from Ghostty, the key table,
how the pieces fit together and what is deliberately not possible. Ghostty itself (`/Applications/Ghostty.app`, MIT) was the
checklist: `ghostty +show-config --default --docs` and `ghostty +list-keybinds --default`.

## Keys

All Terminal actions are registered with `context: {toolWindow: "terminal"}`: the keys below apply **only while a terminal
(tool window or quick terminal) has focus** and beat editor/global IntelliJ keys there. Everything else in the IntelliJ keymap
keeps working from the terminal (⌘1, ⌥F12, ⇧⎋, double-⇧, ⌘E, ⌘⇧A, ...). ⎋ is sent to the shell (IntelliJ behaviour); ⇧⎋ hides the tool window.
Every action is listed in Find Action (⌘⇧A) as `Terminal: <name>`.

| Keys | Action | Ghostty equivalent |
|---|---|---|
| ⌘T | New tab (inherits the focused shell's cwd, local or ssh host) | new_tab |
| ⌘W | Close split, or the tab when it is the last split (asks first if a process is running) | close_surface |
| ⌥⌘W | Close tab | close_tab |
| ⇧⌘] / ⇧⌘[ | Next / previous tab | next_tab / previous_tab |
| ⌥⇧⌘→ / ⌥⇧⌘← | Move tab right / left | move_tab (unbound in Ghostty) |
| ⇧⌘T | Reopen the last closed tab (or split) with new shells in their cwds (5 min window) | undo |
| (Find Action) | Rename Tab; also double-click a tab; Go to Tab 1-8 / last (⌘1-9 stay IntelliJ tool-window keys) | goto_tab |
| ⌘D / ⇧⌘D | Split right / down (inherits cwd and font size) | new_split |
| ⌘] / ⌘[ | Focus next / previous split | goto_split:next/previous |
| ⌥⌘←→↑↓ | Focus split by direction | goto_split:left/... |
| ⌃⌘= | Equalize splits (also double-click a divider) | equalize_splits |
| ⌃⌘←→↑↓ | Resize split by 10 px (also drag a divider) | resize_split |
| ⇧⌘↩ | Zoom / unzoom the focused split | toggle_split_zoom |
| ⌘F | Find in scrollback (bar with match count, case, regex); ↩ / ⇧↩ next / previous; ⎋ closes | start_search |
| ⌘G / ⇧⌘G | Find next / previous | search:next / previous |
| ⌘K | Clear screen and scrollback | clear_screen |
| ⌘C / ⌘V / ⌘A | Copy selection / paste (with paste protection) / select all | copy / paste / select_all |
| ⌘↑ ⇧⌘↑ / ⌘↓ ⇧⌘↓ | Jump to previous / next shell prompt (needs shell integration) | jump_to_prompt |
| (Find Action) | Select / Copy Last Command Output | write_screen_file (partial) |
| ⌘Home / ⌘End / ⌘PgUp / ⌘PgDn | Scroll to top / bottom / page up / page down | scroll_to_* |
| ⌘= (⌘+) / ⌘- / ⌘0 | Font size larger / smaller / reset, **per terminal** | increase/decrease/reset_font_size |
| ⌘← / ⌘→ / ⌘⌫ | Line start / end / delete line (sends ^A / ^E / ^U) | text:\x01 ... |
| ⌥← / ⌥→ | Word back / forward (ESC b / ESC f) | esc:b / esc:f |
| ⌘, | Terminal Settings | open_config |
| ⇧⌘, | Reload Ghostty config | reload_config |
| ⇧⌘P | Command palette (opens Find Action) | toggle_command_palette |
| (Find Action) | Toggle Quick Terminal, Select Theme, Reset Terminal, Toggle Secure Keyboard Entry, Toggle Copy on Select | toggle_quick_terminal ... |

Not bound on purpose because IntelliJ owns them: ⌘1-9 (tool windows), ⌃⇥ / ⌃⇧⇥ (Switcher), ⌃⌘F (full screen), ⌘N, ⌘Q.

## What is implemented

- **Splits and tabs**: binary split tree per tab, dividers draggable, geometry-based directional focus, zoom, equalize, key resize, close, undo close.
  New tabs/splits inherit the cwd the shell reports through OSC 7 (local and `ssh mc`); without OSC 7 the foreground process cwd is read
  from the OS (`pty_cwd`, `proc_pidinfo`). Tab titles come from OSC 0/2, rename wins. Bell shows a dot on background tabs.
- **Shell integration** (Ghostty-style, never edits dotfiles): zsh gets a private `ZDOTDIR` (`$TMPDIR/atelier-shell-integration-v1-<uid>/zsh`) whose
  `.zshenv` restores the user's ZDOTDIR and sources their real files, then hooks `precmd`/`preexec`/`chpwd`. bash is started with `--rcfile` pointing at a
  wrapper that emulates the login profile read-only (`/etc/profile`, `~/.bash_profile`...) and adds the hooks. Emits OSC 7 (cwd), OSC 133 A/B/C/D
  (prompt, input, output start, exit status) and OSC 2 (title). Remote: for `ssh <host>` whose login shell is bash, the wrapper is passed as
  `bash --rcfile <(printf %s <base64> | base64 -d) -i`: a pipe, **no file is written on the remote host**. Other remote shells get their plain login shell.
  Setting `shellIntegration` turns it off. Limitation: prompt frameworks that reassign `PS1` after our hook can drop the marks (we re-add them on every prompt).
- **Search** via `@xterm/addon-search` with highlighted matches (all matches + active one) and result counts.
- **Links**: OSC 8 hyperlinks, URL detection (`@xterm/addon-web-links`), and file paths (`src/foo.ts:12:3`, `res://a/b.gd:40`, Python tracebacks).
  ⌘-click opens URLs in the browser (tauri-plugin-opener) and files in Atelier's editor at line:col, resolved against the shell's cwd
  (`res://` against the project root). Only paths that exist are underlined (stat is cached).
- **Clipboard**: copy-on-select (Ghostty default on), OSC 52 write (`clipboard-write = allow`), OSC 52 read (`clipboard-read`: deny by default, `ask` shows a dialog,
  `allow`), paste protection (`clipboard-paste-protection`: multi-line text when bracketed paste is off, any text containing control characters or `ESC[201~`
  asks first) and bracketed paste. Clipboard access goes through Rust (NSPasteboard) because WebKit refuses writes that are not tied to a user gesture.
- **Rendering / protocol**: WebGL renderer (lazy, dropped for hidden tabs, DOM fallback on context loss), Unicode 11 widths, true color, synchronized output (DEC 2026, built into xterm 6),
  sixel and iTerm2 (OSC 1337) inline images via `@xterm/addon-image` (loaded only when the first image sequence arrives), OSC 9 / OSC 777 desktop notifications
  (only while Atelier is not the focused app), visual bell + tab badge.
- **Appearance**: theme picker over Ghostty's 400+ bundled themes, read at runtime from `/Applications/Ghostty.app/.../themes` (plus `~/.config/ghostty/themes`);
  `light:X,dark:Y` pairs follow the system appearance; default is the IDE's Nord. Font family/size, line height, cursor style/blink, padding, scrollback,
  option-as-alt, mouse-hide-while-typing, confirm-close-surface, quick terminal size/autohide.
- **Settings**: `⌘,` or the ⚙ in the tool window header. Stored in `localStorage` (`atelier.terminal.settings`). Layers: defaults, then `~/.config/ghostty/config` /
  `~/Library/Application Support/com.mitchellh.ghostty/config` if present (read-only; keys: theme, font-family, font-size, adjust-cell-height, cursor-style,
  cursor-style-blink, scrollback-limit, window-padding-x/y, macos-option-as-alt, copy-on-select, mouse-hide-while-typing, confirm-close-surface, clipboard-read/write,
  clipboard-paste-protection, shell-integration, desktop-notifications, bell-features, quick-terminal-size/autohide, palette, background, foreground, cursor-color,
  cursor-text, selection-background/foreground), then Atelier's own choices. "Reload Ghostty Config" re-reads it.
- **Quick terminal**: action `Terminal: Toggle Quick Terminal` (unbound; no global OS hotkey) drops a shell down over the window; it keeps its shell between toggles,
  hides when focus leaves it (setting), and its keys behave like any terminal.
- **Secure keyboard entry**: `Terminal: Toggle Secure Keyboard Entry` (Carbon `EnableSecureEventInput`).
- **Confirm close**: closing a split/tab with a running command asks first (OSC 133 state, or the pty's foreground process group for local shells).

## Not possible / not done

- **GPU-native renderer**: Ghostty renders with Metal; xterm.js with WebGL inside WKWebView is the closest available.
- **Kitty graphics protocol**, **Kitty keyboard protocol** and **ligatures**: not supported by xterm.js / WKWebView (the ligatures addon needs the Local Font Access API).
- **Global OS hotkey** for the quick terminal and a **real macOS window per terminal / native tabs of terminals**: out of scope (Atelier's windows are projects).
- **Keyboard selection adjust** (`adjust_selection`), `write_screen_file`, the inspector, background opacity/blur, `window-*` options, custom `keybind =` lines from a Ghostty config:
  not implemented.
- **Click-to-move cursor at the prompt** (optional in the brief): not implemented.
- Confirm-close covers closing a split or tab, not quitting the whole window.
- Remote shell integration needs bash on the remote host (true for `mc`).

## Code map

- Rust: `src-tauri/src/pty.rs` (spawn, shell integration, `pty_busy`, `pty_cwd`), `src-tauri/src/shell_integration/*` (scripts, `include_str!`), `src-tauri/src/termext.rs` (Ghostty themes/config, clipboard, secure input).
- Frontend (`src/components/terminal/`): `pane.ts` (one xterm + pty), `sessions.ts` (tabs/splits/undo/quick model), `splitTree.ts` (pure tree, tested),
  `TerminalPanel.tsx`, `SearchBar.tsx`, `QuickTerminal.tsx`, `TerminalSettings.tsx` (settings + theme picker), `register.tsx` (tool window + actions),
  `settings.ts`, `ghosttyConfig.ts`, `themes.ts`, `links.ts`, `clipboard.ts`, `notify.ts`, `qa.ts` (test hooks).
- Tests: `pnpm test` (split tree, config/theme parsing, link detection), `cargo test` (integration emits OSC 7/133 in real zsh/bash, remote command writes no files),
  `node scripts/qa/terminal.mjs` (end-to-end through the automation harness), `node scripts/qa/termperf.mjs` (memory + keystroke latency).
