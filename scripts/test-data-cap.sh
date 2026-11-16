#!/usr/bin/env bash
# test-data-cap.sh <command> [args...] — run a test command with a SAMPLED 4 GB cap on the data it generates.
# SAMPLED, not hard: the size is checked every 5 s, so a fast writer can overshoot the cap between two
# samples before the run is killed. COVERS only files under TMPDIR/TMP/TEMP (redirected below); mocha
# (src/test/setup.js self-wrap), cargo test (.cargo/config.toml runner) and nested runs all route through
# this script; writes a test makes to its own DATA_DIR/HOME outside TMPDIR are NOT counted.
#
# Owner order 2026-11-16: "add a permanent cap to tests to limit to 4 GB any generated fake data
# for tests!" and "no, the cap is 4GB. i don't care about testing full data size."
# Incident that caused it: measurement scripts cloned a 43 GB data folder 29 times and the main
# disk fell to 41 GB free.
set -u

# The cap is a constant on purpose: NO env-var override, so nothing can quietly raise it.
CAP_KB=4194304   # 4 GiB, in the 1024-byte blocks `du -sk` reports

if [ "$#" -lt 1 ]; then
  echo "usage: test-data-cap.sh <command> [args...]" >&2
  exit 2
fi

# Nesting: when an outer wrapper already set AGENTLENS_TEST_CAP_DIR (and that run dir still exists), run
# the command directly. WHY: a nested wrapper would open a SECOND 4 GB budget with its own TMPDIR, so
# `outer(4 GB) -> inner(4 GB)` could write 8 GB while each du stayed under the cap; joining the outer run
# keeps one directory, one budget, one du. A stale variable (dir already removed) must NOT skip the cap,
# hence the -d test.
if [ -n "${AGENTLENS_TEST_CAP_DIR:-}" ] && [ -d "$AGENTLENS_TEST_CAP_DIR" ]; then
  exec "$@"
fi

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
# Fresh per-run dir under the gitignored tests_dev/: one directory holds ALL test temp data, so one
# `du` measures everything the run generated, and cleanup is one rm of a dir this script created.
RUN_DIR="$ROOT/tests_dev/tmp/run-$(date +%Y%m%d_%H%M%S)-$$"
mkdir -p "$RUN_DIR" || exit 2
# Redirect every temp-dir convention into it, otherwise tests would write to the system temp and escape the cap.
export TMPDIR="$RUN_DIR" TMP="$RUN_DIR" TEMP="$RUN_DIR"
# Published so every nested launcher (mocha self-wrap in src/test/setup.js, the cargo runner, a test
# that spawns another test run) can see it is already under a cap and join it instead of opening its own.
export AGENTLENS_TEST_CAP_DIR="$RUN_DIR"

CMD_PID=""
# Kill what the process-group kill cannot reach. Test-spawned daemons (alcore e2e servers, anything that
# setsid()s) leave the command's process group and, once the command dies, are reparented to pid 1, so
# the group kill misses them and they keep writing into the run dir (seen: an orphaned alcore survived
# the wrapper). Two nets, from ONE ps snapshot: (1) every descendant of the command while the ppid chain
# is still intact, so this must run BEFORE the group kill; (2) any process whose command line names the
# unique run dir, which also catches daemons already reparented. Excludes this wrapper itself.
# $1 = "walk" enables net (1); "dir" is net (2) only. WHY the mode: on NORMAL exit (EXIT trap, command
# already gone) CMD_PID may have been reused by an unrelated process, and the ppid walk would then KILL
# strangers; so the walk runs only while CMD_PID is known alive (cap-exceeded path, on_signal, both
# called before the group kill) and the exit-time cleanup uses the run-dir command-line match alone.
kill_stragglers() {
  local pids
  pids=$(ps -axo pid=,ppid=,command= | awk -v root="${CMD_PID:-0}" -v dir="$RUN_DIR" -v self="$$" -v walk="$1" '
    { pid=$1; par[pid]=$2; cmd=$0; sub(/^ *[0-9]+ +[0-9]+ */, "", cmd); if (index(cmd, dir)) hit[pid]=1; all[++n]=pid }
    END {
      if (walk == "walk") for (i = 1; i <= n; i++) { p = all[i]; q = p; while (q > 1 && q in par) { if (q == root) { hit[p] = 1; break }; q = par[q] } }
      for (p in hit) if (p != self) print p
    }')
  # shellcheck disable=SC2086  # intentional word splitting: one pid per word
  if [ -n "$pids" ]; then kill -KILL $pids 2>/dev/null; fi
}
# shellcheck disable=SC2329  # invoked indirectly by the EXIT trap
cleanup() {
  # Remove only the run dir this script created: regeneratable temp data, never anything else.
  # "dir" mode only: the command is already gone here and its pid may be reused (see kill_stragglers).
  kill_stragglers dir
  rm -rf "$RUN_DIR"
}
# Signals: stop the child group too, then run the EXIT trap (cleanup). Without this an interrupted run would orphan the command.
# shellcheck disable=SC2329  # invoked indirectly by the signal trap
# $1 = the exit status to report: 128+signal (INT 130, TERM 143, HUP 129), the shell convention, so a
# caller can tell WHICH signal stopped the run instead of every signal looking like INT.
on_signal() {
  # TERM first, then KILL: a child that ignores TERM must not be orphaned.
  # Stragglers first: once the group is dead, setsid daemons are reparented and the ppid walk can no longer find them.
  # CMD_PID is almost always alive here (we are interrupted mid-run); in the tiny window where the command
  # just exited and was not yet reaped the pid could in theory be reused, a risk accepted only on this signal path.
  kill_stragglers walk
  if [ -n "$CMD_PID" ]; then kill -TERM -- "-$CMD_PID" 2>/dev/null; sleep 2; kill -KILL -- "-$CMD_PID" 2>/dev/null; fi
  exit "$1"
}
trap cleanup EXIT
trap 'on_signal 130' INT
trap 'on_signal 143' TERM
trap 'on_signal 129' HUP

# `set -m` gives the background job its own process group (pgid == pid), so the cap can kill the
# command AND every child it spawned (mocha workers, cargo test binaries) with one signal.
set -m
# stdin from /dev/null: a background job that reads the tty is stopped by SIGTTIN and the poll loop would wait forever.
"$@" </dev/null &
CMD_PID=$!
set +m

STATUS=""
while kill -0 "$CMD_PID" 2>/dev/null; do
  # `du -sk` counts allocated blocks, so APFS clones (cp -c) count in full: deliberately strict,
  # because a clone is exactly how the incident filled the disk.
  USED_KB=$(du -sk "$RUN_DIR" 2>/dev/null | cut -f1)
  USED_KB=${USED_KB:-0}
  if [ "$USED_KB" -gt "$CAP_KB" ]; then
    echo "test-data-cap: $((USED_KB / 1024)) MB of test data in $RUN_DIR exceeds the 4 GB cap — run stopped" >&2
    kill_stragglers walk   # before the group kill, see kill_stragglers
    kill -KILL -- "-$CMD_PID" 2>/dev/null
    wait "$CMD_PID" 2>/dev/null
    STATUS=3
    break
  fi
  # Poll every 5 s but return as soon as the command ends, so short tests are not delayed.
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    kill -0 "$CMD_PID" 2>/dev/null || break
    sleep 0.5
  done
done

if [ -z "$STATUS" ]; then
  wait "$CMD_PID"
  STATUS=$?
fi
exit "$STATUS"
