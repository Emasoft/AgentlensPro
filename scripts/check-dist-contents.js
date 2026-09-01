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
