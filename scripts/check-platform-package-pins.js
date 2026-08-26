#!/usr/bin/env node
// scripts/check-platform-package-pins.js — the main package's optionalDependencies on the
// agentlenspro-<platform> packages MUST equal package.json's own "version" (TRDD-EAK9R8IY): npm
// only ever resolves a version that has actually been published, so a stale pin here means the
// tag's `npm publish` succeeds for the main package while every platform install 404s.
'use strict'
const pkg = require('../package.json')

const optional = pkg.optionalDependencies || {}
const platformDeps = Object.keys(optional).filter((name) => name.startsWith('agentlenspro-'))

if (platformDeps.length === 0) {
  console.error('no agentlenspro-<platform> optionalDependencies found — expected at least one')
  process.exit(1)
}

const bad = platformDeps.filter((name) => optional[name] !== pkg.version)
if (bad.length > 0) {
  for (const name of bad) console.error(`${name}: pinned to ${optional[name]}, package.json version is ${pkg.version}`)
  process.exit(1)
}

console.log(`OK — ${platformDeps.length} platform package pins match version ${pkg.version}`)
