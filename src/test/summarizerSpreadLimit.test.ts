import * as assert from 'assert'
import { maxOrDefault } from '../summarizers/codex'

// TRDD-2YP3DB9Y — the server's stack overflow, root-caused.
//
// `Math.max(...xs)` passes every element as an ARGUMENT. Past V8's max-arguments limit that throws
// `RangeError: Maximum call stack size exceeded` — and the call site sat inside buildCodexSessions'
// per-trace map, so the array was one trace group's spans: unbounded, and largest during exactly the
// high-volume period the dashboard is most needed.
//
// MEASURED on this machine before the fix: 4,156 of these RangeErrors in one server log, thrown every
// 4s from the dashboard push (tickBurn → pushUpdate → summarizeSpans → buildCodexSessions), and TWO
// fatal heap-exhaustion crashes, with 532,283 spans in memory.

/** Comfortably past V8's limit (~125k) without being slow to build. */
const N = 200_000

suite('summarizers: a large array must not be spread into a call', () => {
  test('the PREMISE — Math.max(...xs) really does throw at this size', () => {
    // Pin the premise rather than trusting it: if a future V8 raises the limit, this test says so
    // loudly instead of the regression test below silently becoming vacuous.
    const xs = new Array<number>(N).fill(1)
    assert.throws(() => Math.max(...xs), (e: Error) => e instanceof RangeError,
      'if this stops throwing, the guard below is no longer proving anything — check V8 changed, not that the bug is gone')
  })

  test('maxOrDefault survives it and returns the true maximum', () => {
    const xs = new Array<number>(N).fill(1)
    xs[N - 1] = 99
    assert.strictEqual(maxOrDefault(xs, 0), 99)
  })

  test('an empty array yields the fallback — the original behaviour, unchanged', () => {
    assert.strictEqual(maxOrDefault([], 1234), 1234)
  })

  test('the fallback does NOT act as a floor', () => {
    // Deliberate: the original returned Math.max(...xs) whenever the array was non-empty, even when
    // that was below the fallback. Turning it into a floor here would silently change a downstream
    // duration, so the fix keeps the old semantics and leaves that question where it was.
    assert.strictEqual(maxOrDefault([5, 7], 100), 7)
  })

  test('a single element, and negatives, behave like Math.max', () => {
    assert.strictEqual(maxOrDefault([42], 0), 42)
    assert.strictEqual(maxOrDefault([-5, -2, -9], 0), -2)
  })
})
