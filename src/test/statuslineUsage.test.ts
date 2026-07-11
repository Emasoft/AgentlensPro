import * as assert from 'assert'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { StatuslineUsageReader } from '../statuslineUsage'

// TRDD-VY1IUVUM Part-5 — the reader's rate_limits ingestion. REAL temp-file tails (no mocks): write a
// usage jsonl, point a reader at it, and assert getLatestRateLimits() reflects what was persisted. The
// rate_limits block is present ONLY on statusline builds that re-emit it — an absent block yields null,
// never a fabricated 0.

let seq = 0
function tempLog(lines: unknown[]): { file: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `al-sl-${process.pid}-${seq++}-`))
  const file = path.join(dir, 'statusline-usage.jsonl')
  fs.writeFileSync(file, lines.map(l => JSON.stringify(l)).join('\n') + '\n')
  return { file, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) }
}

// One usage record. Only session_id + ts matter to the aggregate; the caller supplies rate_limits.
function rec(ts: number, over: Record<string, unknown> = {}): Record<string, unknown> {
  return { ts, session_id: 's1', project_dir: '/p', model: 'claude-opus-4-8', total_cost_usd: 0, ...over }
}

suite('statuslineUsage — rate_limits ingestion (TRDD-VY1IUVUM Part-5)', () => {
  test('no record carries rate_limits → getLatestRateLimits() is null (absent, not 0)', () => {
    const { file, cleanup } = tempLog([rec(100), rec(200)])
    try {
      const r = new StatuslineUsageReader(file)
      r.refresh()
      assert.strictEqual(r.getLatestRateLimits(), null)
    } finally { cleanup() }
  })

  test('captures the utilization when a record carries the rate_limits block', () => {
    const { file, cleanup } = tempLog([
      rec(100, { rate_limits: { five_hour: { utilization: 37.5 }, seven_day: { utilization: 6 } } }),
    ])
    try {
      const r = new StatuslineUsageReader(file)
      r.refresh()
      assert.deepStrictEqual(r.getLatestRateLimits(), { ts: 100, fiveHourUtilization: 37.5, sevenDayUtilization: 6 })
    } finally { cleanup() }
  })

  test('latest-wins: a newer record overrides an older snapshot; a stale one does not clobber it', () => {
    const { file, cleanup } = tempLog([
      rec(100, { rate_limits: { five_hour: { utilization: 10 }, seven_day: { utilization: 2 } } }),
      rec(300, { rate_limits: { five_hour: { utilization: 55 }, seven_day: { utilization: 9 } } }),
      rec(200, { rate_limits: { five_hour: { utilization: 99 }, seven_day: { utilization: 99 } } }),  // out-of-order/stale
    ])
    try {
      const r = new StatuslineUsageReader(file)
      r.refresh()
      assert.deepStrictEqual(r.getLatestRateLimits(), { ts: 300, fiveHourUtilization: 55, sevenDayUtilization: 9 })
    } finally { cleanup() }
  })

  test('a partial block (only five_hour) leaves the missing window null, never 0', () => {
    const { file, cleanup } = tempLog([rec(100, { rate_limits: { five_hour: { utilization: 20 } } })])
    try {
      const r = new StatuslineUsageReader(file)
      r.refresh()
      assert.deepStrictEqual(r.getLatestRateLimits(), { ts: 100, fiveHourUtilization: 20, sevenDayUtilization: null })
    } finally { cleanup() }
  })

  test('a rotated/truncated file resets the snapshot to null', () => {
    const { file, cleanup } = tempLog([rec(100, { rate_limits: { five_hour: { utilization: 42 } } })])
    try {
      const r = new StatuslineUsageReader(file)
      r.refresh()
      assert.ok(r.getLatestRateLimits() !== null)
      // Shrink the file (rotation): the reader detects size < offset and clears its snapshot.
      fs.writeFileSync(file, '')
      r.refresh()
      assert.strictEqual(r.getLatestRateLimits(), null)
    } finally { cleanup() }
  })
})
