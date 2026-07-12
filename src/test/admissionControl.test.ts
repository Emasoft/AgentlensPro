import * as assert from 'assert'
import * as os from 'os'
import { ResourceMonitor, type ResourceSample } from '../resourceMonitor'
import { AdmissionController, admissionLimitsFromEnv, type AdmissionLimits } from '../admissionController'

// ── D3K7QM2P/1c — resource monitor + admission control ───────────────────────────────────────────

suite('resourceMonitor (D3K7QM2P/1c)', () => {
  test('sample() returns a well-formed pressure snapshot', () => {
    const m = new ResourceMonitor(os.tmpdir())
    const s = m.sample()
    assert.ok(s.rssMb > 0, 'rss is positive')
    assert.ok(s.cpuCount >= 1, 'at least one cpu')
    assert.ok(s.loadPerCore >= 0, 'load per core is non-negative')
    assert.ok(s.freeDiskMb > 0, 'free disk is positive (or Infinity)')
  })

  test('samples are cached within the TTL and refreshed after it (injected clock)', () => {
    let clock = 0
    const m = new ResourceMonitor(os.tmpdir(), 1000, () => clock)
    const a = m.sample()
    clock = 500
    assert.strictEqual(m.sample(), a, 'within TTL → the very same cached object')
    clock = 1500
    assert.notStrictEqual(m.sample(), a, 'past TTL → a fresh sample')
  })
})

const HEALTHY: ResourceSample = { rssMb: 100, loadPerCore: 0.5, freeDiskMb: 5000, cpuCount: 4 }
const LIMITS: AdmissionLimits = {
  softInflight: 2, maxInflight: 3, maxQueue: 2,
  maxRssMb: 1000, minFreeDiskMb: 10, loadPerCoreMax: 2, queueWaitMs: 50,
}
function make(sample: ResourceSample): { ctrl: AdmissionController; res: { s: ResourceSample } } {
  const res = { s: { ...sample } }
  const ctrl = new AdmissionController(LIMITS, () => res.s)
  return { ctrl, res }
}

suite('admissionController (D3K7QM2P/1c)', () => {
  test('admits below the soft in-flight mark', async () => {
    const { ctrl } = make(HEALTHY)
    const r = await ctrl.enter()
    assert.deepStrictEqual([r.ok, r.reason], [true, 'admit'])
    assert.strictEqual(ctrl.stats().inflight, 1)
  })

  test('sheds immediately when RSS is over the hard ceiling', async () => {
    const { ctrl } = make({ ...HEALTHY, rssMb: 2000 })
    const r = await ctrl.enter()
    assert.strictEqual(r.ok, false)
    assert.strictEqual(r.reason, 'rss')
    assert.ok((r.retryAfterSec ?? 0) > 0, 'a Retry-After is advertised')
  })

  test('sheds immediately when free disk is under the floor', async () => {
    const { ctrl } = make({ ...HEALTHY, freeDiskMb: 5 })
    const r = await ctrl.enter()
    assert.strictEqual(r.ok, false)
    assert.strictEqual(r.reason, 'disk')
  })

  test('queues over the ceiling and a leave() promotes the oldest waiter (FIFO)', async () => {
    const { ctrl } = make(HEALTHY)
    for (let i = 0; i < 3; i++) assert.strictEqual((await ctrl.enter()).ok, true) // fill to maxInflight=3
    const queued = ctrl.enter() // 4th → queued (pending)
    await new Promise((r) => setTimeout(r, 5))
    assert.strictEqual(ctrl.stats().queued, 1, 'the 4th request is waiting, not admitted')
    ctrl.leave() // frees a slot → promotes the waiter
    const r = await queued
    assert.deepStrictEqual([r.ok, r.reason], [true, 'admit'])
    assert.strictEqual(ctrl.stats().queued, 0)
  })

  test('sheds when the queue is full', async () => {
    const { ctrl } = make(HEALTHY)
    for (let i = 0; i < 3; i++) await ctrl.enter()      // inflight = maxInflight
    const w1 = ctrl.enter(); const w2 = ctrl.enter()    // queue = maxQueue (2)
    await new Promise((r) => setTimeout(r, 5))
    const r = await ctrl.enter()                        // queue full → shed
    assert.strictEqual(r.ok, false)
    assert.strictEqual(r.reason, 'inflight')
    // Drain the two waiters so no timer leaks past the test.
    ctrl.leave(); ctrl.leave()
    await Promise.all([w1, w2])
  })

  test('a queued request sheds after queueWaitMs when nothing frees a slot', async () => {
    const { ctrl } = make(HEALTHY)
    for (let i = 0; i < 3; i++) await ctrl.enter()
    const r = await ctrl.enter() // queued, never promoted → times out (~50ms)
    assert.strictEqual(r.ok, false)
    assert.strictEqual(r.reason, 'queue-timeout')
  })

  test('between soft and max, HIGH load queues instead of admitting (backpressure)', async () => {
    const { ctrl, res } = make(HEALTHY)
    await ctrl.enter(); await ctrl.enter() // inflight = softInflight (2)
    res.s = { ...HEALTHY, loadPerCore: 5 } // load now over loadPerCoreMax (2)
    const queued = ctrl.enter()            // inflight(2) < max(3) but load high → queue, not admit
    await new Promise((r) => setTimeout(r, 5))
    assert.strictEqual(ctrl.stats().queued, 1, 'high load applies backpressure below the hard ceiling')
    ctrl.leave()
    await queued
  })

  test('admissionLimitsFromEnv scales to CPU and honors overrides', () => {
    const base = admissionLimitsFromEnv({}, 4)
    assert.ok(base.softInflight >= 8 && base.maxInflight > base.softInflight)
    const over = admissionLimitsFromEnv({ AGENTLENS_MAX_INFLIGHT: '99', AGENTLENS_MAX_RSS_MB: '2048' }, 4)
    assert.strictEqual(over.maxInflight, 99)
    assert.strictEqual(over.maxRssMb, 2048)
  })
})
