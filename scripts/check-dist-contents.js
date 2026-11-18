#!/usr/bin/env node
// scripts/check-dist-contents.js — asserts the DISTRIBUTION/DEVELOPMENT split (owner ruling
// 2026-08-28): the npm package ships COMPILED artifacts only — the four platforms' Rust
// binaries, the esbuild bundles, the built dashboard assets, skills and agents. Source code,
// build inputs and dev intermediates never ship; development happens by cloning the repo.
//
// This replaces check-platform-package-pins.js, which policed the four separate
// `agentlenspro-<platform>` packages that no longer exist (one package now carries every
// platform's binaries under bin-native/).
//
// Why a script and not just trusting `files`: `files` is an allowlist, but a directory entry
// like "skills/" ships whatever is inside it, and a future entry added in a hurry ("src/" to
// fix a stack trace, "rust-core/" to ship a fixture) would silently ship source with no test
// failing. `npm pack --dry-run --json` reports the ACTUAL file list, so this asserts on the
// artifact rather than on the intent.
'use strict'
const { execFileSync } = require('child_process')
const path = require('path')
const Module = require('module')
const esbuild = require('esbuild')

// Anything matching these must NEVER appear in the tarball. Kept as shapes, not a list of
// today's directories, so a newly added source tree is caught too.
const FORBIDDEN = [
  { re: /^src\//, why: 'TypeScript source — development is via the git repo, not the tarball' },
  { re: /^media\/src\//, why: 'dashboard source — only the built media/*.js|css ship' },
  { re: /^rust-core\//, why: 'Rust source/build inputs — only the compiled bin-native/ binaries ship' },
  { re: /^(standalone|scripts)\/.*\.ts$/, why: 'TypeScript source' },
  { re: /^(out|dist|build)\//, why: 'test/build intermediate' },
  { re: /\.map$/, why: 'source map — points at source that is not in the package' },
  { re: /^(design|reports|docs_dev|_corpus_dev)\//, why: 'internal working material' },
  { re: /^\.github\//, why: 'CI configuration' },
  { re: /(^|\/)tsconfig[^/]*\.json$/, why: 'build configuration' },
  { re: /(^|\/)(Cargo\.toml|Cargo\.lock|esbuild\.js)$/, why: 'build input' },
  { re: /(^|\/)\.env/, why: 'environment file — never ship one' },
  // TRDD-1B98LCVR box 2/4 — the USER's ruling 2026-08-27: "delete the TypeScript core; leave
  // TypeScript only for the web UI part." Rust is the ONLY backend that ships; standalone/server.ts
  // is deleted and esbuild no longer builds server.js at all. Kept as a shape (not "today's
  // directories") so a re-added TS server entrypoint is caught as a build failure, not shipped.
  { re: /^standalone\/server\.js$/, why: 'the TypeScript backend — alcore is the only server that ships' },
]

// Read AGENT_NAMES from the TypeScript source — the ONE list the CLI installs from. Bundled in
// memory with esbuild (the same technique scripts/export-pricing.js uses for pricing.ts) so
// this check can never drift from a second hand-maintained copy of the names.
function readAgentNames() {
  const src = path.join(__dirname, '..', 'src', 'cli', 'hookInstall.ts')
  const out = esbuild.buildSync({
    entryPoints: [src], bundle: true, write: false, platform: 'node', format: 'cjs',
    // No sql.js entry: this in-memory bundle of src/cli/hookInstall.ts never reaches it
    // (output byte-identical without it, measured 2026-11-04), and naming it here trips
    // check-duckdb-only (TRDD-8GXG3SGV). The other three stay external so a future import
    // of a native or heavy package stays a runtime require instead of being inlined.
    external: ['@duckdb/node-api', 'duckdb', '@modelcontextprotocol/sdk'],
  })
  const m = new Module(src, module)
  m.filename = src
  m.paths = Module._nodeModulePaths(path.dirname(src))
  m._compile(out.outputFiles[0].text, src)
  return m.exports.AGENT_NAMES
}

function main() {
  const out = execFileSync('npm', ['pack', '--dry-run', '--json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
  const files = JSON.parse(out)[0].files.map((f) => f.path)

  const bad = []
  for (const p of files) {
    for (const { re, why } of FORBIDDEN) {
      if (re.test(p)) bad.push(`${p}  — ${why}`)
    }
  }

  if (bad.length) {
    console.error('check-dist-contents: FAIL — the distribution package must carry compiled artifacts only.\n')
    for (const b of bad) console.error(`  ${b}`)
    console.error(`\n${bad.length} forbidden entr${bad.length === 1 ? 'y' : 'ies'}. Fix package.json "files", do not widen this check.`)
    process.exit(1)
  }

  // The agent set must MATCH the CLI's own list, against the ACTUAL tarball. `installAgents`
  // iterates AGENT_NAMES and THROWS when a file is missing, so a tarball that ships fewer agents
  // than the CLI promises makes `agentlenspro setup` fail on the user's machine with "is the
  // package intact?". AGENT_NAMES is read from the TypeScript source (the ONE list) by bundling
  // it in memory with esbuild — the same technique scripts/export-pricing.js uses for pricing.ts,
  // so there is no second copy of the list to drift.
  const agentNames = readAgentNames()
  const shippedAgents = files.filter((p) => p.startsWith('agents/')).map((p) => p.replace(/^agents\//, '').replace(/\.md$/, ''))
  const missingAgents = agentNames.filter((n) => !shippedAgents.includes(n))
  if (missingAgents.length) {
    console.error('check-dist-contents: FAIL — the tarball ships fewer agents than the CLI installs.\n')
    for (const n of missingAgents) console.error(`  agents/${n}.md  — listed in AGENT_NAMES but not in the tarball`)
    console.error(`\n${missingAgents.length} agent(s) missing from the package. Every name in AGENT_NAMES must have its agents/<name>.md shipped.`)
    process.exit(1)
  }

  // bin-native/ is populated by CI (the build-binaries matrix), so it is legitimately absent in a
  // dev checkout. Report which state we are in rather than failing — a check that fails locally
  // for a CI-only artifact gets disabled, and then it never runs anywhere.
  const nativeCount = files.filter((p) => p.startsWith('bin-native/')).length
  const note = nativeCount === 0
    ? 'bin-native/ absent (dev checkout — CI stages it before packing)'
    : `bin-native/ present: ${nativeCount} binaries`
  console.log(`check-dist-contents: OK — ${files.length} files, no source or build inputs. ${note}`)
}

main()
