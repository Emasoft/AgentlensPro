// Regenerates forensicsspawn-expected.json from the COMPILED src/forensicsIndex.ts — the parity
// oracle for SLICE B3's PURE half (TRDD-DMWOBWFH): resolveSpawn.
//
// loadSpawnMap is NOT oracled here. It opens a real SQLite file through sql.js, so an oracle would
// need this generator to build a .db fixture and would then be testing sql.js's reader against
// rusqlite's rather than testing the port. Its behaviours — an absent DB, a table-less DB, and the
// un-migrated-column degradation — are pinned natively in Rust instead, where a DB is three lines
// to construct.
//
// Run from the repo root AFTER `pnpm run compile-tests`:
//   node rust-core/crates/agentlens-core/tests/fixtures/gen-forensicsspawn-expected.mjs

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const { resolveSpawn } = await import(path.join(HERE, '../../../../../out/test/forensicsIndex.js'))

// Every row shape the ladder branches on, plus the ones that look like they should branch and must
// not. Session ids are visibly fake — a fixture is shipped, and a real session id in a shipped file
// is one machine's noise handed to everyone.
const rows = {
  // kind present → 'direct', carrying every field through.
  full: { spawnKind: 'task', spawnModelOverride: 'claude-opus-5', spawnIsolation: 'worktree', subagentType: 'spark', isSidechain: true, parentSessionId: 'aaaaaaaa', model: 'claude-opus-5' },
  // kind present, everything else absent → 'direct' with nulls, NOT a fabricated root.
  kindOnly: { spawnKind: 'task', isSidechain: false },
  // no kind, no parent → synthetic 'root'. spawnKind becomes the STRING 'root' while
  // spawnResolution is also 'root' — two different fields that a port can easily conflate.
  rootish: { isSidechain: false },
  // no kind, no parent, but IS a sidechain → the sidechain flag must survive the root branch.
  rootishSidechain: { isSidechain: true },
  // no kind WITH a parent → still 'direct' (it matched), kind left null rather than invented.
  childNoKind: { isSidechain: false, parentSessionId: 'bbbbbbbb', spawnModelOverride: 'claude-sonnet-5', spawnIsolation: 'none', subagentType: 'explore' },
  // an EMPTY-STRING kind is falsy in JS, so it must take the kind-LESS branch, not 'direct'.
  emptyKind: { spawnKind: '', isSidechain: false, parentSessionId: 'cccccccc' },
  // an empty parent id is likewise falsy → the root branch, not the child branch.
  emptyParent: { isSidechain: false, parentSessionId: '' },
}

const map = new Map(Object.entries(rows))
const cases = []
for (const key of Object.keys(rows)) {
  cases.push({ case: key, sessionId: key, out: resolveSpawn(key, map) })
}
// Lookup misses and absent ids — each still an honest 'unresolved' bucket rather than a dropped row.
cases.push({ case: 'no such session', sessionId: 'zzzzzzzz', out: resolveSpawn('zzzzzzzz', map) })
cases.push({ case: 'undefined sessionId', sessionId: null, out: resolveSpawn(undefined, map) })
cases.push({ case: 'empty sessionId', sessionId: '', out: resolveSpawn('', map) })
cases.push({ case: 'empty map', sessionId: 'full', out: resolveSpawn('full', new Map()) })

fs.writeFileSync(path.join(HERE, 'forensicsspawn-expected.json'), `${JSON.stringify({ rows, cases }, null, 2)}\n`)
console.log(`wrote forensicsspawn-expected.json — ${cases.length} resolveSpawn cases`)
