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
# Usage: scripts/safe-deploy.sh [--dry-run] [--no-restart]
#   --dry-run      run every gate but do NOT build or restart (a CI-style check)
#   --no-restart   build on green but leave the running server as-is
#
# Node note: pnpm/tsc/esbuild run under the invoking Node; the mocha suite's known-good baseline runs
# under Node 20, resolved automatically (override with AGENTLENS_TEST_NODE=/path/to/node).
#
# Testability: every external command is overridable via an env var (GATE_CHECKTYPES, GATE_LINT,
# GATE_MIRRORS, GATE_COMPILE_TESTS, GATE_MOCHA, BUILD_CMD, SMOKE_CMD, RESTART_CMD) so the safety logic
# (abort-before-build) is unit-tested in milliseconds without the real ~1-minute suite. These are
# operator/test-controlled, never untrusted input.

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

  --dry-run      run every gate but do NOT build or restart
  --no-restart   build on green but leave the running server as-is
  -h, --help     this help
EOF
      exit 0 ;;
    *) echo "safe-deploy: unknown argument '$arg' (try --help)" >&2; exit 2 ;;
  esac
done

# Resolve the Node used for the mocha step (Node 20 baseline). AGENTLENS_TEST_NODE overrides; else the
# newest local nvm v20; else the current node (with the version echoed) so a missing exact version
# never hard-blocks a deploy.
resolve_test_node() {
  if [ -n "${AGENTLENS_TEST_NODE:-}" ] && [ -x "${AGENTLENS_TEST_NODE}" ]; then
    printf '%s' "${AGENTLENS_TEST_NODE}"; return
  fi
  local nvmdir="$HOME/.nvm/versions/node"
  if [ -d "$nvmdir" ]; then
    # Glob the v20.* dirs (nullglob → empty on no match) and pick the highest by version sort — no
    # `ls | grep` (SC2010), and version-sort so v20.10 > v20.9 (lexical glob order would get that wrong).
    shopt -s nullglob
    local candidates=("$nvmdir"/v20.*)
    shopt -u nullglob
    if [ "${#candidates[@]}" -gt 0 ]; then
      local best
      best="$(printf '%s\n' "${candidates[@]}" | sort -V | tail -1)"
      if [ -n "$best" ] && [ -x "$best/bin/node" ]; then
        printf '%s' "$best/bin/node"; return
      fi
    fi
  fi
  command -v node
}

# Gate/build/restart commands — overridable for tests (defaults are the real gates).
GATE_CHECKTYPES="${GATE_CHECKTYPES:-pnpm run check-types}"
GATE_LINT="${GATE_LINT:-pnpm run lint}"
GATE_MIRRORS="${GATE_MIRRORS:-node scripts/check-no-mirrors.js}"
GATE_COMPILE_TESTS="${GATE_COMPILE_TESTS:-pnpm run compile-tests}"
BUILD_CMD="${BUILD_CMD:-node esbuild.js}"
SMOKE_CMD="${SMOKE_CMD:-__default_smoke__}"
RESTART_CMD="${RESTART_CMD:-agentlenspro server restart}"

fail() {
  echo ""
  echo "❌ RED — '$1' failed."
  echo "   ABORTED before building. The live bundle is UNTOUCHED (the last known-good build stays deployed)."
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
  PATH="$(dirname "$TEST_NODE"):$PATH" npx mocha || fail "test suite"
fi

echo ""
echo "✅ GREEN — all gates passed."

if [ "$DRYRUN" -eq 1 ]; then
  echo "   --dry-run: NOT building or restarting."
  exit 0
fi

step "build — writing the live bundle (node esbuild.js)"
eval "$BUILD_CMD" || fail "esbuild (WARNING: the on-disk bundle may be partially written — inspect before use)"

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
  step "restart — server onto the fresh bundle"
  eval "$RESTART_CMD" || fail "server restart"
else
  echo ""
  echo "   --no-restart: bundle built + smoke-passed, server left as-is."
fi

echo ""
echo "✅ DEPLOYED — green gates, fresh bundle live."
