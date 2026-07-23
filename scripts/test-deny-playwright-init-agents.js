#!/usr/bin/env node
// Test matrix for the PreToolUse guard. A hook with no test is an unverified control, and this
// one already shipped a defect that only a test would have caught: substring matching blocked
// `git add` of the guard's own filename.
const { execFileSync } = require('child_process')
const path = require('path')

const GUARD = path.join(__dirname, 'deny-playwright-init-agents.js')

function decide(command) {
  const out = execFileSync('node', [GUARD], { input: JSON.stringify({ tool_input: { command } }) }).toString()
  if (!out.trim()) return 'allow'
  return JSON.parse(out).hookSpecificOutput.permissionDecision
}

const DENY = [
  'npx playwright init-agents',
  'npx playwright init-agents --loop claude',
  'pnpm exec playwright init-agents --prompts',
  './node_modules/.bin/playwright init-agents',
  'playwright init-agents',
  'cd /tmp && npx playwright init-agents',           // later segment
  '"playwright" init-agents',                         // quoted binary
]

const ALLOW = [
  'npx playwright test',
  'npx playwright install chromium',
  'playwright --version',
  'git status',
  // The regression that motivated token matching: the guard's own path names both words.
  'git add scripts/deny-playwright-init-agents.js',
  'cat scripts/deny-playwright-init-agents.js',
  'node scripts/test-deny-playwright-init-agents.js',
]

let failures = 0
for (const c of DENY) {
  const got = decide(c)
  if (got !== 'deny') { console.error(`FAIL expected deny, got ${got}: ${c}`); failures++ }
}
for (const c of ALLOW) {
  const got = decide(c)
  if (got !== 'allow') { console.error(`FAIL expected allow, got ${got}: ${c}`); failures++ }
}

// A guard that cannot read its own input must not block every Bash call in the session.
const malformed = execFileSync('node', [GUARD], { input: 'not json' }).toString()
if (malformed.trim()) { console.error('FAIL malformed payload must allow'); failures++ }

console.log(failures === 0
  ? `deny-playwright-init-agents: ${DENY.length + ALLOW.length + 1} cases OK`
  : `deny-playwright-init-agents: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
