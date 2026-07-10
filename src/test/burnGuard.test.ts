import * as assert from 'assert'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { checkBurnRisk } from '../burnGuard'

// ── check_burn_risk (TRDD-W6UH8LPA) — real-filesystem tests ──────────────────
// Real tmpdir stores; each signal toggled by the synthetic shape that trips it.

let seq = 0
function stores(): { bodies: string; hooks: string; cleanup: () => void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `al-guard-${process.pid}-${seq++}-`))
  const bodies = path.join(root, 'otel-bodies')
  const hooks = path.join(root, 'hook-events')
  fs.mkdirSync(bodies, { recursive: true })
  fs.mkdirSync(hooks, { recursive: true })
  return { bodies, hooks, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) }
}

function hookEvent(dir: string, ts: number, ev: string, payload: Record<string, unknown> = {}): void {
  const day = new Date(ts).toISOString().slice(0, 10)
  fs.appendFileSync(path.join(dir, `${day}.ndjsonl`),
    `${JSON.stringify({ ts, ev, payload: { hook_event_name: ev, ...payload } })}\n`)
}

function bigRequest(dir: string, ts: number, mb: number): void {
  const p = path.join(dir, `g${seq}-${Math.random().toString(36).slice(2)}.request.json`)
  fs.writeFileSync(p, JSON.stringify({ body: { pad: 'z'.repeat(mb * 1_000_000) } }))
  fs.utimesSync(p, ts / 1000, ts / 1000)
}

const NOW = Date.now()
const active = (r: ReturnType<typeof checkBurnRisk>, code: string): boolean =>
  r.risks.find(x => x.code === code)?.active ?? false

suite('burnGuard — check_burn_risk (TRDD-W6UH8LPA)', () => {
  test('quiet stores: zero active risks, sources honest, no advice', () => {
    const { bodies, hooks, cleanup } = stores()
    try {
      const r = checkBurnRisk({ bodiesDir: bodies, hookEventsDir: hooks, burnStatus: { accountWindows: [] }, now: NOW })
      assert.strictEqual(r.activeCount, 0)
      assert.strictEqual(r.advice, null)
      assert.deepStrictEqual(r.sources, { hookEvents: true, bodies: true, burnStatus: true })
    } finally { cleanup() }
  })

  test('FANOUT_BURST trips at 5 SubagentStarts in 2min, not at 4', () => {
    const { bodies, hooks, cleanup } = stores()
    try {
      for (let i = 0; i < 4; i++) hookEvent(hooks, NOW - i * 10_000, 'SubagentStart')
      let r = checkBurnRisk({ bodiesDir: bodies, hookEventsDir: hooks, now: NOW })
      assert.strictEqual(active(r, 'FANOUT_BURST'), false, '4 starts must not trip')
      hookEvent(hooks, NOW - 45_000, 'SubagentStart')
      r = checkBurnRisk({ bodiesDir: bodies, hookEventsDir: hooks, now: NOW })
      assert.strictEqual(active(r, 'FANOUT_BURST'), true, '5 starts must trip')
      assert.ok(r.advice, 'active risk carries advice')
    } finally { cleanup() }
  })

  test('FANOUT_BURST ignores starts older than the 2min window', () => {
    const { bodies, hooks, cleanup } = stores()
    try {
      for (let i = 0; i < 6; i++) hookEvent(hooks, NOW - 10 * 60_000 - i * 1000, 'SubagentStart')
      const r = checkBurnRisk({ bodiesDir: bodies, hookEventsDir: hooks, now: NOW })
      assert.strictEqual(active(r, 'FANOUT_BURST'), false)
    } finally { cleanup() }
  })

  test('COLD_RESUME_RISK trips on a StopFailure within 10min and names its age', () => {
    const { bodies, hooks, cleanup } = stores()
    try {
      hookEvent(hooks, NOW - 7 * 60_000, 'StopFailure')
      const r = checkBurnRisk({ bodiesDir: bodies, hookEventsDir: hooks, now: NOW })
      assert.strictEqual(active(r, 'COLD_RESUME_RISK'), true)
      const risk = r.risks.find(x => x.code === 'COLD_RESUME_RISK')
      if (!risk) throw new Error('unreachable')
      assert.ok(risk.detail.includes('7min ago'), risk.detail)
    } finally { cleanup() }
  })

  test('COMPACTION_REWRITE trips on PreCompact within 5min, carrying the trigger', () => {
    const { bodies, hooks, cleanup } = stores()
    try {
      hookEvent(hooks, NOW - 2 * 60_000, 'PreCompact', { trigger: 'auto' })
      const r = checkBurnRisk({ bodiesDir: bodies, hookEventsDir: hooks, now: NOW })
      assert.strictEqual(active(r, 'COMPACTION_REWRITE'), true)
      const detail = r.risks.find(x => x.code === 'COMPACTION_REWRITE')?.detail ?? ''
      assert.ok(detail.includes('auto'), detail)
    } finally { cleanup() }
  })

  test('HUGE_REQUEST_BURST trips at 3 requests >1MB inside 90s, ignores old/small ones', () => {
    const { bodies, hooks, cleanup } = stores()
    try {
      bigRequest(bodies, NOW - 10_000, 2)
      bigRequest(bodies, NOW - 20_000, 2)
      bigRequest(bodies, NOW - 5 * 60_000, 2)   // too old
      let r = checkBurnRisk({ bodiesDir: bodies, hookEventsDir: hooks, now: NOW })
      assert.strictEqual(active(r, 'HUGE_REQUEST_BURST'), false, '2 recent must not trip')
      bigRequest(bodies, NOW - 30_000, 2)
      r = checkBurnRisk({ bodiesDir: bodies, hookEventsDir: hooks, now: NOW })
      assert.strictEqual(active(r, 'HUGE_REQUEST_BURST'), true)
    } finally { cleanup() }
  })

  test('BURN_SPIKE trips on the injected live monitor rate, threshold overridable', () => {
    const { bodies, hooks, cleanup } = stores()
    try {
      const status = { accountWindows: [{ fiveMinTokensPerMin: 300_000 }] }
      let r = checkBurnRisk({ bodiesDir: bodies, hookEventsDir: hooks, burnStatus: status, now: NOW })
      assert.strictEqual(active(r, 'BURN_SPIKE'), true, '300k/min > default 250k')
      r = checkBurnRisk({ bodiesDir: bodies, hookEventsDir: hooks, burnStatus: status, spikeTokensPerMin: 500_000, now: NOW })
      assert.strictEqual(active(r, 'BURN_SPIKE'), false, 'raised threshold must clear it')
    } finally { cleanup() }
  })

  test('absent feeds are reported honestly, never as "no risk"', () => {
    const r = checkBurnRisk({
      bodiesDir: '/nonexistent/bodies', hookEventsDir: '/nonexistent/hooks', burnStatus: null, now: NOW,
    })
    assert.deepStrictEqual(r.sources, { hookEvents: false, bodies: false, burnStatus: false })
    assert.strictEqual(r.activeCount, 0)
  })
})
