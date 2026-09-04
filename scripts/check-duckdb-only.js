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
  // P2 — the migration TOOL itself. It names forensics.db because its whole job is emptying it
  // into parquet, and it reads that file through DuckDB's sqlite_scanner, which is the sanctioned
  // path. Exempted by name rather than by loosening the `.db`-path pattern: the pattern is what
  // catches the next file that reaches for SQLite directly, and a tool that migrates SQLite is
  // exactly the one case that must not become a hole in it. This entry is DELETED with the file,
  // once the source database is gone.
  ['scripts/migrate-forensics-to-parquet.mjs', 'P2'],
])

// The RATCHET. Without this, "the budget can only go down" was just a sentence in a comment: adding
// an ALLOW entry made the guard pass silently, so the exemption list could grow forever and the
// guard would still print OK.
//
// It counts the LIST LENGTH, not how many entries the current tree happens to exercise. Counting
// live matches instead would let a deleted file — or a spelling drifting out of pattern range —
// silently free budget, so the list could grow while the number stayed flat: exactly the silent
// growth this exists to stop. It also made the ratchet depend on the filesystem walk, which made a
// mutation test run from /tmp pass vacuously against 0 scanned files. The ratchet governs the
// PROMISE; the stale-entry note governs the BOOKKEEPING. Two mechanisms, two jobs.
//
// Raising this is ALLOWED but must be deliberate and justified in the commit message: a phase in
// flight can legitimately need a transitional file. The friction is the point — an edit here is a
// decision someone has to defend, which is exactly what a silent `ALLOW.push` was not.
// 35, raised by one for `scripts/migrate-forensics-to-parquet.mjs` — the tool that EMPTIES
// forensics.db into parquet. Raising the ratchet is the thing this number exists to make hard, so:
// the exemption is temporary by construction (it dies with the source database), and the migration
// it performs is what lowers the other entries. A budget raised to admit the tool that shrinks the
// budget is the one increase that pays for itself.
const MAX_EXEMPTIONS = 35

// ─── THE OPENER CAP (TRDD-Q9WD3K5R) ──────────────────────────────────────────────────────────
//
// Everything above asks WHICH ENGINE a file uses. That is the wrong invariant, and shipping only
// it would have produced a green guard over an unchanged architecture: migrate every file from
// SQLite to DuckDB one-for-one and you land N files each opening their own DuckDB connection —
// exemptions zero, guard green, and the USER's actual complaint ("exemptions are code smells...
// the clear sign of a bad architecture") untouched. The defect is not the engine. It is HOW MANY
// PLACES REACH DISK AT ALL.
//
// So this second cap counts files that OPEN a store — any engine, DuckDB INCLUDED. A DuckDB
// handle opened in eighteen places is the same architecture as a SQLite handle opened in eighteen
// places; only the spelling changed. The directive is "duckdb is your memory", which means one
// place asks and everyone else queries — not "say duckdb more often".
//
// MEASURED 2026-09-04 with these patterns over this guard's own walk: 18 non-test, 15 test.
// Note the card that specified this cap guessed "~7", because it counted only SQLite openers.
// Counting every engine — which is the point — gives 33. Seeded at the measured values so the
// ratchet starts from the truth rather than from the estimate.
const OPENERS = [
  // TS/JS — constructing a database handle, whatever the engine.
  { re: /\binitSqlJs\s*\(|new\s+SQL\.Database\b/, what: 'sql.js handle' },
  { re: /\bDuckDBInstance\.create\s*\(/, what: 'DuckDB handle' },
  // Rust — both engines expose the same constructor name, which is precisely why the cap must
  // count them together rather than trying to tell them apart.
  { re: /\bConnection::open|duckdb::Connection/, what: 'Rust DB connection' },
]

// A file is TEST-side if it lives in a test tree, is named *.test.*, mocks, or generates fixtures.
// The split exists because the two halves have different targets and merging them hides both: the
// non-test count must ratchet toward 1, while whether test scaffolding can route through the
// gateway at all is an OPEN QUESTION this card must decide (a test may legitimately need to
// CONSTRUCT a store). Reporting one blended number would let test scaffolding mask real progress,
// or make legitimate fixtures look like regressions.
// A `gen-*` file under fixtures/ is a GENERATOR — a program that opens a store and writes the
// expected output a parity suite compares against. Classifying it as "test" put the one class of
// file that MUST migrate in lockstep with its subject into the bucket explicitly described as
// "not aimed at 1", where a generator still opening SQLite after its subject moved to DuckDB
// would be invisible to both caps. It counts as non-test, which is where the pressure is.
const isTestPath = (rel) =>
  !/(^|\/)gen-/.test(rel) &&
  (/(^|\/)tests?\//.test(rel) || /\.test\./.test(rel) || /__mocks__/.test(rel) || /fixtures\//.test(rel))

// Ratchet targets. NON_TEST ratchets toward 1 (the store crate). TEST is frozen at today's count —
// it may only go DOWN, and the question of what its floor SHOULD be is deliberately unanswered
// here rather than guessed. Raising either is allowed but must be justified in the commit message,
// exactly like MAX_EXEMPTIONS.
// 20/14, from a measured 18/15, and both changes are deliberate:
//   +1 non-test / -1 test — reclassifying `gen-*` fixture generators as non-test (see isTestPath).
//     Same 33 openers, one boundary corrected. A re-seed, not a raised budget.
//   +1 non-test — `scripts/migrate-forensics-to-parquet.mjs` genuinely opens a store, so it is
//     counted rather than excused. It is the tool whose whole purpose is to let the other openers
//     be deleted, and it dies with the source database; the honest accounting is to count it now
//     and drop the cap by one when it goes.
const MAX_NON_TEST_OPENERS = 20
const MAX_TEST_OPENERS = 14

// WHAT THIS CAP DOES NOT MEASURE — stated here because the commit that added it overclaimed.
// It counts CONSTRUCTION (`X::open`, `new SQL.Database`, `DuckDBInstance.create`). The card says
// the real coupling is handle-PASSING, and those are different: move all 19 opens into one factory
// and pass handles to the other 18 files and this cap reads 1/19 while 18 files still hold a live
// store handle and still reach disk through it — "guard green, architecture unchanged" reproduced
// by the very guard written to prevent it. So the cap catches the NAIVE one-for-one migration
// (which is what was actually about to happen) and not the sophisticated one. Catching that needs
// a check on handle-typed parameters and struct fields, which is a real piece of work and is not
// this. Do not read a green cap as "the gateway exists".

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
const openers = { test: [], nonTest: [] }

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
  // Counted per FILE, not per pattern: a file opening two engines is still one place that reaches
  // disk, and double-counting it would make a migration that removes one of the two look like
  // progress toward a cap it never moved.
  if (OPENERS.some(({ re }) => re.test(text))) (isTestPath(rel) ? openers.test : openers.nonTest).push(rel)
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

// The opener caps are checked AFTER the engine checks, and fail independently. A tree can be
// perfectly DuckDB-only and still be wrong in the way that matters, which is the whole reason this
// cap exists — so it must be able to fail on its own, on a tree where `violations` is empty.
const capFail = (label, list, max, note) => {
  if (list.length <= max) return false
  console.error(`check-duckdb-only: FAIL — ${label} opener cap exceeded: ${list.length} > ${max}.`)
  for (const f of list) console.error('  ' + f)
  console.error('\n' + note)
  return true
}
// Array literal, NOT `||`: short-circuiting would evaluate the second cap only when the first
// passed, so a tree breaching both would report one, get fixed, and breach again on the next run.
// Both must be evaluated so both are printed.
const capFailures = [
  capFail(
    'non-test', openers.nonTest, MAX_NON_TEST_OPENERS,
    'This cap counts files that OPEN a store — ANY engine, DuckDB included. Migrating a file from\n' +
    'SQLite to DuckDB does not lower it, and it is not supposed to: the defect is the NUMBER OF\n' +
    'PLACES that reach disk, not which library they reach it with. Route the new caller through the\n' +
    'store crate instead of opening its own handle. Raising this number is a decision to defend in\n' +
    'the commit message.'
  ),
  capFail(
    'test', openers.test, MAX_TEST_OPENERS,
    'Test scaffolding may legitimately CONSTRUCT a store, so this cap is frozen rather than aimed\n' +
    'at 1 — but it may only go DOWN. A new test that opens its own handle should ask first whether\n' +
    'it can use the same entry point the product uses.'
  ),
]
if (capFailures.some(Boolean)) process.exit(1)

console.log(`OK — DuckDB-only guard: ${files.length} files scanned, ${usedAllow.size} known exemption(s) awaiting migration (budget ${ALLOW.size}/${MAX_EXEMPTIONS})`)
console.log(`     store openers: ${openers.nonTest.length}/${MAX_NON_TEST_OPENERS} non-test (target 1), ${openers.test.length}/${MAX_TEST_OPENERS} test (frozen)`)
if (stale.length) console.log(`  note: ${stale.length} allowlist entr(y/ies) no longer needed: ${stale.join(', ')}`)
