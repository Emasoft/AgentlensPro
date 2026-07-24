// burnSeismic v2 — the engine, end-to-end over REAL (synthetic) transcripts via DuckDB. Each cause
// class is pinned by a fixture carrying EXACTLY its statistical signature — and nothing else — so a
// label can only fire from the decomposition it claims to detect:
//   (a) many-cheap-turns minute  → RATE evidence only     → FANOUT_RATE
//   (b) one-huge-cold-write turn → INTENSITY+write        → FAT_TURN_THRASH + COLD_REWRITE tag
//   (c) sustained fat-read tail  → INTENSITY+read plateau → PELT boundary + FAT_TURN_MARATHON
//   (d) model switch in event    → MODEL_SWITCH tag
//   (e) empty inputs             → typed reasons, never a fabricated event
// pvalueEngine:'internal' keeps it deterministic and offline (no community-extension download).
import * as assert from 'assert'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { burnSeismic, renderBurnSeismic } from '../burnSeismic'

const OPUS = 'claude-opus-4-8' // /1M: input 5, cacheRead 0.5, cacheWrite 6.25, output 25
const SONNET = 'claude-sonnet-5'

interface Turn { min: number; cc?: number; cr?: number; inp?: number; out?: number; model?: string; blocks?: unknown[] }
function writeTranscript(turns: Turn[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentlens-seismic-'))
  const p = path.join(dir, 'session.jsonl')
  const base = Date.UTC(2026, 0, 1, 0, 0, 0)
  const lines = turns.map((t, i) => JSON.stringify({
    type: 'assistant',
    timestamp: new Date(base + Math.round(t.min * 60_000) + (i % 50)).toISOString(), // tiny skew keeps ts unique
    message: {
      model: t.model ?? OPUS,
      usage: { input_tokens: t.inp ?? 1, cache_creation_input_tokens: t.cc ?? 0, cache_read_input_tokens: t.cr ?? 0, output_tokens: t.out ?? 10 },
      content: t.blocks ?? [{ type: 'text', text: 'ok' }],
    },
  }))
  fs.writeFileSync(p, lines.join('\n') + '\n')
  return p
}
const SINCE = '2025-12-31T00:00:00.000Z'
const bucketIso = (min: number): string => new Date(Date.UTC(2026, 0, 1, 0, min, 0)).toISOString().replace('T', ' ').replace(/\..*/, '')

suite('burnSeismic v2 — rate×intensity decomposition names the cause', () => {
  test('(a) a 30-turn fan-out minute over a 1-turn/min background is FANOUT_RATE (rate evidence, not intensity)', async () => {
    const turns: Turn[] = []
    for (let m = 0; m < 40; m++) {
      // One spawn far BEFORE the event: it must NOT leak into spawnsInMainshock. (The live fleet
      // run exposed exactly this leak — a VARCHAR-vs-naive-timestamp compare passed the whole day.)
      turns.push({ min: m, cr: 20_000, out: 20, blocks: m === 2
        ? [{ type: 'tool_use', name: 'Agent', id: 'tu0', input: { subagent_type: 'spark', prompt: 'early unrelated spawn' } }]
        : [{ type: 'text', text: 'ok' }] })
    }
    for (let k = 0; k < 30; k++) {
      turns.push({ min: 40, cr: 20_000, out: 20, blocks: k === 0
        ? [{ type: 'tool_use', name: 'Agent', id: 'tu1', input: { subagent_type: 'spark', prompt: 'fan out' } }]
        : [{ type: 'text', text: 'ok' }] })
    }
    const r = await burnSeismic({ files: [writeTranscript(turns)], sinceIso: SINCE, pvalueEngine: 'internal' })
    assert.strictEqual(r.reason, undefined)
    assert.ok(r.mainshock, 'the burst must be a significant event')
    const m = r.mainshock!
    assert.strictEqual(m.cause, 'FANOUT_RATE')
    assert.ok(m.minPRate <= 1e-10, `rate p must carry the evidence (got ${m.minPRate})`)
    assert.ok(m.minPIntensity >= 0.2, `per-turn cost is UNCHANGED — intensity must stay quiet (got ${m.minPIntensity})`)
    // λ̂ from the trimmed background, the burst excluded from its own baseline.
    assert.ok(Math.abs(r.poissonLambda - 1) < 0.15, `λ̂ ≈ 1 (got ${r.poissonLambda})`)
    // ONLY the spawn inside the event window is named — the minute-2 spawn stays out.
    assert.strictEqual(r.spawnsInMainshock.length, 1, `expected 1 in-window spawn, got ${r.spawnsInMainshock.map(s => s.iso).join(',')}`)
    assert.ok(r.spawnsInMainshock[0].input.includes('fan out'))
    assert.ok(!r.spawnsInMainshock.some(s => s.input.includes('early unrelated')), 'the out-of-window spawn leaked in')
    // The (single) session's event excess is positive and drives the session ranking key.
    assert.ok(m.culprits.length === 1 && m.culprits[0].excessUsd > 0)
    assert.ok(r.sessions[0].eventExcessUsd > 0)
  })

  test('(b) one cold full-prefix rewrite turn is FAT_TURN_THRASH with the COLD_REWRITE tag', async () => {
    const turns: Turn[] = []
    for (let m = 0; m < 40; m++) turns.push({ min: m, cr: 400_000, out: 20 }) // fat 400k prefix, steady
    turns.push({ min: 40, cc: 5_000_000, out: 40 }) // ONE turn, cc ≈ 12× the prefix — a cold rewrite
    const r = await burnSeismic({ files: [writeTranscript(turns)], sinceIso: SINCE, pvalueEngine: 'internal' })
    assert.ok(r.mainshock)
    const m = r.mainshock!
    assert.strictEqual(m.cause, 'FAT_TURN_THRASH')
    assert.ok(m.minPIntensity <= 1e-10, 'intensity carries the evidence')
    assert.ok(m.minPRate >= 0.2, 'ONE turn at the background rate — the rate test must stay quiet')
    assert.ok(m.excessUsd > 30, `the excess is the ~$31.25 cold write (got ${m.excessUsd})`)
    assert.deepStrictEqual(m.culprits[0].tags, ['COLD_REWRITE'])
    assert.strictEqual(r.dominantModeOverall, 'CACHE_THRASH')
    assert.match(renderBurnSeismic(r), /FAT_TURN_THRASH/)
  })

  test('(c) a sustained fat-read tail: PELT puts the boundary at the regime change, cause FAT_TURN_MARATHON', async () => {
    const turns: Turn[] = []
    for (let m = 0; m < 54; m++) turns.push({ min: m, cr: 10_000, out: 10 }) // thin background
    for (let m = 54; m < 60; m++) turns.push({ min: m, cr: 2_000_000, out: 10 }) // 2M-prefix re-read plateau
    const r = await burnSeismic({ files: [writeTranscript(turns)], sinceIso: SINCE, pvalueEngine: 'internal' })
    assert.ok(r.mainshock, 'the plateau must be a significant event')
    const m = r.mainshock!
    assert.strictEqual(m.cause, 'FAT_TURN_MARATHON')
    // PELT found the regime boundary exactly at the plateau onset; the WHOLE elevated segment is
    // the event (a tremor, not a one-bucket spike).
    assert.ok(r.peltChangepoints.includes(bucketIso(54)), `PELT boundary at min 54 (got ${r.peltChangepoints.join(',')})`)
    assert.strictEqual(m.fromIso, bucketIso(54))
    assert.strictEqual(m.durMin, 6)
    assert.strictEqual(m.dominantMode, 'MARATHON_REREAD')
    // No cold-rewrite fabrication: cc is 0 throughout.
    assert.ok(m.culprits.every(c => !c.tags.includes('COLD_REWRITE')))
  })

  test('(d) a model switch inside the event tags the culprit MODEL_SWITCH', async () => {
    const turns: Turn[] = []
    for (let m = 0; m < 30; m++) turns.push({ min: m, cr: 400_000, out: 20 })
    turns.push({ min: 30, cc: 5_000_000, out: 40 }) // opus rewrite …
    turns.push({ min: 30, cr: 400_000, out: 40, model: SONNET }) // … plus a sonnet turn = a switch
    const r = await burnSeismic({ files: [writeTranscript(turns)], sinceIso: SINCE, pvalueEngine: 'internal' })
    assert.ok(r.mainshock)
    const tags = r.mainshock!.culprits[0].tags
    assert.ok(tags.includes('MODEL_SWITCH'), `expected MODEL_SWITCH in [${tags.join(',')}]`)
    assert.ok(tags.includes('COLD_REWRITE'))
    assert.deepStrictEqual(r.mainshock!.culprits[0].models, [OPUS, SONNET].sort())
  })

  test('calibration self-check reports a background false-positive share ≤ ~5% on a quiet series', async () => {
    // 120 steady minutes, no anomaly: nothing significant, background share must be small.
    const turns: Turn[] = []
    for (let m = 0; m < 120; m++) turns.push({ min: m, cr: 50_000, out: 15 })
    const r = await burnSeismic({ files: [writeTranscript(turns)], sinceIso: SINCE, pvalueEngine: 'internal' })
    assert.strictEqual(r.events.length, 0, 'a steady series has no events')
    assert.ok(r.calibration.observedBackgroundShare !== null)
    assert.ok(r.calibration.observedBackgroundShare! <= 0.05 + 1e-9,
      `background p<.05 share ${r.calibration.observedBackgroundShare} must be ≤ 5% (discrete-conservative)`)
    assert.strictEqual(r.pvalueEngine, 'internal')
  })

  test('(f) NONSTATIONARY day/night: the global null calls the busy regime an anomaly, the LOCAL (CFAR) null does not — and still finds the real burst', async () => {
    // 120 quiet minutes (1 turn) then 120 busy minutes (20 turns) at IDENTICAL per-turn cost: a
    // regime change, not an anomaly. One genuine 200-turn burst sits inside the busy regime — the
    // detector must separate "busy because it is daytime" from "busy because something went wrong".
    const turns: Turn[] = []
    for (let m = 0; m < 120; m++) turns.push({ min: m, cr: 20_000, out: 10 })
    for (let m = 120; m < 240; m++) {
      const n = m === 180 ? 200 : 20
      for (let k = 0; k < n; k++) turns.push({ min: m, cr: 20_000, out: 10 })
    }
    const file = writeTranscript(turns)
    const common = { files: [file], sinceIso: SINCE, pvalueEngine: 'internal' as const }
    // Three configurations isolate the two mechanisms — each has its own falsifier.
    const poissonGlobal = await burnSeismic({ ...common, cfarReference: 0, rateLaw: 'poisson' })
    const glob = await burnSeismic({ ...common, cfarReference: 0 })
    const loc = await burnSeismic({ ...common, cfarReference: 40, cfarGuard: 5, cfarMinReference: 20 })

    // 1. THE DEFECT, reproduced on demand: one stationary background + a Poisson law calls every
    //    ordinary busy minute improbable — the live-fleet symptom (a >5% background share).
    assert.strictEqual(poissonGlobal.rateLaw, 'poisson')
    assert.ok(poissonGlobal.calibration.observedBackgroundShare! > 0.2,
      `the stationary Poisson null must mis-calibrate here (got ${poissonGlobal.calibration.observedBackgroundShare})`)

    // 2. The NEGATIVE BINOMIAL fixes the SHAPE: the regime mixture is absorbed as over-dispersion
    //    (σ²/μ ≫ 1) and calibration is restored — but at the cost of a much wider null.
    assert.strictEqual(glob.rateLaw, 'negative-binomial')
    assert.ok(glob.dispersionIndex > 3, `the mixture shows up as dispersion (got ${glob.dispersionIndex})`)
    assert.ok(glob.calibration.observedBackgroundShare! <= 0.05 + 1e-9)

    // 3. The LOCAL background fixes the LEVEL, which is what the dispersion parameter was papering
    //    over: each window is homogeneous again (dispersion collapses), λ̂ₜ tracks the regime instead
    //    of averaging it, and the REAL burst becomes orders of magnitude more significant.
    assert.ok(loc.localBaseline && loc.localBaseline.fallbackShare < 0.6)
    assert.ok(loc.calibration.observedBackgroundShare! <= 0.05 + 1e-9)
    assert.ok(loc.dispersionIndex <= 1, `local windows are homogeneous (got ${loc.dispersionIndex})`)
    const at = (min: number): number => loc.buckets[min].lambda
    assert.ok(Math.abs(at(60) - 1) < 0.2, `quiet-regime λ̂ ≈ 1 (got ${at(60)})`)
    assert.ok(Math.abs(at(200) - 20) < 2, `busy-regime λ̂ ≈ 20 (got ${at(200)})`)
    assert.ok(Math.abs(glob.buckets[60].lambda - glob.buckets[200].lambda) < 1e-9,
      'the global null must use ONE λ̂ for both regimes — that is the thing being fixed')
    assert.ok(loc.buckets[180].pValueRate < glob.buckets[180].pValueRate / 100,
      `the burst is far better resolved locally (${loc.buckets[180].pValueRate} vs ${glob.buckets[180].pValueRate})`)

    // …and under every configuration the REAL burst is still found and named.
    for (const r of [glob, loc]) {
      assert.ok(r.mainshock, 'the 200-turn burst must remain a significant event')
      assert.strictEqual(r.mainshock!.fromIso, bucketIso(180))
      assert.strictEqual(r.mainshock!.cause, 'FANOUT_RATE')
    }
    assert.match(renderBurnSeismic(loc), /LOCAL CFAR/)
    assert.match(renderBurnSeismic(glob), /NegBinom/)
  })

  test('(e) no files → typed reason no-files; nothing fabricated', async () => {
    const r = await burnSeismic({ files: [], sinceIso: SINCE, pvalueEngine: 'internal' })
    assert.strictEqual(r.reason, 'no-files')
    assert.strictEqual(r.mainshock, undefined)
    assert.strictEqual(r.events.length, 0)
    assert.match(renderBurnSeismic(r), /no analysis \(no-files\)/)
  })

  test("fdrMethod 'by' is accepted and disclosed (arbitrary-dependence guarantee)", async () => {
    const turns: Turn[] = []
    for (let m = 0; m < 30; m++) turns.push({ min: m, cr: 20_000, out: 10 })
    turns.push({ min: 30, cc: 5_000_000, out: 10 })
    const r = await burnSeismic({ files: [writeTranscript(turns)], sinceIso: SINCE, pvalueEngine: 'internal', fdrMethod: 'by' })
    assert.strictEqual(r.fdrMethod, 'by')
    assert.ok(r.mainshock, 'a p≈0 spike survives even the conservative BY correction')
  })
})
