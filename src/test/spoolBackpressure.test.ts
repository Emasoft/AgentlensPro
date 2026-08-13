// Spool back-pressure (TRDD-KB17X5G2, Option 3) — falsifies the exact failure the card describes:
// a spool at/over capacity must not silently drop bodies. Since the raw-body write itself is
// performed by Claude Code's own OTEL exporter (not this process — see spoolBackpressure.ts's
// header), the assertion is at the layer we DO control: the controller must repoint the owned
// telemetry config at the legacy SSD dir on the OVER-CAPACITY transition, count it, and repoint
// back to the spool only once the spool has recovered with hysteresis room.
import * as assert from 'assert'
import {
  applySpoolBackpressure, checkSpoolCapacity, spoolFloorBytes, INITIAL_BACKPRESSURE_STATE,
  DEFAULT_SPOOL_FLOOR_BYTES, SPOOL_FLOOR_MB_ENV,
  type BackpressureState,
} from '../spoolBackpressure'

// `ramdisk.ts`'s `ramDiskInfo` only reports `mounted: true` when the path passed IS itself a
// filesystem mount point (df's own "Mounted-on" column must equal it exactly — see its comment
// "resolved to a parent fs → not its own mount"). An arbitrary tmp SUBdirectory therefore always
// reads as unmounted (freeBytes: null). `/` is a real mount on every POSIX box (and is never
// written to by these tests — `checkSpoolCapacity` only reads via `df`), so it is the one path
// guaranteed to give this test suite a real, non-null freeBytes reading without touching the
// actual RAM-disk spool.
const REAL_MOUNT = '/'

suite('spoolFloorBytes — env override, tolerant parse', () => {
  test('default, override, and nonsense fall back to default', () => {
    assert.strictEqual(spoolFloorBytes({}), DEFAULT_SPOOL_FLOOR_BYTES)
    assert.strictEqual(spoolFloorBytes({ [SPOOL_FLOOR_MB_ENV]: '128' }), 128 * 1024 * 1024)
    assert.strictEqual(spoolFloorBytes({ [SPOOL_FLOOR_MB_ENV]: 'nope' }), DEFAULT_SPOOL_FLOOR_BYTES)
    assert.strictEqual(spoolFloorBytes({ [SPOOL_FLOOR_MB_ENV]: '0' }), DEFAULT_SPOOL_FLOOR_BYTES)
  })
})

suite('checkSpoolCapacity — pure df-backed reading, no real spool needed', () => {
  test('a floor far above real free space reports over-capacity, on the real root mount', () => {
    // Number.MAX_SAFE_INTEGER bytes of floor: no disk on earth has that much free, so this is a
    // deterministic over-capacity trip without filling or writing anything.
    const check = checkSpoolCapacity(REAL_MOUNT, Number.MAX_SAFE_INTEGER)
    assert.strictEqual(check.overCapacity, true)
    assert.strictEqual(typeof check.freeBytes, 'number')
  })

  test('a floor of 0 never trips over-capacity', () => {
    const check = checkSpoolCapacity(REAL_MOUNT, 0)
    assert.strictEqual(check.overCapacity, false)
  })

  test('a nonexistent mount point fails OPEN (freeBytes null, overCapacity false)', () => {
    const check = checkSpoolCapacity('/nonexistent/AgentLensSpool-does-not-exist', 1)
    assert.strictEqual(check.freeBytes, null)
    assert.strictEqual(check.overCapacity, false)
  })
})

suite('applySpoolBackpressure — the over-capacity spill and its counter', () => {
  test('THE FIX: over-capacity redirects, counts the spill ONCE, and re-asserts every tick while over', async () => {
    let legacyCalls = 0
    let spoolCalls = 0
    const warns: string[] = []
    const deps = {
      redirectToLegacy: () => { legacyCalls++ },
      restoreToSpool: () => { spoolCalls++ },
      onWarn: (m: string) => { warns.push(m) },
    }
    let state: BackpressureState = INITIAL_BACKPRESSURE_STATE

    // Tick 1: spool crosses over capacity — must redirect + count the spill.
    state = await applySpoolBackpressure({ overCapacity: true, freeBytes: 1_000_000, floorBytes: 64 * 1024 * 1024 }, state, deps)
    assert.strictEqual(legacyCalls, 1, 'must redirect to the legacy SSD dir on the over-capacity transition')
    assert.strictEqual(state.redirected, true)
    assert.strictEqual(state.spills, 1, 'the spill must be counted so it is visible in spool health reporting')

    // Tick 2: still over capacity — must RE-ASSERT the redirect (this controller is not the
    // settings' sole writer: `agentlenspro setup` can "repair" the value back mid-outage, and a
    // transition-only redirect would then let sessions write into a full spool while status
    // claims protection — the 08e1c35 review finding). The callback is idempotent at the config
    // layer, so re-calling costs a no-op; what must NOT repeat is the spill count and the warning.
    state = await applySpoolBackpressure({ overCapacity: true, freeBytes: 500_000, floorBytes: 64 * 1024 * 1024 }, state, deps)
    assert.strictEqual(legacyCalls, 2, 'still-over-capacity must re-assert the redirect to heal an external config overwrite')
    assert.strictEqual(state.spills, 1, 'a re-assert is not a new spill event')
    assert.strictEqual(warns.length, 1, 'a re-assert must not repeat the warning — nothing NEW happened')

    // Tick 3: back under the floor but NOT past the hysteresis line (2x floor) — must stay redirected.
    state = await applySpoolBackpressure({ overCapacity: false, freeBytes: 70 * 1024 * 1024, floorBytes: 64 * 1024 * 1024 }, state, deps)
    assert.strictEqual(spoolCalls, 0, 'must not flap back to the spool without real recovery headroom')
    assert.strictEqual(state.redirected, true)

    // Tick 4: comfortably recovered (> 2x floor) — must restore, without incrementing spills again.
    state = await applySpoolBackpressure({ overCapacity: false, freeBytes: 200 * 1024 * 1024, floorBytes: 64 * 1024 * 1024 }, state, deps)
    assert.strictEqual(spoolCalls, 1, 'must restore the spool once real headroom exists')
    assert.strictEqual(state.redirected, false)
    assert.strictEqual(state.spills, 1, 'spills counts SPILL EVENTS, not restores')
  })

  test('never over capacity: no redirect, no spill, ever', async () => {
    let legacyCalls = 0
    const deps = { redirectToLegacy: () => { legacyCalls++ }, restoreToSpool: () => {} }
    let state: BackpressureState = INITIAL_BACKPRESSURE_STATE
    for (let i = 0; i < 5; i++) {
      state = await applySpoolBackpressure({ overCapacity: false, freeBytes: 500 * 1024 * 1024, floorBytes: 64 * 1024 * 1024 }, state, deps)
    }
    assert.strictEqual(legacyCalls, 0)
    assert.strictEqual(state.spills, 0)
  })
})
