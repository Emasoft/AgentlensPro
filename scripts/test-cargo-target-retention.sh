#!/usr/bin/env bash
# Test matrix for scripts/cargo-target-retention.sh. Every run is against a synthetic target tree
# under mktemp -d; the real cargo target is never touched. Exit 0 = all passed.
#
# Test knob: CARGO_RETENTION_PS_SNAPSHOT names a file in `ps -eo pid,command` format that the
# script reads instead of running ps (so the "cargo is running" refusal can be tested, and so a
# real cargo on this machine cannot interfere with the other tests).
set -u
SCRIPT="$(dirname "$0")/cargo-target-retention.sh"
ROOT="$(mktemp -d)"
trap 'rm -rf "$ROOT"' EXIT
PASS=0; FAIL=0
printf "  PID COMMAND\n    1 /sbin/launchd\n" > "$ROOT/ps-idle"
printf "  PID COMMAND\n    1 /sbin/launchd\n  777 /usr/bin/cargo build --release\n" > "$ROOT/ps-cargo"
printf "  PID COMMAND\n    1 /sbin/launchd\n  778 bash /x/scripts/cargo-target-retention.sh --apply\n" > "$ROOT/ps-lookalike"
export CARGO_RETENTION_PS_SNAPSHOT="$ROOT/ps-idle"

check() { # name, then a command; passes when it exits 0
  local name="$1"; shift
  if "$@"; then PASS=$((PASS+1)); else FAIL=$((FAIL+1)); echo "FAIL: $name"; fi
}
mktree() { # sets T to a fresh <tmp>/target with the cargo layout for profile $1
  T="$(mktemp -d "$ROOT/t.XXXXXX")/target"
  mkdir -p "$T/$1/.fingerprint" "$T/$1/build" "$T/$1/deps"; touch "$T/CACHEDIR.TAG"
}
mkgen() { # target profile crate hash stamp(YYYYMMDDhhmm): fingerprint dir + deps file, all stamped
  local d="$1/$2" u="${3//-/_}"
  mkdir -p "$d/.fingerprint/$3-$4"
  echo x > "$d/.fingerprint/$3-$4/f"; echo x > "$d/deps/lib$u-$4.rlib"
  touch -t "$5" "$d/.fingerprint/$3-$4/f" "$d/.fingerprint/$3-$4" "$d/deps/lib$u-$4.rlib"
}
H1=aaaaaaaaaaaaaaaa; H2=bbbbbbbbbbbbbbbb; H3=cccccccccccccccc; H4=dddddddddddddddd

# 1. foo-bar and foo_bar are different crates: two generations each, --keep 2 => nothing removable.
mktree debug
mkgen "$T" debug foo-bar $H1 202001010000; mkgen "$T" debug foo-bar $H2 202002010000
mkgen "$T" debug foo_bar $H3 202003010000; mkgen "$T" debug foo_bar $H4 202004010000
"$SCRIPT" --keep 2 "$T" > "$ROOT/o1" 2>&1
check "collision: report says 0 removable" grep -q "0 removable" "$ROOT/o1"
"$SCRIPT" --keep 2 --apply "$T" > "$ROOT/o1b" 2>&1
check "collision: apply keeps all four deps files" test "$(find "$T/debug/deps" -type f | wc -l | tr -d " ")" = 4

# 2. rank by newest file mtime, not directory mtime: the oldest-by-directory generation holds the
#    newest file, so with --keep 1 it is the one kept.
mktree debug
mkgen "$T" debug foo $H1 202001010000; mkgen "$T" debug foo $H2 202002010000; mkgen "$T" debug foo $H3 202003010000
touch -t 202501010000 "$T/debug/.fingerprint/foo-$H1/f"; touch -t 199901010000 "$T/debug/.fingerprint/foo-$H1"
"$SCRIPT" --keep 1 --apply "$T" > "$ROOT/o2" 2>&1
check "mtime: generation with newest file kept" test -d "$T/debug/.fingerprint/foo-$H1"
check "mtime: other generations removed" test ! -e "$T/debug/.fingerprint/foo-$H2" -a ! -e "$T/debug/.fingerprint/foo-$H3"

# 3. --apply guard follows --profile: a release-only tree with no CACHEDIR.TAG must be accepted.
mktree release; rm "$T/CACHEDIR.TAG"
mkgen "$T" release foo $H1 202001010000; mkgen "$T" release foo $H2 202002010000
"$SCRIPT" --profile release --keep 1 --apply "$T" > "$ROOT/o3" 2>&1; rc=$?
check "profile: release apply accepted (rc 0)" test "$rc" = 0
check "profile: release old generation removed" test ! -e "$T/release/.fingerprint/foo-$H1"

# 4. symlinked deps (and build, and profile dir) refused in both modes, nothing removed.
mktree debug
mkgen "$T" debug foo $H1 202001010000; mkgen "$T" debug foo $H2 202002010000
mv "$T/debug/deps" "$ROOT/realdeps"; ln -s "$ROOT/realdeps" "$T/debug/deps"
"$SCRIPT" --keep 1 "$T" > /dev/null 2>&1; check "symlink deps: report refused" test $? = 2
"$SCRIPT" --keep 1 --apply "$T" > /dev/null 2>&1; check "symlink deps: apply refused" test $? = 2
check "symlink deps: nothing removed" test "$(find "$ROOT/realdeps" -type f | wc -l | tr -d " ")" = 2
mktree debug; rmdir "$T/debug/build"; ln -s "$ROOT" "$T/debug/build"
"$SCRIPT" "$T" > /dev/null 2>&1; check "symlink build: refused" test $? = 2
mktree debug; mv "$T/debug" "$ROOT/realdebug"; ln -s "$ROOT/realdebug" "$T/debug"
"$SCRIPT" "$T" > /dev/null 2>&1; check "symlink profile: refused" test $? = 2

# 5. a running cargo/rustc blocks --apply unless --force-while-building; a lookalike name does not.
mktree debug
mkgen "$T" debug foo $H1 202001010000; mkgen "$T" debug foo $H2 202002010000
CARGO_RETENTION_PS_SNAPSHOT="$ROOT/ps-cargo" "$SCRIPT" --keep 1 --apply "$T" > /dev/null 2>&1
check "running cargo: apply refused" test $? = 2
check "running cargo: nothing removed" test -e "$T/debug/.fingerprint/foo-$H1"
CARGO_RETENTION_PS_SNAPSHOT="$ROOT/ps-cargo" "$SCRIPT" --keep 1 "$T" > /dev/null 2>&1
check "running cargo: report-only still works" test $? = 0
CARGO_RETENTION_PS_SNAPSHOT="$ROOT/ps-cargo" "$SCRIPT" --keep 1 --apply --force-while-building "$T" > /dev/null 2>&1
check "running cargo: --force-while-building applies" test ! -e "$T/debug/.fingerprint/foo-$H1"
mktree debug
mkgen "$T" debug foo $H1 202001010000; mkgen "$T" debug foo $H2 202002010000
CARGO_RETENTION_PS_SNAPSHOT="$ROOT/ps-lookalike" "$SCRIPT" --keep 1 --apply "$T" > /dev/null 2>&1
check "lookalike process name does not block apply" test ! -e "$T/debug/.fingerprint/foo-$H1"

# 6. kept safety properties: report-only default removes nothing; non-/target path refused.
mktree debug
mkgen "$T" debug foo $H1 202001010000; mkgen "$T" debug foo $H2 202002010000
"$SCRIPT" --keep 1 "$T" > /dev/null 2>&1
check "default is report-only" test -e "$T/debug/.fingerprint/foo-$H1"
mkdir "$ROOT/notarget"; cp -R "$T/debug" "$ROOT/notarget/debug"; touch "$ROOT/notarget/CACHEDIR.TAG"
"$SCRIPT" --keep 1 --apply "$ROOT/notarget" > /dev/null 2>&1
check "apply refuses a path not ending in /target" test $? = 2

echo "cargo-target-retention tests: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
