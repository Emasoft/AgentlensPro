// Regenerates seismicrun-expected.json from the COMPILED src/burnSeismic.ts — the END-TO-END parity
// oracle for `burnSeismic` itself (TRDD-DMWOBWFH P4x.2t): the DuckDB aggregation, the bucket grid,
// the marked-point-process null, FDR, PELT segmentation, culprits, sessions and the spawn listing.
// Also (re)writes the synthetic transcript tree it analyses.
// Run from the repo root AFTER `pnpm run compile-tests`:
//   node rust-core/crates/agentlens-core/tests/fixtures/gen-seismicrun-expected.mjs
//
// WHY AN END-TO-END ORACLE AND NOT UNIT ONES: nothing between the SQL and the result is exported —
// the aggregation, the grid, the per-bucket nulls and the event assembly are all locals. Their
// values are observable ONLY through the returned object, so that object IS the contract.
//
// EVERYTHING IS FIXED IN TIME. `sinceIso` is passed explicitly and every record carries a literal
// 2026-01-01 timestamp, so no part of this depends on when it runs — unlike the file-SELECTION
// oracle next door, which has to stamp mtimes because selection is a wall-clock window.
//
// `pvalueEngine: 'internal'` is NOT a convenience: the 'auto' default probes for the `stochastic`
// DuckDB community extension, which would try to INSTALL it over the network. A fixture that
// silently depends on a network install is a fixture that fails in CI for a reason no one can see.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const TREE = path.join(HERE, 'seismicrun')
const { burnSeismic } = await import(path.join(HERE, '../../../../../out/test/burnSeismic.js'))

const SINCE = '2026-01-01T00:00:00'
const OPUS = 'claude-opus-5'
const SONNET = 'claude-sonnet-5'

// `2026-01-01T00:mm:ssZ` — the wire form Claude Code writes.
const ts = (min, sec = 0) =>
  `2026-01-01T${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}:${String(sec).padStart(2, '0')}.000Z`

const asst = (min, sec, model, inp, cc, cr, out) => JSON.stringify({
  type: 'assistant', timestamp: ts(min, sec),
  message: { model, usage: { input_tokens: inp, cache_creation_input_tokens: cc, cache_read_input_tokens: cr, output_tokens: out } },
})

const spawn = (min, sec, tool, input) => JSON.stringify({
  type: 'assistant', timestamp: ts(min, sec),
  message: { model: OPUS, usage: { input_tokens: 1, cache_creation_input_tokens: 1, cache_read_input_tokens: 1, output_tokens: 1 },
    content: [{ type: 'tool_use', name: tool, input }] },
})

// A quiet baseline for 90 minutes, then a 10-minute BURST in one session: many turns, each with a
// large cache_creation. That is the shape the detector exists to find — and it must find it here or
// the fixture pins nothing (an all-quiet series would exercise only the empty branches).
const lines = { a: [], b: [], c: [] }
for (let m = 0; m < 120; m += 5) {
  // Two steady sessions, deliberately different models so the per-model rate lookup is exercised.
  lines.a.push(asst(m, 10, OPUS, 100, 2_000, 20_000, 300))
  lines.b.push(asst(m, 20, SONNET, 80, 1_500, 15_000, 250))
}
// The burst: session C, minutes 60-69, eight turns per bucket with 40x the usual cache_creation.
for (let m = 60; m < 70; m++) {
  for (let k = 0; k < 8; k++) {
    lines.c.push(asst(m, k * 7, OPUS, 500, 80_000, 5_000, 900))
  }
}
// A spawn call INSIDE the burst window and one OUTSIDE it: only the first may appear in the report,
// and the window comparison is the one that was silently broken by comparing ISO-T text to a naive
// bucket label.
lines.c.push(spawn(62, 30, 'Agent', { subagent_type: 'general-purpose', model: OPUS, prompt: 'do the thing' }))
lines.a.push(spawn(5, 30, 'Task', { subagent_type: 'spark', prompt: 'not in the event' }))
// A record with no usage at all (filtered by the WHERE), and a torn line (all-NULL row under
// ignore_errors — counted by the torn-line probe, not dropped).
lines.a.push(JSON.stringify({ type: 'user', timestamp: ts(1), message: { role: 'user' } }))
lines.a.push('{"type":"assistant","message":{"usage":{')

const FILES = {
  'projA/aaaaaaaa-1111-2222-3333-444444444444.jsonl': lines.a,
  'projA/bbbbbbbb-1111-2222-3333-444444444444.jsonl': lines.b,
  'projB/cccccccc-1111-2222-3333-444444444444.jsonl': lines.c,
}
const paths = []
for (const [rel, ls] of Object.entries(FILES)) {
  const p = path.join(TREE, rel)
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, ls.join('\n') + '\n')
  paths.push(p)
}

const redact = (v) => JSON.parse(JSON.stringify(v).split(TREE).join('<FIXTURES>'))

const cases = {}
const run = async (name, opts) => {
  cases[name] = { opts, out: redact(await burnSeismic({ files: paths, sinceIso: SINCE, pvalueEngine: 'internal', ...opts })) }
}

await run('default', { bucketMinutes: 5 })
// One-minute buckets: a finer grid, more zero buckets, and a different null — the zero-inflation the
// hurdle model exists for.
await run('bucket_1m', { bucketMinutes: 1 })
// `rateLaw: 'poisson'` pins variance to the mean, which is the falsifier that reproduces the
// pre-negative-binomial false-alarm rate on demand.
await run('poisson_law', { bucketMinutes: 5, rateLaw: 'poisson' })
// CFAR disabled ⇒ the GLOBAL stationary null, and `localBaseline: null` in the result.
await run('no_cfar', { bucketMinutes: 5, cfarReference: 0 })
// A window that starts after every record: no costed turns at all.
await run('empty_window', { bucketMinutes: 5, sinceIso: '2027-01-01T00:00:00' })
// No files: the earliest exit, and the one that must NOT open DuckDB.
cases.no_files = { opts: { files: [] }, out: redact(await burnSeismic({ files: [], sinceIso: SINCE, pvalueEngine: 'internal' })) }
// A single session, which is what a `scope: 'session'` caller passes.
cases.one_file = {
  opts: { files: ['<FIXTURES>/projB/cccccccc-1111-2222-3333-444444444444.jsonl'], bucketMinutes: 5 },
  out: redact(await burnSeismic({ files: [paths[2]], sinceIso: SINCE, bucketMinutes: 5, pvalueEngine: 'internal' })),
}

const out = { sinceIso: SINCE, files: paths.map((p) => p.split(TREE).join('<FIXTURES>')), cases }
fs.writeFileSync(path.join(HERE, 'seismicrun-expected.json'), JSON.stringify(out, null, 2) + '\n')
console.log('wrote seismicrun-expected.json')
for (const [k, v] of Object.entries(cases)) {
  const r = v.out
  console.log(` ${k}: reason=${r.reason ?? '-'} buckets=${r.bucketCount} events=${r.events.length} sig=${r.fdrSignificantCount} spawns=${r.spawnsInMainshock.length} law=${r.rateLaw}`)
}
