import * as assert from 'assert'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { runCtxvisCli } from '../cli/ctxvisCli'
import { EXIT, UsageError } from '../cli/cliErrors'
import { DATA_DIR_ENV } from '../dataDir'

// TRDD-M8SV6LK5 — ctxvis promises, in its own usage text: "Every number that says 'measured' came
// from count_tokens; nothing is estimated." Three ways it did not keep that.
//
// The flag-drop here is a MISS from this audit's own earlier sweep: the grep that fixed the identical
// helper in ctxmapCli and statuslineHistoryCli listed ctxvisCli:259 in its output, and only two of
// the three files were acted on. Worth a test precisely because the sweep is what failed, not the
// reasoning about the defect.

function scratchDataDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'agentlens-ctxvis-'))
  fs.mkdirSync(path.join(d, 'otel-bodies'), { recursive: true })
  return d
}

suite('ctxvis: a flag with no value must not be silently dropped', () => {
  let prev: string | undefined
  setup(() => { prev = process.env[DATA_DIR_ENV]; process.env[DATA_DIR_ENV] = scratchDataDir() })
  teardown(() => {
    if (prev === undefined) delete process.env[DATA_DIR_ENV]; else process.env[DATA_DIR_ENV] = prev
  })

  /** A refusal, however this command surfaces one. The flag reads sit before the try/catch, so they
   *  THROW a UsageError while the paths inside it RETURN EXIT.USAGE — both reach the caller as exit
   *  64, because standalone/cli.ts maps UsageError to it. Asserting either keeps this test about the
   *  defect (a silently dropped flag) rather than about which side of a try block a line is on. */
  const refuses = async (argv: string[], label: string): Promise<void> => {
    const err = console.error
    console.error = (): void => { /* the refusal line */ }
    try {
      const code = await runCtxvisCli(argv)
      assert.strictEqual(code, EXIT.USAGE, `${label}: expected a refusal, got exit ${code}`)
    } catch (e) {
      assert.ok(e instanceof UsageError, `${label}: expected a UsageError, got ${(e as Error).message}`)
    } finally { console.error = err }
  }

  test('--subject swallowing the next flag is refused', async () => {
    // Before: subject became undefined, so NO agent was marked as the subject and the environment
    // fingerprint that validates every cached baseline was taken from an arbitrary one instead.
    await refuses(['--subject', '--json', '--measured', 'a=abcd1234abcd'], '--subject')
  })

  test('--html, --out, --baselines and --turns are refused the same way', async () => {
    await refuses(['--html', '--json', '--measured', 'a=abcd1234abcd'], '--html')
    await refuses(['--out', '--json', '--measured', 'a=abcd1234abcd'], '--out')
    // --baselines is the worst of them: dropping it wrote the persisted baseline store to the
    // DEFAULT path while the caller believed they had redirected it.
    await refuses(['--baselines', '--json', '--measured', 'a=abcd1234abcd'], '--baselines')
    await refuses(['--turns', '--json', '--measured', 'a=abcd1234abcd'], '--turns')
  })

  test('a malformed --measured is still a caller mistake (64), not a runtime failure', async () => {
    await refuses(['--measured', 'no-equals-sign'], '--measured without =')
    await refuses(['--measured', '--json'], '--measured swallowing a flag')
  })

  test('correct usage is NOT refused — the guard must not redden on a valid command line', async () => {
    // A well-formed invocation gets past parsing and fails later for a real reason (no captures /
    // no credential), which must NOT be reported as a bad command line.
    const err = console.error
    console.error = (): void => { /* the diagnostic */ }
    try {
      const code = await runCtxvisCli(['--measured', 'Explore=abcd1234abcd', '--subject', 'Explore'])
      assert.notStrictEqual(code, EXIT.USAGE,
        'a well-formed command line that fails for a REAL reason must not report exit 64')
    } finally { console.error = err }
  })
})

suite('ctxvis: --reuse-last and --estimate keep their own exit contracts', () => {
  let prev: string | undefined
  setup(() => { prev = process.env[DATA_DIR_ENV]; process.env[DATA_DIR_ENV] = scratchDataDir() })
  teardown(() => {
    if (prev === undefined) delete process.env[DATA_DIR_ENV]; else process.env[DATA_DIR_ENV] = prev
  })

  test('--reuse-last with nothing to reuse is a usage error, and says where it looked', async () => {
    const err = console.error
    let said = ''
    console.error = (...a: unknown[]): void => { said += a.join(' ') }
    try {
      assert.strictEqual(await runCtxvisCli(['--reuse-last']), EXIT.USAGE)
    } finally { console.error = err }
    assert.ok(/no previous run to reuse/.test(said), said)
  })

  test('a CORRUPT previous run is a runtime failure, not a bad command line', async () => {
    // The distinction this fixes: every throw used to return 64, so a corrupt file on disk told a
    // harness its own invocation was wrong and sent it looking for a bug it did not have.
    const dir = process.env[DATA_DIR_ENV] as string
    fs.writeFileSync(path.join(dir, 'ctxvis-last.json'), '{ this is not json')
    const err = console.error
    console.error = (): void => { /* the parse error */ }
    try {
      const code = await runCtxvisCli(['--reuse-last'])
      assert.notStrictEqual(code, EXIT.USAGE, 'a corrupt store on disk is not a caller mistake')
      assert.strictEqual(code, EXIT.ABORT)
    } finally { console.error = err }
  })
})
