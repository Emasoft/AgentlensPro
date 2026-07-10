import * as assert from 'assert'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import {
  evaluateAgentGate, buildAdvisory, readTranscriptContext,
  type AgentGateState, type ParentContext,
} from '../agentGate'
import type { ThrashReport } from '../bodiesActivity'

// ── agent-launch burn gate (TRDD-GOD0108C) ────────────────────────────────────
// Pure decision tests + a real-fs transcript-tail parse.

const NOW = Date.now()

function state(over: Partial<AgentGateState> = {}): AgentGateState {
  return {
    now: NOW,
    mode: 'enforce',
    parent: { contextTokens: 50_000, idleMs: 10_000 },
    startsLast60s: 0,
    startsLast2min: 0,
    lastStopFailureMs: null,
    thrash: null,
    premiumShare: null,
    premiumModel: null,
    ...over,
  }
}

const thrashing: ThrashReport = { active: true, count: 4, rebilledTokens: 1_200_000, model: 'claude-fable-5', windowMs: 300_000 }

suite('agentGate — evaluateAgentGate (TRDD-GOD0108C)', () => {
  test('quiet state: silent allow', () => {
    const d = evaluateAgentGate({ subagent_type: 'general-purpose' }, state())
    assert.deepStrictEqual(d, { decision: 'allow', code: null, reason: null })
  })

  test('active cache-thrash denies ANY launch, naming the re-billed tokens', () => {
    const d = evaluateAgentGate({}, state({ thrash: thrashing }))
    assert.strictEqual(d.decision, 'deny')
    assert.strictEqual(d.code, 'THRASH_ACTIVE')
    assert.ok(d.reason?.includes('1200k'), d.reason ?? '')
    assert.ok(d.reason?.includes('investigate_burn'), 'deny reason must carry the next step')
  })

  test('runaway fan-out (8 starts in 60s) denies; 7 does not', () => {
    assert.strictEqual(evaluateAgentGate({}, state({ startsLast60s: 7, startsLast2min: 7 })).decision, 'warn')
    const d = evaluateAgentGate({}, state({ startsLast60s: 8, startsLast2min: 8 }))
    assert.strictEqual(d.decision, 'deny')
    assert.strictEqual(d.code, 'RUNAWAY_FANOUT')
  })

  test('cold resume: the FIRST launch after a stall is allowed (it IS the warm-up), the second is denied', () => {
    const stalled = state({ lastStopFailureMs: NOW - 3 * 60_000 })
    assert.strictEqual(evaluateAgentGate({}, stalled).decision, 'allow', 'no starts yet — warm-up launch passes')
    const second = state({ lastStopFailureMs: NOW - 3 * 60_000, startsLast2min: 1 })
    const d = evaluateAgentGate({}, second)
    assert.strictEqual(d.decision, 'deny')
    assert.strictEqual(d.code, 'COLD_RESUME_FANOUT')
    assert.ok(d.reason?.includes('warm-up'), d.reason ?? '')
  })

  test('a stall older than 10min disarms the cold-resume rule', () => {
    const d = evaluateAgentGate({}, state({ lastStopFailureMs: NOW - 11 * 60_000, startsLast2min: 2 }))
    assert.strictEqual(d.decision, 'allow')
  })

  test('fork storm forming: fat parent + cold cache + 2 launches in 2min denies a fork', () => {
    const s = state({ parent: { contextTokens: 450_000, idleMs: 7 * 60_000 }, startsLast2min: 2 })
    const d = evaluateAgentGate({ subagent_type: 'fork' }, s)
    assert.strictEqual(d.decision, 'deny')
    assert.strictEqual(d.code, 'FORK_STORM_FORMING')
    assert.ok(d.reason?.includes('450k'), d.reason ?? '')
    // A fresh (non-fork) agent in the same state does not inherit the parent prefix — allowed.
    assert.notStrictEqual(evaluateAgentGate({ subagent_type: 'scout' }, s).code, 'FORK_STORM_FORMING')
  })

  test('single cold fat fork: warning (COLD_FORK), never a deny', () => {
    const s = state({ parent: { contextTokens: 450_000, idleMs: 7 * 60_000 }, startsLast2min: 0 })
    const d = evaluateAgentGate({ subagent_type: 'fork' }, s)
    assert.strictEqual(d.decision, 'warn')
    assert.strictEqual(d.code, 'COLD_FORK')
  })

  test('warm fat fork: FORK_FAT_PARENT warning suggests compacting', () => {
    const s = state({ parent: { contextTokens: 300_000, idleMs: 5_000 } })
    const d = evaluateAgentGate({ subagent_type: 'fork' }, s)
    assert.strictEqual(d.decision, 'warn')
    assert.strictEqual(d.code, 'FORK_FAT_PARENT')
    assert.ok(d.reason?.includes('300k'), d.reason ?? '')
  })

  test('fan-out heads-up at 5 starts/2min adds the premium-model hint only when model is unpinned', () => {
    const s = state({ startsLast2min: 5, premiumShare: 0.8, premiumModel: 'claude-fable-5' })
    const unpinned = evaluateAgentGate({}, s)
    assert.strictEqual(unpinned.code, 'FANOUT_HEADSUP')
    assert.ok(unpinned.reason?.includes('claude-fable-5'), unpinned.reason ?? '')
    const pinned = evaluateAgentGate({ model: 'haiku' }, s)
    assert.strictEqual(pinned.code, 'FANOUT_HEADSUP')
    assert.ok(!pinned.reason?.includes('pin a cheaper'), 'pinned launch must not get the hint')
  })

  test('mode=warn downgrades every deny to a warning and says so', () => {
    const d = evaluateAgentGate({}, state({ mode: 'warn', thrash: thrashing }))
    assert.strictEqual(d.decision, 'warn')
    assert.strictEqual(d.code, 'THRASH_ACTIVE')
    assert.ok(d.reason?.startsWith('[deny downgraded'), d.reason ?? '')
  })

  test('unreadable parent transcript fails open: nulls never satisfy fat/cold', () => {
    const s = state({ parent: { contextTokens: null, idleMs: null } as ParentContext, startsLast2min: 3 })
    const d = evaluateAgentGate({ subagent_type: 'fork' }, s)
    assert.notStrictEqual(d.decision, 'deny')
  })
})

suite('agentGate — buildAdvisory (PostToolUse in-band warning)', () => {
  test('quiet state yields no advisory', () => {
    assert.strictEqual(buildAdvisory(state()), null)
  })

  test('thrash advisory names tokens and the investigate command', () => {
    const a = buildAdvisory(state({ thrash: thrashing }))
    assert.ok(a)
    assert.strictEqual(a?.code, 'THRASH_ACTIVE')
    assert.ok(a?.text.includes('investigate_burn'), a?.text)
  })

  test('fan-out advisory carries the premium share hint', () => {
    const a = buildAdvisory(state({ startsLast2min: 6, premiumShare: 0.9, premiumModel: 'claude-fable-5' }))
    assert.strictEqual(a?.code, 'FANOUT_HEADSUP')
    assert.ok(a?.text.includes('claude-fable-5'), a?.text)
  })
})

suite('agentGate — readTranscriptContext (real fs)', () => {
  let seq = 0
  function transcript(lines: string[], mtimeMs: number): { p: string; cleanup: () => void } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `al-gate-${process.pid}-${seq++}-`))
    const p = path.join(dir, 'session.jsonl')
    fs.writeFileSync(p, lines.join('\n') + '\n')
    fs.utimesSync(p, mtimeMs / 1000, mtimeMs / 1000)
    return { p, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) }
  }
  const usageLine = (input: number, cr: number, cc: number): string =>
    JSON.stringify({ type: 'assistant', message: { usage: { input_tokens: input, cache_read_input_tokens: cr, cache_creation_input_tokens: cc, output_tokens: 9 } } })

  test('reads the LAST usage entry: context tokens + idle from mtime', () => {
    const { p, cleanup } = transcript([
      JSON.stringify({ type: 'user', message: { content: 'hi' } }),
      usageLine(100, 200_000, 5_000),
      JSON.stringify({ type: 'user', message: { content: 'more' } }),
      usageLine(150, 380_000, 12_000),
    ], NOW - 7 * 60_000)
    try {
      const r = readTranscriptContext(p, NOW)
      assert.strictEqual(r.contextTokens, 150 + 380_000 + 12_000)
      assert.ok(r.idleMs !== null && Math.abs(r.idleMs - 7 * 60_000) < 5_000, String(r.idleMs))
    } finally { cleanup() }
  })

  test('big transcript: the tail read still finds the last usage past a partial first line', () => {
    const pad = JSON.stringify({ type: 'user', message: { content: 'x'.repeat(4000) } })
    const lines = Array.from({ length: 200 }, () => pad)
    lines.push(usageLine(1, 111_000, 0))
    const { p, cleanup } = transcript(lines, NOW - 1000)
    try {
      const r = readTranscriptContext(p, NOW, 64 * 1024) // tail smaller than the file
      assert.strictEqual(r.contextTokens, 111_001)
    } finally { cleanup() }
  })

  test('missing file: both fields null (gate fails open)', () => {
    const r = readTranscriptContext('/nonexistent/t.jsonl', NOW)
    assert.deepStrictEqual(r, { contextTokens: null, idleMs: null })
  })

  test('transcript with no usage lines: contextTokens null, idle still measured', () => {
    const { p, cleanup } = transcript([JSON.stringify({ type: 'user', message: { content: 'only' } })], NOW - 60_000)
    try {
      const r = readTranscriptContext(p, NOW)
      assert.strictEqual(r.contextTokens, null)
      assert.ok(r.idleMs !== null && r.idleMs > 30_000)
    } finally { cleanup() }
  })
})
