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
  ['src/test/setupEnvironment.test.ts', 'P3'],
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
  // P2 — the parity oracle for that migration. It names forensics.db because its whole job is
  // running the same query against the SQLite source and the parquet copy and comparing, which is
  // the precondition for repointing any reader. Both sides go through DuckDB (the SQLite side via
  // a READ_ONLY attach), so this is not a file reaching around DuckDB — it is the file that proves
  // DuckDB can replace it. Deleted together with the source database.
  ['scripts/verify-forensics-parquet-parity.mjs', 'P2'],
  // NOTE: `scripts/build-forensics-views.mjs` deliberately has NO entry. It reads only parquet
  // through DuckDB and names no SQLite path, so it needs no exemption — the guard's own
  // stale-entry note caught the entry added here and said so. It still counts against the OPENER
  // cap, which is the correct split: it opens a store (so the cap sees it) without reaching around
  // DuckDB (so the exemption list should not).
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
// 2026-09-24: lowered to the measured count after TRDD-4BZPAQWM deleted src/database/* and
// sessionRepository.ts (a81972f9).
const MAX_EXEMPTIONS = 27

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
// 2026-10-17 (TRDD-4BZPAQWM): the bare `duckdb::Connection` alternative was removed from the Rust
// pattern. It matched files that only IMPORT or NAME the type and open nothing (agentlens-digest
// src/views.rs and tests/digest.rs), so they were counted as openers they are not. `\bConnection::open`
// still matches open, open_in_memory, open_with_flags and the qualified
// `agentlens_store::duckdb::Connection::open*`. Residual blind spot: an aliased import
// (`Connection as X; X::open`) is not counted; none exists in the tree today.
const OPENERS = [
  // TS/JS — constructing a database handle, whatever the engine.
  { re: /\binitSqlJs\s*\(|new\s+SQL\.Database\b/, what: 'sql.js handle' },
  { re: /\bDuckDBInstance\.create\s*\(/, what: 'DuckDB handle' },
  // Rust — both engines expose the same constructor name, which is precisely why the cap must
  // count them together rather than trying to tell them apart.
  { re: /\bConnection::open/, what: 'Rust DB connection' },
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
//   +1 non-test — `scripts/verify-forensics-parquet-parity.mjs`, the oracle that runs the same
//     query against forensics.db and its parquet copy and compares. It genuinely opens a store, so
//     it is counted rather than excused. Both migration-phase tools sit ABOVE this line on purpose:
//     they are the only two entries here whose deletion is already scheduled — they go when the
//     source database goes, taking the cap from 21 to 19 and the exemptions from 36 to 34.
//   +1 non-test — `scripts/build-forensics-views.mjs`, the typed-view layer. THREE raises this
//     session (18 -> 20 -> 21 -> 22) and every one was a tool added to serve the migration, so the
//     number has moved the WRONG WAY all session. Stated plainly rather than buried: this cap has
//     not yet done the job it was written for. Two of the three (`migrate-*`, `verify-*-parity`)
//     die with the source database; the repoint they enable is what removes `forensicsDb.ts`,
//     `forensicsIndex.ts`, `database/db.ts` and `database/reader.ts` — a drop of 4 against the 3
//     added. The ratchet only becomes real at that step, and until then the honest reading of
//     "22/22" is a debt, not progress.
// 2026-09-24 correction: the "repoint... removes forensicsDb.ts, forensicsIndex.ts, database/db.ts
// and database/reader.ts" claim above is now false. `database/db.ts` and `database/reader.ts` were
// deleted by a81972f9 directly, not via a repoint; `forensicsDb.ts` is LIVE (bundled via
// src/cli/setup.ts) and `forensicsIndex.ts` is LIVE as a rust-core parity-oracle root
// (reports/4BZPAQWM/20260924_104703+0200-dead-module-set.md §3) — neither is scheduled for deletion.
// 2026-10-17 (TRDD-4BZPAQWM): DEFENDED RAISE, and it moves the ratchet the wrong way. Seven files began
// opening a store after 8002f1f6, the commit at which the caps stood at 22 and 8, and none stopped: the
// opener sets at the two commits differ by exactly these seven. Two of them existed before 8002f1f6 and
// became openers in the commit named, so "added" is the wrong word for them.
//   non-test (+4):
//     rust-core/crates/agentlens-core/src/burn/investigator_scan.rs (cbe06222, TRDD-QSFYIHUO)
//     rust-core/crates/agentlens-core/src/cache_event_log.rs (cc49a819, TRDD-QSFYIHUO)
//     rust-core/crates/agentlens-core/src/cache_turns_sql.rs (fb09facf, TRDD-GVA8TTJF)
//     rust-core/crates/agentlens-digest/src/lib.rs (69b7d406, TRDD-VXD881R6): its own database file for
//       the aldigest process, kept out of alcore by design.
//   test (+3):
//     rust-core/crates/agentlens-core/tests/card_reuse.rs (94125a8d, TRDD-9VX3WTGU): needs a raw handle on cards.duckdb.
//     rust-core/crates/agentlens-store/tests/spill.rs (cdb13539, TRDD-9VX3WTGU Phase B): the store crate's own test of DuckDB spill.
//     rust-core/crates/agentlens-core/tests/chores_prefix_wiring.rs (d74c74dd, TRDD-QSFYIHUO step 2): classification inferred, not verified.
// The three non-test core files (burn/investigator_scan.rs, cache_event_log.rs, cache_turns_sql.rs) each
// need a handle with duplicated settings. They are reducible only by a data-returning gateway, owed to the
// follow-up card named on TRDD-4BZPAQWM. Deduplicating them into a helper that returns a Connection lowers
// no count honestly: any such helper's call sites must be counted.
// 2026-11-16 (TRDD-HTARKH87): 26 -> 27 for src/cli/diskStore.ts. The owner ordered the disk-space monitor to record into "a new dedicated duckdb table"; it
// runs every minute from launchd and must not share cards.duckdb (one DuckDB writer lock: the sampler would contend with the collector), so it
// needs its own handle on its own file, opened READ_WRITE by the sampler and READ_ONLY by the query verbs. No gateway exists for a persistent
// TS-side DuckDB file (store/db.ts only builds :memory: views over parquet), and one new file is the whole of the addition: every disk verb goes through diskStore.ts.
const MAX_NON_TEST_OPENERS = 27
// 2026-09-24: lowered to the measured count (raised again 2026-10-17, see above) after TRDD-4BZPAQWM
// deleted src/database/* and sessionRepository.ts (a81972f9).
// 2026-11-18 (TRDD-CXNUWXX7): DEFENDED RAISE 11 -> 12, and it moves the ratchet the wrong way, for one file:
//   src/test/duckPathPattern.test.ts (f2374de6): its canary tests prove that a quote-doubled path holding
//     * ? or [ is read by DuckDB as a file pattern, and its fix tests prove that the repo read sites are not,
//     so it runs plain SQL on a raw `:memory:` handle with fixed settings. Routing it through `openStore`
//     would lower the count without lowering the coupling (a helper that hands back a connection, see
//     above) and would change what the canary runs on (three store sub-directories, the half-of-RAM limit,
//     a proxied connection). Folding its cases into another opener test file would hide the same construction.
//     The file became an opener in f2374de6, which landed with no `pnpm run compile`; the cap was first
//     seen exceeded by the compile of 2026-11-18.
const MAX_TEST_OPENERS = 12

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

// `SELF_TEST_SAMPLES` pins every OPENERS pattern to known inputs. It is checked on EVERY run, not only
// under `--self-test`, and before the tree is walked: a pattern that drifts, or an alternative that
// over-matches an import, must fail here before any count is trusted. The samples are inline and safe,
// because this file is skipped by the scan (see `__filename` above).
const SELF_TEST_SAMPLES = [
  { text: 'use duckdb::Connection;\nfn f(c: &duckdb::Connection) {}', counted: false },
  { text: 'use agentlens_store::duckdb::Connection;', counted: false },
  { text: 'let c = Connection::open(p)?;', counted: true },
  { text: 'let c = Connection::open_in_memory()?;', counted: true },
  { text: 'let c = Connection::open_with_flags(p, f)?;', counted: true },
  { text: 'let c = agentlens_store::duckdb::Connection::open_in_memory()?;', counted: true },
  { text: 'const SQL = await initSqlJs({ locateFile })', counted: true },
  { text: 'const db = new SQL.Database(buf)', counted: true },
  { text: 'const inst = await DuckDBInstance.create(p)', counted: true },
  { text: "import type { DuckDBInstance } from '@duckdb/node-api'", counted: false },
  // Known BLIND SPOT, pinned as NOT counted so it stays visible: an aliased import is missed. This is
  // the alias gap named in the 2026-10-17 OPENERS comment. A change that starts counting it must flip
  // this line deliberately, in the same commit.
  { text: 'use duckdb::Connection as Db;\nlet c = Db::open_in_memory()?;', counted: false },
]

// Returns the number of failed samples and prints one line per failure.
function selfTest() {
  let failures = 0
  for (const { text, counted } of SELF_TEST_SAMPLES) {
    const got = OPENERS.some(({ re }) => re.test(stripComments(text)))
    if (got !== counted) {
      failures++
      console.error(`check-duckdb-only self-test: FAIL — ${JSON.stringify(text)} counted=${got}, expected ${counted}`)
    }
  }
  return failures
}

const selfTestFailures = selfTest()
if (process.argv.includes('--self-test')) {
  if (selfTestFailures) process.exit(1)
  console.log(`check-duckdb-only self-test: OK (${SELF_TEST_SAMPLES.length} cases)`)
  process.exit(0)
}
if (selfTestFailures) {
  console.error('check-duckdb-only: FAIL — opener self-test failed')
  process.exit(1)
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
