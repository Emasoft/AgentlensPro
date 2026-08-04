import * as assert from 'assert'
import { evaluateImageReadGate, DEFAULT_GATE_THRESHOLDS, type AgentGateState } from '../agentGate'
import { isImageReadPath } from '../shared/imageReads'

// ── image cache-guard (pre-flight resident-cost warning) ──────────────────────
// The guard rides GATE_MATCHER's `Read` entry, which is the one NON-rare tool in that matcher, so
// these tests are as much about what the guard must STAY SILENT on as about what it warns for. A
// guard that speaks on ordinary source reads gets switched off, and then it prevents nothing.
//
// It is WARN-ONLY by construction, and as of 2026-08-04 that rests on a MEASUREMENT rather than on
// an absence. Seven consecutive image appends each wrote exactly the image's own 3,252 tokens while
// re-reading everything before them, so the upstream "an image invalidates the whole messages tier"
// claim is FALSE for Claude Code, not merely uncorroborated — and a deny built on it would have
// blocked a hot-path tool on a fiction. What IS real is resident cost (turns x per-turn-context),
// and that is the only mechanism the reason text may assert.
//
// The older rationale here argued from `CacheBreakCause` not listing an image among "the 14 causes".
// That was unsound twice over: an enum records what WE instrumented rather than what the API does,
// and the enum has 18 values, not 14. Evidence:
// reports/image-cache-test/20260804_144500+0200-image-append-cache-measurement.md

const NOW = Date.now()

function state(over: Partial<AgentGateState> = {}): AgentGateState {
  return {
    now: NOW,
    mode: 'enforce',
    parent: { contextTokens: 400_000, idleMs: 10_000 },
    startsLast60s: 0,
    startsLast2min: 0,
    lastStopFailureMs: null,
    thrash: null,
    premiumShare: null,
    premiumModel: null,
    ...over,
  }
}

const read = (file_path: unknown): Record<string, unknown> => ({ file_path })

suite('image cache-guard — evaluateImageReadGate', () => {
  test('stays silent on ordinary source reads, however large the session', () => {
    for (const p of ['/repo/src/server.ts', '/repo/README.md', '/repo/data.json', '/repo/a.svg']) {
      const d = evaluateImageReadGate(read(p), state({ parent: { contextTokens: 900_000, idleMs: 1 } }))
      assert.strictEqual(d.decision, 'allow', `${p} must not trigger the image guard`)
      assert.strictEqual(d.code, null)
    }
  })

  test('warns on every extension Claude Code renders as an image block', () => {
    for (const ext of ['png', 'PNG', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'pdf']) {
      const d = evaluateImageReadGate(read(`/tmp/shot.${ext}`), state())
      assert.strictEqual(d.decision, 'warn', `.${ext} should warn in a fat session`)
      assert.strictEqual(d.code, 'IMG_RESIDENT')
    }
  })

  test('.svg is deliberately NOT an image read — it arrives as text/XML source', () => {
    assert.strictEqual(isImageReadPath('/tmp/icon.svg'), false)
    assert.strictEqual(evaluateImageReadGate(read('/tmp/icon.svg'), state()).decision, 'allow')
  })

  test('never denies — a per-turn resident tax is not a disaster signature, and Read is a hot path', () => {
    // Even at an absurd context size, and with mode:'enforce' (which is what turns the launch
    // gate's warnings into denies), this guard may only warn.
    const d = evaluateImageReadGate(read('/tmp/x.png'), state({
      mode: 'enforce', parent: { contextTokens: 5_000_000, idleMs: 1 },
    }))
    assert.strictEqual(d.decision, 'warn')
  })

  test('silent below imgWarnTokens — a small session absorbs a resident block', () => {
    const under = DEFAULT_GATE_THRESHOLDS.imgWarnTokens - 1
    assert.strictEqual(
      evaluateImageReadGate(read('/tmp/x.png'), state({ parent: { contextTokens: under, idleMs: 1 } })).decision,
      'allow')
    assert.strictEqual(
      evaluateImageReadGate(read('/tmp/x.png'), state({
        parent: { contextTokens: DEFAULT_GATE_THRESHOLDS.imgWarnTokens, idleMs: 1 },
      })).decision,
      'warn')
  })

  test('an unreadable transcript means NO number, so no claim (never invent a context size)', () => {
    const d = evaluateImageReadGate(read('/tmp/x.png'), state({ parent: { contextTokens: null, idleMs: null } }))
    assert.strictEqual(d.decision, 'allow', 'with no measured context there is nothing honest to warn about')
    assert.strictEqual(d.reason, null)
  })

  test('the reason names the session size, the mechanism, and a cheaper path', () => {
    const d = evaluateImageReadGate(read('/tmp/screenshot.png'), state({ parent: { contextTokens: 400_000, idleMs: 1 } }))
    const r = d.reason ?? ''
    assert.ok(/screenshot\.png/.test(r), 'names the file being read')
    assert.ok(/400k/.test(r), `quotes the measured session size, got: ${r}`)
    assert.ok(/RESIDENT/.test(r), 'names the mechanism it can actually defend')
    assert.ok(/subagent/i.test(r), 'offers the delegate-to-a-subagent escape')
    assert.ok(/ONE message/.test(r), 'offers the batch-into-one-turn escape')
    assert.ok(/AGENTLENS_CACHE_GUARD=off/.test(r), 'a warning must say how to silence it')
    // The upstream framing this guard deliberately does NOT adopt.
    assert.ok(!/invalidat/i.test(r), 'must not assert prefix invalidation — unverified for Claude Code')
  })

  test('above imgDenyTokens the phrasing escalates, but the decision does not', () => {
    const quiet = evaluateImageReadGate(read('/tmp/x.png'), state({
      parent: { contextTokens: DEFAULT_GATE_THRESHOLDS.imgDenyTokens - 1, idleMs: 1 },
    }))
    const loud = evaluateImageReadGate(read('/tmp/x.png'), state({
      parent: { contextTokens: DEFAULT_GATE_THRESHOLDS.imgDenyTokens, idleMs: 1 },
    }))
    assert.strictEqual(quiet.decision, 'warn')
    assert.strictEqual(loud.decision, 'warn')
    assert.ok(!/dominate/.test(quiet.reason ?? ''))
    assert.ok(/dominate/.test(loud.reason ?? ''), 'the fat-session sentence should appear at the threshold')
  })

  test('thresholds are overridable per state, like every other gate rule', () => {
    const s = state({ parent: { contextTokens: 10_000, idleMs: 1 }, thresholds: { imgWarnTokens: 5_000 } })
    assert.strictEqual(evaluateImageReadGate(read('/tmp/x.png'), s).decision, 'warn')
  })

  test('a missing or non-string file_path is not an image read', () => {
    for (const bad of [undefined, null, 42, { path: '/tmp/x.png' }, ['/tmp/x.png']]) {
      assert.strictEqual(evaluateImageReadGate(read(bad), state()).decision, 'allow')
    }
    assert.strictEqual(evaluateImageReadGate(null, state()).decision, 'allow')
    assert.strictEqual(evaluateImageReadGate(undefined, state()).decision, 'allow')
  })

  test('a query-string or trailing text after the extension is not an image path', () => {
    // The matcher anchors at end-of-string on purpose: "notes-about-png.md" is not a screenshot.
    assert.strictEqual(isImageReadPath('/tmp/notes-about-png.md'), false)
    assert.strictEqual(isImageReadPath('/tmp/x.png.bak'), false)
    assert.strictEqual(isImageReadPath('/tmp/x.png'), true)
  })
})
