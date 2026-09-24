import * as assert from 'assert'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { buildContextComposition } from '../contextComposition'

// TRDD-ZQQYRYBO I9b — hand-written coverage for the dedup/boundary/rule-mapping revision that does
// NOT depend on regenerating the cross-engine parity fixtures. Each test writes a synthetic .jsonl
// into a tmp CLAUDE_CONFIG_DIR and drives the real streaming builder — no mocks.

let seq = 0
function writeSession(lines: Array<Record<string, unknown>>): { sessionId: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `al-comp-dedup-${process.pid}-${seq++}-`))
  const projects = path.join(dir, 'projects', 'proj-a')
  fs.mkdirSync(projects, { recursive: true })
  const sessionId = `dedup-sess-${seq}`
  fs.writeFileSync(path.join(projects, `${sessionId}.jsonl`), lines.map(l => JSON.stringify(l)).join('\n') + '\n')
  const prevConfigDir = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = dir
  return {
    sessionId,
    cleanup: () => {
      if (prevConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
      else process.env.CLAUDE_CONFIG_DIR = prevConfigDir
      fs.rmSync(dir, { recursive: true, force: true })
    },
  }
}

const asst = (id?: string) => (id === undefined ? { type: 'assistant', message: {} } : { type: 'assistant', message: { id } })
const instructionsAtt = (path_: string, content: string) => ({
  type: 'attachment',
  attachment: { type: 'instructions', files: [{ path: path_, type: 'Project', content }] },
})
const promptSnapshotAtt = (text: string) => ({
  type: 'attachment',
  attachment: { type: 'prompt_snapshot', systemPrompt: [text], reminderFold: false },
})

suite('contextComposition — I9b dedup, compaction boundary, rule mapping', () => {
  test('one "system prompt" row per segment when the content is not repeated', async () => {
    const { sessionId, cleanup } = writeSession([
      promptSnapshotAtt('You are a helper.'),
      asst(undefined),
    ])
    try {
      const comp = await buildContextComposition(sessionId)
      assert.ok(comp)
      const sources = comp!.turns.flatMap(t => t.sources)
      const systemPromptRows = sources.filter(s => s.label === 'system prompt')
      assert.strictEqual(systemPromptRows.length, 1, 'exactly one "system prompt" row')
      assert.strictEqual(systemPromptRows[0].count, 1)
    } finally {
      cleanup()
    }
  })

  test('after a compact_boundary WITHOUT isCompactSummary, the re-injected instructions row is counted again', async () => {
    const { sessionId, cleanup } = writeSession([
      instructionsAtt('/proj/CLAUDE.md', 'project instructions'),
      instructionsAtt('/proj/CLAUDE.md', 'project instructions'), // byte-identical repeat — deduped
      { type: 'system', subtype: 'compact_boundary', compactMetadata: { trigger: 'auto', preTokens: 100000, postTokens: 20000 } },
      instructionsAtt('/proj/CLAUDE.md', 'project instructions'), // past the boundary — counted again
      asst(undefined),
    ])
    try {
      const comp = await buildContextComposition(sessionId)
      assert.ok(comp)
      const sources = comp!.turns.flatMap(t => t.sources)
      const rows = sources.filter(s => s.label === 'instructions: /proj/CLAUDE.md')
      // Two DISTINCT occurrences survived (pre-boundary dedup collapsed to 1, post-boundary is a
      // fresh 1) — asserted via the combined count across every surviving row for this label.
      const totalCount = rows.reduce((n, r) => n + r.count, 0)
      assert.strictEqual(totalCount, 2, `pre-boundary dedup (1) + post-boundary fresh occurrence (1): ${JSON.stringify(rows)}`)
    } finally {
      cleanup()
    }
  })

  test('A, B, A on the same label counts A once and B once (a SET, not a last-value-only map)', async () => {
    const { sessionId, cleanup } = writeSession([
      promptSnapshotAtt('content A'),
      promptSnapshotAtt('content B'),
      promptSnapshotAtt('content A'), // repeat of the FIRST value, not the most recent — must be skipped
      asst(undefined),
    ])
    try {
      const comp = await buildContextComposition(sessionId)
      assert.ok(comp)
      const sources = comp!.turns.flatMap(t => t.sources)
      const rows = sources.filter(s => s.label === 'system prompt')
      assert.strictEqual(rows.length, 1, 'one row for the shared label')
      assert.strictEqual(rows[0].count, 2, 'A counted once, B counted once, the trailing A skipped')
    } finally {
      cleanup()
    }
  })

  test('a src/rules/CLAUDE.md path (plain rules dir, not under .claude/) maps to claudemd', async () => {
    const { sessionId, cleanup } = writeSession([
      instructionsAtt('/proj/src/rules/CLAUDE.md', 'not a project rule'),
      asst(undefined),
    ])
    try {
      const comp = await buildContextComposition(sessionId)
      assert.ok(comp)
      const sources = comp!.turns.flatMap(t => t.sources)
      const row = sources.find(s => s.label === 'instructions: /proj/src/rules/CLAUDE.md')
      assert.ok(row)
      // The raw classify kind stays 'instructions' — the rule/claudemd split happens only inside
      // contextHistory.ts's attachmentKind, exercised by the sibling assertion below.
      assert.strictEqual(row!.kind, 'instructions')
    } finally {
      cleanup()
    }
  })

  test('a .claude/rules/x.md path maps to rule via contextHistory.attachmentKind', async () => {
    // contextHistory.ts's attachmentKind is not exported (module-private, mapped only through
    // buildContextHistory's block taxonomy) — exercise it end to end instead of importing it
    // directly, mirroring how the Rust twin's own unit test proves the same mapping.
    const { buildContextHistory } = await import('../contextHistory.js')
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `al-hist-dedup-${process.pid}-${seq++}-`))
    const projects = path.join(dir, 'projects', 'proj-a')
    fs.mkdirSync(projects, { recursive: true })
    const sessionId = `dedup-hist-${seq}`
    const lines = [
      instructionsAtt('/home/x/.claude/rules/r.md', 'a user rule'),
      instructionsAtt('/proj/src/rules/CLAUDE.md', 'not a project rule'),
      asst(undefined),
    ]
    fs.writeFileSync(path.join(projects, `${sessionId}.jsonl`), lines.map(l => JSON.stringify(l)).join('\n') + '\n')
    const prevConfigDir = process.env.CLAUDE_CONFIG_DIR
    process.env.CLAUDE_CONFIG_DIR = dir
    try {
      const h = await buildContextHistory(sessionId)
      assert.ok(h)
      const blocks = (h!.steps as Array<{ blocks: Array<{ id: string; kind: string }> }>).flatMap(s => s.blocks)
      const ruleBlock = blocks.find(b => b.id.endsWith('/home/x/.claude/rules/r.md'))
      const claudemdBlock = blocks.find(b => b.id.endsWith('/proj/src/rules/CLAUDE.md'))
      assert.ok(ruleBlock, `no block for the .claude/rules/ path: ${JSON.stringify(blocks)}`)
      assert.ok(claudemdBlock, `no block for the plain rules/ path: ${JSON.stringify(blocks)}`)
      assert.strictEqual(ruleBlock!.kind, 'rule')
      assert.strictEqual(claudemdBlock!.kind, 'claudemd')
    } finally {
      if (prevConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
      else process.env.CLAUDE_CONFIG_DIR = prevConfigDir
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  // Review finding (TRDD-ZQQYRYBO I9b revision): a file with NO `path` falls back to the label
  // "instructions: instructions" — the fallback string literally reuses the word "instructions".
  // Must still map to claudemd, not accidentally match `rule` (there is no `.claude`/`rules`
  // segment pair in "instructions", but this was previously unexercised by any test).
  test('a path-less instructions file (label "instructions: instructions") maps to claudemd, not rule', async () => {
    const { buildContextHistory } = await import('../contextHistory.js')
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `al-hist-dedup-${process.pid}-${seq++}-`))
    const projects = path.join(dir, 'projects', 'proj-a')
    fs.mkdirSync(projects, { recursive: true })
    const sessionId = `dedup-hist-${seq}`
    const lines = [
      { type: 'attachment', attachment: { type: 'instructions', files: [{ type: 'AutoMem', content: 'no path here' }] } },
      asst(undefined),
    ]
    fs.writeFileSync(path.join(projects, `${sessionId}.jsonl`), lines.map(l => JSON.stringify(l)).join('\n') + '\n')
    const prevConfigDir = process.env.CLAUDE_CONFIG_DIR
    process.env.CLAUDE_CONFIG_DIR = dir
    try {
      const h = await buildContextHistory(sessionId)
      assert.ok(h)
      const blocks = (h!.steps as Array<{ blocks: Array<{ id: string; kind: string; label: string }> }>).flatMap(s => s.blocks)
      const block = blocks.find(b => b.label === 'instructions: instructions')
      assert.ok(block, `no path-less instructions block found: ${JSON.stringify(blocks)}`)
      assert.strictEqual(block!.kind, 'claudemd')
    } finally {
      if (prevConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
      else process.env.CLAUDE_CONFIG_DIR = prevConfigDir
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
