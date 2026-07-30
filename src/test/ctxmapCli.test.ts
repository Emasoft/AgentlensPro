// Unit tests for `agentlenspro ctxmap` — the pure decomposition/classification half. The io half
// (spool discovery, response pairing) is exercised by the CLI itself against captured bodies; what
// matters here is that the splitter never loses bytes and the classifier names what it sees, since
// a decomposer that silently drops content misreports the very total it exists to explain.

import * as assert from 'assert'
import { extractElements, splitInjected, renderDiff } from '../cli/ctxmapCli'
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

suite('ctxmap — renderDiff', () => {
  const mk = (file: string, els: [string, string, number][]): CtxReport => ({
    file, model: 'm', messageCount: 1, toolCount: 0, agent: '', exact: 100, usage: {}, source: 'calibrated',
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
