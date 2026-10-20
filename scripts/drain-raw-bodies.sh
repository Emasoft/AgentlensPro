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
#
# ONE INSTANCE AT A TIME. There is no PID lock: two concurrent instances would interleave the
# pass counter, append to the same error log, and fight over the same temp files. The store's
# own data-directory lock (rust-core/crates/agentlens-core/src/pid_lock.rs) is what protects
# the DATA; nothing protects this script's bookkeeping.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BIN="$REPO_ROOT/rust-core/target/release/alstore"
STORE="$HOME/.agentlens/store"
BODIES="$HOME/.agentlens/otel-bodies"
LOG="$REPO_ROOT/reports_dev/drain-loop.log"
# The pass stderr goes here, NOT into the summary line: the summary must stay one parseable
# JSON line per pass, and a failing pass's reason usually arrives on stderr.
ERRLOG="$REPO_ROOT/reports_dev/drain-loop.err.log"
# The error log is TRUNCATED when it grows past this, so a long-running drain cannot fill the
# disk with diagnostics. WHAT THIS IS NOT: a hard ceiling. The truncation runs at the TOP of a
# pass, so the file's size after a pass is this ceiling PLUS whatever that pass wrote to stderr,
# and a failing pass can write a lot. This is a SAWTOOTH that keeps the average bounded, not an
# invariant - a reader watching the file mid-pass can see it above the ceiling.
# The last records are kept: the recent passes are the ones worth reading, and the error log is
# a diagnostic aid, not the audit trail - that is $LOG.
ERRLOG_MAX_BYTES=2000000

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
# Past the legacy prefixless pass 94: if the log holds any line WITHOUT the prefix, the
# sequence has already gone past 93, so the next number is at least 95.
PASS_N=1
if [ -f "$LOG" ]; then
  PASS_N=$(sed -n 's/^pass=\([0-9][0-9]*\).*/\1/p' "$LOG" | sort -n | tail -1)
  PASS_N="${PASS_N:-0}"
  # Strip any leading zeros before the arithmetic. Bash reads a leading-zero integer as OCTAL,
  # so a log line "pass=08" would make the arithmetic below die with "value too great for base"
  # - and under `set -e` that kills the whole script on resume. 10# forces base 10 for the
  # same reason.
  PASS_N=$(( 10#$PASS_N + 1 ))
fi
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
  #
  # STDERR GOES TO ITS OWN LOG, NOT INTO THE SUMMARY. The pass's stdout is ONE bare JSON line
  # (measured against the real binary on a scratch corpus: exactly one line), and the summary
  # line must stay parseable, so stderr is redirected to $ERRLOG rather than folded in. It is
  # NOT discarded: a failing pass's explanation usually arrives on stderr, and a log line with
  # no reason is exactly the failure mode this file had to be repaired for once.
  if out="$("$BIN" pass "$STORE" "$BODIES" \
      --max-bytes 2147483648 \
      --durable-source \
      --max-age-ms 300000 2>>"$ERRLOG")"; then
    status=0
  else
    status=$?
  fi
  # THE SUMMARY IS THE PASS'S FIRST STDOUT LINE, and any further stdout lines go to the error
  # log. Folding the whole capture onto one line with spaces would preserve the LINE count but
  # CORRUPT the JSON: a capture of two lines becomes one line that is not valid JSON, which is
  # the same failure the one-line property exists to prevent, merely relocated. The real binary
  # prints exactly one bare JSON line (measured against it on a scratch corpus), so in practice
  # the first line IS the whole summary; taking the first line anyway makes the property hold
  # even if that changes, instead of depending on it.
  #
  # The pass's stderr also goes to the error log: a failing pass's reason usually arrives there,
  # and a log line with no reason is exactly the failure mode this file had to be repaired for.
  # Bound the error log BEFORE it is written to, never after.
  if [ -f "$ERRLOG" ] && [ "$(wc -c < "$ERRLOG")" -gt "$ERRLOG_MAX_BYTES" ]; then
    # The last 2000 LINES would not bound the file: a run of output with no newline in it is
    # ONE line of any length, so the line-based cut kept the whole file. The cut is by BYTES:
    # the last ERRLOG_MAX_BYTES of the file, which bounds it whatever the line structure is.
    #
    # A BYTE cut lands mid-LINE. What follows the cut's first newline is a whole record, and
    # what PRECEDES it is the tail of a record whose start was cut away - a fragment a reader
    # cannot classify, the same defect the one-line-per-pass property exists to prevent.
    #
    # THE FRAGMENT IS REMOVED BY POSITION, NOT BY CONTENT.
    #
    # The cut can land two ways. It can land MID-LINE, and then the trimmed file opens with the
    # tail of a record whose start was cut away, JOINED to the next record's text (the fragment
    # has no trailing newline, so the next record continues it) - the fragment is exactly the
    # bytes BEFORE the first newline, and removing those bytes removes the fragment AND KEEPS
    # the record it was joined to. Or it can land EXACTLY ON A NEWLINE, and then the trimmed
    # file opens with a WHOLE record, and removing that first line would delete it.
    #
    # So the decision is POSITIONAL, made from the byte that precedes the cut IN THE ORIGINAL
    # FILE: the trimmed file's first line is a whole record exactly when the original byte
    # before the cut was a newline. A CONTENT test ('does this line start with pass=') was tried
    # and REJECTED: the error log holds records that do not start with 'pass=' - the pass's raw
    # stderr, and the continuation lines of a multi-line stdout diversion - so a content test
    # DELETED A VALID RECORD. A position test cannot be wrong about the log's format.
    # The temp files live next to the log, so an interrupted truncation leaves debris in
    # reports_dev/ (gitignored, but unbounded across interruptions). The trap removes them.
    trap 'rm -f "$ERRLOG.trimmed" "$ERRLOG.trimmed.2"' EXIT INT TERM
    local size start
    size=$(wc -c < "$ERRLOG")
    start=$(( size - ERRLOG_MAX_BYTES ))
    tail -c "$ERRLOG_MAX_BYTES" "$ERRLOG" > "$ERRLOG.trimmed" 2>/dev/null || : > "$ERRLOG.trimmed"
    # Did the cut land EXACTLY on a newline? The byte before the cut is the byte at index
    # start-1 of the ORIGINAL file; 'head -c start | tail -c 1' emits bytes 0..start-1, so its
    # last byte is exactly index start-1. (head -c emits what it has when the file is shorter,
    # and every stage of this pipeline exits 0 on empty input, so 'set -euo pipefail' is safe.)
    # 'LC_ALL=C' is load-bearing: the error log can carry any bytes the pass's stderr carried,
    # so the byte must be read in a single-byte locale.
    local first_line_is_whole=0
    if [ "$start" -gt 0 ] && [ -s "$ERRLOG.trimmed" ]; then
      local before
      before=$(LC_ALL=C head -c "$start" "$ERRLOG" 2>/dev/null | tail -c 1 | od -An -tu1 | tr -d ' \n')
      # 10 is the byte value of a newline.
      if [ "$before" = "10" ]; then
        first_line_is_whole=1
      fi
    fi
    if [ -s "$ERRLOG.trimmed" ] && [ "$first_line_is_whole" -eq 0 ]; then
      # MID-LINE cut: the trimmed file's FIRST LINE is the fragment - the tail of the line
      # whose head was cut away. It is a whole line but not the start of one, so it is dropped
      # and every line after it is kept. 'tail -n +2' drops exactly that first line.
      #
      # A trimmed file with NO newline at all is ONE line: a single fragment with no whole
      # line in it. Dropping it would empty the log of everything, so it is left as it is.
      #
      # WHAT IS AND IS NOT PRESERVED, precisely: the retained content is always a CONTIGUOUS
      # SUFFIX of the original and never contains a partial LINE. A LOGICAL RECORD that spans
      # several lines (the script writes one, for a multi-line stdout diversion) can still
      # lose its head when the cut lands inside it - the lines that survive are a suffix of
      # that record, not the record. What is guaranteed is that no whole LINE is deleted by
      # the truncation.
      tail -n "+2" "$ERRLOG.trimmed" > "$ERRLOG.trimmed.2" 2>/dev/null || : > "$ERRLOG.trimmed.2"
      mv "$ERRLOG.trimmed.2" "$ERRLOG.trimmed"
    fi
    mv "$ERRLOG.trimmed" "$ERRLOG"
  fi
  local summary
  local rest
  summary="${out%%$'\n'*}"
  if [ "$out" != "$summary" ]; then
    rest="${out#*$'\n'}"
    printf 'pass=%s extra stdout lines:\n%s\n' "$PASS_N" "$rest" >> "$ERRLOG"
  fi
  # AN EMPTY SUMMARY IS ITS OWN RECORD, not a truncated one. A pass that printed nothing and a
  # pass whose stdout was lost both yield an empty capture, and a log line that cannot be
  # classified is exactly the defect the one-line-per-pass property exists to prevent - so the
  # empty case is marked NO-SUMMARY rather than written as a bare trailing space.
  if [ -z "$summary" ]; then
    summary='NO-SUMMARY'
    printf 'pass=%s the pass printed NOTHING on stdout; the record has no summary\n' "$PASS_N" >> "$ERRLOG"
  fi
  # The summary line carries the pass's own JSON, which already includes the abort counter
  # (deleteAbortedReemission) as a field - so a reader can see the count without parsing the
  # failed array. Nothing extra is appended here: the JSON IS the record, and appending a
  # second copy of the same fact would create a second thing to keep in step with the first.
  if [ "$status" -eq 0 ]; then
    printf 'pass=%s dur=%ss %s\n' "$PASS_N" "$(( $(date +%s) - start ))" "$summary" >> "$LOG"
  else
    printf 'pass=%s dur=%ss FAILED status=%s %s\n' "$PASS_N" "$(( $(date +%s) - start ))" "$status" "$summary" >> "$LOG"
    printf 'pass=%s FAILED — the pass stderr is in %s\n' "$PASS_N" "$ERRLOG" >> "$LOG"
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
