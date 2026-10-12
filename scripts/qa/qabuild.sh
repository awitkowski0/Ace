#!/bin/bash
# Fast QA build (no LTO, opt-level 1, separate target dir so release/bundle builds are untouched). Serialised across agents with a lock.
# Output binary: src-tauri/target-qa/release/ace   (run it with ACE_BIN=... node scripts/qa/<suite>.mjs)
cd "$(dirname "$0")/../.." || exit 1
LOCK=/tmp/ace-qabuild.lock
for i in $(seq 1 600); do mkdir "$LOCK" 2>/dev/null && break; sleep 2; done
trap 'rmdir "$LOCK" 2>/dev/null' EXIT
export CARGO_TARGET_DIR="$PWD/src-tauri/target-qa" CARGO_PROFILE_RELEASE_LTO=false CARGO_PROFILE_RELEASE_CODEGEN_UNITS=16 CARGO_PROFILE_RELEASE_OPT_LEVEL=1 CARGO_PROFILE_RELEASE_STRIP=false CARGO_INCREMENTAL=1
pnpm tauri build --no-bundle 2>&1 | tail -${QA_TAIL:-15}
ls -la "$CARGO_TARGET_DIR/release/ace"
