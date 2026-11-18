#!/usr/bin/env node
// PRRD G1.1 (owner order 2026-11-18, TRDD-YL3EWT6N item 9): the published npm package declares no install-time
// lifecycle script. Such a script runs arbitrary code on every machine that installs the package, so none is ever
// added; whatever AgentlensPro installs into Claude Code is brought up to date by the CLI itself at its first
// execution after an update. This check fails the build when package.json declares one of them.
// `--self-test` proves the check can fail: it feeds it objects that declare such scripts.
'use strict'
const fs = require('fs')
const path = require('path')

// The four names PRRD G1.1 lists. npm runs the first three when the package is installed, and `prepare` when it is
// installed from a git URL or packed.
const FORBIDDEN = ['preinstall', 'install', 'postinstall', 'prepare']

/** The forbidden script names a parsed package.json declares, in FORBIDDEN order. A declared name counts whatever
 *  its command is: an empty string is still a script npm will run. */
function forbiddenScripts(pkg) {
  const scripts = pkg && typeof pkg.scripts === 'object' && pkg.scripts !== null ? pkg.scripts : {}
  return FORBIDDEN.filter((name) => Object.prototype.hasOwnProperty.call(scripts, name))
}

function selfTest() {
  const cases = [
    [{ scripts: { postinstall: 'node x.js' } }, ['postinstall']],
    [{ scripts: { prepare: 'c', install: 'b', preinstall: 'a' } }, ['preinstall', 'install', 'prepare']],
    [{ scripts: { postinstall: '' } }, ['postinstall']],
    [{ scripts: { prepublishOnly: 'pnpm run package', test: 'mocha' } }, []],
    [{ scripts: null }, []],
    [{}, []],
  ]
  for (const [pkg, want] of cases) {
    const got = forbiddenScripts(pkg)
    if (JSON.stringify(got) !== JSON.stringify(want)) {
      console.error(`check-no-lifecycle-scripts self-test FAILED: ${JSON.stringify(pkg)} gave ${JSON.stringify(got)}, wanted ${JSON.stringify(want)}`)
      process.exit(1)
    }
  }
  console.log(`check-no-lifecycle-scripts self-test OK (${cases.length} cases)`)
}

if (process.argv.includes('--self-test')) {
  selfTest()
} else {
  // `--file` lets a test point the check at another package.json; the build uses the repo's own.
  const i = process.argv.indexOf('--file')
  const file = i >= 0 ? process.argv[i + 1] : path.join(__dirname, '..', 'package.json')
  const found = forbiddenScripts(JSON.parse(fs.readFileSync(file, 'utf8')))
  if (found.length > 0) {
    console.error(`check-no-lifecycle-scripts FAILED: ${file} declares ${found.join(', ')} (PRRD G1.1: no install-time lifecycle script, ever)`)
    process.exit(1)
  }
  console.log(`check-no-lifecycle-scripts OK: none of ${FORBIDDEN.join(', ')} is declared`)
}
