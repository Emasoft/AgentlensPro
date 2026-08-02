#!/usr/bin/env node
// Test matrix for the outbound-identity guard. A hook with no test is an unverified control, and
// this one has two failure modes that only a matrix catches: denying a harmless grep whose PATTERN
// looks like an address (too broad) and missing the exact shape the real incident took — a body
// passed by --body-file rather than inline (too narrow).
const { execFileSync } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')

const GUARD = path.join(__dirname, 'deny-identity-leak-to-github.js')

function decide(command) {
  const out = execFileSync('node', [GUARD], { input: JSON.stringify({ tool_input: { command } }) }).toString()
  if (!out.trim()) return 'allow'
  return JSON.parse(out).hookSpecificOutput.permissionDecision
}

function reason(command) {
  const out = execFileSync('node', [GUARD], { input: JSON.stringify({ tool_input: { command } }) }).toString()
  return out.trim() ? JSON.parse(out).hookSpecificOutput.permissionDecisionReason : ''
}

// A real body file carrying the exact shape that leaked: an account table with addresses.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'al-guard-'))
const leakFile = path.join(tmp, 'body.md')
fs.writeFileSync(leakFile, '| account | email |\n| 75099fe9 | someone@gmail.com |\n')
const cleanFile = path.join(tmp, 'clean.md')
fs.writeFileSync(cleanFile, '| account | plan |\n| 75099fe9 | Max 20x |\n')

const DENY = [
  'gh issue create --repo Emasoft/AgentlensPro --title T --body "ping someone@gmail.com"',
  'gh issue comment 8 --body "the account is someone@gmail.com"',
  'gh pr create --title T --body "see /Users/realname/Code/thing"',
  'gh pr comment 4 --body "logs in /home/realname/.agentlens"',
  'gh release create v1.0.0 --notes "thanks someone@gmail.com"',
  `gh issue create --title T --body-file ${leakFile}`,           // the shape the real incident took
  `gh issue comment 8 -F ${leakFile}`,
  'cd /tmp && gh issue comment 8 --body "someone@gmail.com"',    // later segment
  'gh issue create --title T --body "C:\\Users\\realname\\notes"',
]

const ALLOW = [
  // Read verbs publish nothing.
  'gh issue view 8 --repo Emasoft/AgentlensPro',
  'gh pr diff 6',
  'gh api /repos/Emasoft/AgentlensPro/issues/8',
  // Posting, but with no identity in it.
  'gh issue create --repo Emasoft/AgentlensPro --title T --body "the setup verb now streams segments"',
  `gh issue create --title T --body-file ${cleanFile}`,
  // The sanctioned public identity and the reserved example domains must not trip it.
  'gh issue comment 8 --body "commits are authored by 713559+Emasoft@users.noreply.github.com"',
  'gh issue comment 8 --body "configure it as you@example.com"',
  // Placeholder homes carry no identity.
  'gh issue comment 8 --body "fixtures use /Users/x/project"',
  'gh pr comment 4 --body "on CI the path is /home/runner/work"',
  // Not gh at all — including greps whose PATTERN looks like an address. This is the "too broad"
  // regression: an earlier shape of this guard would have blocked the very command that finds leaks.
  'grep -rn "[a-z]*@[a-z]*\\.com" reports/',
  'git add scripts/deny-identity-leak-to-github.js',
  'node scripts/test-deny-identity-leak-to-github.js',
  'echo "someone@gmail.com" > /tmp/scratch.txt',
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

// The denial must not reprint the address it is protecting — a transcript gets shared too.
const r = reason('gh issue comment 8 --body "someone@gmail.com"')
if (r.includes('someone@gmail.com')) { console.error('FAIL denial reason leaked the address verbatim'); failures++ }
if (!r.includes('s***@gmail.com')) { console.error(`FAIL denial reason did not name the masked match: ${r}`); failures++ }

fs.rmSync(tmp, { recursive: true, force: true })

if (failures) { console.error(`\n${failures} case(s) failed`); process.exit(1) }
console.log(`identity-leak guard: ${DENY.length + ALLOW.length} cases + 2 message assertions passed`)
