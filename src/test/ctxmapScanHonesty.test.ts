import * as assert from 'assert'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { runCtxmapCli } from '../cli/ctxmapCli'
import { EXIT } from '../cli/cliErrors'
import { RAW_BODIES_ENV } from '../captureConfig'
import { DATA_DIR_ENV } from '../dataDir'

// TRDD-M8SV6LK5 — `ctxmap`'s two scanning verbs must not answer a question they failed to answer.
//
// All three cases here are the same failure wearing different clothes: the tool reports an ANSWER
// ("(no match)", an empty list, exit 64) for a question it did not actually resolve. That is the one
// class of wrongness this tool cannot afford, because the whole point of ctxmap is to settle "is X in
// my context" — a false negative reads identically to a true one, and the reader stops looking.

interface Fixture { data: string; bodies: string; env: NodeJS.ProcessEnv }

/** A data dir with an `otel-bodies` dir. The removed RAM-disk spool's second-dir shape is gone
 *  (TRDD-Z53IJFE9), so a scan fixture needs exactly one capture dir. */
function fixture(opts: { capture?: boolean } = {}): Fixture {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'ctxmap-scan-'))
  const bodies = path.join(data, 'otel-bodies')
  fs.mkdirSync(bodies, { recursive: true })
  const env: NodeJS.ProcessEnv = { ...process.env }
  env[DATA_DIR_ENV] = data
  if (opts.capture !== undefined) env[RAW_BODIES_ENV] = opts.capture ? '1' : '0'
  return { data, bodies, env }
}

function writeCapture(dir: string, name: string, content: string): string {
  const p = path.join(dir, name)
  fs.writeFileSync(p, JSON.stringify({ model: 'claude-test', messages: [{ role: 'user', content }] }))
  return p
}

/** Run the CLI against a fixture's env, capturing what it told the caller on each stream. */
async function run(f: Fixture, argv: string[]): Promise<{ code: number; out: string; err: string }> {
  const prevEnv = process.env
  const log = console.log, error = console.error
  let out = '', err = ''
  console.log = (...a: unknown[]): void => { out += `${a.join(' ')}\n` }
  console.error = (...a: unknown[]): void => { err += `${a.join(' ')}\n` }
  process.env = f.env
  try {
    return { code: await runCtxmapCli(argv), out, err }
  } finally {
    process.env = prevEnv
    console.log = log
    console.error = error
  }
}

suite('ctxmap --find: the deciding stage must try BOTH spellings, like the prefilter', () => {
  test('a needle carrying a quote is FOUND, not silently dropped', async () => {
    const f = fixture()
    writeCapture(f.bodies, 'quoted.request.json', 'he said "hi" loudly and left')

    // On disk this text is JSON-escaped (`said \"hi\"`), so the raw prefilter matches it only via the
    // escaped spelling — and re-serialising the parsed body escapes it again. A literal-only test at
    // the deciding stage therefore matched nothing and the file was dropped after passing stage one.
    const needle = 'said "hi" loudly'
    const { code, out } = await run(f, ['--find', needle])

    assert.strictEqual(code, 0)
    assert.ok(out.includes('quoted.request.json'), `expected the capture to be listed, got: ${out.trim()}`)
    assert.ok(out.includes('in=messages'), `expected the location to be named, got: ${out.trim()}`)
    assert.ok(!out.includes('(no match)'), 'a false negative here reads exactly like "not in your context"')
  })

  test('a needle carrying a backslash is FOUND too — same escaping, different character', async () => {
    const f = fixture()
    writeCapture(f.bodies, 'backslash.request.json', 'path C:\\Users\\agent\\notes.md')
    const { code, out } = await run(f, ['--find', 'C:\\Users\\agent'])
    assert.strictEqual(code, 0)
    assert.ok(out.includes('backslash.request.json'), `expected a hit, got: ${out.trim()}`)
  })

  test('a needle that is genuinely absent still reports no match', async () => {
    const f = fixture()
    writeCapture(f.bodies, 'plain.request.json', 'nothing interesting here')
    const { code, out } = await run(f, ['--find', 'definitely-not-present-xyzzy'])
    assert.strictEqual(code, 0)
    assert.ok(out.includes('(no match)'), 'the fix must not turn every needle into a hit')
  })
})

suite('ctxmap --list: one unreadable dir must not blind the scan', () => {
  test('a body dir that denies listing is skipped, never crashes the command', async function () {
    // chmod cannot deny root, so the premise would not hold and the test would pass vacuously.
    // No `return` after skip(): mocha's skip() throws, and tsc types it `never`.
    if (typeof process.getuid === 'function' && process.getuid() === 0) this.skip()

    // The RAM-disk spool is removed (TRDD-Z53IJFE9), so the read scope has exactly ONE dir —
    // <dataDir>/otel-bodies — which makes this simpler than the two-dir shape it replaces: the
    // bodies dir itself stats as a directory (so the read scope keeps it) but cannot be listed.
    // The scan must skip it via safeReaddir, not throw EACCES out of the command.
    const f = fixture()
    writeCapture(f.bodies, 'hidden.request.json', 'exists but cannot be listed')
    fs.chmodSync(f.bodies, 0o000)
    try {
      const denied = ((): boolean => { try { fs.readdirSync(f.bodies); return false } catch { return true } })()
      if (!denied) this.skip()

      const { code, err } = await run(f, ['--list'])
      assert.notStrictEqual(code, EXIT.USAGE, 'a denied dir is not a bad command line')
      assert.ok(!err.includes('EACCES'), 'the unreadable dir must be skipped, not thrown out of the command')
    } finally {
      fs.chmodSync(f.bodies, 0o700)
    }
  })
})

suite('ctxmap --list: an empty feed is a healthy machine, not a bad command line', () => {
  test('nothing captured yet exits UNKNOWN, never USAGE', async () => {
    const f = fixture({ capture: false })
    const { code, out, err } = await run(f, ['--list'])

    assert.notStrictEqual(code, EXIT.USAGE,
      'EX_USAGE is documented as never coming from a healthy invocation — 64 sends a harness hunting for its own bug')
    assert.strictEqual(code, EXIT.UNKNOWN, 'the enum\'s own meaning: no value in the feed')
    assert.strictEqual(out, '', 'nothing may be printed to stdout that a caller could parse as a listing')
    assert.ok(/raw-body capture is OFF/.test(err),
      `the reason must be actionable, not just the dirs looked in — got: ${err.trim()}`)
  })
})
