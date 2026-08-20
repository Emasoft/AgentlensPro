// Regenerates lpv-expected.json from the COMPILED src/loadedPluginVersions.ts — the parity oracle
// for get_loaded_plugin_versions (TRDD-DMWOBWFH P4x.2d).
// Run from the repo root AFTER `pnpm run compile-tests`:
//   node rust-core/crates/agentlens-core/tests/fixtures/gen-lpv-expected.mjs
//
// Both engines read the SAME committed fixtures: transcripts under ./lpv-home/ and a fake plugin
// cache under ./lpv-cache/, passed explicitly so neither ever touches the real ~/.claude.
//
// MTIMES ARE PART OF THE ANSWER (`lastActivityTs`, and the sort's second key) and git does NOT
// preserve them. So this generator STAMPS a fixed mtime on every fixture transcript before
// measuring and publishes the table it used; the Rust test stamps the same values from that table
// before running. The oracle file is the single source of truth for both — a second hardcoded copy
// on the Rust side would drift silently and the parity test would be comparing two different
// worlds while still passing.
//
// What the fixtures are built to discriminate:
//  - loadedVersion is the MAX version, NOT the latest-by-timestamp. sess-replay loads 3.4.0 at
//    11:00 and then 3.3.9 at 11:10 (a compaction REPLAYING an old invocation as a fresh record).
//    Latest-ts reports 3.3.9 and calls a current session stale; max reports 3.4.0.
//  - lastObservationTs tracks the version being REPORTED, not the session: sess-replay's is 11:00,
//    the 3.4.0 record — not the 11:10 replay.
//  - stale: true vs 'unknown'. sess-blind is behind AND reloaded (12:30) after its last evidence
//    (12:00), so its real version is unknowable — reported 'unknown', never a false true.
//  - ONLY the attachment is evidence. sess-ghost also carries a versioned path in assistant PROSE
//    (7.7.7) and in a non-invoked_skills attachment (8.8.8); both must be ignored, or the model
//    merely READING an old cached path would be reported as running it.
//  - An unparseable timestamp drops the whole record (9.9.9), because an observation that cannot be
//    placed in time cannot support the reload comparison.
//  - A session with no sessionId falls back to the transcript's basename.
//  - sessionsScanned counts every readable transcript; sessionsWithSkillEvidence only those with an
//    attachment. sess-noskills makes the two differ — that gap IS the blind spot in the note.
//  - The plugin cache's `/^\d/` filter: `walkthrough` sorts AFTER `3.4.0` under the comparator, so
//    without the filter it would be reported as the newest cached "version".
//  - compareVersions is numeric, not lexicographic: ponytail has 1.0.9 and 1.0.10, where a string
//    sort picks 1.0.9 and would call every 1.0.10 session "ahead of the cache".
import { createRequire } from 'module'
import { writeFileSync, utimesSync } from 'fs'
const require = createRequire(import.meta.url)
const { buildLoadedVersionsReport, compareVersions, scanPluginCache } = require('../../../../../out/test/loadedPluginVersions.js')
const dir = new URL('.', import.meta.url).pathname

const NOW = Date.parse('2026-08-01T18:00:00.000Z')
const MTIMES = {
  'proj-b/sess-noskills.jsonl': Date.parse('2026-08-01T13:00:00.000Z'),
  'proj-b/sess-blind.jsonl': Date.parse('2026-08-01T14:00:00.000Z'),
  'proj-a/sess-ghost.jsonl': Date.parse('2026-08-01T15:00:00.000Z'),
  'proj-a/sess-replay.jsonl': Date.parse('2026-08-01T16:00:00.000Z'),
  'proj-b/sess-nosession.jsonl': Date.parse('2026-08-01T17:00:00.000Z'),
}
for (const [rel, ms] of Object.entries(MTIMES)) utimesSync(dir + 'lpv-home/' + rel, ms / 1000, ms / 1000)

const dirs = [dir + 'lpv-home']
const cacheRoot = dir + 'lpv-cache'
const run = (o = {}) => buildLoadedVersionsReport({ dirs, cacheRoot, nowMs: NOW, ...o })

// Numeric-vs-lexicographic, missing components reading as 0, and the non-numeric tail fallback.
// Only sign is asserted — the TS returns a localeCompare result for the string branch, whose
// magnitude is not specified.
const CMP = [
  ['1.0.10', '1.0.9'], ['1.0.9', '1.0.10'], ['3.4.0', '3.3.18'], ['3.3.18', '3.3.9'],
  ['1.2', '1.2.0'], ['1.2.0', '1.2'], ['2', '10'], ['0.52.0', '0.53.0'], ['1.0.0', '1.0.0'],
  ['1.0.0-beta', '1.0.0'], ['1.0.0', '1.0.0-beta'], ['beta', 'alpha'], ['alpha', 'beta'],
  ['walkthrough', '3.4.0'], ['3.4.0', 'walkthrough'],
]

writeFileSync(dir + 'lpv-expected.json', JSON.stringify({
  nowMs: NOW,
  mtimes: MTIMES,
  compareCases: CMP,
  compareSigns: CMP.map(([a, b]) => Math.sign(compareVersions(a, b))),
  newestCached: scanPluginCache(cacheRoot),
  report: run(),
  // A plugin filter is applied to BOTH the rows and the newestCached map.
  filtered: run({ plugin: 'ponytail' }),
  filteredJanitor: run({ plugin: 'ai-maestro-janitor' }),
  staleOnly: run({ staleOnly: true }),
  // activeMinutes is a PRESENCE test, not a truthy one — 0 is a real (now-anchored) window.
  active90: run({ activeMinutes: 90 }),
  active0: run({ activeMinutes: 0 }),
  // An unknown plugin: zero rows, and an EMPTY newestCached — not the unfiltered map.
  filteredMissing: run({ plugin: 'no-such-plugin' }),
}, null, 2) + '\n')
console.log('wrote lpv-expected.json')
