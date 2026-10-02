import * as assert from 'assert'
import {
  buildEventOps, rebuildEventMatchers, HOOK_CMD, GATE_CMD, REVIEW_CMD, HOOK_EVENTS, GATE_EVENTS,
  REVIEW_EVENTS, SUPERVISOR_EVENTS, HOOK_TIMEOUT_SEC, type HookMatcher,
} from '../cli/hookInstall'

const EVENTS = [...new Set([...HOOK_EVENTS, ...GATE_EVENTS, ...REVIEW_EVENTS, ...SUPERVISOR_EVENTS])]
const fresh = (ev: string): HookMatcher[] => rebuildEventMatchers([], ev, false, HOOK_CMD, GATE_CMD, REVIEW_CMD).rebuilt
const at = (ms: HookMatcher[], timeout: number): HookMatcher[] =>
  ms.map(m => ({ ...m, hooks: m.hooks.map(h => ({ ...h, timeout })) }))

suite('hook timeout migration — an old registration is rewritten on the next install', () => {
  // a registration still carrying the previous 30s ceiling is drift: the installer must emit ops
  test('registrations at timeout 30 produce a non-empty op list and rebuild to HOOK_TIMEOUT_SEC', () => {
    assert.strictEqual(HOOK_TIMEOUT_SEC, 120)
    for (const ev of EVENTS) {
      const stale = at(fresh(ev), 30)
      assert.ok(buildEventOps(ev, stale, false).length > 0, `${ev}: 30s registration must be treated as drift`)
      const rebuilt = rebuildEventMatchers(stale, ev, false, HOOK_CMD, GATE_CMD, REVIEW_CMD).rebuilt
      assert.ok(rebuilt.length > 0)
      for (const h of rebuilt.flatMap(m => m.hooks)) assert.strictEqual(h.timeout, HOOK_TIMEOUT_SEC, `${ev}: ${h.command}`)
    }
  })

  // registrations already at HOOK_TIMEOUT_SEC need no change
  test('registrations already at HOOK_TIMEOUT_SEC are idempotent (no ops)', () => {
    for (const ev of EVENTS) assert.deepStrictEqual(buildEventOps(ev, at(fresh(ev), HOOK_TIMEOUT_SEC), false), [], ev)
  })
})