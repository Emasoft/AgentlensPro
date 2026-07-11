import * as assert from 'assert'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import {
  isClaudeScratchPath, estimateTokensFromBytes, resolveGeneratedFile, indexScratchTree,
  attachGeneratedFiles, readScratchFile, scratchPathsInToolInput, scratchPathsInToolUseResult,
  type HarvestedGeneratedFile,
} from '../generatedFiles'
import type { SessionSummaryCard } from '../shared/summarizerTypes'

// ── Output-file / subfolder tracking (TRDD-ZS1GDXVY) — pure-module tests ──────
// Covers the matcher, the bytes→tokens estimate, the stat resolver, the bounded scratch-tree
// indexer (cap + truncation flag), the Phase-A/Phase-B attach, and the guarded content reader.

let seq = 0
function makeScratchTree(fileCount: number): { root: string; sessionId: string; slug: string; files: string[]; cleanup: () => void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `al-gf-${process.pid}-${seq++}-`))
  const sessionId = `sess-${process.pid}-${seq++}`
  const slug = 'proj-slug'
  const dir = path.join(root, 'claude-test', slug, sessionId, 'scratchpad')
  fs.mkdirSync(dir, { recursive: true })
  const files: string[] = []
  for (let i = 0; i < fileCount; i++) {
    const f = path.join(dir, `out-${i}.txt`)
    fs.writeFileSync(f, `content ${i} `.repeat(4))
    files.push(f)
  }
  return { root, sessionId, slug, files, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) }
}

function makeCard(sessionId: string, timeline: SessionSummaryCard['timeline'] = []): SessionSummaryCard {
  return {
    sessionId, traceId: sessionId, source: 'claude_code', dataSource: 'log', workspace: '',
    userRequest: '', model: 'claude', turns: 1, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0,
    cacheCreateTokens: 0, cacheHitRate: 0, durationMs: 0, startTime: '', filesRead: [], filesSearched: [],
    filesChanged: [], filesWritten: [], toolCounts: {}, totalToolCalls: 0, totalLlmCalls: 1, errors: 0,
    outcome: 'text_response', timeline, backgroundSpans: [], loopSignals: [],
  }
}

suite('generatedFiles — matcher + token estimate', () => {
  test('isClaudeScratchPath matches temp claude-* trees and rejects normal paths', () => {
    assert.ok(isClaudeScratchPath('/private/tmp/claude-501/-Users-me-proj/abc123/scratchpad/x.md'))
    assert.ok(isClaudeScratchPath('/tmp/claude-501/slug/uuid/tasks/y.output'))
    assert.ok(isClaudeScratchPath('/var/folders/9p/xyz/T/claude-501/slug/uuid/z.txt'))
    assert.strictEqual(isClaudeScratchPath('/Users/me/project/src/index.ts'), false)
    assert.strictEqual(isClaudeScratchPath('/home/me/claude-notes/todo.md'), false) // not under a temp root
    assert.strictEqual(isClaudeScratchPath(undefined), false)
    assert.strictEqual(isClaudeScratchPath(42), false)
  })

  test('estimateTokensFromBytes is bytes/4 rounded up, 0 for non-positive', () => {
    assert.strictEqual(estimateTokensFromBytes(0), 0)
    assert.strictEqual(estimateTokensFromBytes(4), 1)
    assert.strictEqual(estimateTokensFromBytes(5), 2)
    assert.strictEqual(estimateTokensFromBytes(-10), 0)
  })
})

suite('generatedFiles — resolve + read', () => {
  test('resolveGeneratedFile stats a real file; missing referenced → missing:true; missing scratch → null', () => {
    const t = makeScratchTree(1)
    try {
      const ref = resolveGeneratedFile(t.files[0], 'referenced')
      assert.ok(ref)
      assert.ok(ref.sizeBytes > 0)
      assert.strictEqual(ref.origin, 'referenced')
      assert.strictEqual(ref.missing, undefined)
      const gone = path.join(t.root, 'claude-test', t.slug, t.sessionId, 'nope.txt')
      const refMissing = resolveGeneratedFile(gone, 'referenced')
      assert.ok(refMissing && refMissing.missing === true && refMissing.sizeBytes === 0)
      assert.strictEqual(resolveGeneratedFile(gone, 'scratch'), null)
    } finally { t.cleanup() }
  })

  test('readScratchFile refuses a non-scratch path and reads a scratch file', () => {
    const t = makeScratchTree(1)
    try {
      const bad = readScratchFile('/Users/me/secret.txt')
      assert.strictEqual(bad.exists, false)
      assert.ok(bad.error)
      // The fixture path is under a temp claude tree only if os.tmpdir() resolves under one — assert
      // the guard behaviour directly on a known-scratch path shape via a symlink-free temp file.
      const scratchLike = t.files[0]
      if (isClaudeScratchPath(scratchLike)) {
        const ok = readScratchFile(scratchLike)
        assert.strictEqual(ok.exists, true)
        assert.ok((ok.content ?? '').includes('content 0'))
      }
    } finally { t.cleanup() }
  })

  test('readScratchFile caps content at maxBytes and flags truncation', () => {
    // Build a scratch-matching path explicitly under /tmp so the guard passes cross-platform.
    const dir = fs.mkdtempSync('/tmp/claude-gfcap-')
    const f = path.join(dir, 'big.txt')
    try {
      fs.writeFileSync(f, 'x'.repeat(50))
      const r = readScratchFile(f, 10)
      assert.strictEqual(r.exists, true)
      assert.strictEqual(r.truncated, true)
      assert.strictEqual((r.content ?? '').length, 10)
    } finally { fs.rmSync(dir, { recursive: true, force: true }) }
  })

  test('readScratchFile refuses a .. traversal that escapes the scratch tree (path-traversal containment)', () => {
    // A path that CONTAINS a /tmp/claude-*/ segment but climbs back out with `..` matches the naming
    // regex yet resolves OUTSIDE the tree. Without realpath containment this leaked arbitrary local
    // files (ssh keys, .env, settings.json) — cross-origin, via /api/generated-file + ACAO:*.
    const dir = fs.mkdtempSync('/tmp/claude-trav-')
    try {
      // Build the string by hand (path.join would normalize the `..` away): it must stay a literal
      // traversal so it still matches the scratch regex but realpath-resolves to /etc/hosts.
      const traversal = `${dir}/../../../../../../../../etc/hosts`
      assert.strictEqual(isClaudeScratchPath(traversal), true, 'raw string still matches the scratch regex')
      const r = readScratchFile(traversal)
      assert.strictEqual(r.exists, false, 'realpath containment must refuse the escaped path')
      assert.strictEqual(r.content, undefined, 'no outside-tree content is returned')
    } finally { fs.rmSync(dir, { recursive: true, force: true }) }
  })
})

suite('generatedFiles — bounded scratch-tree index', () => {
  test('indexScratchTree finds the session dir files (path/size/mtime only)', () => {
    const t = makeScratchTree(3)
    try {
      const { files, truncated } = indexScratchTree(t.sessionId, { tmpRoots: [t.root] })
      assert.strictEqual(files.length, 3)
      assert.strictEqual(truncated, false)
      assert.ok(files.every(f => f.origin === 'scratch' && f.sizeBytes > 0))
    } finally { t.cleanup() }
  })

  test('indexScratchTree caps at maxFiles and reports truncated (no silent cut)', () => {
    const t = makeScratchTree(5)
    try {
      const { files, truncated } = indexScratchTree(t.sessionId, { tmpRoots: [t.root], maxFiles: 2 })
      assert.strictEqual(files.length, 2)
      assert.strictEqual(truncated, true)
    } finally { t.cleanup() }
  })

  test('indexScratchTree returns empty for an unknown session', () => {
    const { files, truncated } = indexScratchTree('no-such-session', { tmpRoots: [os.tmpdir()] })
    assert.strictEqual(files.length, 0)
    assert.strictEqual(truncated, false)
  })
})

suite('generatedFiles — attach (Phase A correlated + Phase B group)', () => {
  test('correlated referenced leaf attaches to its tool entry; scratch discoveries + uncorrelated land in the group', () => {
    const t = makeScratchTree(2)   // out-0.txt, out-1.txt
    try {
      const card = makeCard(t.sessionId, [
        { type: 'tool', spanId: 'sp-1', label: 'Write', durationMs: 0, isError: false, timestamp: '' },
      ])
      const gonePath = path.join(t.root, 'claude-test', t.slug, t.sessionId, 'tasks', 'gone.output')
      const harvested = new Map<string, HarvestedGeneratedFile>([
        [t.files[0], { spanId: 'sp-1' }],  // correlated referenced → attaches to sp-1
        [gonePath, {}],                    // uncorrelated + missing → group, missing:true
      ])
      attachGeneratedFiles(card, harvested, { tmpRoots: [t.root] })

      // Phase A: the correlated referenced file rides on the tool entry.
      assert.ok(card.timeline[0].generatedFiles)
      assert.strictEqual(card.timeline[0].generatedFiles!.length, 1)
      assert.strictEqual(card.timeline[0].generatedFiles![0].path, t.files[0])
      assert.strictEqual(card.timeline[0].generatedFiles![0].origin, 'referenced')

      // Phase B group: out-1.txt (scratch, not the correlated one) + the uncorrelated missing ref.
      const group = card.generatedFiles ?? []
      const paths = group.map(g => g.path)
      assert.ok(paths.includes(t.files[1]), 'scratch discovery out-1.txt in group')
      assert.ok(!paths.includes(t.files[0]), 'correlated file NOT duplicated into group')
      const gone = group.find(g => g.path === gonePath)
      assert.ok(gone && gone.missing === true)
    } finally { t.cleanup() }
  })
})

suite('generatedFiles — tool-input / toolUseResult extraction', () => {
  test('scratchPathsInToolInput picks up path-bearing keys and bare scratch strings', () => {
    const scratch = '/tmp/claude-501/slug/uuid/scratchpad/o.md'
    assert.deepStrictEqual(scratchPathsInToolInput({ file_path: scratch }), [scratch])
    assert.deepStrictEqual(scratchPathsInToolInput({ command: `echo hi > ${scratch}` }), []) // not a bare path value
    assert.deepStrictEqual(scratchPathsInToolInput({ path: scratch, other: 1 }), [scratch])
    assert.deepStrictEqual(scratchPathsInToolInput({ file_path: '/Users/me/x.ts' }), [])
    assert.deepStrictEqual(scratchPathsInToolInput(undefined), [])
  })

  test('scratchPathsInToolUseResult reads output-file keys only', () => {
    const scratch = '/private/tmp/claude-9/slug/uuid/tasks/t.output'
    assert.deepStrictEqual(scratchPathsInToolUseResult({ 'output-file': scratch }), [scratch])
    assert.deepStrictEqual(scratchPathsInToolUseResult({ filePath: scratch }), [scratch])
    assert.deepStrictEqual(scratchPathsInToolUseResult({ note: scratch }), []) // not an output-file key
    assert.deepStrictEqual(scratchPathsInToolUseResult(undefined), [])
  })
})
