import * as assert from 'assert'
import { sessionInWindow } from '../shared/timeWindow'

// Fixed window [1000, 2000] ms. iso() turns an epoch-ms into the ISO string the card carries.
const SINCE = 1000
const UNTIL = 2000
const iso = (ms: number): string => new Date(ms).toISOString()
const card = (startMs: number, durationMs?: number) => ({ startTime: iso(startMs), durationMs })

suite('sessionInWindow — interval-overlap time-window predicate (TRDD-06Q5AXYN D1)', () => {
  test('a session fully inside the window is IN', () => {
    assert.strictEqual(sessionInWindow(card(1200, 300), SINCE, UNTIL), true)
  })

  test('a session that STARTED before the window but is still active inside it is IN (the resumed/long-session case)', () => {
    // [500, 1300] overlaps [1000, 2000] — a start-time-only test wrongly excluded this.
    assert.strictEqual(sessionInWindow(card(500, 800), SINCE, UNTIL), true)
  })

  test('a session that starts inside and ends after the window is IN', () => {
    assert.strictEqual(sessionInWindow(card(1800, 500), SINCE, UNTIL), true)
  })

  test('a session fully before the window is OUT', () => {
    // [100, 400], end 400 < since 1000.
    assert.strictEqual(sessionInWindow(card(100, 300), SINCE, UNTIL), false)
  })

  test('a session fully after the window is OUT', () => {
    // [2500, 2600], start 2500 > until 2000.
    assert.strictEqual(sessionInWindow(card(2500, 100), SINCE, UNTIL), false)
  })

  test('a zero-duration (point) session inside the window is IN', () => {
    assert.strictEqual(sessionInWindow(card(1500, 0), SINCE, UNTIL), true)
  })

  test('a zero-duration session before the window is OUT', () => {
    assert.strictEqual(sessionInWindow(card(500, 0), SINCE, UNTIL), false)
  })

  test('undefined durationMs is treated as a point event at startTime (in-window → IN)', () => {
    assert.strictEqual(sessionInWindow(card(1500, undefined), SINCE, UNTIL), true)
  })

  test('a negative durationMs is clamped to 0 (point event), not extended backwards', () => {
    assert.strictEqual(sessionInWindow(card(1500, -100), SINCE, UNTIL), true)
  })

  test('the window is inclusive at the upper edge (start == until → IN)', () => {
    assert.strictEqual(sessionInWindow(card(UNTIL, 0), SINCE, UNTIL), true)
  })

  test('the window is inclusive at the lower edge (end == since → IN)', () => {
    // [500, 1000], end exactly == since 1000.
    assert.strictEqual(sessionInWindow(card(500, 500), SINCE, UNTIL), true)
  })

  test('a card with no startTime is OUT (never fabricate a window match)', () => {
    assert.strictEqual(sessionInWindow({ durationMs: 100 }, SINCE, UNTIL), false)
  })

  test('a card with an unparseable startTime is OUT', () => {
    assert.strictEqual(sessionInWindow({ startTime: 'not-a-date', durationMs: 100 }, SINCE, UNTIL), false)
  })
})
