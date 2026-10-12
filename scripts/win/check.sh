#!/bin/bash
# Windows type-check of the Tauri backend from macOS: `cargo check --target x86_64-pc-windows-msvc`.
# Check only (no link). ring's C code gets clang + tiny stub CRT headers; tauri-winres needs llvm-rc (brew llvm).
# Usage: scripts/win/check.sh [extra cargo args]   -> errors print as `src/<file>:<line>:<col>: error...`
here="$(cd "$(dirname "$0")" && pwd)"
export PATH="$PATH:/opt/homebrew/opt/llvm/bin"
cd "$here/../../src-tauri" || exit 1
CC_x86_64_pc_windows_msvc=clang CFLAGS_x86_64_pc_windows_msvc="--target=x86_64-pc-windows-msvc -I$here/stub-include" \
AR_x86_64_pc_windows_msvc=/opt/homebrew/opt/llvm/bin/llvm-ar CARGO_TARGET_DIR="$PWD/target-win" \
cargo check --target x86_64-pc-windows-msvc --message-format short "$@" 2>&1
