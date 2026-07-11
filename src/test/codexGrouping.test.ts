import * as assert from 'assert'
import { groupCodexSpansBySession } from '../summarizers/codex'
import type { Span, SpanAttribute } from '../shared/telemetryTypes'

// ── Characterization test for the summarizer's BATCH Codex grouper (Phase 0b) ────────────────────
// groupCodexSpansBySession owns the USER-VISIBLE /api/summary Codex session grouping and — before
// this test — had ZERO direct coverage. It is a deliberately DISTINCT algorithm from the streaming
// CodexSessionNormalizer used at ingest (batch, time-sorted, honors explicit codex.session.id,
// absorbs same-trace non-prompt spans). Phase 0b single-sourced the two atoms both share (the
// prompt-event predicate + the codexPromptSessionId format) so they cannot drift; a full fold onto
// the resolver was rejected because it would change THIS function's output. These cases lock that
// output so the atom-extraction (and any future change) is provably behavior-preserving.

let spanSeq = 0
function attr(key: string, value: string): SpanAttribute {
  return { key, value: { stringValue: value } }
}
function codexSpan(opts: {
  name: string
  traceId: string
  tMs: number
  conv?: string
  turn?: string
  sessionId?: string
  otelTraceId?: string
}): Span {
  const attrs: SpanAttribute[] = []
  if (opts.conv) attrs.push(attr('conversation.id', opts.conv))
  if (opts.turn) attrs.push(attr('turn.id', opts.turn))
  if (opts.sessionId) attrs.push(attr('codex.session.id', opts.sessionId))
  if (opts.otelTraceId) attrs.push(attr('otel.trace_id', opts.otelTraceId))
  return {
    traceId: opts.traceId,
    spanId: `s${spanSeq++}`,
    name: opts.name,
    startTime: String(BigInt(opts.tMs) * 1_000_000n), // ms → unix-nano string
    endTime: String(BigInt(opts.tMs + 1) * 1_000_000n),
    attributes: attrs,
  }
}
function idsOf(spans: Span[]): string[] {
  return spans.map((s) => s.spanId)
}

suite('summarizers/codex — groupCodexSpansBySession (batch grouper characterization)', () => {
  test('two sequential prompts in one conversation → two per-prompt groups, each with its trailing spans', () => {
    const s1 = codexSpan({ name: 'codex.user_prompt', traceId: 't1', conv: 'c1', tMs: 1000 })
    const s2 = codexSpan({ name: 'codex.completion', traceId: 't1', conv: 'c1', tMs: 2000 })
    const s3 = codexSpan({ name: 'codex.user_prompt', traceId: 't1', conv: 'c1', tMs: 3000 })
    const s4 = codexSpan({ name: 'codex.completion', traceId: 't1', conv: 'c1', tMs: 4000 })
    const groups = groupCodexSpansBySession([s1, s2, s3, s4])
    assert.deepStrictEqual(Object.keys(groups).sort(), ['codex:c1:prompt-1', 'codex:c1:prompt-2'])
    assert.deepStrictEqual(idsOf(groups['codex:c1:prompt-1']), [s1.spanId, s2.spanId])
    assert.deepStrictEqual(idsOf(groups['codex:c1:prompt-2']), [s3.spanId, s4.spanId])
  })

  test('input order does not matter — spans are time-sorted before grouping', () => {
    const s1 = codexSpan({ name: 'codex.user_prompt', traceId: 't1', conv: 'c1', tMs: 1000 })
    const s2 = codexSpan({ name: 'codex.completion', traceId: 't1', conv: 'c1', tMs: 2000 })
    const s3 = codexSpan({ name: 'codex.user_prompt', traceId: 't1', conv: 'c1', tMs: 3000 })
    // Shuffled input; grouping must follow start_time, not array order.
    const groups = groupCodexSpansBySession([s3, s1, s2])
    assert.deepStrictEqual(Object.keys(groups).sort(), ['codex:c1:prompt-1', 'codex:c1:prompt-2'])
    assert.deepStrictEqual(idsOf(groups['codex:c1:prompt-1']), [s1.spanId, s2.spanId])
    assert.deepStrictEqual(idsOf(groups['codex:c1:prompt-2']), [s3.spanId])
  })

  test('an explicit codex.session.id is honored as the group key (not re-derived to prompt-N)', () => {
    const s1 = codexSpan({ name: 'codex.user_prompt', traceId: 't1', conv: 'c1', sessionId: 'SESS-A', tMs: 1000 })
    const s2 = codexSpan({ name: 'codex.completion', traceId: 't1', conv: 'c1', sessionId: 'SESS-A', tMs: 2000 })
    const groups = groupCodexSpansBySession([s1, s2])
    assert.deepStrictEqual(Object.keys(groups), ['SESS-A'])
    assert.deepStrictEqual(idsOf(groups['SESS-A']), [s1.spanId, s2.spanId])
  })

  test('partition completeness — every codex span lands in exactly one group; non-codex spans are excluded', () => {
    const s1 = codexSpan({ name: 'codex.user_prompt', traceId: 't1', conv: 'c1', tMs: 1000 })
    const s2 = codexSpan({ name: 'codex.completion', traceId: 't1', conv: 'c1', tMs: 2000 })
    const s3 = codexSpan({ name: 'codex.user_prompt', traceId: 't1', conv: 'c1', tMs: 3000 })
    const nonCodex: Span = {
      traceId: 't1', spanId: 'llm-x', name: 'llm_request',
      startTime: String(BigInt(1500) * 1_000_000n), endTime: String(BigInt(1600) * 1_000_000n), attributes: [],
    }
    const groups = groupCodexSpansBySession([s1, s2, s3, nonCodex])
    const grouped = Object.values(groups).flat().map((s) => s.spanId)
    assert.strictEqual(grouped.length, 3, 'exactly the three codex spans are grouped')
    assert.deepStrictEqual([...grouped].sort(), [s1.spanId, s2.spanId, s3.spanId].sort())
    assert.ok(!grouped.includes('llm-x'), 'the non-codex llm_request span is not grouped')
  })

  test('grouping is a pure function — repeated calls on the same input are deep-equal', () => {
    const spans = [
      codexSpan({ name: 'codex.user_prompt', traceId: 't1', conv: 'c1', tMs: 1000 }),
      codexSpan({ name: 'codex.completion', traceId: 't1', conv: 'c1', tMs: 2000 }),
      codexSpan({ name: 'codex.user_prompt', traceId: 't2', conv: 'c2', tMs: 3000 }),
    ]
    const a = groupCodexSpansBySession(spans)
    const b = groupCodexSpansBySession(spans)
    assert.deepStrictEqual(
      Object.fromEntries(Object.entries(a).map(([k, v]) => [k, idsOf(v)])),
      Object.fromEntries(Object.entries(b).map(([k, v]) => [k, idsOf(v)])),
    )
  })

  test('two independent conversations get independent per-prompt ordinals', () => {
    const a1 = codexSpan({ name: 'codex.user_prompt', traceId: 'ta', conv: 'cA', tMs: 1000 })
    const b1 = codexSpan({ name: 'codex.user_prompt', traceId: 'tb', conv: 'cB', tMs: 2000 })
    const a2 = codexSpan({ name: 'codex.user_prompt', traceId: 'ta', conv: 'cA', tMs: 3000 })
    const groups = groupCodexSpansBySession([a1, b1, a2])
    assert.deepStrictEqual(Object.keys(groups).sort(), ['codex:cA:prompt-1', 'codex:cA:prompt-2', 'codex:cB:prompt-1'])
  })
})
