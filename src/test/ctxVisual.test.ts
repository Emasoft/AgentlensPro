// Unit tests for the ctxvis analysis core. Two things here are worth real scrutiny and get most of
// the coverage:
//
//   1. selectTurns' POSITION RULE. The spawning session's own requests necessarily contain the
//      nonce, and they are bigger and more numerous than the agent's, so any selection that matches
//      "body contains nonce" picks the wrong captures with total confidence. The test that matters
//      is the one where a parent capture is present and must be REJECTED.
//   2. divergence()'s append-vs-break distinction. A later turn always differs from an earlier one,
//      so "they differ" is trivially true; the only question that costs money is whether they differ
//      inside the earlier turn's own extent.
//
// Bodies here are literal objects, not fixtures read off disk. That is deliberate: these functions
// are pure, and a hand-written pair lets a test pin an exact tier and index that a captured body
// could never guarantee.

import * as assert from 'assert'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import {
  selectTurns, divergence, cacheVerdict, mintNonce, NONCE_PREFIX, assertNonce,
  loadBaselines, saveBaselines, validateBaselines, fingerprintDrift,
  listRequestCaptures,
  type EnvFingerprint, type BaselineStore,
} from '../ctxVisual'
import type { RequestBody } from '../capturedBody'

const NONCE = 'AGENTLENS-CTXVIS-DEADBEEF'

const msg = (role: string, text: string) => ({ role, content: [{ type: 'text', text }] })
const base = (): RequestBody => ({
  model: 'claude-opus-5',
  tools: [{ name: 'Bash', description: 'run a command' }, { name: 'Read', description: 'read a file' }],
  system: [{ type: 'text', text: 'you are a subagent' }],
  messages: [msg('user', `do the thing ${NONCE}`)],
})

/** Deep clone so a mutation in one test body cannot leak into another. */
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T

function withTmpDir<T>(fn: (dir: string) => T): T {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctxvis-test-'))
  try { return fn(dir) } finally { fs.rmSync(dir, { recursive: true, force: true }) }
}

function writeCapture(dir: string, name: string, body: RequestBody, mtimeMs?: number): string {
  const p = path.join(dir, `${name}.request.json`)
  fs.writeFileSync(p, JSON.stringify(body))
  if (mtimeMs !== undefined) fs.utimesSync(p, mtimeMs / 1000, mtimeMs / 1000)
  return p
}

suite('ctxvis — mintNonce', () => {
  test('produces a prefixed 8-char hex marker', () => {
    const n = mintNonce(() => 0.5)
    assert.ok(n.startsWith(NONCE_PREFIX), `expected the ${NONCE_PREFIX} prefix, got ${n}`)
    assert.strictEqual(n.length, NONCE_PREFIX.length + 8)
    assert.match(n.slice(NONCE_PREFIX.length), /^[0-9A-F]{8}$/)
  })
})

suite('ctxvis — assertNonce', () => {
  test('accepts a minted nonce', () => {
    assertNonce(mintNonce(() => 0.9))
    assertNonce(NONCE)
  })

  test('REFUSES a short marker, which would match unrelated captures', () => {
    // Found while smoke-testing the CLI: `--measured x=y` selected arbitrary captures containing
    // the letter "y" and produced a confident, fictional turn comparison. A marker that matches
    // everything is not a marker, and a plausible-looking wrong report is worse than an error.
    for (const bad of ['y', 'test', 'nonce', '', 'AGENTLENS-CTXVIS-', 'AGENTLENS-CTXVIS-zzzzzzzz']) {
      assert.throws(() => assertNonce(bad), /not a ctxvis nonce/, `"${bad}" must be refused`)
    }
  })
})

suite('ctxvis — selectTurns', () => {
  test('selects the agent turns and REJECTS the spawning session that also carries the nonce', () => {
    withTmpDir(dir => {
      const t1 = clone(base())
      const t2 = clone(base())
      t2.messages!.push(msg('assistant', 'calling a tool'), msg('user', 'tool result'))

      // The parent: a long conversation that mentions the nonce only once it spawned the agent.
      const parent: RequestBody = {
        model: 'claude-opus-5',
        messages: [
          msg('user', 'unrelated earlier turn'),
          msg('assistant', 'earlier reply'),
          { role: 'assistant', content: [{ type: 'tool_use', name: 'Agent', input: { prompt: `go ${NONCE}` } }] },
          msg('user', `tool result mentioning ${NONCE}`),
        ],
      }

      writeCapture(dir, 'a-turn1', t1, 1_000_000)
      writeCapture(dir, 'b-turn2', t2, 2_000_000)
      writeCapture(dir, 'c-parent', parent, 3_000_000)

      const sel = selectTurns(listRequestCaptures([dir]), NONCE)
      assert.strictEqual(sel.ambiguous, null, sel.ambiguous ?? '')
      assert.strictEqual(sel.turns.length, 2, 'exactly the two agent turns should qualify')
      assert.deepStrictEqual(sel.turns.map(t => t.messageCount), [1, 3])
      assert.strictEqual(sel.rejected.length, 1, 'the parent must be rejected, not silently included')
      assert.match(sel.rejected[0].reason, /not in messages\[0\]/)
    })
  })

  test('ignores captures that never mention the nonce at all', () => {
    withTmpDir(dir => {
      writeCapture(dir, 'mine', base(), 1_000_000)
      writeCapture(dir, 'other', { model: 'x', messages: [msg('user', 'somebody else entirely')] }, 2_000_000)
      const sel = selectTurns(listRequestCaptures([dir]), NONCE)
      assert.strictEqual(sel.turns.length, 1)
      assert.strictEqual(sel.rejected.length, 0, 'an unrelated capture is not a rejection, it is a non-match')
    })
  })

  test('flags contradictory ordering instead of picking one', () => {
    withTmpDir(dir => {
      const t1 = clone(base())
      const t2 = clone(base())
      t2.messages!.push(msg('assistant', 'x'), msg('user', 'y'))
      // The longer turn was written EARLIER — impossible for one sequential run.
      writeCapture(dir, 'short-late', t1, 9_000_000)
      writeCapture(dir, 'long-early', t2, 1_000_000)
      const sel = selectTurns(listRequestCaptures([dir]), NONCE)
      assert.ok(sel.ambiguous, 'contradictory ordering must be reported, never resolved by guessing')
      assert.match(sel.ambiguous!, /contradictory/)
    })
  })

  test('flags two captures with the same message count', () => {
    withTmpDir(dir => {
      writeCapture(dir, 'one', base(), 1_000_000)
      writeCapture(dir, 'two', base(), 2_000_000)
      const sel = selectTurns(listRequestCaptures([dir]), NONCE)
      assert.ok(sel.ambiguous, 'equal message counts give no turn order')
      assert.match(sel.ambiguous!, /same message count/)
    })
  })

  test('survives an unreadable capture without losing the readable ones', () => {
    withTmpDir(dir => {
      writeCapture(dir, 'good', base(), 1_000_000)
      fs.writeFileSync(path.join(dir, 'truncated.request.json'), '{"messages":[{"role"')
      const sel = selectTurns(listRequestCaptures([dir]), NONCE)
      assert.strictEqual(sel.turns.length, 1, 'a half-flushed capture must not abort the scan')
    })
  })
})

suite('ctxvis — divergence', () => {
  test('identical requests', () => {
    const d = divergence(base(), base())
    assert.strictEqual(d.kind, 'identical')
    assert.strictEqual(d.tier, null)
  })

  test('pure append — the healthy case; prefix intact', () => {
    const a = base()
    const b = clone(a)
    b.messages!.push(msg('assistant', 'tool call'), msg('user', 'tool result'))
    const d = divergence(a, b)
    assert.strictEqual(d.kind, 'append')
    assert.strictEqual(d.appended, 2)
    assert.strictEqual(d.tier, null, 'an append has no divergence tier — nothing before the tail moved')
  })

  test('a changed tool schema breaks at the tools tier, the earliest and worst', () => {
    const a = base()
    const b = clone(a)
    b.tools![1] = { name: 'Read', description: 'read a file (v2)' }
    b.messages!.push(msg('assistant', 'x'))
    const d = divergence(a, b)
    assert.strictEqual(d.kind, 'break')
    assert.strictEqual(d.tier, 'tools')
    assert.strictEqual(d.index, 1)
    assert.match(d.label, /Read/)
  })

  test('an added tool is a break even though nothing existing changed', () => {
    const a = base()
    const b = clone(a)
    b.tools!.push({ name: 'Write', description: 'write a file' })
    const d = divergence(a, b)
    assert.strictEqual(d.kind, 'break')
    assert.strictEqual(d.tier, 'tools')
    assert.strictEqual(d.index, 2)
    assert.match(d.label, /added/)
  })

  test('an edited system block breaks at the system tier', () => {
    const a = base()
    const b = clone(a)
    b.system![0] = { type: 'text', text: 'you are a subagent, revised' }
    const d = divergence(a, b)
    assert.strictEqual(d.kind, 'break')
    assert.strictEqual(d.tier, 'system')
    assert.strictEqual(d.index, 0)
  })

  test('tools are checked BEFORE system — the earlier tier wins', () => {
    const a = base()
    const b = clone(a)
    b.tools![0] = { name: 'Bash', description: 'changed' }
    b.system![0] = { type: 'text', text: 'also changed' }
    const d = divergence(a, b)
    assert.strictEqual(d.tier, 'tools', 'reporting the later tier would understate what was invalidated')
  })

  test('a rewritten earlier message breaks inside the messages tier and names the block', () => {
    const a = clone(base())
    a.messages!.push(msg('assistant', 'original reply'))
    const b = clone(a)
    b.messages![1] = msg('assistant', 'retroactively edited reply')
    b.messages!.push(msg('user', 'and a new turn'))
    const d = divergence(a, b)
    assert.strictEqual(d.kind, 'break')
    assert.strictEqual(d.tier, 'messages')
    assert.strictEqual(d.index, 1)
    assert.strictEqual(d.blockIndex, 0)
    assert.match(d.label, /rewritten/)
  })

  test('a truncated history is a break, not an append', () => {
    const a = clone(base())
    a.messages!.push(msg('assistant', 'reply'), msg('user', 'again'))
    const b = clone(base()) // b dropped the tail entirely
    const d = divergence(a, b)
    assert.strictEqual(d.kind, 'break')
    assert.strictEqual(d.tier, 'messages')
    assert.strictEqual(d.index, 1)
  })
})

suite('ctxvis — cacheVerdict', () => {
  const appendDiv = divergence(base(), (() => { const b = clone(base()); b.messages!.push(msg('assistant', 'x')); return b })())

  test('exact match between prediction and billing', () => {
    const v = cacheVerdict(appendDiv, 90_000, 92_000, {
      cache_read_input_tokens: 90_000, cache_creation_input_tokens: 2_000,
      cache_creation: { ephemeral_5m_input_tokens: 2_000, ephemeral_1h_input_tokens: 0 },
    }, 'claude-opus-5')
    assert.strictEqual(v.agreement, 'agree')
    assert.strictEqual(v.predictedRewritten, 2_000)
  })

  test('a small shortfall is breakpoint rounding, not a contradiction', () => {
    const v = cacheVerdict(appendDiv, 90_000, 92_000, {
      cache_read_input_tokens: 88_500, cache_creation_input_tokens: 3_500,
    }, 'claude-opus-5')
    assert.strictEqual(v.agreement, 'shortfall-within-tolerance')
    assert.match(v.agreementNote, /breakpoint/)
  })

  test('a large shortfall is reported as a disagreement, not smoothed over', () => {
    const v = cacheVerdict(appendDiv, 90_000, 92_000, {
      cache_read_input_tokens: 10_000, cache_creation_input_tokens: 82_000,
    }, 'claude-opus-5')
    assert.strictEqual(v.agreement, 'disagree')
  })

  test('reusing MORE than the common prefix blames the prediction, not the billing', () => {
    const v = cacheVerdict(appendDiv, 50_000, 92_000, {
      cache_read_input_tokens: 90_000, cache_creation_input_tokens: 2_000,
    }, 'claude-opus-5')
    assert.strictEqual(v.agreement, 'disagree')
    assert.match(v.agreementNote, /prediction as wrong/)
  })

  test('without a measurement it says unmeasured rather than inventing one', () => {
    const v = cacheVerdict(appendDiv, null, null, { cache_read_input_tokens: 90_000 }, 'claude-opus-5')
    assert.strictEqual(v.agreement, 'unmeasured')
    assert.strictEqual(v.predictedSurviving, null)
    assert.strictEqual(v.predictedRewritten, null)
  })

  test('the 1h write tier costs strictly more than the same tokens at 5m', () => {
    const u = { cache_read_input_tokens: 1_000, cache_creation_input_tokens: 100_000 }
    const at5m = cacheVerdict(appendDiv, null, null,
      { ...u, cache_creation: { ephemeral_5m_input_tokens: 100_000, ephemeral_1h_input_tokens: 0 } }, 'claude-opus-5')
    const at1h = cacheVerdict(appendDiv, null, null,
      { ...u, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 100_000 } }, 'claude-opus-5')
    assert.ok(at1h.actualCostUsd! > at5m.actualCostUsd!,
      `1h writes must cost more than 5m (got 1h=${at1h.actualCostUsd} vs 5m=${at5m.actualCostUsd}); ` +
      'a flat write rate under-reports the tier Claude Code actually uses for main-conversation turns')
  })
})

suite('ctxvis — baseline store', () => {
  const env = (over: Partial<EnvFingerprint> = {}): EnvFingerprint => ({
    claudeCodeVersion: '2.0.0',
    projectDir: '/Users/x/proj',
    claudeMdTokens: 21_188,
    rulesTokens: 64_493,
    mcpSchemaTokens: 58_722,
    skillListingTokens: 14_364,
    ...over,
  })

  test('an unreadable or future-schema store degrades to empty rather than half-reading it', () => {
    withTmpDir(dir => {
      const f = path.join(dir, 'b.json')
      fs.writeFileSync(f, 'not json at all')
      assert.deepStrictEqual(loadBaselines(f), { version: 1, entries: [] })
      fs.writeFileSync(f, JSON.stringify({ version: 99, entries: [{ agent: 'Explore' }] }))
      assert.deepStrictEqual(loadBaselines(f), { version: 1, entries: [] })
    })
  })

  test('round-trips through disk', () => {
    withTmpDir(dir => {
      const f = path.join(dir, 'nested', 'b.json')
      const store: BaselineStore = {
        version: 1,
        entries: [{ agent: 'Explore', measuredAt: 'now', env: env(), turns: [], verdict: null }],
      }
      saveBaselines(f, store)
      assert.deepStrictEqual(loadBaselines(f), store)
    })
  })

  test('a missing baseline is distinguished from a stale one', () => {
    const store: BaselineStore = {
      version: 1,
      entries: [{ agent: 'Explore', measuredAt: 'now', env: env(), turns: [], verdict: null }],
    }
    const v = validateBaselines(store, env())
    assert.deepStrictEqual(v.map(x => `${x.agent}:${x.state}`),
      ['Explore:fresh', 'Plan:missing', 'general-purpose:missing'])
  })

  test('drift in any shared element marks the baseline stale and names what moved', () => {
    assert.strictEqual(fingerprintDrift(env(), env()), null)
    assert.match(fingerprintDrift(env(), env({ claudeMdTokens: 30_000 }))!, /CLAUDE\.md/)
    assert.match(fingerprintDrift(env(), env({ mcpSchemaTokens: 10 }))!, /MCP tool schemas/)
    assert.match(fingerprintDrift(env(), env({ claudeCodeVersion: '2.1.0' }))!, /Claude Code moved/)
    assert.match(fingerprintDrift(env(), env({ projectDir: '/elsewhere' }))!, /different project/)
  })

  test('a few tokens of wobble does not invalidate the cache', () => {
    // These blocks legitimately vary slightly between turns. Re-spawning three agents because a
    // rules file gained a comma would make the baseline cache worthless.
    assert.strictEqual(fingerprintDrift(env(), env({ claudeMdTokens: 21_188 + 30 })), null)
    assert.strictEqual(fingerprintDrift(env(), env({ rulesTokens: 64_493 + 400 })), null)
  })
})
