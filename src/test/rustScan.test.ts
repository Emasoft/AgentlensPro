// src/test/rustScan.test.ts — the Rust engine bridge (TRDD-DMWOBWFH P1): cross-engine parity
// against the REAL alscan binary on a fixture store, and the fail-fast contract.
//
// The binary comes from the repo's own cargo build (rust-core/target/release/alscan). CI has no
// Rust toolchain, so the parity tests surface as PENDING there (visible, never silently green);
// on this machine they run for real.

import * as assert from 'assert'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { alscanBin, rustScanCallEvents } from '../rustScan'
import { scanOtelCallEvents } from '../otelCallEvents'
import { scanOtelCallEventsIndexed } from '../otelCallIndex'

const BIN = path.join(__dirname, '..', '..', '..', 'rust-core', 'target', 'release', 'alscan')
const haveBin = fs.existsSync(BIN)

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'al-rust-'))
const spansDir = path.join(tmpDir, 'spans')
fs.mkdirSync(spansDir)

const DAY = '2026-08-18'
const ISO = `${DAY}T08:00:00.000Z`
function spanLine(name: string, session: string, attrs: Record<string, unknown>): string {
  const attributes = [
    { key: 'session.id', value: { stringValue: session } },
    ...Object.entries(attrs).map(([key, value]) => ({ key, value })),
  ]
  return JSON.stringify({ name, startTime: '1755504000000000000', attributes })
}
fs.writeFileSync(path.join(spansDir, `${DAY}.ndjson`), [
  spanLine('claude_code.api_request', 'sess-1', {
    'event.timestamp': { stringValue: ISO },
    request_id: { stringValue: 'req-a' },
    model: { stringValue: 'claude-opus-5' },
    input_tokens: { intValue: '100' },        // string intValue on purpose
    output_tokens: { intValue: 20 },
    cache_read_tokens: { intValue: '3000' },
    cache_creation_tokens: { intValue: 0 },
    cost_usd_micros: { intValue: '420000' },
    query_source: { stringValue: 'repl_main_thread' },
    speed: { stringValue: 'fast' },
    effort: { stringValue: 'high' },
    'agent.name': { stringValue: 'lean-worker' },
  }),
  spanLine('claude_code.compaction', 'sess-1', {
    'event.timestamp': { stringValue: ISO },
    trigger: { stringValue: 'auto' },
    pre_tokens: { intValue: '500000' },
    post_tokens: { intValue: 12000 },
  }),
  '{"name":"claude_code.api_request","attributes":[{"key":"trunc', // corrupt tail — skipped
].join('\n') + '\n')

suite('rustScan — engine bridge', () => {
  test('alscanBin: env wins, else the durable install location, else off — never auto-detection', () => {
    const missing = path.join(tmpDir, 'no-such-bin')
    assert.strictEqual(alscanBin({}, missing), null)
    assert.strictEqual(alscanBin({ AGENTLENS_ALSCAN: '  ' }, missing), null)
    assert.strictEqual(alscanBin({ AGENTLENS_ALSCAN: '/x/alscan' }, missing), '/x/alscan')
    const installed = path.join(tmpDir, 'alscan')
    fs.writeFileSync(installed, '#!/bin/sh\n')
    assert.strictEqual(alscanBin({}, installed), installed, 'the installed file IS the opt-in')
  })

  test('a broken binary path THROWS — opted-in means loud, never a silent TS fallback', async () => {
    await assert.rejects(
      () => rustScanCallEvents('/definitely/not/a/binary', { spansDir, sinceMs: 0, untilMs: Date.now() }),
      /alscan failed/)
  })

  const parityTest = haveBin ? test : test.skip
  parityTest('🐌 cross-engine parity: alscan and the TS scan agree field-for-field on the fixture', async function () {
    this.timeout(30_000)
    const until = Date.parse(`${DAY}T23:59:59Z`)
    const rust = await rustScanCallEvents(BIN, { spansDir, sinceMs: 0, untilMs: until })
    const ts = await scanOtelCallEvents({ spansDir, sinceMs: 0, untilMs: until, nowMs: until })
    assert.deepStrictEqual(rust.events, ts.events,
      'every OtelCallEvent field — including speed/effort/agentName and micros-derived costUsd — must match')
    assert.deepStrictEqual(rust.compactions, ts.compactions)
    assert.strictEqual(rust.events[0].costUsd, 0.42)
    assert.strictEqual(rust.events[0].agentName, 'lean-worker')
  })

  parityTest('🐌 scanOtelCallEventsIndexed routes to the Rust engine when AGENTLENS_ALSCAN is set', async function () {
    this.timeout(30_000)
    const prev = process.env.AGENTLENS_ALSCAN
    process.env.AGENTLENS_ALSCAN = BIN
    try {
      const until = Date.parse(`${DAY}T23:59:59Z`)
      const r = await scanOtelCallEventsIndexed({ spansDir, sinceMs: 0, untilMs: until, nowMs: until })
      assert.match(r.coverage.note, /Rust engine \(alscan\)/, 'the coverage note must name the engine that answered')
      assert.strictEqual(r.events.length, 1)
      assert.strictEqual(r.compactions.length, 1)
      assert.ok(!fs.existsSync(path.join(spansDir, '.call-events-index')),
        'the Rust path must not build TS sidecars')
    } finally {
      if (prev === undefined) delete process.env.AGENTLENS_ALSCAN
      else process.env.AGENTLENS_ALSCAN = prev
    }
  })
})
