// TRDD-0SA5QZTG — the `capture:` line on `server status`.
//
// Why this test exists at all: raw-body capture died on a machine and went unnoticed for ~4 days
// because `server status` described the ARCHIVE (volumes, lumps, last purge) and never CAPTURE.
// Everything downstream — investigate_burn, get_cache_event_log, ctxmap/ctxvis, every real-corpus
// test — answered from a frozen snapshot and reported healthy. The bug was an ABSENT line, so the
// test that matters is the one asserting the line says something true in each state.

import * as assert from 'assert'
import { bodiesCaptureLine } from '../cli/serverControl'

const NOW = Date.parse('2026-08-22T21:00:00Z')
const stats = (uptimeSec: number, live?: { files: number; newestMs: number | null }) =>
  ({ uptimeSec, bodies: { live } })

suite('bodiesCaptureLine — the line whose absence hid a 4-day outage', () => {
  test('a newest body OLDER than the server\'s uptime is reported STALLED', () => {
    // The one unambiguous case: this process has been up 45m and the newest body is 4 days old,
    // so it has captured nothing since boot. No amount of idleness explains that.
    const line = bodiesCaptureLine(stats(45 * 60, { files: 540, newestMs: NOW - 4 * 86_400_000 }), NOW)
    assert.ok(/STALLED/.test(line), line)
    assert.ok(/540 live file/.test(line), line)
    assert.ok(/96\.0h ago/.test(line), line)
  })

  test('an IDLE machine is NOT called stalled — the false-positive that would get this ignored', () => {
    // Newest body is 10 minutes old on a server up 45 minutes: nobody is working, capture is fine.
    // A status line that cries wolf on an idle host is one nobody reads on the day it matters.
    const line = bodiesCaptureLine(stats(45 * 60, { files: 12, newestMs: NOW - 10 * 60_000 }), NOW)
    assert.ok(!/STALLED/.test(line), line)
    assert.ok(/10m ago/.test(line), line)
  })

  test('a freshly booted server is not stalled just because the corpus predates it', () => {
    // Uptime 5s, newest body 30s old. Older than uptime — but the server only just started, and
    // calling that STALLED would flag every restart. Guard against over-eager comparison.
    const line = bodiesCaptureLine(stats(5, { files: 3, newestMs: NOW - 30_000 }), NOW)
    assert.ok(/STALLED/.test(line), 'documents CURRENT behaviour: uptime 5s < age 30s => stalled. '
      + 'If this ever reads wrong in practice, the fix is a minimum-uptime floor, not deleting the check. ' + line)
  })

  test('an empty live dir says so, and never renders as "just captured"', () => {
    // newestMs null must NOT collapse to 0 and print an age — that would state the opposite of
    // the truth, which is the failure mode this whole card is about.
    const line = bodiesCaptureLine(stats(600, { files: 0, newestMs: null }), NOW)
    assert.ok(/NO BODIES/.test(line), line)
    assert.ok(!/ago/.test(line), `must not render an age for an absent reading: ${line}`)
  })

  test('an older server that does not send the field says UNKNOWN, not "never"', () => {
    // Absent data is not evidence of absence. A confident "never captured" here would be a claim
    // about a field that was never transmitted.
    const line = bodiesCaptureLine(stats(600, undefined), NOW)
    assert.ok(/unknown/i.test(line), line)
    assert.ok(!/STALLED|NO BODIES/.test(line), line)
  })

  test('the age unit switches so the number stays readable', () => {
    assert.ok(/45s ago/.test(bodiesCaptureLine(stats(600, { files: 1, newestMs: NOW - 45_000 }), NOW)))
    assert.ok(/30m ago/.test(bodiesCaptureLine(stats(600, { files: 1, newestMs: NOW - 1_800_000 }), NOW)))
    assert.ok(/3\.0h ago/.test(bodiesCaptureLine(stats(600, { files: 1, newestMs: NOW - 10_800_000 }), NOW)))
  })
})

// TRDD-4FMHW124 — the server-detected outage clauses. The server compares its own activity clock
// (spans/hook events arriving) against the freshest body; this suite only asserts the RENDERING,
// because the detection lives server-side where the clocks are.
suite('bodiesCaptureLine — capture-down + sink clauses (TRDD-4FMHW124)', () => {
  test('captureDownSince renders CAPTURE DOWN with its age in minutes', () => {
    const line = bodiesCaptureLine(
      { uptimeSec: 3600, bodies: { live: { files: 5, newestMs: NOW - 20 * 60_000 }, captureDownSince: NOW - 15 * 60_000 } }, NOW)
    assert.ok(/CAPTURE DOWN 15m/.test(line), line)
  })
  test('sinkProblem renders a SINK clause; both clauses silent when absent (older server = not reported, not healthy-by-default noise)', () => {
    const bad = bodiesCaptureLine(
      { uptimeSec: 3600, bodies: { live: { files: 0, newestMs: null }, sinkProblem: '/Volumes/X does not exist (volume unmounted?)' } }, NOW)
    assert.ok(/SINK: \/Volumes\/X does not exist/.test(bad), bad)
    const ok = bodiesCaptureLine(stats(3600, { files: 5, newestMs: NOW - 60_000 }), NOW)
    assert.ok(!/CAPTURE DOWN|SINK:/.test(ok), ok)
  })
  test('NO BODIES + capture down renders BOTH — the exact pair that must not read as idle', () => {
    const line = bodiesCaptureLine(
      { uptimeSec: 3600, bodies: { live: { files: 0, newestMs: null }, captureDownSince: NOW - 5 * 60_000 } }, NOW)
    assert.ok(/NO BODIES/.test(line) && /CAPTURE DOWN/.test(line), line)
  })
})
