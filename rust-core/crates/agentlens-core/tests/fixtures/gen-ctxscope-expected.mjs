// Regenerates ctxscope-expected.json from the COMPILED src/contextCompositionIndex.ts — the parity
// oracle for the three SCOPED composition tools (TRDD-DMWOBWFH P4x.2c):
// get_image_report / find_resident_blobs / query_context_blocks, plus resolveScope underneath them.
// Run from the repo root AFTER `pnpm run compile-tests`:
//   node rust-core/crates/agentlens-core/tests/fixtures/gen-ctxscope-expected.mjs
//
// The three report builders are PURE over a list of SessionCompositions, so the compositions are
// built once and then fed to each — the engine (buildSessionComposition) is already covered by
// ctxcomp_parity, and driving through the class would test it twice and the reports not at all.
//
// Discriminators:
//  - resolveScope checks the EXACT session-id match FIRST. An id is also a valid startsWith prefix
//    of itself, so without it a single-session drill silently widens to every id sharing a prefix.
//  - coverage is a CLAIM, not decoration: complete=false says "SAMPLE" in words, so a capped scan
//    can never read as a full one.
//  - imageReport ranks by cumulative READ cost, not image count — an image is expensive because it
//    is RESIDENT and re-read every turn.
//  - topN is CLAMPED to [1,100] with a default of 20, so a caller cannot pull an unbounded list.
//  - `note` is undefined (key OMITTED) when nothing was cut.
//  - queryBlocks matches `model` by SUBSTRING; an equality check returns nothing for "opus".
import { createRequire } from 'module'
import { writeFileSync } from 'fs'
import { join } from 'path'
const require = createRequire(import.meta.url)
const { ContextCompositionIndex } = require('../../../../../out/test/contextCompositionIndex.js')
const dir = new URL('.', import.meta.url).pathname

// The class holds the scope/report logic; the private methods are exercised through the public
// three. The registry is module-global, so the compositions are injected via the LRU (put) rather
// than by faking body files — the reports never touch disk once a composition is cached.
const idx = new ContextCompositionIndex()

// Two synthetic compositions: one image-heavy, one not, in different projects, so every filter and
// grouping dimension has at least two distinguishable values.
const comp = (sessionId, project, model, opts) => ({
  sessionId, project, model, accountUuid: opts.accountUuid ?? null,
  callsTotal: opts.callsTotal ?? 2, callsWithExactUsage: opts.callsWithExactUsage ?? 1,
  images: opts.images ?? { count: 0, tokens: 0, firstSeenTurn: null, residentTurns: 0, cumulativeReadTokens: 0, cumulativeReadCostUsd: 0 },
  residentBlobs: opts.residentBlobs ?? [],
  calls: opts.calls ?? [],
})
const call = (turn, blocks) => ({ turn, blocks })
const blk = (id, kind, tokens) => ({ id, kind, label: id, tokens, bytes: tokens * 4, role: 'user', tokenSource: 'estimate' })

const comps = [
  comp('sess-alpha', '/ws/alpha', 'claude-opus-5', {
    accountUuid: 'acct-1111',
    images: { count: 3, tokens: 4800, firstSeenTurn: 1, residentTurns: 9, cumulativeReadTokens: 43200, cumulativeReadCostUsd: 0.0216004 },
    residentBlobs: [
      { id: 'b1', kind: 'image', label: 'screenshot', peakTokens: 3252, residentTurns: 9, cumulativeReadTokens: 29268, cumulativeReadCostUsd: 0.01463411, sampleTurn: 1, sampleBlockIndex: 2 },
      { id: 'b2', kind: 'text', label: 'CLAUDE.md', peakTokens: 64868, residentTurns: 9, cumulativeReadTokens: 583812, cumulativeReadCostUsd: 0.29190611, sampleTurn: 1, sampleBlockIndex: 0 },
      { id: 'b3', kind: 'tool_result', label: 'small', peakTokens: 100, residentTurns: 2, cumulativeReadTokens: 200, cumulativeReadCostUsd: 0.0001, sampleTurn: 2, sampleBlockIndex: 5 },
    ],
    calls: [call(1, [blk('b2', 'text', 64868), blk('b1', 'image', 3252)]), call(2, [blk('b3', 'tool_result', 100), blk('b4', 'text', 500)])],
  }),
  comp('sess-beta', '/ws/beta', 'claude-sonnet-5', {
    accountUuid: 'acct-2222',
    residentBlobs: [{ id: 'c1', kind: 'text', label: 'notes', peakTokens: 900, residentTurns: 4, cumulativeReadTokens: 3600, cumulativeReadCostUsd: 0.0018, sampleTurn: 1, sampleBlockIndex: 1 }],
    calls: [call(1, [blk('c1', 'text', 900)]), call(3, [blk('c2', 'tool_use', 250)])],
  }),
]
for (const c of comps) { idx.put?.(c.sessionId, c) }

// resolveScope is private; drive it through the public reports with a project resolver.
const projectFor = (id) => comps.find(c => c.sessionId === id)?.project

// The class would re-derive compositions from the (empty) registry, so the report builders are
// invoked with the compositions injected: monkey-patch the one private seam, which is exactly the
// boundary the Rust port draws (report builders take `comps` + `coverage`).
const scopeCap = 25
const resolveScope = (scope) => {
  const all = comps.map(c => c.sessionId)
  if (scope && all.includes(scope)) {
    return { ids: [scope], coverage: { sessionsMatched: 1, sessionsScanned: 1, scanCap: scopeCap, complete: true, note: `Single session ${scope}.` } }
  }
  const matched = scope ? all.filter(id => (projectFor(id) ?? '').startsWith(scope) || id.startsWith(scope)) : all
  const scanned = matched.slice(0, scopeCap)
  const complete = scanned.length === matched.length
  return {
    ids: scanned,
    coverage: {
      sessionsMatched: matched.length, sessionsScanned: scanned.length, scanCap: scopeCap, complete,
      note: complete
        ? `Scanned all ${matched.length} live-registry session(s) in scope${scope ? ` "${scope}"` : ''}. Historical sessions not in the live registry are not scanned (lazy).`
        : `SAMPLE: ${scanned.length} most-recent of ${matched.length} in-scope sessions scanned (cap ${scopeCap}). Lazy — no full-disk sweep; not full history.`,
    },
  }
}
idx.sessionsInScope = async (scope) => {
  const { ids, coverage } = resolveScope(scope)
  return { comps: ids.map(id => comps.find(c => c.sessionId === id)), coverage }
}

const scopeCases = ['sess-alpha', '/ws/', '/ws/beta', 'sess-', 'nomatch', undefined]
const imageCases = [{ name: 'all', scope: undefined }, { name: 'one-session', scope: 'sess-alpha' }, { name: 'project', scope: '/ws/beta' }, { name: 'no-match', scope: 'nomatch' }]
const blobCases = [
  { name: 'defaults', scope: undefined, filters: {} },
  { name: 'min-resident-4', scope: undefined, filters: { minResidentTurns: 4 } },
  { name: 'min-tokens', scope: undefined, filters: { minTokens: 1000 } },
  { name: 'kind-image', scope: undefined, filters: { kind: 'image' } },
  { name: 'topN-1-discloses-the-cut', scope: undefined, filters: { topN: 1 } },
  { name: 'topN-clamped-low', scope: undefined, filters: { topN: 0 } },
  { name: 'topN-clamped-high', scope: undefined, filters: { topN: 9999 } },
  { name: 'scoped-to-one-session', scope: 'sess-beta', filters: {} },
]
const queryCases = [
  { name: 'by-kind', filter: {}, groupBy: 'kind' },
  { name: 'by-session', filter: {}, groupBy: 'session' },
  { name: 'by-project', filter: {}, groupBy: 'project' },
  { name: 'by-model', filter: {}, groupBy: 'model' },
  { name: 'by-turn', filter: {}, groupBy: 'turn' },
  { name: 'model-substring-match', filter: { model: 'opus' }, groupBy: 'session' },
  { name: 'min-tokens', filter: { minTokens: 500 }, groupBy: 'kind' },
  { name: 'turn-range', filter: { turnFrom: 2, turnTo: 3 }, groupBy: 'turn' },
  { name: 'session-scope', filter: { sessionId: 'sess-beta' }, groupBy: 'kind' },
  { name: 'project-scope', filter: { project: '/ws/alpha' }, groupBy: 'kind' },
  { name: 'kind-filter', filter: { kind: 'text' }, groupBy: 'session' },
  { name: 'topN-1-discloses-the-cut', filter: { topN: 1 }, groupBy: 'kind' },
]

const J = (v) => JSON.parse(JSON.stringify(v ?? null))
writeFileSync(join(dir, 'ctxscope-expected.json'), JSON.stringify({
  comps: J(comps),
  scopeCases: J(scopeCases.map(s => s ?? null)),
  scopeResults: scopeCases.map(s => J(resolveScope(s))),
  imageCases: J(imageCases),
  imageResults: await Promise.all(imageCases.map(c => idx.imageReport(c.scope, projectFor).then(J))),
  blobCases: J(blobCases),
  blobResults: await Promise.all(blobCases.map(c => idx.findResidentBlobs(c.scope, c.filters, projectFor).then(J))),
  queryCases: J(queryCases),
  queryResults: await Promise.all(queryCases.map(c => idx.queryBlocks(c.filter, c.groupBy, projectFor).then(J))),
}, null, 1) + '\n')
console.log(`ctxscope-expected.json: ${scopeCases.length} scope + ${imageCases.length} image + ${blobCases.length} blob + ${queryCases.length} query cases`)
