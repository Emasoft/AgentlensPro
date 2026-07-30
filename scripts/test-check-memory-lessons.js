#!/usr/bin/env node
// Case matrix for check-memory-lessons.js. It runs the REAL checker over fixture dirs rather
// than re-implementing its regexes — a test that owns its own copy of the matching proves
// nothing about the matching that ships (the deny-hook guard in this repo learned that the
// hard way, where a substring matcher passed its author's eye and blocked `git add`).
//
// Run: node scripts/test-check-memory-lessons.js
'use strict'

const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawnSync } = require('child_process')

const CHECKER = path.join(__dirname, 'check-memory-lessons.js')
const GOOD = '[^1]: [id:ATOM-AAAA-BBBB, status:valid, keywords:"a_symptom another_symptom", ocd:2026-07-30, lmd:2026-07-30]\n  DO NOT x, BECAUSE y. DO z instead.\n'

const CASES = [
  { name: 'a fully-formed lesson passes', body: GOOD, expect: 0 },
  {
    name: 'no metadata block at all is caught',
    body: '[^1]: promoted from the old note, with no bracket block\n',
    expect: 1, expectText: 'the whole [id:',
  },
  {
    name: 'metadata without id: is caught',
    body: '[^1]: [status:valid, keywords:"a_symptom", ocd:2026-07-30, lmd:2026-07-30] text\n',
    expect: 1, expectText: 'missing id:',
  },
  {
    name: 'metadata without keywords: is caught',
    body: '[^1]: [id:ATOM-A, status:valid, ocd:2026-07-30, lmd:2026-07-30] text\n',
    expect: 1, expectText: 'missing keywords:',
  },
  {
    name: 'the ocd/lmd-only shape (the real corpus defect) is caught on BOTH fields',
    body: '[^1]: [ocd:2026-07-11 lmd:2026-07-11] promoted from the old-repo LOCAL note\n',
    expect: 1, expectText: 'missing id: + keywords:',
  },
  {
    name: 'an EMPTY keywords value is caught — it ranks on nothing, same as absent',
    body: '[^1]: [id:ATOM-A, status:valid, keywords:"", ocd:2026-07-30, lmd:2026-07-30] text\n',
    expect: 1, expectText: 'missing keywords:',
  },
  {
    name: 'a whitespace-only keywords value is caught',
    body: '[^1]: [id:ATOM-A, status:valid, keywords:"   ", ocd:2026-07-30, lmd:2026-07-30] text\n',
    expect: 1, expectText: 'missing keywords:',
  },
  {
    name: 'a footnote REFERENCE in prose is not a definition and is never flagged',
    body: 'The window is metered by cost, not raw tokens.[^1]\n\n' + GOOD,
    expect: 0,
  },
  {
    name: 'an indented continuation line is not read as a second lesson',
    body: '[^1]: [id:ATOM-A, status:valid, keywords:"a_symptom", ocd:2026-07-30, lmd:2026-07-30]\n  [^2]: this indented line is prose, not a definition\n',
    expect: 0,
  },
  {
    name: 'a lettered label like [^1a] is still a lesson',
    body: '[^1a]: [ocd:2026-07-11 lmd:2026-07-11] no id, no keywords\n',
    expect: 1, expectText: '[^1a]',
  },
  {
    name: 'MEMORY.md is the harness index, not a wiki page — never scanned',
    file: 'MEMORY.md',
    body: '[^1]: [ocd:2026-07-11 lmd:2026-07-11] would fail if this file were scanned\n',
    expect: 0,
  },
  { name: 'an empty corpus passes', body: '', expect: 0 },
]

function run(dir) {
  const r = spawnSync(process.execPath, [CHECKER, dir], { encoding: 'utf8' })
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') }
}

function main() {
  const rows = []
  let failed = 0

  for (const c of CASES) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memlessons-'))
    try {
      if (c.body !== '') fs.writeFileSync(path.join(dir, c.file || 'page.md'), c.body)
      const { code, out } = run(dir)
      const okCode = code === c.expect
      const okText = !c.expectText || out.includes(c.expectText)
      const ok = okCode && okText
      if (!ok) {
        failed++
        rows.push(`  FAIL  ${c.name}\n        exit=${code} (want ${c.expect})${c.expectText && !okText ? `; output missing ${JSON.stringify(c.expectText)}` : ''}`)
      } else {
        rows.push(`  ok    ${c.name}`)
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }

  console.log(rows.join('\n'))
  console.log(`\n${CASES.length - failed}/${CASES.length} passing`)
  if (failed) process.exit(1)
}

main()
