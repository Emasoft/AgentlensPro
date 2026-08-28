#!/usr/bin/env node
// scripts/verify-bin-native.js — proves the four platforms' binaries are staged in the exact
// layout src/rustBinResolve.ts resolves, and are executable.
//
// A committed script rather than an inline `node -e '…'` in the workflow: the inline form has to
// survive YAML block scalars AND shell quoting (shellcheck's SC2016 fires on any `${…}` inside
// the single-quoted argument, failing actionlint), and it cannot be run locally to check itself.
//
// Two failure modes it exists to catch, both of which produce a package that INSTALLS CLEANLY and
// only fails when a binary is spawned on a user's machine:
//   1. wrong layout — download-artifact restores `bin-native/<artifact-name>/…`, so the flatten
//      step must rename `bin-native-<suffix>` → `<suffix>`;
//   2. lost executable bit — upload-artifact zips, and ZIP carries no unix mode.
'use strict'
const fs = require('fs')
const path = require('path')

// Must stay in lockstep with SHIPPED_TARGETS in src/rustBinResolve.ts and the publish.yml matrix.
const TARGETS = ['darwin-arm64', 'darwin-x64', 'linux-x64', 'linux-arm64']
const BINARIES = ['alcore', 'alstore', 'alscan', 'allogscan']

function main() {
  const base = process.argv[2] || 'bin-native'
  const missing = []
  for (const t of TARGETS) {
    for (const b of BINARIES) {
      const p = path.join(base, t, b)
      try {
        if (!fs.statSync(p).isFile()) throw new Error('not a regular file')
        fs.accessSync(p, fs.constants.X_OK)
      } catch (err) {
        missing.push(`${p} — ${err.code === 'ENOENT' ? 'missing' : err.code === 'EACCES' ? 'not executable' : err.message}`)
      }
    }
  }

  if (missing.length) {
    console.error(`verify-bin-native: FAIL — ${missing.length} of ${TARGETS.length * BINARIES.length} expected binaries unusable:\n`)
    for (const m of missing) console.error(`  ${m}`)
    process.exit(1)
  }
  console.log(`verify-bin-native: OK — ${TARGETS.length} targets x ${BINARIES.length} binaries, all present and executable under ${base}/`)
}

main()
