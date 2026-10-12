# Ace shell integration for zsh (OSC 7 cwd, OSC 133 prompt marks, OSC 2 titles).
# Loaded from a private ZDOTDIR; the user's own dotfiles are never touched.
if [[ -o interactive && -n "$ACE_SHELL_INTEGRATION" && -z "$__ace_loaded" ]]; then
  typeset -g __ace_loaded=1 __ace_ran=
  __ace_osc7() {
    emulate -L zsh
    setopt extendedglob nomultibyte
    local p=${PWD//(#m)[^a-zA-Z0-9\/._~-]/%${(l:2::0:)$(( [##16] #MATCH ))}}
    builtin printf '\e]7;file://%s%s\a' "${HOST}" "$p"
  }
  __ace_precmd() {
    local ret=$?
    if [[ -n "$__ace_ran" ]]; then builtin printf '\e]133;D;%s\a' "$ret"; fi
    __ace_ran=
    __ace_osc7
    builtin printf '\e]2;%s\a' "${PWD/#$HOME/~}"
    # prompt themes rebuild PS1 on every prompt: re-add our marks when they are missing
    if [[ "$PS1" != *'133;A'* ]]; then
      PS1=$'%{\e]133;A\a%}'"$PS1"$'%{\e]133;B\a%}'
    fi
  }
  __ace_preexec() {
    __ace_ran=1
    builtin printf '\e]133;C\a'
    builtin printf '\e]2;%s\a' "${1[1,60]//[[:cntrl:]]/ }"
  }
  __ace_chpwd() { __ace_osc7 }
  __ace_init() {
    # Python "Activate virtualenv": source <venv>/bin/activate once, before the first prompt is drawn (so it shows "(.venv)").
    if [[ -n "$ACE_ACTIVATE" ]]; then
      [[ -r "$ACE_ACTIVATE" ]] && builtin source "$ACE_ACTIVATE" >/dev/null 2>&1
      unset ACE_ACTIVATE
    fi
    # Claude notifications: inside Ace shells `claude` starts with Ace's Stop/Notification hooks (--settings is additive to the user's
    # own settings; nothing on disk is changed). Not defined when the user has their own claude alias/function.
    if [[ -n "$ACE_HOOK_FILE" && -n "$ACE_CLAUDE_SETTINGS" ]] && (( ! ${+aliases[claude]} && ! ${+functions[claude]} )); then
      function claude {
        case "${1-}" in agents|attach|auth|auto-mode|doctor|gateway|import|install|logs|mcp|plugin|plugins|purge|respawn|rm|setup-token|stop|kill|ultrareview|update|upgrade) command claude "$@"; return;; esac
        local a; for a in "$@"; do case "$a" in -p|--print|-h|--help|-v|--version|--bg) command claude "$@"; return;; esac; done
        local -a __pd; [[ -n "$ACE_CLAUDE_PLUGIN_DIR" ]] && __pd=(--plugin-dir "$ACE_CLAUDE_PLUGIN_DIR")
        command "${ACE_CLAUDE_BIN:-${ATELIER_CLAUDE_BIN:-claude}}" --settings "$ACE_CLAUDE_SETTINGS" "${__pd[@]}" "$@"
      }
    fi
    precmd_functions=(${precmd_functions:#__ace_init})
    autoload -Uz add-zsh-hook
    add-zsh-hook precmd __ace_precmd
    add-zsh-hook preexec __ace_preexec
    add-zsh-hook chpwd __ace_chpwd
    __ace_precmd
  }
  # First prompt: run after every user rc file so we wrap the final PS1.
  precmd_functions=(__ace_init $precmd_functions)
fi
