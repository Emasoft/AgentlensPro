#!/usr/bin/env node
// Recall-invariant guard for the PROJECT wikimem: fails (exit 1) if any `[^N]:` lesson under
// .claude/project/memory/ lacks `id:` or a non-empty `keywords:` in its metadata block.
//
// Why only those two fields, and why a gate at all. A lesson is found by SYMPTOM, and
// `keywords:` is the only surface the search ranks on — so a lesson without it is on disk and
// unreachable. That is not a cosmetic lint: measured on this corpus on 2026-07-30, the same
// query shape returned nothing for a keyword-less lesson and returned the full text for one
// that had keywords, and 27 of 67 lessons here were in the first state. `id:` is the other
// half — `[^N]` is page-local and renumbers on every insert, so only `id` survives as a
// citable reference.
//
// Deliberately NOT checked: `lesson-uncited` (the linter's own text makes it conditional —
// "cite it from an atom IF it should travel with one" — and it is INFO, not a defect), and
// the LINK LAW (real, but backlink detection has a false-positive surface a CI gate should
// not own). Keep this gate to the invariant whose violation makes a memory silently not exist.
//
// Zero dependencies on purpose: memgrep is the richer linter, but it is an external Rust
// binary reporting 0.1.0 across two known schemas, so pinning CI to it would trade a
// deterministic check for an ambiguous one. Wired into `pnpm run check-memory` and CI.
'use strict'

const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
// An explicit dir argument exists so the case matrix in test-check-memory-lessons.js can run
// the real checker over fixtures instead of a copy of its regexes — a test that re-implements
// the matching proves nothing about the matching that ships.
const MEM_DIR = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.join(ROOT, '.claude', 'project', 'memory')

// A lesson line starts at column 0 with `[^<label>]:` and carries its metadata in the first
// bracketed block that follows. Continuation lines are indented, so anchoring at ^ is what
// keeps a footnote reference inside prose from being read as a definition.
const LESSON_RE = /^\[\^([^\]]+)\]:\s*(.*)$/

function metaBlock(rest) {
  // The block is `[...]` immediately after the label. Absent => the lesson has no metadata.
  if (!rest.startsWith('[')) return null
  const end = rest.indexOf(']')
  return end === -1 ? null : rest.slice(1, end)
}

function main() {
  if (!fs.existsSync(MEM_DIR)) {
    console.log('check-memory-lessons: no .claude/project/memory — nothing to check')
    return
  }

  const files = fs.readdirSync(MEM_DIR).filter(f => f.endsWith('.md') && f !== 'MEMORY.md').sort()
  const violations = []
  let lessons = 0

  for (const file of files) {
    const lines = fs.readFileSync(path.join(MEM_DIR, file), 'utf8').split('\n')
    lines.forEach((line, i) => {
      const m = LESSON_RE.exec(line)
      if (!m) return
      lessons++
      const [, label, rest] = m
      const meta = metaBlock(rest)
      const missing = []
      if (meta === null) {
        missing.push('the whole [id:… status:… keywords:… ocd:… lmd:…] block')
      } else {
        if (!/\bid:\s*\S/.test(meta)) missing.push('id:')
        // An empty or whitespace-only keywords value is the same failure as no keywords —
        // it ranks on nothing — so match a non-quote, non-space character inside the value.
        if (!/\bkeywords:\s*"?[^"\s]/.test(meta)) missing.push('keywords:')
      }
      if (missing.length) violations.push(`${file}:${i + 1}  [^${label}] missing ${missing.join(' + ')}`)
    })
  }

  if (violations.length > 0) {
    console.error('check-memory-lessons: lessons that cannot be recalled by symptom.\n')
    console.error('`keywords:` is the only field recall ranks on, and `[^N]` renumbers so only')
    console.error('`id:` is a durable citation. A lesson missing either is on disk and unreachable.\n')
    for (const v of violations) console.error('  ' + v)
    console.error(`\n${violations.length} of ${lessons} lesson(s) across ${files.length} page(s).`)
    process.exit(1)
  }
  console.log(`check-memory-lessons: OK — ${lessons} lessons across ${files.length} pages, all recallable`)
}

main()
