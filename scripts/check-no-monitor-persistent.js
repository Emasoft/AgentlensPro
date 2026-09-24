#!/usr/bin/env node
// scripts/check-no-monitor-persistent.js — refuse to ship a Monitor `persistent:` call.
//
// WHY THIS EXISTS. Claude Code 2.1.271 removed the Monitor tool's no-timeout `persistent` option
// (every watch now has a deadline of at most 30 minutes, 10 in a `-p` run, and notifies Claude to
// re-arm). The `agentlenspro-diagnostics` skill told agents to arm Monitor with `persistent: true`
// in three places and claimed the watch survives for the rest of the session/day — text that is
// simply wrong on 2.1.271+ and whose call the live Monitor schema now rejects
// (`additionalProperties: false`, no `persistent` key). Fixed once (TRDD-ZQQYRYBO increment I4);
// this guard is what keeps it fixed — a shipped skill is prose, so tsc/lint/tests cannot see it
// regress.
//
// SCOPE. Every file under skills/ and agents/ (whatever a fresh install actually ships), matched
// on a Monitor(...) call — bounded lookahead so a `persistent:` on an unrelated call elsewhere in
// the file is not a false positive.

const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..')
const SCAN_DIRS = ['skills', 'agents']

function walk(dir, out) {
  if (!fs.existsSync(dir)) return out
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(p, out)
    else out.push(p)
  }
  return out
}

const MONITOR_PERSISTENT = /Monitor\([\s\S]{0,600}?["']?\bpersistent["']?\s*:/

const findings = []
for (const dir of SCAN_DIRS) {
  for (const file of walk(path.join(ROOT, dir), [])) {
    const content = fs.readFileSync(file, 'utf8')
    if (MONITOR_PERSISTENT.test(content)) {
      findings.push(path.relative(ROOT, file))
    }
  }
}

if (findings.length > 0) {
  console.error('check-no-monitor-persistent: FAIL — Monitor `persistent:` found (removed in Claude Code 2.1.271; use `timeout_ms` instead):')
  for (const f of findings) console.error(`  ${f}`)
  process.exit(1)
}

console.log('check-no-monitor-persistent: OK — no shipped skill/agent uses Monitor `persistent:`')
