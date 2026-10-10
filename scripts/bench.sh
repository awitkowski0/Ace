#!/bin/bash
# Release-build performance bench against ~/thematic-kyf. Writes docs/PERF.md (via scripts/qa/perf-report.mjs) from the
# measured JSON. Usage: scripts/bench.sh            (builds, then measures; SKIP_BUILD=1 to reuse the binary)
# Env: PROJ, RUNS (cold-start repetitions, default 5), BENCH_TMP.  Needs node + a Screen-Recording-free harness only.
set -euo pipefail
cd "$(dirname "$0")/.."
export BENCH_TMP="${BENCH_TMP:-${TMPDIR:-/tmp}/atelier-bench}"; mkdir -p "$BENCH_TMP"
if [ -z "${SKIP_BUILD:-}" ]; then
  # --no-bundle: binary only. Fallback (e.g. tsc errors in someone's WIP): vite build + cargo with the same custom-protocol feature tauri-cli adds.
  pnpm tauri build --no-bundle || { pnpm vite build && (cd src-tauri && cargo build --release --features tauri/custom-protocol); }
fi
export OUT="$BENCH_TMP/bench.json"
node scripts/qa/bench.mjs > "$BENCH_TMP/bench.log"
node scripts/qa/perf-report.mjs "$OUT" docs/PERF.md
echo "wrote docs/PERF.md"
