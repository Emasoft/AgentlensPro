#!/usr/bin/env node
// Matrix for scripts/deny-unscoped-measurement.js.
//
// The ALLOW cases carry more weight than the DENY cases. A guard that reddens on correct work is
// worse than no guard, because it gets disabled and then protects nothing — so every shape that
// looks superficially like a violation but is legitimate (`tail -f` on a log, `cat f | head`,
// `cargo fmt --check` with no path, the bracket trick) is pinned here deliberately.

const { execFileSync } = require('child_process')
const path = require('path')

const GUARD = path.join(__dirname, 'deny-unscoped-measurement.js')

function verdict(command) {
  const out = execFileSync('node', [GUARD], {
    input: JSON.stringify({ tool_input: { command } }),
    encoding: 'utf8',
  })
  if (!out.trim()) return 'allow'
  return JSON.parse(out).hookSpecificOutput.permissionDecision
}

const CASES = [
  // ── rule 1: cargo fmt scoping ────────────────────────────────────────────────────────────
  ['cargo fmt -- --check crates/tldr-core/src/ast/extractor.rs', 'deny', 'the exact call that produced two opposite false verdicts'],
  ['cargo fmt -- --check src/lib.rs', 'deny', 'any path after -- is unscoped'],
  ['cargo fmt --check', 'allow', 'whole-crate check is CORRECT and must stay usable'],
  ['cargo fmt', 'allow', 'plain formatting'],
  ['rustfmt --check --edition 2021 src/lib.rs', 'allow', 'the RIGHT command must never be blocked'],

  // ── rule 2: measurement into a truncator ─────────────────────────────────────────────────
  ['cargo test --workspace | tail -3', 'deny', 'hid the totals AND replaced cargo exit with tail'],
  ['cargo test --workspace 2>&1 | tail -40', 'deny', 'same with stderr merged'],
  ['pnpm run check-types | head -5', 'deny', 'same shape, different tool'],
  ['npx mocha out/test/x.js | tail -20', 'deny', 'same shape'],
  ['make check | head', 'deny', 'same shape'],
  ['cargo test --workspace > /tmp/out.txt 2>&1', 'allow', 'the prescribed replacement'],
  ['cargo test --workspace | grep -E "^test result"', 'allow', 'grep does not truncate or buffer to EOF'],
  ['tail -f /tmp/server.log', 'allow', 'following a live log'],
  ['cargo test 2>&1 | tail -f', 'allow', '-f follows, never truncates'],
  ['cat /tmp/out.txt | head -20', 'allow', 'inspecting a FILE, not measuring a command'],
  ['grep error /tmp/out.txt | head -5', 'allow', 'file inspection'],
  ['head -20 /tmp/out.txt', 'allow', 'no pipe at all'],

  // ── rule 3: tee truncation ───────────────────────────────────────────────────────────────
  ['cargo build 2>&1 | tee /tmp/b.txt | head -18', 'deny', 'SIGPIPEs tee, silently truncating the file'],
  ['ls | tee /tmp/b.txt | tail -3', 'deny', 'same trap regardless of producer'],
  ['cargo build 2>&1 | tee /tmp/b.txt', 'allow', 'tee with no early-closing consumer is fine'],
  ['cargo build 2>&1 | tee /tmp/b.txt | grep error', 'allow', 'grep drains the stream'],

  // ── rule 4: self-matching process lookups ────────────────────────────────────────────────
  ['ps aux | grep alcore', 'deny', 'the pipeline shell carries the pattern in its own argv'],
  ['ps -ef | rg cargo', 'deny', 'same with ripgrep'],
  ['pgrep -f write_alerts_bot.py', 'deny', 'pgrep -f matches its own invocation'],
  ["pgrep -af '[w]rite_alerts_bot.py'", 'allow', 'the bracket trick breaks the self-match'],
  ['ps -eo pid,ppid,etime,command > /tmp/ps.txt', 'allow', 'the prescribed snapshot'],
  ['grep alcore /tmp/ps.txt', 'allow', 'grepping the snapshot cannot self-match'],
  ['pkill -TERM 1234', 'allow', 'killing by pid, no -f pattern'],

  // ── the filename trap the sibling guard documents ────────────────────────────────────────
  ['git add scripts/deny-unscoped-measurement.js', 'allow', 'the guard must not block committing itself'],
  ['cat scripts/deny-unscoped-measurement.js', 'allow', 'nor reading itself'],
  ['echo "never use cargo fmt -- --check <file>"', 'allow', 'prose ABOUT the hazard is not the hazard'],
]

let pass = 0
const failures = []
for (const [command, want, why] of CASES) {
  let got
  try {
    got = verdict(command)
  } catch (e) {
    got = `ERROR: ${e.message}`
  }
  if (got === want) {
    pass++
  } else {
    failures.push({ command, want, got, why })
  }
}

for (const f of failures) {
  console.error(`FAIL  want=${f.want} got=${f.got}\n      cmd: ${f.command}\n      why: ${f.why}`)
}
console.log(`deny-unscoped-measurement: ${pass}/${CASES.length} passed`)
process.exit(failures.length ? 1 : 0)
