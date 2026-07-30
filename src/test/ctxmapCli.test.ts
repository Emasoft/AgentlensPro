// Unit tests for `agentlenspro ctxmap` — the pure decomposition/classification half. The io half
// (spool discovery, response pairing) is exercised by the CLI itself against captured bodies; what
// matters here is that the splitter never loses bytes and the classifier names what it sees, since
// a decomposer that silently drops content misreports the very total it exists to explain.

import * as assert from 'assert'
import { extractElements, splitInjected, renderDiff, selectPairing, buildPrefix, auditCoverage } from '../cli/ctxmapCli'
import type { CtxReport } from '../cli/ctxmapCli'

suite('ctxmap — splitInjected', () => {
  test('carves a block into named file sections and loses no bytes', () => {
    const text = [
      'preamble words before any marker',
      'Contents of /Users/x/Code/proj/CLAUDE.md (project instructions)',
      'project body line',
      'Contents of /Users/x/.claude/rules/never-git-add-all.md (user rules)',
      'rule body line',
    ].join('\n')
    const parts = splitInjected(text)
    assert.deepStrictEqual(parts.map(p => p.label), ['preamble', 'file:CLAUDE.md', 'file:never-git-add-all.md'])
    assert.strictEqual(parts.map(p => p.text).join(''), text, 'every byte must land in exactly one section')
  })

  test('recognises a skill body by its command-message marker', () => {
    const text = '<command-message>janitor-memory-repair</command-message>\nBase directory for this skill: /x'
    assert.strictEqual(splitInjected(text)[0].label, 'skill:janitor-memory-repair')
  })

  test('a block with no markers stays one element', () => {
    const parts = splitInjected('just some prose with no structural markers at all')
    assert.strictEqual(parts.length, 1)
    assert.strictEqual(parts[0].label, 'text')
  })
})

suite('ctxmap — extractElements', () => {
  test('counts system blocks, every tool schema, and each message block separately', () => {
    const els = extractElements({
      model: 'claude-sonnet-5',
      system: [{ type: 'text', text: "You are Claude Code, Anthropic's official CLI for Claude." }],
      tools: [{ name: 'Bash', description: 'run a command' }, { name: 'Agent', description: 'spawn' }],
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'do the thing' }] },
        { role: 'assistant', content: [{ type: 'tool_use', name: 'Bash', input: { command: 'ls' } }] },
        { role: 'user', content: [{ type: 'tool_result', content: 'file.txt' }] },
      ],
    })
    assert.strictEqual(els.filter(e => e.section === 'system').length, 1)
    assert.deepStrictEqual(els.filter(e => e.section === 'tools').map(e => e.label), ['tool:Bash', 'tool:Agent'])
    assert.ok(els.some(e => e.label === 'tool_use:Bash'), 'a tool_use is attributed to its tool')
    assert.ok(els.some(e => e.label === 'tool_result'))
    assert.strictEqual(els.find(e => e.section === 'system')?.label, 'harness-identity')
  })

  test('a string content payload is handled like a single text block', () => {
    const els = extractElements({ messages: [{ role: 'user', content: 'plain string content' }] })
    assert.strictEqual(els.length, 1)
    assert.strictEqual(els[0].section, 'messages/user')
  })

  test('every element carries a non-negative raw token count', () => {
    const els = extractElements({ messages: [{ role: 'user', content: [{ type: 'text', text: 'hello world' }] }] })
    assert.ok(els[0].raw > 0)
  })
})

// The pairing decides the total every per-element number is scaled to, so picking a sibling call's
// response silently rewrites the whole report. Nothing on disk links a request to its response, so
// the rank is ARRIVAL TIME (physically grounded) and size is only a rejection filter — size must not
// rank, because the estimator reads low and would pull every pick downward.
suite('ctxmap — selectPairing', () => {
  const resp = (model: string, input: number) => ({ model, usage: { input_tokens: input } })

  test('takes the nearest surviving candidate, since cands arrive time-ordered', () => {
    const p = selectPairing([resp('m', 220_000), resp('m', 226_000)], 'm', 225_000)
    assert.strictEqual(p?.exact, 220_000)
  })

  test('rejects a neighbour that is plainly a different call', () => {
    // 4x this request cannot be its response — unfiltered, nearest-in-time would take it.
    const p = selectPairing([resp('m', 900_000), resp('m', 220_000)], 'm', 225_000)
    assert.strictEqual(p?.exact, 220_000)
    assert.strictEqual(p.candidates, 1)
    assert.strictEqual(p.ambiguous, false)
  })

  test('size only rejects — it must NOT rank, because the estimator reads ~40% low', () => {
    // Measured: 161,685 estimated against 225,825 billed. Ranking by closeness to the estimate would
    // take the 170k here; the real response is the 226k that arrived first.
    const p = selectPairing([resp('m', 226_000), resp('m', 170_000)], 'm', 161_685)
    assert.strictEqual(p?.exact, 226_000, 'a low-biased estimate must not pull the pick downward')
  })

  test('more than one survivor means the pairing is unverified, and says so', () => {
    const p = selectPairing([resp('m', 210_000), resp('m', 240_000)], 'm', 225_000)
    assert.strictEqual(p?.candidates, 2)
    assert.ok(p.ambiguous)
  })

  test('a different model is not a candidate at all', () => {
    const p = selectPairing([resp('other', 225_000), resp('m', 400_000)], 'm', 225_000)
    assert.strictEqual(p?.exact, 400_000)
    assert.strictEqual(p.candidates, 1)
  })

  test('sums the cache buckets — input_tokens alone is the uncached remainder', () => {
    const p = selectPairing(
      [{ model: 'm', usage: { input_tokens: 2, cache_creation_input_tokens: 218_785, cache_read_input_tokens: 7_038 } }],
      'm', 225_000)
    assert.strictEqual(p?.exact, 225_825)
  })

  test('no usable response yields null so the caller labels the report estimated', () => {
    assert.strictEqual(selectPairing([{ model: 'm', usage: {} }], 'm', 1000), null)
    assert.strictEqual(selectPairing([], 'm', 1000), null)
    assert.strictEqual(selectPairing([resp('m', 5_000_000)], 'm', 225_000), null, 'all rejected → null')
  })
})

// Exact per-element counts are differences between prefixes, so a prefix that does not truncate
// where it claims to would silently mis-attribute every element after it.
suite('ctxmap — buildPrefix', () => {
  const req = {
    model: 'm',
    system: [{ type: 'text', text: 'sys0' }, { type: 'text', text: 'sys1' }],
    tools: [{ name: 'Bash' }, { name: 'Read' }],
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'AAAABBBB' }, { type: 'text', text: 'second' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'reply' }] },
    ],
  }

  test('a system cut carries only the system blocks up to it, plus the stub message', () => {
    const p = buildPrefix(req, { kind: 'system', upto: 0 })
    assert.deepStrictEqual(p.system, [{ type: 'text', text: 'sys0' }])
    assert.strictEqual(p.tools, undefined, 'tools must not be in a system prefix or the delta double-counts')
    assert.strictEqual(p.messages.length, 1)
  })

  test('a tool cut carries all system plus tools up to it', () => {
    const p = buildPrefix(req, { kind: 'tool', upto: 0 })
    assert.strictEqual((p.system as unknown[]).length, 2)
    assert.deepStrictEqual(p.tools, [{ name: 'Bash' }])
  })

  test('a message cut keeps whole earlier messages and truncates the current one at the block', () => {
    const p = buildPrefix(req, { kind: 'msg', mi: 1, bi: 0 })
    assert.strictEqual(p.messages.length, 2)
    assert.strictEqual(p.tools?.length, 2, 'message prefixes must carry the full system+tools preamble')
  })

  test('a textEnd cut slices inside the block, which is how one file is separated from the next', () => {
    const p = buildPrefix(req, { kind: 'msg', mi: 0, bi: 0, textEnd: 4 })
    const c = p.messages[0] as { content: { text: string }[] }
    assert.strictEqual(c.content.length, 1, 'the later block must not appear yet')
    assert.strictEqual(c.content[0].text, 'AAAA')
  })
})

suite('ctxmap — auditCoverage', () => {
  test('splits content fields from non-tokenizing parameters', () => {
    const c = auditCoverage({ model: 'm', messages: [], system: [], tools: [], thinking: {}, betas: [] })
    assert.deepStrictEqual(c.decomposed.sort(), ['messages', 'system', 'tools'])
    assert.ok(c.parameters.includes('thinking') && c.parameters.includes('betas'))
    assert.deepStrictEqual(c.unknown, [])
  })

  test('an unrecognised field is reported, never silently ignored', () => {
    // The guard against a future content-bearing field being dropped from every report.
    assert.deepStrictEqual(auditCoverage({ model: 'm', messages: [], future_context: {} }).unknown, ['future_context'])
  })
})

suite('ctxmap — renderDiff', () => {
  const mk = (file: string, els: [string, string, number][]): CtxReport => ({
    file, model: 'm', messageCount: 1, toolCount: 0, agent: '', exact: 100, usage: {}, source: 'calibrated',
    pairCandidates: 1, pairAmbiguous: false, mode: 'calibrated', exactElements: 0,
    coverage: { decomposed: ['messages'], parameters: ['model'], unknown: [], residual: 0 },
    total: els.reduce((a, e) => a + e[2], 0),
    elements: els.map(([section, label, tokens]) => ({ section, label, detail: '', chars: tokens * 4, raw: tokens, tokens })),
  })

  test('reports added, removed and changed elements with a net total', () => {
    const out = renderDiff(
      mk('A.json', [['tools', 'tool:Bash', 100], ['tools', 'tool:Skill', 50]]),
      mk('B.json', [['tools', 'tool:Bash', 120], ['tools', 'tool:Agent', 30]]),
    )
    assert.match(out, /net \+0\b/)          // 150 -> 150
    assert.match(out, /tool:Skill/)          // removed
    assert.match(out, /tool:Agent/)          // added
    assert.match(out, /tool:Bash/)           // changed
  })

  test('warns that independent calibration makes unchanged rows drift', () => {
    const out = renderDiff(mk('A.json', [['s', 'l', 10]]), mk('B.json', [['s', 'l', 11]]))
    assert.match(out, /calibrated independently/)
  })

  test('an uncalibrated side is called out so the delta is not quoted as exact', () => {
    const a = mk('A.json', [['s', 'l', 10]])
    const b = { ...mk('B.json', [['s', 'l', 20]]), source: 'estimated' as const }
    assert.match(renderDiff(a, b), /at least one side is uncalibrated/)
  })

  test('identical composition says so instead of printing an empty table', () => {
    const a = mk('A.json', [['s', 'l', 10]])
    assert.match(renderDiff(a, mk('B.json', [['s', 'l', 10]])), /identical composition/)
  })
})
