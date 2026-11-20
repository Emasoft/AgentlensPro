#!/usr/bin/env node
// Test-data-cap coverage guard: fails (exit 1) when a way of launching tests would bypass the 4 GB cap
// of scripts/test-data-cap.sh. Owner order 2026-11-16: "add a permanent cap to tests to limit to 4 GB
// any generated fake data for tests!". The cap existed but only `pnpm run test:unit` used it, so a bare
// `npx mocha` (ci.yml), `test:browser`, and every `cargo test` ran uncapped; this guard keeps each
// launch path covered. It proves COVERAGE only — it does not prove the cap trips above 4 GB.
// Known limits (regex heuristics, not a parser): the comment stripper can eat code after a // inside a string,
// and the mkdtempSync check matches only a literal first argument starting with /tmp (not path.join('/tmp', ...)).
// Usage: node scripts/check-test-cap.js [--root DIR]   (--root lets the guard be pointed at a fixture)
'use strict'

const fs = require('fs')
const path = require('path')

const rootArg = process.argv.indexOf('--root')
const ROOT = rootArg > 0 ? path.resolve(process.argv[rootArg + 1]) : path.resolve(__dirname, '..')

// mkdtempSync on a literal /tmp escapes the TMPDIR redirect of the cap script. Each entry needs a reason.
const MKDTEMP_ALLOW = new Map([
  ['src/test/generatedFiles.test.ts', '50-byte files that must sit under /tmp/claude-* for path-matching tests'],
  ['src/test/browser/dashboardSmoke.test.ts', 'Chrome SingletonSocket path limit; the dir holds only a symlink back into the capped TMPDIR'],
])

const failures = []
const fail = (msg) => failures.push(msg)
const read = (rel) => {
  const abs = path.join(ROOT, rel)
  return fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : null
}

// Recursive file list with a suffix filter; never descends into build/dependency dirs.
function walk(dir, suffix, out = []) {
  if (!fs.existsSync(dir)) return out
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'target' || e.name === 'node_modules' || e.name === '.git') continue
    const abs = path.join(dir, e.name)
    if (e.isDirectory()) walk(abs, suffix, out)
    else if (e.name.endsWith(suffix)) out.push(abs)
  }
  return out
}
const rel = (abs) => path.relative(ROOT, abs)

// Comment-stripped matching so prose that NAMES a forbidden thing (every explanatory comment does)
// never trips the guard — a guard that reddens on correct writing gets deleted.
const stripSlashComments = (t) =>
  t.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^[ \t]*\/\/[^\n]*$/gm, ' ').replace(/([^:"'])\/\/[^\n]*$/gm, '$1')

// 1. mocha --no-config bypasses .mocharc.cjs, so src/test/setup.js (the self-wrap) is NOT loaded: the
//    invocation itself must go through the wrapper.
function checkNoConfigLines(label, text) {
  text.split('\n').forEach((line, i) => {
    if (/^\s*#/.test(line)) return
    if (/\bmocha\b/.test(line) && /--no-config/.test(line) && !/test-data-cap\.sh/.test(line)) {
      fail(label + ':' + (i + 1) + ': mocha --no-config without scripts/test-data-cap.sh (setup.js is not loaded, so nothing caps this run)')
    }
  })
}
const pkg = read('package.json')
if (pkg === null) fail('package.json missing')
else checkNoConfigLines('package.json', pkg)
const wfDir = path.join(ROOT, '.github', 'workflows')
for (const f of walk(wfDir, '.yml')) checkNoConfigLines(rel(f), fs.readFileSync(f, 'utf8'))

// 2. bare mocha is covered by the self-wrap in setup.js (loaded via .mocharc.cjs).
const setup = read('src/test/setup.js')
if (setup === null) fail('src/test/setup.js missing')
else if (!setup.includes('AGENTLENS_TEST_CAP_DIR') || !setup.includes('test-data-cap.sh')) {
  fail('src/test/setup.js lacks the self-wrap (AGENTLENS_TEST_CAP_DIR + test-data-cap.sh): a bare mocha run is uncapped')
}

// 3. cargo test is covered by the repo-root runner.
const cargoCfg = read('.cargo/config.toml')
if (cargoCfg === null) fail('.cargo/config.toml missing: cargo test is uncapped')
else if (!/^\s*runner\s*=.*AGENTLENS_TEST_CAP_SCRIPT/m.test(cargoCfg) || !cargoCfg.includes('test-data-cap.sh')) {
  fail('.cargo/config.toml has no runner that wraps test binaries in scripts/test-data-cap.sh')
}

// 4. CARGO_TARGET_TMPDIR is baked in at compile time, so data written there escapes the cap's TMPDIR.
//    Scans ALL rust-core .rs files (src/ too), no fixed list.
const rsFiles = walk(path.join(ROOT, 'rust-core'), '.rs')
for (const f of rsFiles) {
  if (/"CARGO_TARGET_TMPDIR"/.test(stripSlashComments(fs.readFileSync(f, 'utf8')))) {
    fail(rel(f) + ': uses CARGO_TARGET_TMPDIR (compile-time path, escapes the cap) — use std::env::temp_dir()')
  }
}

// 5. mkdtempSync on a literal /tmp escapes the cap too.
const tsFiles = walk(path.join(ROOT, 'src', 'test'), '.ts')
for (const f of tsFiles) {
  const r = rel(f)
  if (MKDTEMP_ALLOW.has(r)) continue
  if (/mkdtempSync\(\s*['"`]\/tmp/.test(stripSlashComments(fs.readFileSync(f, 'utf8')))) {
    fail(r + ': mkdtempSync on a literal /tmp escapes the cap — use path.join(os.tmpdir(), ...)')
  }
}

if (failures.length) {
  console.error('check-test-cap: FAIL — ' + failures.length + ' launch path(s) bypass the 4 GB test-data cap')
  for (const m of failures) console.error('  ' + m)
  process.exit(1)
}
console.log('check-test-cap: OK — ' + rsFiles.length + ' rust files, ' + tsFiles.length + ' test files, package.json + ' + walk(wfDir, '.yml').length + ' workflows scanned; ' + MKDTEMP_ALLOW.size + ' mkdtemp exemption(s)')
