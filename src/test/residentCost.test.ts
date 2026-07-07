import * as assert from 'assert'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { buildResidentCostReport, kindRemediation } from '../residentCost'
import { buildContextHistory } from '../contextHistory'
import type {
  ContextHistory, ContextHistoryStep, ContextBlock, ContextBlockKind,
} from '../summarizers/summarizerTypes'

// ── residentCost (TRDD-W0RRL2FZ) — pure-derivation + real end-to-end tests ─────
// The derivation is deterministic math over a ContextHistory, so the synthetic fixtures assert the
// EXACT residency windows and sums (no tolerance). The end-to-end suite drives the REAL
// buildContextHistory over a real .jsonl on disk (via the CLAUDE_CONFIG_DIR override) so the
// isCompactSummary-vs-isMeta classification fix is tested against the code that ships, not a copy.

function block(kind: ContextBlockKind, label: string, tokens: number): ContextBlock {
  return { id: `${kind}:${label}`, kind, label, tokens, tokenSource: 'estimated', bytes: tokens * 4, text: `text of ${label}`, role: 'input' }
}

function step(turn: number, blocks: ContextBlock[], usage?: { input: number; output: number; cacheRead: number; cacheCreate: number }): ContextHistoryStep {
  return { turn, usage, blocks, diff: { added: blocks.map(b => b.id), removed: [], changed: [] } }
}

function history(steps: ContextHistoryStep[]): ContextHistory {
  return { sessionId: 'synthetic', steps, estimated: true, truncated: false }
}

suite('residentCost — residency windows (no compaction)', () => {
  test('a block added at turn 1 of a 5-turn session rides all 5 turns', () => {
    const h = history([
      step(1, [block('userMsg', 'user', 100)]),
      step(2, []), step(3, []), step(4, []), step(5, []),
    ])
    const r = buildResidentCostReport(h)
    assert.strictEqual(r.lastTurn, 5)
    assert.deepStrictEqual(r.compactionTurns, [])
    assert.strictEqual(r.blocks.length, 1)
    const b = r.blocks[0]
    assert.strictEqual(b.firstSeenTurn, 1)
    assert.strictEqual(b.lastResidentTurn, 5)
    assert.strictEqual(b.turnsResident, 5)
    assert.strictEqual(b.residentCost, 100 * 5)
  })

  test('a late block rides only the remaining turns', () => {
    const h = history([step(1, []), step(2, []), step(3, [block('toolOutput', 'Read', 50)]), step(4, []), step(5, [])])
    const b = buildResidentCostReport(h).blocks[0]
    assert.strictEqual(b.residentCost, 50 * 3) // T3..T5
  })

  test('re-injected block sums per-occurrence windows (not span × total tokens)', () => {
    // 10 tok at T1 (rides 3), 20 tok at T2 (rides 2), 30 tok at T3 (rides 1) = 30+40+30 = 100.
    const h = history([
      step(1, [block('hook', 'h', 10)]),
      step(2, [block('hook', 'h', 20)]),
      step(3, [block('hook', 'h', 30)]),
    ])
    const b = buildResidentCostReport(h).blocks[0]
    assert.strictEqual(b.occurrences, 3)
    assert.strictEqual(b.tokens, 60)
    assert.strictEqual(b.peakTokens, 30)
    assert.strictEqual(b.residentCost, 10 * 3 + 20 * 2 + 30 * 1)
  })

  test('blocks are ranked by residentCost, heaviest first', () => {
    // Small-but-early beats big-but-late: 10×5=50 vs 40×1=40.
    const h = history([
      step(1, [block('userMsg', 'early', 10)]),
      step(5, [block('file', 'late', 40)]),
      step(2, []), step(3, []), step(4, []),
    ])
    const r = buildResidentCostReport(h)
    assert.strictEqual(r.blocks[0].label, 'early')
    assert.strictEqual(r.blocks[1].label, 'late')
  })
})

suite('residentCost — compaction-aware eviction', () => {
  test('content before a compaction is evicted at the compaction turn', () => {
    // Compaction at T3 (the step carrying the postCompact block). The T1 block rides T1..T2 only;
    // the summary itself rides T3..T5.
    const h = history([
      step(1, [block('toolOutput', 'Bash', 100)]),
      step(2, []),
      step(3, [block('postCompact', 'compact summary', 20)]),
      step(4, []), step(5, []),
    ])
    const r = buildResidentCostReport(h)
    assert.deepStrictEqual(r.compactionTurns, [3])
    const evicted = r.blocks.find(b => b.label === 'Bash')!
    assert.strictEqual(evicted.lastResidentTurn, 2)
    assert.strictEqual(evicted.residentCost, 100 * 2)
    const summary = r.blocks.find(b => b.kind === 'postCompact')!
    assert.strictEqual(summary.lastResidentTurn, 5)
    assert.strictEqual(summary.residentCost, 20 * 3)
  })

  test('two compactions create three residency segments', () => {
    const h = history([
      step(1, [block('userMsg', 'a', 10)]),
      step(2, [block('postCompact', 'compact summary', 5)]),
      step(3, [block('userMsg', 'b', 10)]),
      step(4, [block('postCompact', 'compact summary', 5)]),
      step(5, []),
    ])
    const r = buildResidentCostReport(h)
    assert.deepStrictEqual(r.compactionTurns, [2, 4])
    const a = r.blocks.find(b => b.label === 'a')!
    assert.strictEqual(a.residentCost, 10 * 1)   // T1 only — evicted by the T2 compaction
    const bb = r.blocks.find(b => b.label === 'b')!
    assert.strictEqual(bb.residentCost, 10 * 1)  // T3 only — evicted by the T4 compaction
    // The compact-summary id merges both occurrences: T2 copy rides T2..T3, T4 copy rides T4..T5.
    const s = r.blocks.find(b => b.kind === 'postCompact')!
    assert.strictEqual(s.occurrences, 2)
    assert.strictEqual(s.residentCost, 5 * 2 + 5 * 2)
  })
})

suite('residentCost — reconciliation against exact usage', () => {
  test('totalContextTokens sums input + cacheRead + cacheCreate over steps with usage', () => {
    const h = history([
      step(1, [block('userMsg', 'u', 10)], { input: 100, output: 5, cacheRead: 0, cacheCreate: 900 }),
      step(2, [], { input: 10, output: 5, cacheRead: 1000, cacheCreate: 0 }),
      step(3, []), // no usage — must be counted in stepCount but not in stepsWithUsage
    ])
    const r = buildResidentCostReport(h)
    assert.strictEqual(r.totalContextTokens, 100 + 900 + 10 + 1000)
    assert.strictEqual(r.stepsWithUsage, 2)
    assert.strictEqual(r.stepCount, 3)
    assert.strictEqual(r.itemizedResidentTokens, 10 * 3)
    assert.strictEqual(r.unattributedTokens, 2010 - 30)
  })

  test('unattributed stays SIGNED when estimates overshoot (never clamped to 0)', () => {
    const h = history([
      step(1, [block('userMsg', 'u', 500)], { input: 100, output: 5, cacheRead: 0, cacheCreate: 0 }),
    ])
    const r = buildResidentCostReport(h)
    assert.strictEqual(r.unattributedTokens, 100 - 500) // negative — a loud reconciliation failure
    assert.ok(r.unattributedTokens < 0)
  })

  test('no usage at all → totalContextTokens 0 and an explicit unreconcilable note', () => {
    const r = buildResidentCostReport(history([step(1, [block('userMsg', 'u', 10)])]))
    assert.strictEqual(r.totalContextTokens, 0)
    assert.ok(/cannot be reconciled/.test(r.note), `note must say it cannot reconcile: ${r.note}`)
  })

  test('empty history → empty report, no NaN/negative turns', () => {
    const r = buildResidentCostReport(history([]))
    assert.strictEqual(r.lastTurn, 0)
    assert.strictEqual(r.blocks.length, 0)
    assert.strictEqual(r.itemizedResidentTokens, 0)
  })
})

suite('residentCost — remediation hints', () => {
  test('every ContextBlockKind has a non-empty remediation', () => {
    const kinds: ContextBlockKind[] = [
      'system', 'claudemd', 'rule', 'toolCatalog', 'skillCatalog', 'agentCatalog', 'mcp',
      'file', 'toolInput', 'toolOutput', 'bashInput', 'bashOutput', 'hook', 'skillPrompt',
      'agentPrompt', 'userMsg', 'assistantMsg', 'reasoning', 'postCompact', 'subagentOutput',
      'harness', 'cron', 'reminder', 'other',
    ]
    for (const k of kinds) {
      const hint = kindRemediation(k)
      assert.ok(typeof hint === 'string' && hint.length > 20, `kind ${k} needs a real hint, got: ${hint}`)
    }
  })

  test('each ranked block carries its kind hint', () => {
    const r = buildResidentCostReport(history([step(1, [block('postCompact', 'compact summary', 5)])]))
    assert.strictEqual(r.blocks[0].remediation, kindRemediation('postCompact'))
  })
})

// ── End-to-end: the REAL buildContextHistory classification feeding the derivation ──────────────
// Writes a real .jsonl to a temp CLAUDE_CONFIG_DIR and runs the shipped parser. This pins the
// TRDD-W0RRL2FZ classification fix: an isMeta local-command caveat must classify as 'cron' (NOT
// postCompact — the old branch fabricated compaction boundaries out of cron pings), and only the
// real isCompactSummary record may mark a compaction boundary for the residency model.
suite('residentCost — end-to-end over a real transcript (CLAUDE_CONFIG_DIR)', () => {
  let tmpDir: string
  let savedConfigDir: string | undefined
  const sessionId = 'rc-e2e-0000-session'

  const asst = (id: string, text: string) => JSON.stringify({
    type: 'assistant', timestamp: '2026-07-07T10:00:00Z',
    message: { id, model: 'claude-sonnet-4-5', usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 20 }, content: [{ type: 'text', text }] },
  })
  const user = (text: string) => JSON.stringify({ type: 'user', message: { role: 'user', content: text } })
  const metaCaveat = () => JSON.stringify({
    type: 'user', isMeta: true,
    message: { role: 'user', content: '<local-command-caveat>Caveat: The messages below were generated by the user while running local commands.</local-command-caveat>' },
  })
  const metaTaskFire = () => JSON.stringify({
    type: 'user', isMeta: true,
    message: { role: 'user', content: '[janitor-heartbeat]\nRun the heartbeat checks and report drift.' },
  })
  const compactSummary = () => JSON.stringify({
    type: 'user', isCompactSummary: true,
    message: { role: 'user', content: 'This session is being continued from a previous conversation that ran out of context. Summary: did things.' },
  })

  suiteSetup(() => {
    savedConfigDir = process.env['CLAUDE_CONFIG_DIR']
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentlens-rc-'))
    const projDir = path.join(tmpDir, 'projects', 'proj')
    fs.mkdirSync(projDir, { recursive: true })
    // T1: user + cron caveat → assistant; T2: user → assistant; T3: compaction summary + user → assistant.
    const lines = [
      user('start the work'),
      metaCaveat(),
      metaTaskFire(),
      asst('m1', 'ok'),
      user('keep going'),
      asst('m2', 'done step 2'),
      compactSummary(),
      user('continue after compaction'),
      asst('m3', 'continuing'),
      user('final'),
      asst('m4', 'finished'),
    ]
    fs.writeFileSync(path.join(projDir, `${sessionId}.jsonl`), lines.join('\n') + '\n')
    process.env['CLAUDE_CONFIG_DIR'] = tmpDir
  })

  suiteTeardown(() => {
    if (savedConfigDir === undefined) delete process.env['CLAUDE_CONFIG_DIR']
    else process.env['CLAUDE_CONFIG_DIR'] = savedConfigDir
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  test('isMeta records classify as cron (named per entity); only isCompactSummary marks postCompact', async () => {
    const h = await buildContextHistory(sessionId)
    assert.ok(h, 'history must reconstruct from the temp transcript')
    const allBlocks = h!.steps.flatMap(s => s.blocks)
    const cron = allBlocks.filter(b => b.kind === 'cron')
    const compact = allBlocks.filter(b => b.kind === 'postCompact')
    assert.deepStrictEqual(
      cron.map(b => b.label).sort(),
      ['local-command caveat', 'scheduled task: janitor-heartbeat'],
      'the caveat and the bracket-named task fire must each be their own cron block',
    )
    assert.strictEqual(compact.length, 1, 'exactly one postCompact block (the real summary)')
    // The metas are input for turn 1; the summary is input for turn 3.
    assert.strictEqual(h!.steps.find(s => s.blocks.some(b => b.kind === 'cron'))!.turn, 1)
    assert.strictEqual(h!.steps.find(s => s.blocks.some(b => b.kind === 'postCompact'))!.turn, 3)
  })

  test('the derivation sees ONE compaction boundary and evicts pre-compaction content there', async () => {
    const h = await buildContextHistory(sessionId)
    const r = buildResidentCostReport(h!)
    assert.deepStrictEqual(r.compactionTurns, [3])
    assert.strictEqual(r.lastTurn, 4)
    // Pre-compaction content (T1/T2) must stop at T2; post-compaction content rides to T4.
    const cron = r.blocks.find(b => b.kind === 'cron')!
    assert.strictEqual(cron.lastResidentTurn, 2)
    const summary = r.blocks.find(b => b.kind === 'postCompact')!
    assert.strictEqual(summary.firstSeenTurn, 3)
    assert.strictEqual(summary.lastResidentTurn, 4)
    // Exact usage reconciliation base: 4 turns × (10 + 100 + 20).
    assert.strictEqual(r.totalContextTokens, 4 * 130)
  })
})
