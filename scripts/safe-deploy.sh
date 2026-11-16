#!/usr/bin/env bash
#
# safe-deploy.sh — gate-then-build for the dogfood npm-link (see .claude/project/memory/
# agentlenspro-ops-lessons.md, "DOGFOOD-LINK DEPLOY IS STRICT" + lesson [^5]).
#
# WHY THIS EXISTS: `agentlenspro` is npm-linked to this repo, so `node esbuild.js` makes the bundle
# LIVE for EVERY Claude Code instance on the machine (the CLI powers the lifecycle hooks + the
# burn-gate PreToolUse deny on every agent launch). A broken build therefore has machine-wide blast
# radius. This script runs the FULL gate suite FIRST and only writes the bundle + restarts the server
# when ALL gates are green; a red gate ABORTS with the last known-good bundle UNTOUCHED. The gate is
# fail-open, so the dangerous class is "bundle loads but MISBEHAVES" — only a real test run catches
# that, which is why the full mocha suite is a mandatory gate here, not just tsc/lint.
#
# TWO HALVES, NOT ONE: the deploy ships the JS bundle AND the Rust backend. The deployed `alcore`
# IS the whole server — the TypeScript server was retired in commit 567fc5c2 (2026-09-01,
# TRDD-1B98LCVR box 4) — so a deploy that compiles only the JS bundle leaves the running server on
# a STALE binary while saying nothing about it. 81 rust-core commits went unshipped that way
# (TRDD-KRJNTSQH). The rust half below builds the workspace, stages the shipped binaries into
# bin-native/<platform>-<arch>/, codesigns them, and then proves the RUNNING pid executes the file
# that was just staged.
#
# Usage: scripts/safe-deploy.sh [--dry-run] [--no-restart]
#   --dry-run      run every gate but do NOT build or restart (a CI-style check); reports BOTH
#                  halves (the JS bundle AND the rust binary) so the gap cannot reappear silently
#   --no-restart   build on green but leave the running server as-is
#
# Node note: everything runs under the invoking Node, which must satisfy package.json `engines` and be
# able to load the store engine (see require_store_capable_node). Override the mocha runner with
# AGENTLENS_TEST_NODE=/path/to/node.
#
# Testability: every external command is overridable via an env var (GATE_CHECKTYPES, GATE_LINT,
# GATE_MIRRORS, GATE_COMPILE_TESTS, GATE_MOCHA, BUILD_CMD, SMOKE_CMD, RESTART_CMD, RUST_PLATFORM_CMD,
# RUST_HASH_CMD, RUST_BUILD_CMD, RUST_STAGE_CMD, RUST_CODESIGN_CMD, RUST_VERIFY_CMD) so the safety
# logic (abort-before-build) is unit-tested in milliseconds without the real ~1-minute suite and
# without a real cargo build. These are operator/test-controlled, never untrusted input.

set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO" || { echo "safe-deploy: cannot cd to repo root" >&2; exit 3; }

RESTART=1
DRYRUN=0
for arg in "$@"; do
  case "$arg" in
    --)           ;;  # `pnpm run deploy:safe -- --dry-run` forwards a literal `--` separator; ignore it
    --dry-run)    DRYRUN=1 ;;
    --no-restart) RESTART=0 ;;
    -h|--help)
      cat <<'EOF'
safe-deploy.sh — gate-then-build for the dogfood npm-link.
Runs the full gate suite, then builds + restarts ONLY when all gates are green.
A red gate aborts with the last known-good bundle untouched.
Ships TWO halves: the JS bundle AND the rust backend (alcore) the server actually runs.

  --dry-run      run every gate but do NOT build or restart; reports both halves
  --no-restart   build on green but leave the running server as-is
  -h, --help     this help
EOF
      exit 0 ;;
    *) echo "safe-deploy: unknown argument '$arg' (try --help)" >&2; exit 2 ;;
  esac
done

# Resolve the Node used for the mocha step. AGENTLENS_TEST_NODE overrides; else the current node.
#
# WHY NO PIN ANY MORE (was: "newest local nvm v20"): the pin existed only to dodge mocha 10's ancient
# yargs@16, which throws `require is not defined in ES module scope` on modern Node. mocha 11 (yargs@18)
# fixed that and the whole suite passes on the current Node. Pinning the gate to an EOL runtime
# (Node 18 EOL 2025-04, Node 20 EOL 2026-04) also hid the fact that the product's real floor had moved,
# so the pin is gone and the floor is declared in package.json `engines` instead.
resolve_test_node() {
  if [ -n "${AGENTLENS_TEST_NODE:-}" ] && [ -x "${AGENTLENS_TEST_NODE}" ]; then
    printf '%s' "${AGENTLENS_TEST_NODE}"; return
  fi
  command -v node
}

# Fail LOUDLY (never silently skip) when the store engine cannot load on the resolved Node. @duckdb/node-api
# ships a PREBUILT native binary per platform (optionalDependencies, esbuild-style — never built from
# source), so a failure here means a genuinely unsupported platform/runtime, not a missing toolchain. A
# green gate on a runtime that cannot open the database is worse than a red one.
require_store_capable_node() {
  local n="$1"
  if ! "$n" -e 'require("@duckdb/node-api")' >/dev/null 2>&1; then
    printf 'FATAL: %s (%s) cannot load @duckdb/node-api (the store engine) — unsupported platform/runtime.\n' \
      "$n" "$("$n" -v 2>/dev/null)" >&2
    exit 1
  fi
}

# Gate/build/restart commands — overridable for tests (defaults are the real gates).
GATE_CHECKTYPES="${GATE_CHECKTYPES:-pnpm run check-types}"
GATE_LINT="${GATE_LINT:-pnpm run lint}"
GATE_MIRRORS="${GATE_MIRRORS:-node scripts/check-no-mirrors.js}"
GATE_COMPILE_TESTS="${GATE_COMPILE_TESTS:-pnpm run compile-tests}"
BUILD_CMD="${BUILD_CMD:-node esbuild.js}"
SMOKE_CMD="${SMOKE_CMD:-__default_smoke__}"
RESTART_CMD="${RESTART_CMD:-agentlenspro server restart}"

# ── The RUST half ───────────────────────────────────────────────────────────────────────
#
# WHY THIS HALF EXISTS: the deployed `alcore` IS the whole backend — the TypeScript server was
# retired in commit 567fc5c2 (2026-09-01, TRDD-1B98LCVR box 4). A deploy that compiles only the
# JS bundle therefore leaves the running server on a STALE binary while saying nothing about it:
# 81 rust-core commits went unshipped that way (TRDD-KRJNTSQH), and a green deploy said NOTHING
# about what was actually serving. The half below builds the Rust workspace, stages the shipped
# binaries, codesigns them (an unsigned binary is SIGKILLed by macOS before `main` — the tell is
# exit 137), and then proves the RUNNING pid executes the file that was just staged.
#
# Every external command is overridable, exactly like the gates above, so this half's safety
# logic is unit-tested in milliseconds without a real cargo build.
RUST_PLATFORM_CMD="${RUST_PLATFORM_CMD:-node scripts/deploy-rust-helper.js platform-arch}"
RUST_HASH_CMD="${RUST_HASH_CMD:-node scripts/deploy-rust-helper.js rust-hash}"
RUST_BUILD_CMD="${RUST_BUILD_CMD:-cargo build --release --manifest-path rust-core/Cargo.toml}"
RUST_STAGE_CMD="${RUST_STAGE_CMD:-__default_rust_stage__}"
RUST_CODESIGN_CMD="${RUST_CODESIGN_CMD:-__default_rust_codesign__}"
RUST_VERIFY_CMD="${RUST_VERIFY_CMD:-node scripts/deploy-rust-helper.js verify-running}"
RUST_VERIFY_ATTEMPTS="${RUST_VERIFY_ATTEMPTS:-20}"
RUST_SKIPPED=0

# The mtime (epoch seconds) of a file, portable across BSD and GNU stat.
file_mtime() {
  stat -c %Y "$1" 2>/dev/null || stat -f %m "$1" 2>/dev/null || echo ""
}

# The size of a file in bytes, portable across BSD and GNU stat.
file_size() {
  stat -c %s "$1" 2>/dev/null || stat -f %z "$1" 2>/dev/null || echo ""
}

# The default staging: copy the four SHIPPED binaries (the same set publish.yml stages and
# scripts/verify-bin-native.js checks) into bin-native/<platform>-<arch>/. FOUR, not everything
# cargo produced: bin-native/ is packed into the npm tarball and the publish workflow asserts
# exactly 16 bin-native files (4 targets x 4 binaries).
#
# COPY-THEN-RENAME, not a plain `cp` over the destination: the destination may be the file the
# RUNNING server has mapped, and writing into it fails with ETXTBSY ("Text file busy"). A rename
# replaces the directory entry instead, leaving the running process on its old inode — which the
# verify step then reports as a mismatch instead of a crash.
default_rust_stage() {
  local b tmp
  mkdir -p "$RUST_STAGE_DIR" || return 1
  for b in alcore alstore alscan allogscan; do
    if [ -f "$RUST_BUILD_DEST/$b" ]; then
      tmp="$RUST_STAGE_DIR/.$b.new.$$"
      cp "$RUST_BUILD_DEST/$b" "$tmp" || return 1
      chmod +x "$tmp" || return 1
      mv -f "$tmp" "$RUST_STAGE_DIR/$b" || return 1
    fi
  done
  if [ ! -f "$RUST_STAGE_DIR/alcore" ]; then
    echo "   the cargo build produced no alcore at $RUST_BUILD_DEST/alcore" >&2
    return 1
  fi
  ls -l "$RUST_STAGE_DIR" | sed 's/^/   /'
  return 0
}

# The default codesign: an ad-hoc signature on every staged binary. macOS SIGKILLs an unsigned
# binary before `main` (exit 137) — the failure mode this whole half exists to prevent. On a
# non-macOS host there is no codesign and no Gatekeeper, so the step is a stated skip, not a
# silent one.
default_rust_codesign() {
  local b signed=0
  if [ "$(uname -s)" != "Darwin" ]; then
    echo "   not macOS ($(uname -s)) — codesign is not applicable here, SKIPPED"
    return 0
  fi
  for b in alcore alstore alscan allogscan; do
    if [ -f "$RUST_STAGE_DIR/$b" ]; then
      codesign -s - --force "$RUST_STAGE_DIR/$b" || return 1
      signed=$((signed + 1))
    fi
  done
  echo "   codesigned $signed staged binary/binaries"
  return 0
}

# Is the rust workspace unchanged since the last staging? CONTENT-based (the source hash), with
# the staged binary's mtime+size as the second half: a `git checkout` back and forth rewrites
# mtimes without changing the code, and a rebuild is then pure waste. The mtime+size half also
# catches a hand-replaced binary in bin-native/ (the out-of-band step that stranded 81 commits):
# a file that no longer matches the stamp is treated as "not what we staged" and rebuilt.
#
# The stamp lives in rust-core/target/ — gitignored, and outside bin-native/ (which is packed
# into the npm tarball, so a stamp there would ship).
rust_workspace_unchanged() {
  local stamp_hash stamp_mtime stamp_size
  [ -f "$RUST_STAMP_FILE" ] || return 1
  read -r stamp_hash stamp_mtime stamp_size < "$RUST_STAMP_FILE" 2>/dev/null || return 1
  [ -n "$stamp_hash" ] && [ "$stamp_hash" = "$RUST_HASH" ] || return 1
  [ -x "$RUST_STAGE_DIR/alcore" ] || return 1
  [ "$(file_mtime "$RUST_STAGE_DIR/alcore")" = "$stamp_mtime" ] || return 1
  [ "$(file_size "$RUST_STAGE_DIR/alcore")" = "$stamp_size" ] || return 1
  return 0
}

# Record what was staged, so the next deploy can tell whether a rebuild is needed at all.
write_rust_stamp() {
  mkdir -p "$(dirname "$RUST_STAMP_FILE")" || return 1
  printf '%s %s %s\n' "$RUST_HASH" "$(file_mtime "$RUST_STAGE_DIR/alcore")" "$(file_size "$RUST_STAGE_DIR/alcore")" > "$RUST_STAMP_FILE" || return 1
  return 0
}

# The RUNNING process must execute the file that was just staged. An INODE comparison, not a
# path comparison: replacing a binary leaves the running process on the OLD inode while the path
# already reads the NEW file, so a path check would say "fine" while the server keeps serving the
# old code — the silent-stale-server failure this whole half exists to prevent. Exit 2 from the
# verifier means "no live server owns the data dir" (the restart has not come up yet) and is
# retried; exit 1 is a real mismatch.
verify_running_process() {
  local attempt out rc
  attempt=0
  # The verifier is told WHICH file was staged, so it compares the running pid's executable
  # against the staged INODE — not against a path it recomputes. RUST_STAGE_DIR is exported so
  # the helper sees the same directory this script staged into.
  export RUST_STAGE_DIR
  while :; do
    attempt=$((attempt + 1))
    out="$(eval "$RUST_VERIFY_CMD" 2>&1)"; rc=$?
    [ -n "$out" ] && echo "$out"
    if [ "$rc" -eq 0 ]; then return 0; fi
    # exit 2 = "no live server owns the data dir" (the restart has not come up yet) → keep
    # waiting. exit 1 = a REAL mismatch (a live server running a different inode) → that will
    # not fix itself, so it is retried only three times before the deploy goes RED.
    if [ "$rc" -ne 2 ] && [ "$attempt" -ge 3 ]; then break; fi
    if [ "$attempt" -ge "$RUST_VERIFY_ATTEMPTS" ]; then break; fi
    sleep 1
  done
  fail "verify-running (the running server does not execute the staged binary)"
}

# Tracks how far the run actually got, so the abort message can STATE THE TRUE BUNDLE STATE rather
# than assert one. It used to hardcode "ABORTED before building … UNTOUCHED" for every failure — but
# fail() is also called AFTER the build (esbuild itself, and the restart), so a restart failure
# printed "the live bundle is UNTOUCHED" while a freshly-built bundle was sitting on disk. That is
# the one question this script exists to answer ("did my change ship?"), answered wrong, in the
# direction that makes you stop looking. Observed live 2026-08-05.
#
# The RUST half has its own stage, because a rust failure is NOT the generic "the live bundle is
# UNTOUCHED": the JS bundle may be perfectly fresh while the server still runs the OLD alcore
# (the deployed alcore IS the backend — the TS server was retired in 567fc5c2). Saying "UNTOUCHED"
# there would send the operator looking in the wrong place — the same class of wrong answer this
# function exists to stop.
STAGE=pre-build   # pre-build → building → built → rust-building → rust-built

fail() {
  echo ""
  echo "❌ RED — '$1' failed."
  case "$STAGE" in
    pre-build)
      echo "   ABORTED before building. The live bundle is UNTOUCHED (the last known-good build stays deployed)." ;;
    building)
      echo "   FAILED DURING THE BUILD. The on-disk bundle may be PARTIALLY WRITTEN — do not trust it;"
      echo "   re-run this script, and until it goes green treat the deployed bundle as unknown." ;;
    built)
      echo "   The build SUCCEEDED and the new bundle IS on disk — this failed afterwards, so the code"
      echo "   is deployed but the server may still be running the OLD bundle. Check with"
      echo "   'agentlenspro server status' and restart before trusting a measurement." ;;
    rust-building)
      echo "   FAILED DURING THE RUST BUILD. The JS bundle above may be fresh, but the RUST half is"
      echo "   SUSPECT: the server runs the alcore binary, and it is still the OLD one. The deployed"
      echo "   backend is NOT what you just built — fix the rust build and re-run before trusting a"
      echo "   measurement." ;;
    rust-built)
      echo "   The RUST BUILD SUCCEEDED and the new binaries ARE staged in $RUST_STAGE_DIR — this"
      echo "   failed afterwards, so the server may still be running the OLD binary. The JS bundle is"
      echo "   fresh; the BACKEND may not be. Check with 'agentlenspro server status' and restart"
      echo "   before trusting a measurement." ;;
  esac
  exit 1
}
step() { echo ""; echo "▶ $1"; }

echo "safe-deploy: gate-then-build for the dogfood link (repo: $REPO)"

step "gate 1/5 — check-types (tsc: src + media)"
eval "$GATE_CHECKTYPES" || fail "check-types"

step "gate 2/5 — lint"
eval "$GATE_LINT" || fail "lint"

step "gate 3/5 — check-no-mirrors (one source of truth in src/shared)"
eval "$GATE_MIRRORS" || fail "check-no-mirrors"

step "gate 4/5 — compile-tests"
eval "$GATE_COMPILE_TESTS" || fail "compile-tests"

step "gate 5/5 — full test suite (mocha)"
if [ -n "${GATE_MOCHA:-}" ]; then
  eval "$GATE_MOCHA" || fail "test suite"
else
  TEST_NODE="$(resolve_test_node)"
  echo "  test node: $TEST_NODE ($("$TEST_NODE" --version 2>/dev/null))"
  require_store_capable_node "$TEST_NODE"
  PATH="$(dirname "$TEST_NODE"):$PATH" npx mocha || fail "test suite"
fi

echo ""
echo "✅ GREEN — all gates passed."

# ── The RUST half, resolved BEFORE the dry-run exit so a dry run can REPORT it ─────────────
#
# The platform-arch key is the product's OWN spelling (`${process.platform}-${process.arch}` in
# src/rustBinResolve.ts npmPlatformBin and src/cli/serverControl.ts alcoreBin) — read through the
# helper rather than re-derived here, so the deploy stages into the directory the resolver will
# look in. A second, slightly different spelling would stage somewhere the server never reads,
# and the deploy would again say "shipped" while the old binary kept serving.
RUST_PLATFORM="$(eval "$RUST_PLATFORM_CMD" 2>/dev/null | tr -d '[:space:]')"
if [ -z "$RUST_PLATFORM" ]; then
  echo "❌ the platform-arch could not be determined ('$RUST_PLATFORM_CMD' produced nothing)."
  echo "   The rust half cannot be staged blind — refusing to report a deploy that shipped nothing."
  exit 1
fi
RUST_STAGE_DIR="${RUST_STAGE_DIR:-$REPO/bin-native/$RUST_PLATFORM}"
RUST_BUILD_DEST="${RUST_BUILD_DEST:-$REPO/rust-core/target/release}"
RUST_STAMP_FILE="${RUST_STAMP_FILE:-$REPO/rust-core/target/.deploy-rust-stamp}"
RUST_HASH="$(eval "$RUST_HASH_CMD" 2>/dev/null | tr -d '[:space:]')"

if [ "$DRYRUN" -eq 1 ]; then
  echo ""
  echo "▶ dry-run — what WOULD be shipped (both halves):"
  echo "   half 1 — JS bundle:    node esbuild.js → standalone/cli.js, media/dashboard.js, …"
  echo "   half 2 — RUST binary:  $RUST_BUILD_CMD"
  echo "                           → $RUST_STAGE_DIR/{alcore,alstore,alscan,allogscan} (platform: $RUST_PLATFORM)"
  echo "                           → codesign -s - --force (macOS) + executable check"
  if [ -n "$RUST_HASH" ] && rust_workspace_unchanged; then
    echo "                           → the rust workspace is UNCHANGED since the last staging — the build would be SKIPPED"
  else
    echo "                           → the rust workspace CHANGED — the build would RUN"
  fi
  echo "   then: server restart, then an inode check that the running pid executes the staged binary."
  echo ""
  echo "   --dry-run: NOT building or restarting (neither the JS bundle nor the rust binary)."
  exit 0
fi

step "build — writing the live bundle (node esbuild.js)"
STAGE=building
eval "$BUILD_CMD" || fail "esbuild"
STAGE=built

# ── The rust half ───────────────────────────────────────────────────────────────────────────
#
# ORDER: the JS bundle is built FIRST (it is the cheap half and the one the gates already cover),
# then the rust workspace is built and staged. A rust failure therefore leaves a FRESH JS bundle
# on disk and the OLD binary serving — which is exactly why fail() has a rust-specific message
# instead of claiming the live bundle is UNTOUCHED.
step "rust — building + staging the Rust backend (the deployed alcore IS the server)"
STAGE=rust-building
if [ -z "$RUST_HASH" ]; then
  echo "❌ the rust source hash could not be computed ('$RUST_HASH_CMD' produced nothing)."
  echo "   Without it the deploy cannot tell a changed workspace from an unchanged one, and a"
  echo "   silent skip would look identical to a shipped rebuild. Refusing."
  exit 1
fi
if rust_workspace_unchanged; then
  RUST_SKIPPED=1
  echo "  ⏭  SKIPPED — the rust workspace is UNCHANGED since the last staging."
  echo "     (source hash $RUST_HASH matches the stamp; the staged binary is untouched)"
  echo "     This is a SKIP, not a rebuild: the rust half was NOT rebuilt by this run."
  STAGE=rust-built
else
  echo "  building: $RUST_BUILD_CMD"
  eval "$RUST_BUILD_CMD" || fail "cargo build --release (rust-core)"
  echo "  staging into $RUST_STAGE_DIR"
  if [ "$RUST_STAGE_CMD" = "__default_rust_stage__" ]; then
    default_rust_stage || fail "rust staging into $RUST_STAGE_DIR"
  else
    eval "$RUST_STAGE_CMD" || fail "rust staging into $RUST_STAGE_DIR"
  fi
  # The staged binary must be EXECUTABLE. A binary that lost its x-bit (a zip round-trip, a
  # bad copy) resolves but then fails at spawn — and the product's own resolver
  # (src/rustBinResolve.ts) treats a present-but-not-executable file as a CORRUPT INSTALL.
  if [ ! -x "$RUST_STAGE_DIR/alcore" ]; then
    echo "❌ the staged binary $RUST_STAGE_DIR/alcore is NOT EXECUTABLE — refusing to continue."
    echo "   A present-but-not-executable binary resolves and then fails at spawn; the product's"
    echo "   own resolver (src/rustBinResolve.ts) treats it as a corrupt install."
    fail "staging (the staged binary is not executable)"
  fi
  echo "  codesigning the staged binaries (macOS SIGKILLs an unsigned binary before main)"
  if [ "$RUST_CODESIGN_CMD" = "__default_rust_codesign__" ]; then
    default_rust_codesign || fail "codesign of the staged binaries"
  else
    eval "$RUST_CODESIGN_CMD" || fail "codesign of the staged binaries"
  fi
  # Re-check AFTER the codesign: signing rewrites the file, and a signing step that dropped the
  # x-bit would leave an unspawnable binary behind a green codesign.
  if [ ! -x "$RUST_STAGE_DIR/alcore" ]; then
    echo "❌ the staged binary $RUST_STAGE_DIR/alcore is NOT EXECUTABLE after codesigning."
    fail "codesign (the staged binary is not executable)"
  fi
  STAGE=rust-built
  write_rust_stamp || echo "   (note: could not write the rust stamp $RUST_STAMP_FILE — the next deploy will rebuild)"
  echo "  ✓ rust staged: $RUST_STAGE_DIR/alcore"
fi

# Smoke: the freshly-written bundle must LOAD and report the expected version before we make it live.
# esbuild-fails-after-tsc-green is rare, but a partial/broken bundle here must NOT trigger a restart.
step "smoke — the freshly-built CLI loads and runs"
if [ "$SMOKE_CMD" = "__default_smoke__" ]; then
  EXPECT="$(node -e "process.stdout.write(require('./package.json').version)")"
  GOT="$(node standalone/cli.js --version 2>/dev/null | head -1 | tr -d '[:space:]')"
  if [ "$GOT" != "$EXPECT" ]; then
    echo "❌ smoke FAILED: built CLI reported '$GOT', expected '$EXPECT'."
    echo "   The bundle is on disk but suspect — NOT restarting (the running server keeps the prior code)."
    exit 1
  fi
  echo "  cli --version = $GOT ✓"
else
  eval "$SMOKE_CMD" || { echo "❌ smoke FAILED — NOT restarting."; exit 1; }
fi

if [ "$RESTART" -eq 1 ]; then
  step "restart — server onto the fresh bundle + binary"
  eval "$RESTART_CMD" || fail "server restart"
  # The deploy did NOT take is a LOUD failure, not a stale server that looks healthy. The check
  # is an INODE comparison (see the helper): the running pid must execute the file that was just
  # staged. A path comparison would say "fine" while the process still runs the old inode.
  step "verify — the running server executes the binary that was just staged"
  verify_running_process
else
  echo ""
  echo "   --no-restart: bundle built + smoke-passed, server left as-is."
  echo "   The running server may still be executing the PREVIOUS binary — restart it before"
  echo "   trusting a measurement."
fi

echo ""
if [ "$RUST_SKIPPED" -eq 1 ]; then
  if [ "$RESTART" -eq 1 ]; then
    echo "✅ DEPLOYED — green gates, fresh bundle live; the RUST half was SKIPPED (workspace unchanged)."
  else
    echo "✅ BUILT (not restarted) — green gates, fresh bundle on disk; the RUST half was SKIPPED (workspace unchanged)."
  fi
elif [ "$RESTART" -eq 1 ]; then
  echo "✅ DEPLOYED — green gates, fresh bundle live, fresh rust binary staged and verified."
else
  echo "✅ BUILT (not restarted) — green gates, fresh bundle + fresh rust binary on disk; the running"
  echo "   server still executes the PREVIOUS binary — restart it before trusting a measurement."
fi
