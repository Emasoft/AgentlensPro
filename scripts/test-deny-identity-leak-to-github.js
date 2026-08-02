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

// The fixtures are ASSEMBLED AT RUNTIME rather than written as literals, so this file contains no
// address-shaped and no home-path-shaped text of its own. That is not squeamishness: `pnpm run
// check-identities` scans tracked files by SHAPE and cannot tell a test fixture from a real leak —
// nor should it try, since a synthetic placeholder address sitting in someone's docs is exactly the
// ambiguity that wasted time during the 2026-08-02 sweep. The guard under test, meanwhile, must
// treat these as real (example.com is explicitly allowed, so it cannot be used as a DENY fixture).
// Building them from parts is what lets both checks stay strict.
const AT = String.fromCharCode(64)
const ADDR = `someone${AT}gmail.com`
const MAC_HOME = `/Users${'/'}realname`
const LINUX_HOME = `/home${'/'}realname`
const WIN_HOME = `C:\\Users${'\\'}realname`

// A real body file carrying the exact shape that leaked: an account table with an address.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'al-guard-'))
const leakFile = path.join(tmp, 'body.md')
fs.writeFileSync(leakFile, `| account | email |\n| 75099fe9 | ${ADDR} |\n`)
const cleanFile = path.join(tmp, 'clean.md')
fs.writeFileSync(cleanFile, '| account | plan |\n| 75099fe9 | Max 20x |\n')

const DENY = [
  `gh issue create --repo Emasoft/AgentlensPro --title T --body "ping ${ADDR}"`,
  `gh issue comment 8 --body "the account is ${ADDR}"`,
  `gh pr create --title T --body "see ${MAC_HOME}/Code/thing"`,
  `gh pr comment 4 --body "logs in ${LINUX_HOME}/.agentlens"`,
  `gh release create v1.0.0 --notes "thanks ${ADDR}"`,
  `gh issue create --title T --body-file ${leakFile}`,           // the shape the real incident took
  `gh issue comment 8 -F ${leakFile}`,
  `cd /tmp && gh issue comment 8 --body "${ADDR}"`,              // later segment
  `gh issue create --title T --body "${WIN_HOME}\\notes"`,
  // @-mentions in rendered prose page a real GitHub account. Both of these are TAKEN handles that
  // agents actually paged on 2026-08-02 by writing role names.
  `gh issue comment 8 --body "routing this to ${AT}manager for approval"`,
  `gh issue create --title T --body "the ${AT}janitor heartbeat covers it"`,
  `gh pr comment 4 --body "cc ${AT}Emasoft"`,                     // even the owner: the rule is absolute
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
  `gh issue comment 8 --body "commits are authored by 713559+Emasoft${AT}users.noreply.github.com"`,
  'gh issue comment 8 --body "configure it as you@example.com"',
  // Placeholder homes carry no identity.
  'gh issue comment 8 --body "fixtures use /Users/x/project"',
  'gh pr comment 4 --body "on CI the path is /home/runner/work"',
  // Not gh at all — including greps whose PATTERN looks like an address. This is the "too broad"
  // regression: an earlier shape of this guard would have blocked the very command that finds leaks.
  'grep -rn "[a-z]*@[a-z]*\\.com" reports/',
  'git add scripts/deny-identity-leak-to-github.js',
  'node scripts/test-deny-identity-leak-to-github.js',
  `echo "${ADDR}" > /tmp/scratch.txt`,
  // A BACKTICKED handle renders as code and notifies nobody — this is the prescribed fix, so it
  // must pass, or the guard would forbid the very thing its message tells you to do.
  // Single-quoted on purpose: inside double quotes bash would command-substitute the backticks,
  // which is itself why real posts use --body-file or single quotes for anything with code in it.
  `gh issue comment 8 --body 'routing this to \`${AT}manager\` for approval'`,
  `gh issue create --title T --body 'fenced:\n\`\`\`\n${AT}janitor\n\`\`\`\n'`,
  // An email is the email rule's business, not a mention: its @ is preceded by a word character.
  `gh issue comment 8 --body "contact you${AT}example.com"`,
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
const r = reason(`gh issue comment 8 --body "${ADDR}"`)
if (r.includes(ADDR)) { console.error('FAIL denial reason leaked the address verbatim'); failures++ }
if (!r.includes(`${ADDR[0]}***${AT}gmail.com`)) {
  console.error(`FAIL denial reason did not name the masked match: ${r}`); failures++
}

fs.rmSync(tmp, { recursive: true, force: true })

if (failures) { console.error(`\n${failures} case(s) failed`); process.exit(1) }
console.log(`identity-leak guard: ${DENY.length + ALLOW.length} cases + 2 message assertions passed`)
