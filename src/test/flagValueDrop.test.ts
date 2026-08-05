import * as assert from 'assert'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { flagValue } from '../cli/argHelpers'
import { UsageError, EXIT } from '../cli/cliErrors'
import { runCtxmapCli } from '../cli/ctxmapCli'
import { runStatuslineHistoryCli } from '../cli/statuslineHistoryCli'
import { DATA_DIR_ENV } from '../dataDir'

// TRDD-M8SV6LK5 — the SILENT-DROP half of the flag-value defect, which is the dangerous half.
//
// `ctxmap` and `statusline-history` each carried a private lookup that mapped a flag-shaped value to
// undefined, specifically so `--out --json` could not create a file named "--json". Avoiding the junk
// file was right. Doing it by discarding the flag was not: the command then ran as though the flag
// had never been typed, and said everything was fine.
//
// MEASURED on the installed CLI before the fix:
//   statusline-history sessions --session --json  → 14 sessions instead of 1, exit 0, and the JSON
//                                                   reported no session filter at all
//   ctxmap --list --limit --json                  → silently used the default 20
//   both --out --json                             → exit 0, no file written
//
// A missing file is a nuisance. An unfiltered answer presented as a filtered one is a wrong answer,
// and nothing about the output says so.

/** A refusal, however this command surfaces one: a UsageError (mapped to 64 by the shim) or the
 *  code returned directly. Both are exit 64 to the caller. */
async function refuses(run: () => Promise<number>, label: string): Promise<void> {
  let code: number
  try {
    code = await run()
  } catch (e) {
    assert.ok(e instanceof UsageError, `${label}: expected a UsageError, got ${(e as Error).message}`)
    return
  }
  assert.strictEqual(code, EXIT.USAGE, `${label}: expected a refusal, got exit ${code}`)
}

suite('flagValue: an absent flag is legal, a present flag with no value is not', () => {
  test('absent → undefined, so an optional flag still works', () => {
    assert.strictEqual(flagValue(['--json'], '--out'), undefined)
    assert.strictEqual(flagValue([], '--out'), undefined)
  })

  test('present with a real value → that value', () => {
    assert.strictEqual(flagValue(['--out', 'r.json'], '--out'), 'r.json')
    assert.strictEqual(flagValue(['x', '--out', 'r.json', '--json'], '--out'), 'r.json')
  })

  test('present but swallowed by the next flag → refused, never silently dropped', () => {
    assert.throws(() => flagValue(['--out', '--json'], '--out'), UsageError)
  })

  test('present as the last token → refused', () => {
    assert.throws(() => flagValue(['--out'], '--out'), UsageError)
  })

  test('the named expectation reaches the message', () => {
    assert.throws(() => flagValue(['--limit'], '--limit', 'a number'), /--limit expects a number/)
  })

  test('bareOk permits the documented valueless spelling, and only that', () => {
    // `--project` alone means "the directory I am in", so this must NOT be an error.
    assert.strictEqual(flagValue(['--project', '--json'], '--project', 'a directory', true), undefined)
    assert.strictEqual(flagValue(['--project'], '--project', 'a directory', true), undefined)
    // ...but a real value is still honoured.
    assert.strictEqual(flagValue(['--project', '/tmp'], '--project', 'a directory', true), '/tmp')
  })
})

suite('statusline-history: a dropped --session would answer about the wrong sessions', () => {
  // Point at an empty data dir: these must be refused during PARSING, before any store is touched,
  // so the test says nothing about whether a store exists.
  let prev: string | undefined
  let scratch: string
  setup(() => {
    prev = process.env[DATA_DIR_ENV]
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'agentlens-slh-'))
    process.env[DATA_DIR_ENV] = scratch
  })
  teardown(() => {
    if (prev === undefined) delete process.env[DATA_DIR_ENV]
    else process.env[DATA_DIR_ENV] = prev
  })

  test('--session swallowing the next flag is refused, not answered unfiltered', async () => {
    await refuses(() => runStatuslineHistoryCli(['sessions', '--session', '--json']), '--session --json')
  })

  test('--limit, --out, --since and --until are refused the same way', async () => {
    await refuses(() => runStatuslineHistoryCli(['sessions', '--limit', '--json']), '--limit')
    await refuses(() => runStatuslineHistoryCli(['sessions', '--out', '--json']), '--out')
    await refuses(() => runStatuslineHistoryCli(['sessions', '--since', '--json']), '--since')
    await refuses(() => runStatuslineHistoryCli(['sessions', '--until', '--json']), '--until')
  })

  test('bare --project is still correct usage — the guard must not redden on it', async () => {
    // Legal spelling: "this directory, as JSON". It reaches the store and reports BLIND on an empty
    // one, which is the honest answer and explicitly NOT a usage error.
    const err = console.error
    console.error = (): void => { /* the BLIND + scope lines */ }
    try {
      const code = await runStatuslineHistoryCli(['sessions', '--project', '--json'])
      assert.strictEqual(code, EXIT.UNKNOWN, 'an empty store is BLIND, not a bad command line')
    } finally {
      console.error = err
    }
  })
})

suite('ctxmap: a dropped --limit silently answered with the default', () => {
  let prev: string | undefined
  setup(() => {
    prev = process.env[DATA_DIR_ENV]
    process.env[DATA_DIR_ENV] = fs.mkdtempSync(path.join(os.tmpdir(), 'agentlens-ctxmap-'))
  })
  teardown(() => {
    if (prev === undefined) delete process.env[DATA_DIR_ENV]
    else process.env[DATA_DIR_ENV] = prev
  })

  test('--limit / --top / --out swallowing the next flag are all refused', async () => {
    const err = console.error
    console.error = (): void => { /* the refusal lines */ }
    try {
      await refuses(() => runCtxmapCli(['--list', '--limit', '--json']), '--limit')
      await refuses(() => runCtxmapCli(['--list', '--top', '--json']), '--top')
      await refuses(() => runCtxmapCli(['--list', '--out', '--json']), '--out')
    } finally {
      console.error = err
    }
  })

  test('a caller mistake exits 64, never 1 — 1 is the watchers ABORT signal', async () => {
    const err = console.error
    console.error = (): void => { /* the refusal line */ }
    try {
      // ctxmap catches its own throws and returns a code. Before this change that catch had no
      // UsageError branch, so a caller mistake would have returned 1 — which cliErrors reserves for
      // "abort the guarded run" and a watcher wires straight to its kill path.
      assert.strictEqual(await runCtxmapCli(['--list', '--limit', '--json']), EXIT.USAGE)
    } finally {
      console.error = err
    }
  })
})
