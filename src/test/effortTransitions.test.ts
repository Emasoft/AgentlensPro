// TRDD-A4BA8IU5 gap B — per-turn reasoning effort read off assistant records.
//
// The evidence that justified building this, measured before any code was written: 51,203 assistant
// records across 6 sessions carry `effort`; exactly TWO within-session transitions exist
// (xhigh→low→xhigh, main conversation, 21 s apart); and that session contains ZERO `/effort`
// commands, so the command-based detector finds none of them. Rare and invisible.
//
// Every test below pins a way the differencing could invent a transition that never happened —
// which is the only real risk here, since a false cache-break cause is worse than none.
import * as assert from 'assert'
import { effortObservation, effortTransitionsOf, scanEffortTransitions } from '../effortTransitions'

interface RawEntry {
  type?: unknown
  timestamp?: unknown
  sessionId?: unknown
  effort?: unknown
  isSidechain?: unknown
  message?: { model?: unknown }
}

/** Build the (entry, obs) pairs the pure differencer takes, dropping anything not observable. */
function recs(entries: RawEntry[]): Array<{ entry: RawEntry; obs: NonNullable<ReturnType<typeof effortObservation>> }> {
  const out = []
  for (const entry of entries) {
    const obs = effortObservation(entry)
    if (obs) out.push({ entry, obs })
  }
  return out
}

const at = (s: string) => `2026-08-01T06:23:${s}.000Z`

suite('effortObservation — only an EXPLICIT value is an observation', () => {
  test('reads a well-formed assistant record', () => {
    const o = effortObservation({ type: 'assistant', timestamp: at('01'), effort: 'xhigh', message: { model: 'claude-opus-5' } })
    assert.strictEqual(o?.effort, 'xhigh')
    assert.strictEqual(o?.model, 'claude-opus-5')
  })

  test('a record with NO effort field yields nothing', () => {
    // Pre-2.1.212 records. Treating absent as a value is what would manufacture one false break per
    // session at the upgrade boundary, across all history.
    assert.strictEqual(effortObservation({ type: 'assistant', timestamp: at('01') }), undefined)
  })

  test('a non-string or empty effort yields nothing', () => {
    assert.strictEqual(effortObservation({ type: 'assistant', timestamp: at('01'), effort: 3 }), undefined)
    assert.strictEqual(effortObservation({ type: 'assistant', timestamp: at('01'), effort: '' }), undefined)
  })

  test('a non-assistant record yields nothing even when it carries an effort', () => {
    assert.strictEqual(effortObservation({ type: 'user', timestamp: at('01'), effort: 'high' }), undefined)
  })

  test('an unparseable timestamp yields nothing rather than a NaN-ordered record', () => {
    assert.strictEqual(effortObservation({ type: 'assistant', timestamp: 'not-a-date', effort: 'high' }), undefined)
  })
})

suite('effortTransitionsOf — a change, and never anything else', () => {
  test('the real measured shape: xhigh -> low -> xhigh yields exactly TWO transitions', () => {
    const got = effortTransitionsOf(recs([
      { type: 'assistant', timestamp: at('30'), sessionId: 's1', effort: 'xhigh' },
      { type: 'assistant', timestamp: at('36'), sessionId: 's1', effort: 'low' },
      { type: 'assistant', timestamp: at('44'), sessionId: 's1', effort: 'low' },
      { type: 'assistant', timestamp: at('57'), sessionId: 's1', effort: 'xhigh' },
    ]))
    assert.strictEqual(got.length, 2)
    // Newest first.
    assert.deepStrictEqual(got.map(t => `${t.from}->${t.to}`), ['low->xhigh', 'xhigh->low'])
  })

  test('a steady session yields NOTHING — the first record is a baseline, not a change', () => {
    const got = effortTransitionsOf(recs([
      { type: 'assistant', timestamp: at('01'), sessionId: 's1', effort: 'xhigh' },
      { type: 'assistant', timestamp: at('02'), sessionId: 's1', effort: 'xhigh' },
      { type: 'assistant', timestamp: at('03'), sessionId: 's1', effort: 'xhigh' },
    ]))
    assert.deepStrictEqual(got, [])
  })

  test('a single record yields nothing', () => {
    assert.deepStrictEqual(effortTransitionsOf(recs([
      { type: 'assistant', timestamp: at('01'), sessionId: 's1', effort: 'xhigh' },
    ])), [])
  })

  test('TWO sessions at different efforts are not a transition', () => {
    // Both sessions are internally steady; only the interleaving could suggest a change.
    const got = effortTransitionsOf(recs([
      { type: 'assistant', timestamp: at('01'), sessionId: 's1', effort: 'xhigh' },
      { type: 'assistant', timestamp: at('02'), sessionId: 's2', effort: 'low' },
      { type: 'assistant', timestamp: at('03'), sessionId: 's1', effort: 'xhigh' },
      { type: 'assistant', timestamp: at('04'), sessionId: 's2', effort: 'low' },
    ]))
    assert.deepStrictEqual(got, [])
  })

  test('a SIDECHAIN at a different effort does not create a transition in the main conversation', () => {
    // The important one. A subagent's records interleave into the parent's transcript, so a naive
    // difference reports two transitions per subagent (in and out) that no one ever caused.
    const got = effortTransitionsOf(recs([
      { type: 'assistant', timestamp: at('01'), sessionId: 's1', effort: 'xhigh' },
      { type: 'assistant', timestamp: at('02'), sessionId: 's1', effort: 'low', isSidechain: true },
      { type: 'assistant', timestamp: at('03'), sessionId: 's1', effort: 'low', isSidechain: true },
      { type: 'assistant', timestamp: at('04'), sessionId: 's1', effort: 'xhigh' },
    ]))
    assert.deepStrictEqual(got, [], 'the main conversation never left xhigh')
  })

  test('a real change INSIDE a sidechain is still reported, and marked as one', () => {
    const got = effortTransitionsOf(recs([
      { type: 'assistant', timestamp: at('01'), sessionId: 's1', effort: 'low', isSidechain: true },
      { type: 'assistant', timestamp: at('02'), sessionId: 's1', effort: 'high', isSidechain: true },
    ]))
    assert.strictEqual(got.length, 1)
    assert.strictEqual(got[0].sidechain, true)
  })

  test('records out of file order are differenced in TIME order', () => {
    // A session can span several transcript files, and a resume writes a new one — read order is
    // not time order, and differencing in read order would report a spurious extra flip.
    const got = effortTransitionsOf(recs([
      { type: 'assistant', timestamp: at('03'), sessionId: 's1', effort: 'low' },
      { type: 'assistant', timestamp: at('01'), sessionId: 's1', effort: 'xhigh' },
      { type: 'assistant', timestamp: at('02'), sessionId: 's1', effort: 'xhigh' },
    ]))
    assert.strictEqual(got.length, 1)
    assert.strictEqual(got[0].from, 'xhigh')
    assert.strictEqual(got[0].to, 'low')
  })

  test('a record with no sessionId is dropped, not pooled under one empty key', () => {
    // Pooling them would difference unrelated conversations against each other.
    const got = effortTransitionsOf(recs([
      { type: 'assistant', timestamp: at('01'), effort: 'xhigh' },
      { type: 'assistant', timestamp: at('02'), effort: 'low' },
    ]))
    assert.deepStrictEqual(got, [])
  })

  test('a gap in the field does not difference across the hole', () => {
    // xhigh, (a record with no effort at all), xhigh — the un-stamped record must not become a
    // value, and the two real observations agree, so nothing changed.
    const got = effortTransitionsOf(recs([
      { type: 'assistant', timestamp: at('01'), sessionId: 's1', effort: 'xhigh' },
      { type: 'assistant', timestamp: at('02'), sessionId: 's1' },
      { type: 'assistant', timestamp: at('03'), sessionId: 's1', effort: 'xhigh' },
    ]))
    assert.deepStrictEqual(got, [])
  })

  test('the model on the NEW record is carried, for correlating a /model switch', () => {
    const got = effortTransitionsOf(recs([
      { type: 'assistant', timestamp: at('01'), sessionId: 's1', effort: 'xhigh', message: { model: 'claude-opus-5' } },
      { type: 'assistant', timestamp: at('02'), sessionId: 's1', effort: 'low', message: { model: 'claude-sonnet-5' } },
    ]))
    assert.strictEqual(got[0].model, 'claude-sonnet-5')
  })
})

suite('scanEffortTransitions — an empty corpus is empty, not a crash', () => {
  test('a directory that does not exist yields no transitions', () => {
    assert.deepStrictEqual(scanEffortTransitions({ dirs: ['/nonexistent-agentlens-effort-probe'] }), [])
  })
})
