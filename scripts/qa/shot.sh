#!/bin/bash
# Usage: scripts/qa/shot.sh <name>   -> scripts/qa/out/<name>.png
# Finds the Ace window id by pid (CoreGraphics window list, Swift helper) and runs `screencapture -l <id>`: works
# while the window is unfocused/occluded and never activates it. pid: $ACE_PID, else <sock>.pid written by the harness.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
name="${1:?name}"
mkdir -p "$here/out" "$here/.bin"
sock="${ACE_AUTOMATION_SOCK:-${ATELIER_AUTOMATION_SOCK:-${TMPDIR:-/tmp}/ace-automation.sock}}"
pid="${ACE_PID:-${ATELIER_PID:-$(cat "$sock.pid" 2>/dev/null || true)}}"
[ -n "$pid" ] || { echo "no pid (is the app running with ACE_AUTOMATION=1?)" >&2; exit 1; }
bin="$here/.bin/winshot"
if [ ! -x "$bin" ] || [ "$here/winshot.swift" -nt "$bin" ]; then
  swiftc -O "$here/winshot.swift" -o "$bin" 2>&1 | grep -v warning || true
fi
wid="$("$bin" "$pid")"
screencapture -x -o -l "$wid" "$here/out/$name.png"
echo "$here/out/$name.png"
