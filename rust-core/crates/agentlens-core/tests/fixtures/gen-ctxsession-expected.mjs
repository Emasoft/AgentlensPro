// Regenerates ctxsession-expected.json from the COMPILED TS contextCompositionIndex.js — the
// parity oracle for the session half of context_composition_index.rs (buildSessionComposition,
// aggregateResidents/summarizeImages via it, and sessionCompositionSummary through the real
// registry-backed class).
// Run from the repo root AFTER `pnpm run compile-tests`:
//   node rust-core/crates/agentlens-core/tests/fixtures/gen-ctxsession-expected.mjs
//
// TIME IS PINNED (`generatedAtMs` → Rust now_ms) for the same reason as the ctxcomp oracle: the TS
// prices at "today's rate", so an announced rate change would otherwise fail this on a quiet day.
//
// Discriminators:
//  - callsTotal counts REFS, not parsed calls: an unreadable body is SKIPPED from `calls` while
//    still counted, and that GAP is the coverage-honesty signal, not an off-by-one.
//  - resident ranking is a STABLE sort on (cost, tokens), so rows tied on both keep the map's
//    INSERTION order — a HashMap port reorders them and no tie-free fixture would notice.
//  - `model`/`accountUuid` take the FIRST call that names one; later calls never overwrite.
//  - summarizeImages: count/tokens are MAX across calls, cumulative is Σ, firstSeenTurn uses 0
//    as its unset sentinel.
//  - the peak call is chosen with a STRICT `>`, so the FIRST call at the maximum wins.
import { createRequire } from 'module'
import { writeFileSync } from 'fs'
import { join } from 'path'
const require = createRequire(import.meta.url)
const { buildSessionComposition, ContextCompositionIndex } = require('../../../../../out/test/contextCompositionIndex.js')
const { callBodyRegistry } = require('../../../../../out/test/rawBodyContext.js')
const dir = new URL('.', import.meta.url).pathname
const bodiesDir = join(dir, 'bodies')
const B = (f) => join(bodiesDir, f)

const generatedAtMs = Date.now()

// Explicit-ref sessions (the documented test path: "a test passes explicit file paths").
const sessionCases = [
  {
    sessionId: 'sess-rich',
    projectHint: '/repo/rich',
    refs: [
      { bodyRef: B('comp.request.json'), ts: 1000, responseRef: B('usage.response.json') },
      { bodyRef: B('comp.request.json'), ts: 2000 },
      { bodyRef: B('comp-plain.request.json'), ts: 3000 },
    ],
  },
  {
    // An unreadable body in the middle: skipped from `calls`, still counted in `callsTotal`.
    sessionId: 'sess-gap',
    refs: [
      { bodyRef: B('comp.request.json'), ts: 1000 },
      { bodyRef: B('no-such.request.json'), ts: 2000 },
      { bodyRef: B('comp-plain.request.json'), ts: 3000 },
    ],
  },
  {
    // The first call names no model; the second does. `model ?? cc.model` keeps the FIRST that does.
    sessionId: 'sess-model-order',
    refs: [
      { bodyRef: B('comp-plain.request.json'), ts: 1000 },
      { bodyRef: B('comp.request.json'), ts: 2000 },
    ],
  },
  { sessionId: 'sess-empty', refs: [] },
  { sessionId: 'sess-all-dead', refs: [{ bodyRef: B('no-such.request.json'), ts: 1 }] },
]

// Registry-driven summaries — exercises the REAL lazy path: requestPointers + responseFor.
const registryCases = [
  {
    sessionId: 'reg-sess',
    pointers: [
      { kind: 'request', bodyRef: B('comp.request.json'), ts: 1000, spanId: 'sp1', model: 'claude-opus-5' },
      { kind: 'response', bodyRef: B('usage.response.json'), ts: 1001, spanId: 'sp1', requestId: 'req1' },
      { kind: 'request', bodyRef: B('comp-plain.request.json'), ts: 2000, spanId: 'sp2' },
      { kind: 'request', bodyRef: '', ts: 2500 },   // no bodyRef → registry drops it entirely
    ],
  },
  { sessionId: 'reg-unknown', pointers: [] },   // nothing recorded → the empty-state coverageNote
]
for (const c of registryCases) {
  for (const p of c.pointers) { callBodyRegistry.record(c.sessionId, p) }
}
const idx = new ContextCompositionIndex()

const J = (v) => JSON.parse(JSON.stringify(v ?? null))
// Absolute paths would bake this machine's home dir into a committed fixture (check-identities
// fails the build on exactly that); the Rust test applies the identical rewrite before comparing.
const strip = (text) => text.split(bodiesDir + '/').join('')
writeFileSync(join(dir, 'ctxsession-expected.json'), strip(JSON.stringify({
  generatedAtMs,
  sessionCases: J(sessionCases),
  sessions: await Promise.all(sessionCases.map(c =>
    buildSessionComposition(c.sessionId, c.refs, { projectHint: c.projectHint }).then(J))),
  registryCases: J(registryCases),
  summaries: await Promise.all(registryCases.map(c => idx.sessionCompositionSummary(c.sessionId).then(J))),
}, null, 1)))
console.log(`ctxsession-expected.json: ${sessionCases.length} session + ${registryCases.length} registry cases`)
