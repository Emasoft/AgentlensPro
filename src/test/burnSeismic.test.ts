// burnSeismic — the engine, end-to-end over a REAL (synthetic) transcript via DuckDB. Pins the
// contract WITHOUT a live burn: a lone cold-WRITE spike over a quiet background is detected as a
// CACHE_THRASH event, the cost is reconstructed from usage × real rates, the mainshock's spawn call
// is extracted verbatim, and an empty/quiet input yields a typed reason / no fabricated event.
// pvalueEngine:'internal' keeps it deterministic and offline (no community-extension download).
import * as assert from 'assert'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { burnSeismic, renderBurnSeismic } from '../burnSeismic'

const OPUS = 'claude-opus-4-8' // rates /1M: input 5, cacheRead 0.5, cacheWrite 6.25, output 25

interface Turn { min: number; cc?: number; cr?: number; inp?: number; out?: number; blocks?: unknown[] }
function writeTranscript(turns: Turn[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentlens-seismic-'))
  const p = path.join(dir, 'session.jsonl')
  const base = Date.UTC(2026, 0, 1, 0, 0, 0)
  const lines = turns.map(t => JSON.stringify({
    type: 'assistant',
    timestamp: new Date(base + t.min * 60_000).toISOString(),
    message: {
      model: OPUS,
      usage: { input_tokens: t.inp ?? 1, cache_creation_input_tokens: t.cc ?? 0, cache_read_input_tokens: t.cr ?? 0, output_tokens: t.out ?? 10 },
      content: t.blocks ?? [{ type: 'text', text: 'ok' }],
    },
  }))
  fs.writeFileSync(p, lines.join('\n') + '\n')
  return p
}
const SINCE = '2025-12-31T00:00:00.000Z'

suite('burnSeismic — engine over a real transcript', () => {
  test('a lone cold-WRITE spike over a quiet background is a CACHE_THRASH event; cost from usage×rates', async () => {
    // 40 quiet minutes (small read) + one minute with a 5M-token cold cache WRITE (opus $6.25/M ⇒ $31.25).
    const turns: Turn[] = []
    for (let m = 0; m < 40; m++) turns.push({ min: m, cr: 20_000, out: 20 }) // ~$0.011/min read
    turns.push({ min: 40, cc: 5_000_000, out: 40, blocks: [
      { type: 'text', text: 'fan out' },
      { type: 'tool_use', name: 'Agent', id: 'tu1', input: { subagent_type: 'spark', model: 'opus', prompt: 'go build' } },
    ] })
    const p = writeTranscript(turns)
    const r = await burnSeismic({ files: [p], sinceIso: SINCE, bucketMinutes: 1, pvalueEngine: 'internal' })

    assert.strictEqual(r.reason, undefined)
    assert.strictEqual(r.pvalueEngine, 'internal')
    // Cost is dominated by the single cold-write minute: 5e6 × 6.25/1e6 = $31.25.
    assert.ok(r.totalWriteUsd > 31 && r.totalWriteUsd < 31.5, `write $ ${r.totalWriteUsd} ≈ 31.25`)
    assert.ok(r.mainshock, 'the spike must trigger an FDR-significant event')
    assert.strictEqual(r.mainshock!.dominantMode, 'CACHE_THRASH')
    assert.ok(r.mainshock!.writeUsd > r.mainshock!.readUsd, 'mainshock is cold-write dominated')
    assert.ok(r.fdrSignificantCount >= 1, 'at least one bucket survives BH-FDR')
    assert.strictEqual(r.dominantModeOverall, 'CACHE_THRASH')
    // The spawn call inside the mainshock is extracted verbatim.
    assert.strictEqual(r.spawnsInMainshock.length, 1)
    assert.strictEqual(r.spawnsInMainshock[0].tool, 'Agent')
    assert.strictEqual(r.spawnsInMainshock[0].subagentType, 'spark')
    assert.ok(r.spawnsInMainshock[0].input.includes('go build'))
    assert.match(renderBurnSeismic(r), /CACHE_THRASH/)
  })

  test('a sustained high-READ plateau is classified MARATHON_REREAD by the overall verdict', async () => {
    // Every minute re-reads a fat ~400k prefix (opus $0.50/M ⇒ $0.20/min) — a tremor, not a spike.
    const turns: Turn[] = []
    for (let m = 0; m < 30; m++) turns.push({ min: m, cr: 400_000, cc: 300, out: 50 })
    const r = await burnSeismic({ files: [writeTranscript(turns)], sinceIso: SINCE, pvalueEngine: 'internal' })
    assert.strictEqual(r.dominantModeOverall, 'MARATHON_REREAD')
    assert.ok(r.totalReadUsd > r.totalWriteUsd, 'read dominates the plateau')
    assert.match(r.verdict, /MARATHON RE-READ dominates/)
  })

  test('turn counts feed a Poisson corroboration; the change-point/CUSUM fields are populated', async () => {
    const turns: Turn[] = []
    for (let m = 0; m < 20; m++) turns.push({ min: m, cr: 10_000, out: 10 })
    turns.push({ min: 20, cc: 3_000_000, out: 30 })
    const r = await burnSeismic({ files: [writeTranscript(turns)], sinceIso: SINCE, pvalueEngine: 'internal' })
    assert.ok(r.poissonLambda > 0, 'a background turn rate is estimated')
    assert.ok(r.buckets.length > 0)
    assert.ok(r.buckets.every(b => b.pValue >= 0 && b.pValue <= 1 && b.pValuePoisson >= 0 && b.pValuePoisson <= 1))
  })

  test('no files → typed reason no-files; a nonexistent path is filtered, never fabricated', async () => {
    const r = await burnSeismic({ files: [], sinceIso: SINCE, pvalueEngine: 'internal' })
    assert.strictEqual(r.reason, 'no-files')
    assert.strictEqual(r.mainshock, undefined)
    assert.strictEqual(r.events.length, 0)
    assert.match(renderBurnSeismic(r), /no analysis \(no-files\)/)
  })
})
