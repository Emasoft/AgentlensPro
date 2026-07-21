import * as assert from 'assert'
import { extractLifecycleEvents, toLifecycleEvent, isReloadConfigChange } from '../lifecycleEvents'
import type { HookEventRecord } from '../hookEventStore'

// Build a raw hook record as the store persists it (payload verbatim; classification at read time).
const rec = (ev: string, ts: number, payload: Record<string, unknown> = {}, session = 's1'): HookEventRecord =>
  ({ ts, ev, session, payload })

suite('lifecycleEvents — SessionStart source → lifecycle kind (TRDD-EYA3X5MQ)', () => {
  test('SessionStart source=clear → CLEAR (the /clear floor-reset marker)', () => {
    const e = toLifecycleEvent(rec('SessionStart', 100, { source: 'clear' }))!
    assert.strictEqual(e.kind, 'CLEAR')
    assert.strictEqual(e.detail, 'clear')
  })

  test('every documented source maps to its kind', () => {
    const map: Record<string, string> = { startup: 'STARTUP', clear: 'CLEAR', compact: 'COMPACT', resume: 'RESUME', fork: 'FORK' }
    for (const [source, kind] of Object.entries(map)) {
      assert.strictEqual(toLifecycleEvent(rec('SessionStart', 1, { source }))!.kind, kind, source)
    }
  })

  test('an absent/unknown source degrades to STARTUP, never dropped', () => {
    assert.strictEqual(toLifecycleEvent(rec('SessionStart', 1, {}))!.kind, 'STARTUP')
    assert.strictEqual(toLifecycleEvent(rec('SessionStart', 1, { source: 'wat' }))!.kind, 'STARTUP')
  })
})

suite('lifecycleEvents — other events + discriminators', () => {
  test('StopFailure carries error_type; SessionEnd carries reason; PreCompact carries trigger', () => {
    assert.deepStrictEqual(
      [toLifecycleEvent(rec('StopFailure', 1, { error_type: 'rate_limit' }))!.kind,
       toLifecycleEvent(rec('StopFailure', 1, { error_type: 'rate_limit' }))!.detail],
      ['STOP_FAILURE', 'rate_limit'])
    assert.strictEqual(toLifecycleEvent(rec('SessionEnd', 1, { reason: 'logout' }))!.detail, 'logout')
    assert.strictEqual(toLifecycleEvent(rec('PreCompact', 1, { trigger: 'auto' }))!.detail, 'auto')
  })

  test('a non-lifecycle event (PermissionRequest) is skipped, not mislabeled', () => {
    assert.strictEqual(toLifecycleEvent(rec('PermissionRequest', 1, { tool_name: 'Bash' })), null)
  })

  test('ConfigChange source=skills is the plugin-reload proxy', () => {
    const e = toLifecycleEvent(rec('ConfigChange', 1, { source: 'skills' }))!
    assert.strictEqual(e.kind, 'CONFIG_CHANGE')
    assert.ok(isReloadConfigChange(e))
    assert.ok(!isReloadConfigChange(toLifecycleEvent(rec('ConfigChange', 1, { source: 'user_settings' }))!))
  })
})

suite('lifecycleEvents — extract (sort, default STOP filter, session, limit)', () => {
  const records: HookEventRecord[] = [
    rec('SessionStart', 300, { source: 'clear' }),
    rec('SessionEnd', 275, { reason: 'clear' }),
    rec('Stop', 250, {}),
    rec('StopFailure', 200, { error_type: 'overloaded' }),
    rec('SessionStart', 100, { source: 'startup' }, 's2'),
    rec('PermissionRequest', 90, {}),
  ]

  test('most-recent-first; EXCLUDES per-turn STOP and per-session SESSION_END by default', () => {
    const evs = extractLifecycleEvents(records)
    assert.deepStrictEqual(evs.map(e => e.kind), ['CLEAR', 'STOP_FAILURE', 'STARTUP'])
    assert.deepStrictEqual(evs.map(e => e.ts), [300, 200, 100]) // descending; STOP(250), SESSION_END(275), PermissionRequest dropped
  })

  test('SESSION_END is opt-in via an explicit kinds filter', () => {
    assert.deepStrictEqual(extractLifecycleEvents(records, { kinds: ['SESSION_END'] }).map(e => e.detail), ['clear'])
  })

  test('explicit kinds filter can re-include STOP and narrow the set', () => {
    const evs = extractLifecycleEvents(records, { kinds: ['STOP', 'CLEAR'] })
    assert.deepStrictEqual(evs.map(e => e.kind), ['CLEAR', 'STOP'])
  })

  test('session filter + limit', () => {
    assert.deepStrictEqual(extractLifecycleEvents(records, { session: 's2' }).map(e => e.kind), ['STARTUP'])
    assert.strictEqual(extractLifecycleEvents(records, { limit: 1 }).length, 1)
  })
})
