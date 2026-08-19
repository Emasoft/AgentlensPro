#!/usr/bin/env node
// Derives rust-core/crates/agentlens-core/pricing.json from src/shared/pricing.ts — the ONE rates
// table (TRDD-DMWOBWFH). The Rust core embeds the JSON with include_str!, so rates change in
// exactly one place and the Rust side can never drift: `--check` (wired into compile/package as
// check-pricing-export) fails the build when the committed artifact is stale.
//
//   node scripts/export-pricing.js          # (re)write the artifact
//   node scripts/export-pricing.js --check  # exit 1 if the committed artifact differs
'use strict'
const fs = require('fs')
const path = require('path')
const Module = require('module')
const esbuild = require('esbuild')

const ROOT = path.join(__dirname, '..')
const SRC = path.join(ROOT, 'src', 'shared', 'pricing.ts')
const OUT = path.join(ROOT, 'rust-core', 'crates', 'agentlens-core', 'pricing.json')

// Compile the shared module in memory — no dependency on out/test being built.
const { code } = esbuild.transformSync(fs.readFileSync(SRC, 'utf8'), { loader: 'ts', format: 'cjs' })
const m = new Module(SRC, module)
m.filename = SRC
m.paths = Module._nodeModulePaths(path.dirname(SRC))
m._compile(code, SRC)
const { RATES, PRICING_LAST_UPDATED } = m.exports

// Deterministic, key order preserved (insertion order is part of lookupRates' semantics only in
// the TS prefix scan, which the Rust port reproduces by scanning in this same order).
const artifact = JSON.stringify({ lastUpdated: PRICING_LAST_UPDATED, rates: RATES }, null, 1) + '\n'

if (process.argv.includes('--check')) {
  const current = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : ''
  if (current !== artifact) {
    console.error(`STALE — ${path.relative(ROOT, OUT)} does not match src/shared/pricing.ts. Run: node scripts/export-pricing.js`)
    process.exit(1)
  }
  console.log(`OK — pricing export in lockstep (${Object.keys(RATES).length} models, last updated ${PRICING_LAST_UPDATED})`)
} else {
  fs.writeFileSync(OUT, artifact)
  console.log(`wrote ${path.relative(ROOT, OUT)} (${Object.keys(RATES).length} models)`)
}
