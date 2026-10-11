# Atelier shell integration for zsh (OSC 7 cwd, OSC 133 prompt marks, OSC 2 titles).
# Loaded from a private ZDOTDIR; the user's own dotfiles are never touched.
if [[ -o interactive && -n "$ATELIER_SHELL_INTEGRATION" && -z "$__atelier_loaded" ]]; then
  typeset -g __atelier_loaded=1 __atelier_ran=
  __atelier_osc7() {
    emulate -L zsh
    setopt extendedglob nomultibyte
    local p=${PWD//(#m)[^a-zA-Z0-9\/._~-]/%${(l:2::0:)$(( [##16] #MATCH ))}}
    builtin printf '\e]7;file://%s%s\a' "${HOST}" "$p"
  }
  __atelier_precmd() {
    local ret=$?
    if [[ -n "$__atelier_ran" ]]; then builtin printf '\e]133;D;%s\a' "$ret"; fi
    __atelier_ran=
    __atelier_osc7
    builtin printf '\e]2;%s\a' "${PWD/#$HOME/~}"
    # prompt themes rebuild PS1 on every prompt: re-add our marks when they are missing
    if [[ "$PS1" != *'133;A'* ]]; then
      PS1=$'%{\e]133;A\a%}'"$PS1"$'%{\e]133;B\a%}'
    fi
  }
  __atelier_preexec() {
    __atelier_ran=1
    builtin printf '\e]133;C\a'
    builtin printf '\e]2;%s\a' "${1[1,60]//[[:cntrl:]]/ }"
  }
  __atelier_chpwd() { __atelier_osc7 }
  __atelier_init() {
    # Python "Activate virtualenv": source <venv>/bin/activate once, before the first prompt is drawn (so it shows "(.venv)").
    if [[ -n "$ATELIER_ACTIVATE" ]]; then
      [[ -r "$ATELIER_ACTIVATE" ]] && builtin source "$ATELIER_ACTIVATE" >/dev/null 2>&1
      unset ATELIER_ACTIVATE
    fi
    precmd_functions=(${precmd_functions:#__atelier_init})
    autoload -Uz add-zsh-hook
    add-zsh-hook precmd __atelier_precmd
    add-zsh-hook preexec __atelier_preexec
    add-zsh-hook chpwd __atelier_chpwd
    __atelier_precmd
  }
  # First prompt: run after every user rc file so we wrap the final PS1.
  precmd_functions=(__atelier_init $precmd_functions)
fi
