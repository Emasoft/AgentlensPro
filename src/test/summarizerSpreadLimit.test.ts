import * as assert from 'assert'
import { maxOrDefault, buildCodexSessions } from '../summarizers/codex'
import type { Span } from '../shared/telemetryTypes'

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

// TRDD-SUMSPANRE — end-to-end regression: exercise the REAL call path (buildCodexSessions, not
// maxOrDefault in isolation) with a single trace/group larger than V8's max-arguments limit. This is
// what actually crashed in production (summarizeSpans -> buildCodexSessions -> the old
// `Math.max(...allEndTimes)`); a unit test on maxOrDefault alone can't prove the call SITE was fixed,
// only that the helper function itself is safe.
suite('summarizers: buildCodexSessions survives a single oversized trace group', () => {
  const N = 200_000

  function makeSpan(spanId: string, name: string, traceId: string, startNs: number, endNs: number): Span {
    return {
      traceId,
      spanId,
      name,
      startTime: String(startNs),
      endTime: String(endNs),
      attributes: [],
    }
  }

  test('one codex trace with 200k spans does not throw and reports the true end time', () => {
    const traceId = 'trdd-sumspanre-trace'
    // A prompt span establishes the group (groupCodexSpansBySession attaches subsequent
    // same-trace spans to the "active prompt group" — without one, ungrouped spans are dropped).
    const spans: Span[] = [makeSpan('prompt', 'codex.user_prompt', traceId, 0, 1_000_000)]
    const NS_PER_MS = 1_000_000
    let maxEndNs = 2_000_000
    for (let i = 0; i < N; i++) {
      // endTime increases with i so the true max is deterministic and NOT the first/last element,
      // ruling out a fix that accidentally only reads array[0] or array[length-1].
      const endNs = (i + 2) * NS_PER_MS
      if (endNs > maxEndNs) { maxEndNs = endNs }
      spans.push(makeSpan(`s${i}`, 'codex.sse_event', traceId, i * NS_PER_MS, endNs))
    }

    let sessions: ReturnType<typeof buildCodexSessions> | undefined
    assert.doesNotThrow(() => { sessions = buildCodexSessions(spans) },
      'buildCodexSessions must not throw RangeError: Maximum call stack size exceeded on a large trace group')

    assert.ok(sessions && sessions.length === 1, 'the 200k+1 spans must all group into ONE session')
    const [session] = sessions!
    const expectedEndMs = Math.floor(maxEndNs / NS_PER_MS)
    const expectedDurationMs = expectedEndMs - 0 // startMs comes from the prompt span (startTime 0)
    assert.strictEqual(session.durationMs, expectedDurationMs,
      'durationMs must reflect the TRUE maximum end time across all 200k spans, not a truncated/wrong one')
  })
})
