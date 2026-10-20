#!/usr/bin/env bash
#
# drain-raw-bodies.sh — the raw-body drain loop.
#
# WHY THIS FILE EXISTS IN THE REPO: the loop's first incarnation lived under /tmp and was
# LOST TO A REBOOT, which silently stopped a 93-pass migration mid-corpus. A script whose loss
# stops the migration, and which holds the exact flags the drain card calls MANDATORY, must be
# version-controlled and reviewable. It was also the second /tmp copy — reproducing the failure
# mode it had just recovered from.
#
# WHAT IT DOES: repeatedly runs the store's bodies pass over the raw-body corpus, which digests
# each body into the store, verifies the store reproduces its bytes, and unlinks the file. The
# pass is bounded by --max-bytes so no single pass takes the disk down.
#
# THE THREE FLAGS ARE MANDATORY (TRDD-IGPWXZ1M), NOT TUNING:
#   --durable-source   fsyncs the store parts before any unlink. Without it a power loss loses
#                      BOTH copies, because the CLI's default is durable_source=false.
#   --max-age-ms 300000  only files untouched for 5 minutes are eligible. The corpus is written
#                      live, so this keeps the pass off a file a writer is still filling.
#   --max-bytes 2 GiB   bounds one pass.
#
# THE DELETE IS GATED ON CONTENT (TRDD-IGPWXZ1M): the pass re-hashes each file immediately
# before unlinking it and aborts if the bytes changed since the verify. A metadata comparison
# is NOT enough — a re-emission that preserves size and mtime (a `mv` back or a `cp -p`) is
# invisible to it.
#
# Usage: scripts/drain-raw-bodies.sh [--once]
#   --once   run a single pass and exit (for a manual, observable pass)
#
# Tools relied on: bash, the built `alstore` binary, and the standard file utilities.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BIN="$REPO_ROOT/rust-core/target/release/alstore"
STORE="$HOME/.agentlens/store"
BODIES="$HOME/.agentlens/otel-bodies"
LOG="$REPO_ROOT/reports_dev/drain-loop.log"

if [ ! -x "$BIN" ]; then
  echo "drain-raw-bodies: $BIN is missing or not executable." >&2
  echo "  build it with: cd $REPO_ROOT/rust-core && cargo build --release -p agentlens-store" >&2
  exit 1
fi
if [ ! -d "$BODIES" ]; then
  echo "drain-raw-bodies: corpus dir $BODIES does not exist." >&2
  exit 1
fi
mkdir -p "$(dirname "$LOG")"

# The pass counter, so every log line names its pass. It starts from the highest pass number
# already in the log, so a restart continues the sequence instead of restarting it.
PASS_N=1
if [ -f "$LOG" ]; then
  PASS_N=$(( $(grep -o 'pass=[0-9]*' "$LOG" | tail -1 | cut -d= -f2) + 1 ))
fi
[ -n "$PASS_N" ] || PASS_N=1

# The pass prints its summary as one bare JSON line on stdout. It is written to the log WITH a
# "pass=N dur=Ms " prefix, and that prefix is load-bearing: a reader (or a script) that matches
# lines by shape must be able to tell one pass from the next. A pass whose line lacks the prefix
# is SKIPPED by such a reader, and a parser that assumes the format then reports "no pass ran"
# for a pass that ran. That mistake was made here: the restart's own pass 94 was written without
# the prefix and a parser counted 93 passes and concluded nothing had happened.
#
# The prefix is also how a pass KILLED MID-FLIGHT is detected: the summary is printed at the END
# of a pass, so a killed pass leaves no line at all. A missing line between two present ones is
# therefore evidence of a killed pass, and only the prefix makes the gap visible.
run_pass() {
  local out
  local start
  start=$(date +%s)
  if out="$("$BIN" pass "$STORE" "$BODIES" \
      --max-bytes 2147483648 \
      --durable-source \
      --max-age-ms 300000 2>&1)"; then
    printf 'pass=%s dur=%ss %s\n' "$PASS_N" "$(( $(date +%s) - start ))" "$out" >> "$LOG"
  else
    printf 'pass=%s dur=%ss FAILED %s\n' "$PASS_N" "$(( $(date +%s) - start ))" "$out" >> "$LOG"
  fi
  PASS_N=$(( PASS_N + 1 ))
}

if [ "${1:-}" = "--once" ]; then
  run_pass
  exit 0
fi

while true; do
  run_pass || echo "drain-raw-bodies: a pass failed; retrying in 10s." >&2
  sleep 5
done
