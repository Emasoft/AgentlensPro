import * as assert from 'assert'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { runEnvCli } from '../cli/envCli'
import { strArg } from '../cli/argHelpers'
import { UsageError } from '../cli/cliErrors'

// TRDD-M8SV6LK5 — `env --out` was the third surface taking the next token as a value unchecked.
//
// It failed in BOTH directions and neither raised anything: `--out` as the last token silently
// dropped the request and printed to stdout with exit 0, and `--out --json` wrote a file literally
// named "--json" while swallowing the --json that was asked for. Measured on the installed command
// before the fix.
//
// The fix routes it through argHelpers.strArg, which already implemented this check for `watch` and
// `budget` — so these tests also pin that the shared validator did not lose its old behaviour while
// gaining the `what` parameter.

suite('env --out: a request that cannot be fulfilled must not report success', () => {
  // A test for a guard runs, by definition, in the state where the guard is absent — that is what a
  // falsification pass IS, and what a regression creates. In that state these cases WRITE the junk
  // file, and the cwd would be the repo root. So the suite runs from a throwaway directory: a
  // regression then leaves its droppings somewhere harmless instead of in the working tree. (The
  // sibling diagnostics suite learned this the expensive way — the unguarded `--export-bodies --json`
  // wrote 345 MB of raw request bodies into the repo root before anyone noticed.)
  let prevCwd: string
  let scratch: string
  setup(() => {
    prevCwd = process.cwd()
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'agentlens-envcli-cwd-'))
    process.chdir(scratch)
  })
  teardown(() => { process.chdir(prevCwd) })

  const rejects = async (argv: string[]): Promise<void> => {
    await assert.rejects(runEnvCli(argv), (e: Error) => e instanceof UsageError,
      `expected a UsageError for ${JSON.stringify(argv)}`)
  }

  test('--out as the last token is refused, not silently ignored', async () => {
    // Before: exit 0, the report on stdout, no file — the caller asked for a file and was told
    // everything went fine.
    await rejects(['user', '--out'])
  })

  test('--out swallowing the next flag is refused', async () => {
    // Before: exit 0 and a file named "--json" in the cwd, with --json never applied.
    await rejects(['user', '--out', '--json'])
  })

  test('--out= with an empty value is refused too — same silent drop, different spelling', async () => {
    await rejects(['user', '--out='])
  })

  test('a real path still works — the guard must not redden on correct usage', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentlens-envcli-'))
    const target = path.join(dir, 'env.json')
    const log = console.log
    console.log = (): void => { /* the digest line */ }
    try {
      const code = await runEnvCli(['user', '--out', target])
      assert.strictEqual(code, 0)
    } finally {
      console.log = log
    }
    assert.ok(fs.existsSync(target), 'the file the caller asked for must exist')
    assert.ok(Object.keys(JSON.parse(fs.readFileSync(target, 'utf8'))).length > 0, 'and hold the facet')
  })

  test('--out=PATH still works', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentlens-envcli-'))
    const target = path.join(dir, 'eq.json')
    const log = console.log
    console.log = (): void => { /* the digest line */ }
    try {
      assert.strictEqual(await runEnvCli(['user', `--out=${target}`]), 0)
    } finally {
      console.log = log
    }
    assert.ok(fs.existsSync(target))
  })
})

suite('strArg: the shared validator kept its contract while gaining a named expectation', () => {
  test('still rejects a missing, empty, or flag-shaped value', () => {
    assert.throws(() => strArg(undefined, '--x'), UsageError)
    assert.throws(() => strArg('', '--x'), UsageError)
    assert.throws(() => strArg('--y', '--x'), UsageError)
  })

  test('the default message is unchanged — watchCli asserts on that exact text', () => {
    assert.throws(() => strArg(undefined, '--metric'), /--metric expects a value/)
  })

  test('a named expectation replaces only the generic noun', () => {
    assert.throws(() => strArg(undefined, '--out', 'a path'), /--out expects a path/)
  })

  test('a normal value passes through untouched, including a single dash', () => {
    assert.strictEqual(strArg('report.json', '--out'), 'report.json')
    // A single `-` is a real convention for stdout/stdin and is NOT flag-shaped; only `--` is.
    assert.strictEqual(strArg('-', '--out'), '-')
  })
})
