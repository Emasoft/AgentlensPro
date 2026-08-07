import * as assert from 'assert'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import {
  evaluateAgentGate, evaluateSendMessageGate, buildAdvisory, readTranscriptContext,
  resolveMessageTargetLiveness, isKeepWarmPinger,
  type AgentGateState, type ParentContext,
} from '../agentGate'
import type { ThrashReport } from '../bodiesActivity'
import { classifyTtlRegime } from '../shared/cacheTtl'

// ── agent-launch burn gate (TRDD-GOD0108C) ────────────────────────────────────
// Pure decision tests + a real-fs transcript-tail parse.

const NOW = Date.now()

// Every model-facing message is scoped to the CALLER's own project (2026-08-07), so the default
// state carries an identity and the fan-out cases carry spawners in that same cwd. A test that
// wants the foreign-project path sets FOREIGN_CWD instead — that contrast IS the policy.
const OWN_CWD = '/Users/x/Code/agentlens'
const FOREIGN_CWD = '/Users/x/Code/ai-maestro-janitor'

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
    caller: { session: 'ca11e400-0000-0000-0000-000000000000', cwd: OWN_CWD },
    ...over,
  }
}

/** N launches attributed to one project — OWN by default, which is what a fan-out warning needs. */
function spawnersIn(count: number, cwd = OWN_CWD): NonNullable<AgentGateState['spawners']> {
  return [{
    session: '777b8f52-aaaa-bbbb-cccc-000000000001',
    cwd, count, agentTypes: [`workflow-subagent×${count}`],
  }]
}

const thrashing: ThrashReport = {
  active: true, count: 4, rebilledTokens: 1_200_000, model: 'claude-fable-5', windowMs: 300_000,
  suspects: [{ session: '249c4216-4db4-4b64-9a10-b994b9aa0001', model: 'claude-fable-5', count: 4, bytes: 13_900_000 }],
  topSource: { session: '249c4216-4db4-4b64-9a10-b994b9aa0001', count: 4, rebilledTokens: 1_200_000 },
  unattributed: { count: 0, rebilledTokens: 0 },
  coldStartSessions: 0, coldStartRebilledTokens: 0,
}

suite('agentGate — evaluateAgentGate (TRDD-GOD0108C)', () => {
  test('quiet state: silent allow', () => {
    const d = evaluateAgentGate({ subagent_type: 'general-purpose' }, state())
    assert.deepStrictEqual(d, { decision: 'allow', code: null, reason: null })
  })

  test('active cache-thrash DENIES a fork — it re-enters the thrashing prefix per launch', () => {
    const d = evaluateAgentGate({ subagent_type: 'fork' }, state({ thrash: thrashing }))
    assert.strictEqual(d.decision, 'deny')
    assert.strictEqual(d.code, 'THRASH_ACTIVE')
    assert.ok(d.reason?.includes('1200k'), d.reason ?? '')
    // A suspect carries no cwd, so it can never be shown to be THIS caller's project — naming it
    // would put another project's session id in an agent's context for no action it can take.
    assert.ok(!d.reason?.includes('249c4216'), `suspect session must NOT be named: ${d.reason ?? ''}`)
    assert.ok(d.reason?.includes('1 sender(s) implicated'), 'the count still tells them there IS a source')
    assert.ok(d.reason?.includes('investigate_burn'), 'and where to get the identity on request')
  })

  test('active cache-thrash only WARNS a fresh non-fork launch — its own boot prefix multiplies nothing (TRDD-THRGX41P)', () => {
    // The blanket deny used to block the very advisor/diagnostic launches that could fix the
    // source, while doing nothing to stop the thrash itself.
    const d = evaluateAgentGate({ subagent_type: 'general-purpose' }, state({ thrash: thrashing }))
    assert.strictEqual(d.decision, 'warn')
    assert.strictEqual(d.code, 'THRASH_ACTIVE')
    assert.ok(d.reason?.includes('1200k'), d.reason ?? '')
  })

  test('a big UNATTRIBUTED write pool no longer interrupts the model — it is not provably theirs and names no action', () => {
    // Retired 2026-08-07. By construction these writes could not be tied to ANY session, so the
    // message could never be shown to be about the reader's own work, and its only instruction was
    // "go run investigate_burn" — which is a CLI question, not a reason to interrupt. The
    // DETECTION is untouched; only the unsolicited push is gone.
    const pool: ThrashReport = { ...thrashing, active: false, topSource: null, suspects: [], unattributed: { count: 5, rebilledTokens: 1_100_000 } }
    const d = evaluateAgentGate({ subagent_type: 'general-purpose' }, state({ thrash: pool }))
    assert.deepStrictEqual(d, { decision: 'allow', code: null, reason: null })
  })

  test('unattributable thrash says so honestly and points at investigate_burn', () => {
    const noSuspects: ThrashReport = { ...thrashing, suspects: [] }
    const d = evaluateAgentGate({ subagent_type: 'fork' }, state({ thrash: noSuspects }))
    assert.strictEqual(d.decision, 'deny')
    assert.ok(d.reason?.includes('not attributable'), d.reason ?? '')
    assert.ok(d.reason?.includes('investigate_burn'), d.reason ?? '')
  })

  test('runaway fan-out (8 starts in 60s) still denies, naming agent KINDS but no session or path; 7 does not deny', () => {
    assert.strictEqual(
      evaluateAgentGate({}, state({ startsLast60s: 7, startsLast2min: 7, spawners: spawnersIn(7) })).decision,
      'warn',
    )
    const d = evaluateAgentGate({}, state({
      startsLast60s: 8, startsLast2min: 8,
      spawners: [{ session: '777b8f52-aaaa-bbbb-cccc-000000000001', cwd: OWN_CWD, count: 8, agentTypes: ['workflow-subagent×7', 'fork'] }],
    }))
    assert.strictEqual(d.decision, 'deny')
    assert.strictEqual(d.code, 'RUNAWAY_FANOUT')
    assert.ok(d.reason?.includes('workflow-subagent'), 'agent kinds are the actionable part')
    // The COUNT stays machine-wide (this deny guards the machine's cache) but the IDENTITIES go:
    // a session id and a directory are things the reader can neither act on nor is owed.
    assert.ok(!d.reason?.includes('777b8f52'), `session must NOT be named: ${d.reason ?? ''}`)
    assert.ok(!d.reason?.includes('…/agentlens'), `workspace must NOT be named: ${d.reason ?? ''}`)
  })

  test('a fan-out in ANOTHER project does not warn this caller — it is not theirs to stop', () => {
    const d = evaluateAgentGate({}, state({ startsLast60s: 7, startsLast2min: 7, spawners: spawnersIn(7, FOREIGN_CWD) }))
    assert.deepStrictEqual(d, { decision: 'allow', code: null, reason: null })
  })

  test('an unidentifiable caller is treated as NOT own-project — an unprovable match never becomes a claim', () => {
    const d = evaluateAgentGate({}, state({
      startsLast60s: 7, startsLast2min: 7, spawners: spawnersIn(7), caller: { session: null, cwd: null },
    }))
    assert.deepStrictEqual(d, { decision: 'allow', code: null, reason: null })
  })

  test('cold resume: the FIRST launch after a stall is allowed (it IS the warm-up), the second is denied naming the stalled session', () => {
    const stalled = state({ lastStopFailureMs: NOW - 3 * 60_000 })
    assert.strictEqual(evaluateAgentGate({}, stalled).decision, 'allow', 'no starts yet — warm-up launch passes')
    const second = state({
      lastStopFailureMs: NOW - 3 * 60_000, startsLast2min: 1,
      stall: { session: 'c8a95d7e-048f-4c47-ae33-1dfacbcab3b1', cwd: '/Users/x/Code/ai-maestro-janitor' },
    })
    const d = evaluateAgentGate({}, second)
    assert.strictEqual(d.decision, 'deny')
    assert.strictEqual(d.code, 'COLD_RESUME_FANOUT')
    assert.ok(d.reason?.includes('warm-up'), d.reason ?? '')
    // The stall was in ANOTHER project. The deny is still right — this caller's fan-out prefixes
    // are cold either way — but whose session died is not this agent's business.
    assert.ok(!d.reason?.includes('c8a95d7e'), `foreign stalled session must NOT be named: ${d.reason ?? ''}`)
    assert.ok(!d.reason?.includes('ai-maestro-janitor'), `foreign workspace must NOT be named: ${d.reason ?? ''}`)
  })

  test('cold resume: a stall in the caller OWN project IS named — it is theirs, and knowing which session helps', () => {
    const d = evaluateAgentGate({}, state({
      lastStopFailureMs: NOW - 3 * 60_000, startsLast2min: 1,
      stall: { session: 'c8a95d7e-048f-4c47-ae33-1dfacbcab3b1', cwd: OWN_CWD },
    }))
    assert.strictEqual(d.code, 'COLD_RESUME_FANOUT')
    assert.ok(d.reason?.includes('session c8a95d7e…'), `own stalled session must be named: ${d.reason ?? ''}`)
    assert.ok(d.reason?.includes('…/agentlens'), 'own workspace must be named')
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
    const s = state({ startsLast2min: 5, spawners: spawnersIn(5), premiumShare: 0.8, premiumModel: 'claude-fable-5' })
    const unpinned = evaluateAgentGate({}, s)
    assert.strictEqual(unpinned.code, 'FANOUT_HEADSUP')
    assert.ok(unpinned.reason?.includes('claude-fable-5'), unpinned.reason ?? '')
    const pinned = evaluateAgentGate({ model: 'haiku' }, s)
    assert.strictEqual(pinned.code, 'FANOUT_HEADSUP')
    assert.ok(!pinned.reason?.includes('pin a cheaper'), 'pinned launch must not get the hint')
  })

  test('mode=warn downgrades every deny to a warning and says so', () => {
    const d = evaluateAgentGate({ subagent_type: 'fork' }, state({ mode: 'warn', thrash: thrashing }))
    assert.strictEqual(d.decision, 'warn')
    assert.strictEqual(d.code, 'THRASH_ACTIVE')
    assert.ok(d.reason?.startsWith('[deny downgraded'), d.reason ?? '')
  })

  test('unreadable parent transcript fails open: nulls never satisfy fat/cold', () => {
    const s = state({ parent: { contextTokens: null, idleMs: null } as ParentContext, startsLast2min: 3 })
    const d = evaluateAgentGate({ subagent_type: 'fork' }, s)
    assert.notStrictEqual(d.decision, 'deny')
  })

  test('EVIDENCE-BASED DISARM: a warm post-stall response from the stalled session ends COLD_RESUME early', () => {
    // 2026-07-11 field fix: the fixed 10-min window kept denying launches 6min after the stalled
    // session had already completed a warm request (cacheRead 215-247k, cacheCreate 6-21k).
    const armed = state({ lastStopFailureMs: NOW - 3 * 60_000, startsLast2min: 1 })
    assert.strictEqual(evaluateAgentGate({}, armed).code, 'COLD_RESUME_FANOUT', 'precondition: no evidence → still armed')
    const d = evaluateAgentGate({}, { ...armed, stallRecovered: true })
    assert.deepStrictEqual(d, { decision: 'allow', code: null, reason: null })
  })
})

suite('agentGate — TTL-regime awareness (TRDD-VY1IUVUM)', () => {
  // The fork cold checks read the CALLING session's cache entry, so "cold" is regime-relative:
  // the SAME 7-min idle that trips COLD_FORK on the assumed 5-min floor is warm on a
  // subscription MAIN session's 1-hour tier.
  const subMain = classifyTtlRegime('main', { auth: 'subscription', force5m: false, enable1h: false })

  test('7-min idle fat fork: COLD_FORK on the assumed floor, plain FORK_FAT_PARENT under the 1h tier', () => {
    const base = state({ parent: { contextTokens: 450_000, idleMs: 7 * 60_000 } })
    assert.strictEqual(evaluateAgentGate({ subagent_type: 'fork' }, base).code, 'COLD_FORK', 'assumed floor: cold')
    const warm = evaluateAgentGate({ subagent_type: 'fork' }, { ...base, ttl: subMain })
    assert.strictEqual(warm.code, 'FORK_FAT_PARENT', 'the 1h tier keeps a 7-min idle warm — fat warning only')
  })

  test('FORK_STORM_FORMING does not arm under the 1h tier at 7-min idle (the entry is still warm)', () => {
    const s = state({ parent: { contextTokens: 450_000, idleMs: 7 * 60_000 }, startsLast2min: 2, ttl: subMain })
    const d = evaluateAgentGate({ subagent_type: 'fork' }, s)
    assert.notStrictEqual(d.code, 'FORK_STORM_FORMING')
    // A 65-min+ idle exceeds even the 1h tier (+slack) — the storm rule arms again.
    const reallyCold = evaluateAgentGate({ subagent_type: 'fork' }, { ...s, parent: { contextTokens: 450_000, idleMs: 66 * 60_000 } })
    assert.strictEqual(reallyCold.code, 'FORK_STORM_FORMING')
    assert.ok(reallyCold.reason?.includes('60-min TTL (doc-matrix)'), `the deny must carry the regime provenance: ${reallyCold.reason ?? ''}`)
  })

  test('an EXPLICIT coldIdleMs override still wins over the regime (the env knob must not become a no-op)', () => {
    const s = state({
      parent: { contextTokens: 450_000, idleMs: 7 * 60_000 },
      ttl: subMain,
      thresholds: { coldIdleMs: 6 * 60_000 },
    })
    assert.strictEqual(evaluateAgentGate({ subagent_type: 'fork' }, s).code, 'COLD_FORK')
  })

  test('deny/warn messages carry ttlAssumedMin + ttlSource, never a hardcoded 5-min claim', () => {
    const coldFork = evaluateAgentGate({ subagent_type: 'fork' }, state({ parent: { contextTokens: 450_000, idleMs: 7 * 60_000 } }))
    assert.ok(coldFork.reason?.includes('5-min TTL (assumed)'), coldFork.reason ?? '')
    // COLD_RESUME rules protect the fanned-out SUBAGENT conversations — doc-matrix 5-min always.
    const resume = evaluateAgentGate({}, state({ lastStopFailureMs: NOW - 3 * 60_000, startsLast2min: 1 }))
    assert.ok(resume.reason?.includes('5-min TTL (doc-matrix)'), resume.reason ?? '')
    const msg = evaluateSendMessageGate(state({ lastStopFailureMs: NOW - 3 * 60_000, targetLiveness: 'dead' }))
    assert.ok(msg.reason?.includes('5-min TTL (doc-matrix)'), msg.reason ?? '')
  })

  test('COLD_RESUME_FANOUT stays armed even when the CALLER rides the 1h tier — it guards the subagent tier', () => {
    // The fan-out launches create fresh agent conversations whose prefix entries are 5-min ALWAYS;
    // a warm 1h main entry does not warm those, so the caller regime must not disarm the rule.
    const d = evaluateAgentGate({}, state({ lastStopFailureMs: NOW - 3 * 60_000, startsLast2min: 1, ttl: subMain }))
    assert.strictEqual(d.code, 'COLD_RESUME_FANOUT')
  })
})

suite('agentGate — keep-warm pinger allowance (USER ORDER 2026-07-11)', () => {
  // The pinger prevents the cold cache the gate guards against — denying it CAUSES the waste,
  // and under COLD_RESUME the pinger IS the warm-up. Every deny state must downgrade to at most
  // an advisory for a fork/unspecified-type launch whose prompt matches the keep-warm signature.
  const pinger = { subagent_type: 'fork', prompt: 'Keep-warm ping: reply OK and stop.' }

  test('signature detection: fork or unspecified type + keep-warm/pinger prompt, case-insensitive', () => {
    assert.strictEqual(isKeepWarmPinger(pinger), true)
    assert.strictEqual(isKeepWarmPinger({ prompt: 'background PINGER heartbeat' }), true, 'unspecified type qualifies')
    assert.strictEqual(isKeepWarmPinger({ subagent_type: 'fork', prompt: 'keepwarm cycle' }), true)
    assert.strictEqual(isKeepWarmPinger({ subagent_type: 'scout', prompt: 'keep-warm ping' }), false, 'a named non-fork type does NOT qualify')
    assert.strictEqual(isKeepWarmPinger({ subagent_type: 'fork', prompt: 'refactor the parser' }), false)
  })

  test('THRASH_ACTIVE downgrades to an advisory for the pinger, never a deny', () => {
    const d = evaluateAgentGate(pinger, state({ thrash: thrashing }))
    assert.strictEqual(d.decision, 'warn')
    assert.strictEqual(d.code, 'THRASH_ACTIVE')
    assert.ok(d.reason?.includes('keep-warm pinger allowed'), d.reason ?? '')
  })

  test('COLD_RESUME_FANOUT downgrades for the pinger — under a cold resume the pinger IS the warm-up', () => {
    const s = state({ lastStopFailureMs: NOW - 3 * 60_000, startsLast2min: 1 })
    assert.strictEqual(evaluateAgentGate({}, s).decision, 'deny', 'precondition: a normal launch denies')
    const d = evaluateAgentGate(pinger, s)
    assert.strictEqual(d.decision, 'warn')
    assert.strictEqual(d.code, 'COLD_RESUME_FANOUT')
  })

  test('RUNAWAY_FANOUT and FORK_STORM_FORMING also downgrade for the pinger', () => {
    const runaway = evaluateAgentGate(pinger, state({ startsLast60s: 9, startsLast2min: 9 }))
    assert.strictEqual(runaway.decision, 'warn')
    assert.strictEqual(runaway.code, 'RUNAWAY_FANOUT')
    const storm = evaluateAgentGate(pinger, state({ parent: { contextTokens: 450_000, idleMs: 7 * 60_000 }, startsLast2min: 2 }))
    assert.strictEqual(storm.decision, 'warn')
    assert.strictEqual(storm.code, 'FORK_STORM_FORMING')
  })

  test('the pinger skips the fork warn tier: a cold fat keep-warm fork passes SILENTLY (no per-ping noise)', () => {
    const s = state({ parent: { contextTokens: 450_000, idleMs: 7 * 60_000 } })
    assert.strictEqual(evaluateAgentGate({ subagent_type: 'fork' }, s).code, 'COLD_FORK', 'precondition: a normal fork warns')
    assert.deepStrictEqual(evaluateAgentGate(pinger, s), { decision: 'allow', code: null, reason: null })
  })

  test('a keep-warm prompt on a NAMED non-fork agent gets no allowance (only fork/unspecified qualifies)', () => {
    // Since TRDD-THRGX41P a fresh non-fork under thrash warns rather than denies, so "no
    // allowance" now means: the plain thrash warning, WITHOUT the pinger-allowance wording.
    const d = evaluateAgentGate({ subagent_type: 'scout', prompt: 'keep-warm ping' }, state({ thrash: thrashing }))
    assert.strictEqual(d.decision, 'warn')
    assert.strictEqual(d.code, 'THRASH_ACTIVE')
    assert.ok(!d.reason?.includes('keep-warm pinger allowed'), `no allowance wording for a named type: ${d.reason ?? ''}`)
  })
})

suite('agentGate — evaluateSendMessageGate (P6 SendMessage coverage)', () => {
  test('quiet state: routine messaging passes with a silent allow', () => {
    // THE contract of the P6 gate widening: messaging is never denied outside the two
    // disaster states — a chatty gate on team coordination would get switched off.
    const d = evaluateSendMessageGate(state())
    assert.deepStrictEqual(d, { decision: 'allow', code: null, reason: null })
  })

  test('fan-out / fork signatures NEVER deny a message (only launches are fan-out-gated)', () => {
    // Every launch-deny signal at once EXCEPT thrash/cold-resume: runaway starts, a fat cold
    // parent — a Task would deny here, a SendMessage must still pass.
    const hot = state({
      startsLast60s: 20, startsLast2min: 9,
      parent: { contextTokens: 400_000, idleMs: 20 * 60_000 },
    })
    assert.strictEqual(evaluateAgentGate({ subagent_type: 'fork' }, hot).decision, 'deny', 'precondition: a launch denies')
    assert.deepStrictEqual(evaluateSendMessageGate(hot), { decision: 'allow', code: null, reason: null })
  })

  test('active cache-thrash denies the message to a DEAD target and names the mechanism', () => {
    const d = evaluateSendMessageGate(state({ thrash: thrashing, targetLiveness: 'dead', messageTarget: 'a1b2c3d4e5f6a7b8c' }))
    assert.strictEqual(d.decision, 'deny')
    assert.strictEqual(d.code, 'THRASH_ACTIVE')
    assert.ok(d.reason?.toLowerCase().includes('re-runs its whole transcript'), d.reason ?? '')
  })

  test('LIVE-TARGET RULE: a live target is never gated — delivery rides its existing run (no resume)', () => {
    // 2026-07-11 field fix: the gate denied messaging LIVE running agents under THRASH_ACTIVE,
    // but the resume-risk exists only for DEAD targets. Both disaster states must pass a live target.
    const thrashLive = evaluateSendMessageGate(state({ thrash: thrashing, targetLiveness: 'live' }))
    assert.deepStrictEqual(thrashLive, { decision: 'allow', code: null, reason: null })
    const stallLive = evaluateSendMessageGate(state({ lastStopFailureMs: NOW - 60_000, targetLiveness: 'live' }))
    assert.deepStrictEqual(stallLive, { decision: 'allow', code: null, reason: null })
  })

  test('UNKNOWN liveness downgrades the deny to a warning — a hard deny needs positive dead evidence', () => {
    const d = evaluateSendMessageGate(state({ thrash: thrashing, messageTarget: 'researcher' })) // no liveness resolvable for a name
    assert.strictEqual(d.decision, 'warn')
    assert.strictEqual(d.code, 'THRASH_ACTIVE')
    assert.ok(d.reason?.includes('liveness unknown'), d.reason ?? '')
    assert.ok(d.reason?.includes("'researcher'"), `the target must be named: ${d.reason ?? ''}`)
  })

  test('a rate-limit stall inside the cold-resume window denies a DEAD target: the resume re-runs the killing request', () => {
    const d = evaluateSendMessageGate(state({
      lastStopFailureMs: NOW - 3 * 60_000, stall: { session: 'abcdef1234', cwd: '/w/proj' }, targetLiveness: 'dead',
    }))
    assert.strictEqual(d.decision, 'deny')
    assert.strictEqual(d.code, 'COLD_RESUME_MESSAGE')
    assert.ok(d.reason?.includes('RE-RUNNING the request that killed it'), d.reason ?? '')
  })

  test('a stall OLDER than the cold-resume window no longer gates messaging', () => {
    const d = evaluateSendMessageGate(state({ lastStopFailureMs: NOW - 11 * 60_000, targetLiveness: 'dead' }))
    assert.deepStrictEqual(d, { decision: 'allow', code: null, reason: null })
  })

  test('EVIDENCE-BASED DISARM: a warm post-stall response from the stalled session ends the message gate early', () => {
    // 2026-07-11 field fix: the fixed 10-min window kept denying 6min after the stalled session
    // was already reading its cache warm. stallRecovered (from sessionWarmSince) must disarm NOW.
    const armed = state({ lastStopFailureMs: NOW - 3 * 60_000, targetLiveness: 'dead' })
    assert.strictEqual(evaluateSendMessageGate(armed).decision, 'deny', 'precondition: no evidence → still armed')
    const recovered = evaluateSendMessageGate({ ...armed, stallRecovered: true })
    assert.deepStrictEqual(recovered, { decision: 'allow', code: null, reason: null })
  })

  test('mode=warn downgrades a SendMessage deny to a warning, same as launches', () => {
    const d = evaluateSendMessageGate(state({ mode: 'warn', lastStopFailureMs: NOW - 60_000, targetLiveness: 'dead' }))
    assert.strictEqual(d.decision, 'warn')
    assert.strictEqual(d.code, 'COLD_RESUME_MESSAGE')
    assert.ok(d.reason?.startsWith('[deny downgraded'), d.reason ?? '')
  })
})

suite('agentGate — resolveMessageTargetLiveness (SubagentStart/Stop hook-event resolution)', () => {
  const ev = (evName: 'SubagentStart' | 'SubagentStop', agentId: string, ts: number) =>
    ({ ts, ev: evName, payload: { agent_id: agentId } })

  test('a started, not-yet-stopped agent id resolves live (bare and agent-prefixed forms)', () => {
    const events = [ev('SubagentStart', 'a080a3c4736fbf5df', NOW - 60_000)]
    assert.strictEqual(resolveMessageTargetLiveness('a080a3c4736fbf5df', events), 'live')
    assert.strictEqual(resolveMessageTargetLiveness('agent-a080a3c4736fbf5df', events), 'live')
  })

  test('a stopped agent id resolves dead; a later restart flips it back to live', () => {
    const stopped = [ev('SubagentStart', 'a1', NOW - 120_000), ev('SubagentStop', 'a1', NOW - 60_000)]
    assert.strictEqual(resolveMessageTargetLiveness('a1', stopped), 'dead')
    const restarted = [...stopped, ev('SubagentStart', 'a1', NOW - 10_000)]
    assert.strictEqual(resolveMessageTargetLiveness('a1', restarted), 'live')
  })

  test('a NAME target (no hook-event counterpart) and an empty target resolve unknown; main is live', () => {
    const events = [ev('SubagentStart', 'a1', NOW - 60_000)]
    assert.strictEqual(resolveMessageTargetLiveness('researcher', events), 'unknown')
    assert.strictEqual(resolveMessageTargetLiveness(undefined, events), 'unknown')
    assert.strictEqual(resolveMessageTargetLiveness('', events), 'unknown')
    assert.strictEqual(resolveMessageTargetLiveness('main', []), 'live')
  })
})

suite('agentGate — buildAdvisory (PostToolUse in-band warning)', () => {
  test('quiet state yields no advisory', () => {
    assert.strictEqual(buildAdvisory(state()), null)
  })

  test('thrash advisory states the magnitude but names NO session; identity is a question for the CLI', () => {
    const a = buildAdvisory(state({ thrash: thrashing }))
    assert.ok(a)
    assert.strictEqual(a?.code, 'THRASH_ACTIVE')
    assert.ok(a?.text.includes('1200k'), a?.text)
    assert.ok(!a?.text.includes('249c4216'), `suspect must NOT be named: ${a?.text}`)
    assert.ok(a?.text.includes('investigate_burn'), a?.text)
    const blind = buildAdvisory(state({ thrash: { ...thrashing, suspects: [] } }))
    assert.ok(blind?.text.includes('investigate_burn'), blind?.text)
  })

  test('fan-out advisory carries the premium share hint, counting only the caller OWN launches', () => {
    const a = buildAdvisory(state({ startsLast2min: 6, spawners: spawnersIn(6), premiumShare: 0.9, premiumModel: 'claude-fable-5' }))
    assert.strictEqual(a?.code, 'FANOUT_HEADSUP')
    assert.ok(a?.text.includes('claude-fable-5'), a?.text)
    assert.ok(a?.text.includes('6 agent launches from this project'), a?.text)
  })

  test('a fan-out in ANOTHER project yields NO advisory, and no advisory ever carries a foreign id or path', () => {
    // The measured 2026-08-07 leak: this channel printed `session f7385521… in …/EMASOFT-…;
    // session 9e1dc393… in …/llm-externalizer` into an unrelated agent's context.
    const foreign = buildAdvisory(state({ startsLast2min: 6, spawners: spawnersIn(6, FOREIGN_CWD), premiumShare: 0.9, premiumModel: 'claude-fable-5' }))
    assert.strictEqual(foreign, null, `a foreign project's wave must not speak here: ${foreign?.text}`)
    const mixed = buildAdvisory(state({
      startsLast2min: 11,
      spawners: [...spawnersIn(6), ...spawnersIn(5, FOREIGN_CWD)],
      premiumShare: 0.9, premiumModel: 'claude-fable-5',
    }))
    assert.strictEqual(mixed?.code, 'FANOUT_HEADSUP', 'own launches still cross the threshold')
    assert.ok(mixed?.text.includes('6 agent launches'), `only OWN launches are counted: ${mixed?.text}`)
    assert.ok(!mixed?.text.includes(FOREIGN_CWD.split('/').pop() ?? 'x'), `foreign path leaked: ${mixed?.text}`)
    assert.ok(!mixed?.text.includes('777b8f52'), `session id leaked: ${mixed?.text}`)
  })

  test('cold-start writes are EXPECTED fan-out cost and no longer interrupt — an advisory that says "no action needed" is a fact, not an alert', () => {
    // Retired 2026-08-07. It was added on 2026-07-11 so a HUMAN debugging a burst would not
    // mistake it for cache-thrash — a good explanation, but explaining is not interrupting, and
    // its own closing words were "No action needed". The false-positive it guards against is now
    // pinned where it belongs, in bodiesActivity.test.ts, and the count still reaches the
    // dashboard, --risk and investigate_burn.
    const coldStarts: ThrashReport = {
      active: false, count: 4, rebilledTokens: 463_000, model: 'claude-fable-5', windowMs: 300_000,
      suspects: [], topSource: { session: 's1', count: 1, rebilledTokens: 120_000 },
      unattributed: { count: 0, rebilledTokens: 0 },
      coldStartSessions: 4, coldStartRebilledTokens: 463_000,
    }
    assert.strictEqual(buildAdvisory(state({ thrash: coldStarts })), null)
    // Precedence unchanged: an ACTIVE thrash is a real anomaly the caller can act on, and still speaks.
    const active = buildAdvisory(state({ thrash: { ...coldStarts, active: true, topSource: { session: 's1', count: 4, rebilledTokens: 463_000 } } }))
    assert.strictEqual(active?.code, 'THRASH_ACTIVE')
    assert.strictEqual(buildAdvisory(state({ thrash: { ...coldStarts, coldStartSessions: 1 } })), null)
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
