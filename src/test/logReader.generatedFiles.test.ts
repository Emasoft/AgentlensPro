import * as assert from 'assert'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { LogReader, type LogSessionResult } from '../logReader'
import { isClaudeScratchPath } from '../generatedFiles'

// ── Output-file / subfolder tracking (TRDD-ZS1GDXVY) — harvest end-to-end ─────
// Proves that a Claude session whose transcript references a scratch output file surfaces that file
// as an expandable leaf ON the producing tool call (Phase A, correlated by tool_use id), with real
// size resolved from disk. Uses the same env-isolated fixture pattern as logReader.large.test.ts.

type ClaudeScanner = { _scanClaude(): LogSessionResult[] }
const scanClaude = (r: LogReader): LogSessionResult[] => (r as unknown as ClaudeScanner)._scanClaude()

let seq = 0
suite('logReader — output-file harvest (TRDD-ZS1GDXVY)', () => {
  test('a tool_use writing a scratch file surfaces it as a leaf on that tool step', () => {
    // 1. Isolated Claude config dir → _scanClaude only sees our fixture jsonl.
    const cfgRoot = fs.mkdtempSync(path.join(os.tmpdir(), `al-gfh-cfg-${process.pid}-`))
    const projDir = path.join(cfgRoot, 'projects', 'proj')
    fs.mkdirSync(projDir, { recursive: true })
    const sessionId = `gfh-${process.pid}-${seq++}`
    const jsonlPath = path.join(projDir, `${sessionId}.jsonl`)

    // 2. A real scratch tree under a temp claude-* dir; the file path must match the scratch matcher
    //    (logReader harvests via the real regex). os.tmpdir() gives a realpath-stable root.
    const scratchDir = path.join(os.tmpdir(), `claude-gfh-${process.pid}`, 'proj', sessionId, 'scratchpad')
    fs.mkdirSync(scratchDir, { recursive: true })
    const outFile = path.join(scratchDir, 'report.md')
    fs.writeFileSync(outFile, '# generated report\n' + 'x'.repeat(200))

    const cleanup = () => {
      const orig = savedEnv
      if (orig === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = orig
      fs.rmSync(cfgRoot, { recursive: true, force: true })
      fs.rmSync(path.join(os.tmpdir(), `claude-gfh-${process.pid}`), { recursive: true, force: true })
    }
    const savedEnv = process.env.CLAUDE_CONFIG_DIR
    process.env.CLAUDE_CONFIG_DIR = cfgRoot

    try {
      // Guard: the fixture path must be recognised as scratch, else the harvest can't fire.
      assert.ok(isClaudeScratchPath(outFile), 'fixture scratch path should match isClaudeScratchPath')

      const cwd = path.join(cfgRoot, 'workspace')
      fs.writeFileSync(jsonlPath,
        JSON.stringify({ type: 'user', timestamp: '2026-07-07T10:00:00.000Z', cwd, message: { content: 'write a report' } }) + '\n' +
        JSON.stringify({
          type: 'assistant', timestamp: '2026-07-07T10:00:01.000Z', cwd,
          message: {
            model: 'claude-opus-4-8',
            usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
            content: [{ type: 'tool_use', id: 'tu-1', name: 'Write', input: { file_path: outFile, content: 'stuff' } }],
          },
        }) + '\n',
      )

      const results = scanClaude(new LogReader())
      const found = results.find(r => r.card.sessionId === sessionId)
      assert.ok(found, 'session card parsed')

      const toolStep = found!.card.timeline.find(e => e.type === 'tool')
      assert.ok(toolStep, 'a tool timeline entry exists')
      assert.ok(toolStep!.generatedFiles && toolStep!.generatedFiles.length >= 1, 'tool step carries a generated-file leaf')
      const leaf = toolStep!.generatedFiles!.find(g => g.path === outFile)
      assert.ok(leaf, 'the referenced scratch file is attached to the producing tool step')
      assert.strictEqual(leaf!.origin, 'referenced')
      assert.ok(leaf!.sizeBytes > 200, 'size resolved from disk')
      assert.ok(leaf!.tokenEstimate > 0, 'token estimate populated')
    } finally { cleanup() }
  })
})
