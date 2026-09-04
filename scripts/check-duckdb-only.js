#!/usr/bin/env node
// DuckDB-only guard: fails (exit 1) when a file reaches on-disk data through anything other than
// DuckDB. USER directive 2026-09-02, verbatim and marked IMPERATIVE (TRDD-7YPQWKPG):
//
//   "your only memory is duckdb (and the ondisk files: parqet and jsonl, read only via duckdb and
//    never directly)"
//
// The directive existed for two days and was violated anyway — by the codebase (two of our own
// SQLite databases) and by an agent reading forensics.db with the sqlite3 CLI and parsing JSONL
// with a JSON library. Nothing gated either, because the rule lived only in a `todo` card. A rule
// that is not executable is a rule that is not enforced; this file is the executable half.
//
// It is an ALLOWLIST with a shrinking budget, not a clean-tree assertion: the migration is phased,
// so every known offender is listed below with its owning phase. The budget can only go DOWN —
// adding a new offender fails, and removing one requires editing this file, which is the point at
// which someone has to justify it.
'use strict'

const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')

// Patterns that mean "reaching disk without DuckDB". Kept narrow and literal so a comment
// mentioning sqlite does not trip it — the guard must never redden on correct writing, or it gets
// deleted (the lesson the identity guard in this repo already learned).
const OFFENDERS = [
  // The engine is reached under several spellings; the first version of this guard knew only
  // `sql.js` and therefore MISSED src/database/*.ts entirely, reporting them as needing no
  // exemption. An under-detecting guard is worse than none — it certifies a tree it never checked.
  { re: /require\([^)]*sql-wasm|from\s+['"][^'"]*sql-wasm|\bsql\.js['"]|\binitSqlJs\b|\bloadSqlJs\b|\bSqlJs(?:Static|Database)\b/, what: 'sql.js / sql-wasm (SQLite in TS)' },
  { re: /^\s*use\s+rusqlite|rusqlite::/m, what: 'rusqlite (SQLite in Rust)' },
  { re: /\bsqlite3\s+["'~$/]/, what: 'sqlite3 CLI against a database path' },
  { re: /\bJSON\.parse\(\s*fs\.readFileSync\([^)]*\.jsonl/, what: 'JSONL parsed directly, not via DuckDB' },
  // CAPABILITY, not name. The three name patterns above each missed a real offender on their first
  // outing — `sql.js` missed `sql-wasm`, and both missed `OpenCodeSqlFactory`, which spells the
  // engine nowhere. A SQLite database is reached by its PATH, and a `.db` literal is that path
  // whatever the wrapper is called. `.duckdb` is deliberately not matched: that is the destination.
  // Backticks are in the delimiter class because `${dir}/forensics.db` is idiomatic TS here and the
  // quote-only version missed it. The extension alternation exists because hardcoding `.db` would
  // wave through `forensics.sqlite` — the exact name someone reaches for mid-migration to mean
  // "obviously not the old one", which is when the guard most needs to fire.
  { re: /['"`][^'"`\n]*\.(?:db|sqlite3?|db3)['"`]/, what: 'a SQLite database file path' },
]

// Matching runs on COMMENT-STRIPPED source. A comment that merely NAMES sqlite (this file is full
// of them, and so is every migration note) must not trip the guard — a check that reddens on
// correct writing gets disabled, which is how the repo lost the mirror guard's protection for a
// year. Crude but sufficient: line comments, block comments, and Rust doc comments.
function stripComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/^[ \t]*(?:\/\/|#)[^\n]*$/gm, ' ')
    .replace(/([^:])\/\/[^\n]*$/gm, '$1')
}

// Phase-tagged allowlist. Each entry is a file that legitimately still uses SQLite TODAY because
// its migration phase has not run yet. Delete entries as phases land; never add one without a
// phase and a reason.
const ALLOW = new Map([
  // Phase 2 — forensics.db (the fact table holding cost_usd) -> DuckDB
  ['src/forensicsDb.ts', 'P2'], ['src/forensicsIndex.ts', 'P2'],
    ['rust-core/crates/agentlens-core/src/forensics_db.rs', 'P2'],
  ['rust-core/crates/agentlens-core/src/forensics_scan.rs', 'P2'],
  ['rust-core/crates/agentlens-core/src/forensics_sql.rs', 'P2'],
  ['rust-core/crates/agentlens-core/src/forensics_compare.rs', 'P2'],
  // Phase 3 — agentlens.db (the session store) -> DuckDB
  ['src/database/db.ts', 'P3'], ['src/database/reader.ts', 'P3'],
    ['src/cli/setup.ts', 'P3'],
  // Phase 4 — opencode.db is NOT ours (OpenCode owns the file). It stays SQLite on disk; the fix
  // is to read it through DuckDB's sqlite_scanner rather than sql.js/rusqlite.
  ['src/logReader.ts', 'P4'],
  ['rust-core/crates/agentlens-logscan/src/opencode.rs', 'P4'],
  // Parity oracles + their generators. These follow the phase of the code they pin: they must keep
  // reading the SAME engine as the implementation, or the parity suite stops comparing like with
  // like. They migrate in the SAME commit as their subject, never before it.
  ['rust-core/crates/agentlens-core/tests/fixtures/gen-forensicsindexer-expected.mjs', 'P2'],
  ['rust-core/crates/agentlens-core/tests/forensicsdb_parity.rs', 'P2'],
  ['rust-core/crates/agentlens-core/tests/forensicsindexer_parity.rs', 'P2'],
  ['rust-core/crates/agentlens-core/tests/fixtures/gen-forensicscompare-expected.mjs', 'P2'],
  ['rust-core/crates/agentlens-core/tests/fixtures/gen-forensicssql-expected.mjs', 'P2'],
  ['rust-core/crates/agentlens-core/tests/forensicscompare_parity.rs', 'P2'],
  ['rust-core/crates/agentlens-core/tests/forensicssql_parity.rs', 'P2'],
  // Phase 4 — discovery locates opencode.db on disk before anything opens it.
  ['rust-core/crates/agentlens-logscan/src/discovery.rs', 'P4'],
  ['rust-core/crates/agentlens-logscan/tests/discovery.rs', 'P4'],
  // TESTS. Tagged with the phase of the code they exercise, and they migrate in the SAME commit —
  // a suite still opening SQLite after its subject moved to DuckDB is a green test proving nothing.
  ['src/test/forensicsIndex.test.ts', 'P2'], ['src/test/forensicsAnalytics.test.ts', 'P2'],
  ['src/test/database/generatedFiles.test.ts', 'P3'], ['src/test/database/migration.test.ts', 'P3'],
  ['src/test/database/reader.analytics.test.ts', 'P3'], ['src/test/database/reader.test.ts', 'P3'],
  ['src/test/database/reingest.test.ts', 'P3'], ['src/test/database/retention.test.ts', 'P3'],
  ['src/test/database/writer.test.ts', 'P3'], ['src/test/setupEnvironment.test.ts', 'P3'],
  ['src/test/setupVerb.test.ts', 'P3'],
  ['src/test/logReader.opencode.test.ts', 'P4'], ['src/test/rustOpenCode.test.ts', 'P4'],
  ['src/test/helpers/opencodeParseChild.ts', 'P4'],
])

// The RATCHET. Without this, "the budget can only go down" was just a sentence in a comment: adding
// an ALLOW entry made the guard pass silently, so the exemption list could grow forever and the
// guard would still print OK. The number below is the high-water mark; exceeding it fails. Lower it
// as phases land — never raise it.
const MAX_EXEMPTIONS = 34

// Sibling guards ENUMERATE the patterns they ban, so they trip each other by construction. Excluded
// by name, deliberately narrow — only files whose whole job is pattern-matching.
const GUARD_SCRIPTS = new Set(['scripts/check-no-identities.js', 'scripts/deny-identity-leak-to-github.js'])

const SCAN_DIRS = ['src', 'standalone', 'scripts', 'rust-core/crates']
const EXTS = new Set(['.ts', '.js', '.rs', '.mjs', '.sh'])
// esbuild outputs — they INLINE their sources, so scanning them re-reports every offender the
// source scan already found, attributed to a generated file nobody can fix. Excluded by path, not
// by extension, because standalone/ also holds the hand-written .ts entry points.
const GENERATED = new Set(['standalone/cli.js', 'standalone/server.js', 'media/dashboard.js', 'media/sidebar.js'])

function walk(dir, out) {
  let entries
  try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return out }
  for (const e of entries) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) {
      // `test` is NOT skipped. Skipping it hid 14 files that open SQLite — including the very
      // suites that must migrate alongside their subject. A test still opening SQLite after its
      // source moved to DuckDB is the exact regression this guard exists to catch, and it is
      // invisible to a scan that walks past the directory.
      if (e.name === 'node_modules' || e.name === 'target') continue
      walk(p, out)
    } else if (EXTS.has(path.extname(e.name))) out.push(p)
  }
  return out
}

const files = SCAN_DIRS.flatMap((d) => walk(path.join(ROOT, d), []))
const violations = []
const usedAllow = new Set()

for (const abs of files) {
  const rel = path.relative(ROOT, abs)
  if (rel === path.relative(ROOT, __filename)) continue // this guard names the patterns it bans
  if (GENERATED.has(rel) || GUARD_SCRIPTS.has(rel)) continue
  let text
  try { text = stripComments(fs.readFileSync(abs, 'utf8')) } catch { continue }
  for (const { re, what } of OFFENDERS) {
    if (!re.test(text)) continue
    if (ALLOW.has(rel)) { usedAllow.add(rel); continue }
    violations.push(`${rel}: ${what}`)
  }
}

// A stale allowlist entry is its own defect: it hides a file that no longer needs the exemption and
// lets the budget look larger than it is. Report, do not fail — a phase landing should not have to
// edit this file in the same commit.
const stale = [...ALLOW.keys()].filter((f) => !usedAllow.has(f) && fs.existsSync(path.join(ROOT, f)))

if (violations.length) {
  console.error('check-duckdb-only: FAIL — on-disk data reached without DuckDB\n')
  for (const v of violations) console.error('  ' + v)
  console.error('\nUSER directive (TRDD-7YPQWKPG, IMPERATIVE): DuckDB is the only memory; parquet')
  console.error('and jsonl are read ONLY via DuckDB, never directly. If this file is part of a')
  console.error('migration phase that has not run yet, add it to ALLOW with its phase tag.')
  process.exit(1)
}

if (ALLOW.size > MAX_EXEMPTIONS) {
  console.error(`check-duckdb-only: FAIL — exemption budget exceeded: ${ALLOW.size} > ${MAX_EXEMPTIONS}.`)
  console.error('The allowlist is a RATCHET. A phase landing lowers MAX_EXEMPTIONS; nothing raises it')
  console.error('without an explicit decision, which is the whole point of the number being here.')
  process.exit(1)
}

console.log(`OK — DuckDB-only guard: ${files.length} files scanned, ${usedAllow.size} known exemption(s) awaiting migration (budget ${ALLOW.size}/${MAX_EXEMPTIONS})`)
if (stale.length) console.log(`  note: ${stale.length} allowlist entr(y/ies) no longer needed: ${stale.join(', ')}`)
