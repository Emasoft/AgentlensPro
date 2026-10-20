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

# The pass counter, so every log line names its pass. It resumes from the highest pass number
# already in the log, so a restart continues the sequence instead of restarting it.
#
# The match is ANCHORED to the start of a line. An unanchored "pass=<digits>" would match the
# token anywhere in the file - including inside a pass's own captured output - and would pick up
# a number that is not a pass number.
#
# The log also holds ONE LEGACY LINE WITH NO PREFIX: pass 94, written by the restarted loop
# before the prefix was added. It is invisible to the anchored match, so the counter is seeded
# past it explicitly - otherwise the next pass would also be numbered 94 and the log would hold
# two different passes under one number.
PASS_N=1
if [ -f "$LOG" ]; then
  PASS_N=$(sed -n 's/^pass=\([0-9][0-9]*\).*/\1/p' "$LOG" | sort -n | tail -1)
  PASS_N="${PASS_N:-0}"
  PASS_N=$(( PASS_N + 1 ))
fi
# Past the legacy prefixless pass 94: if the log holds any line WITHOUT the prefix, the
# sequence has already gone past 93, so the next number is at least 95.
if [ -f "$LOG" ] && [ "$(grep -c '^pass=' "$LOG")" -lt "$(grep -c . "$LOG")" ]; then
  [ "$PASS_N" -lt 95 ] && PASS_N=95
fi

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
# The pass's stdout is captured WITHOUT stderr (2>&1 is NOT used here) and written as ONE log
# line, with any embedded newline folded to a space. Two properties of the log depend on it:
#
#   - ONE LINE PER PASS. A newline in the captured output would become a second line, and a
#     reader that parses the log line-by-line would then skip the pass. That is not
#     hypothetical: a pass line that lacked the "pass=N" prefix was skipped by exactly such a
#     reader, and a pass that ran was reported as one that did not.
#   - THE SUMMARY STAYS PARSEABLE. The pass's stderr goes to its OWN log, so a warning or a
#     progress line can never be folded into the JSON summary.
#
# The function returns the pass's exit status explicitly. It used to end with an arithmetic
# assignment, which always returns 0, so the loop's "a pass failed" recovery was unreachable
# and a failing pass was silent.
run_pass() {
  local out
  local status
  local start
  start=$(date +%s)
  # The command substitution is in an `if` CONDITION, not a bare assignment. Under `set -e` a
  # bare assignment whose command substitution fails EXITS THE SHELL AT THAT LINE, so the FAILED
  # record below would never be written and the failure would be silent. In a condition the
  # status is captured instead of being fatal.
  if out="$("$BIN" pass "$STORE" "$BODIES" \
      --max-bytes 2147483648 \
      --durable-source \
      --max-age-ms 300000)"; then
    status=0
  else
    status=$?
  fi
  # One line: no embedded newline may survive into the log.
  out="${out//$'\n'/ }"
  if [ "$status" -eq 0 ]; then
    printf 'pass=%s dur=%ss %s\n' "$PASS_N" "$(( $(date +%s) - start ))" "$out" >> "$LOG"
  else
    printf 'pass=%s dur=%ss FAILED status=%s %s\n' "$PASS_N" "$(( $(date +%s) - start ))" "$status" "$out" >> "$LOG"
  fi
  PASS_N=$(( PASS_N + 1 ))
  return "$status"
}

if [ "${1:-}" = "--once" ]; then
  run_pass
  exit 0
fi

while true; do
  run_pass || echo "drain-raw-bodies: a pass failed; retrying in 5s." >&2
  sleep 5
done
