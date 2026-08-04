import * as assert from 'assert'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { guardStep, newGuardState, writeOut, runDiagnosticsCli, type BurnRiskReport } from '../cli/diagnosticsCli'
import { UsageError } from '../cli/cliErrors'

// TRDD-M8SV6LK5 — three ways `agentlenspro` did something other than what it reported.
//
// Same family as the ctxmap findings: the command returns success while having misread the request
// or thrown the answer away. None of these are crashes, which is why none were noticed.

const risk = (code: string, active: boolean): { code: string; detail: string; active: boolean } =>
  ({ code, detail: `${code} detail`, active })

suite('burn guard: advice rides the first line of EVERY episode, not just the first ever', () => {
  test('a second episode gets its advice line', () => {
    const st = newGuardState()
    const advice = 'kill the fan-out'

    // Episode 1 — the risk fires, advice rides with it.
    const one = guardStep(st, { risks: [risk('FORK_STORM', true)], advice })
    assert.ok(one.some(l => l.includes('FORK_STORM: ')), `expected the risk line, got ${JSON.stringify(one)}`)
    assert.ok(one.some(l => l.includes('advice: kill the fan-out')), 'first episode must carry the advice')

    // Still inside episode 1 — advice must NOT repeat every poll.
    const two = guardStep(st, { risks: [risk('FORK_STORM', true)], advice })
    assert.deepStrictEqual(two, [], 'a quiet poll inside an episode prints nothing at all')

    // Episode 1 ends.
    const three = guardStep(st, { risks: [risk('FORK_STORM', false)], advice })
    assert.deepStrictEqual(three, ['[burn-guard] FORK_STORM cleared'])

    // Episode 2 — THE REGRESSION. The old code kept an `__advised` sentinel inside the same set it
    // used to answer "is an episode running", so that question was never false again and the flag was
    // never cleared: every later episode ran silently for the life of the process.
    const four = guardStep(st, { risks: [risk('FORK_STORM', true)], advice })
    assert.ok(four.some(l => l.includes('advice: kill the fan-out')),
      `the second episode must carry advice too, got ${JSON.stringify(four)}`)
  })

  test('a DIFFERENT risk opening the second episode also gets advice', () => {
    const st = newGuardState()
    guardStep(st, { risks: [risk('A', true)], advice: 'first' })
    guardStep(st, { risks: [risk('A', false)], advice: 'first' })
    const lines = guardStep(st, { risks: [risk('B', true)], advice: 'second' })
    assert.ok(lines.some(l => l.includes('advice: second')), `got ${JSON.stringify(lines)}`)
  })

  test('no advice from the server means no advice line, and no state corruption', () => {
    const st = newGuardState()
    const lines = guardStep(st, { risks: [risk('A', true)] })
    assert.deepStrictEqual(lines, ['[burn-guard] A: A detail'])
    assert.strictEqual(st.advised, false)
  })

  test('an outage reports ONCE, and recovery is announced before any risk line', () => {
    const st = newGuardState()
    assert.deepStrictEqual(guardStep(st, null, 'ECONNREFUSED'), ['[burn-guard] server unreachable: ECONNREFUSED'])
    assert.deepStrictEqual(guardStep(st, null, 'ECONNREFUSED'), [], 'once per outage, not once per poll')

    const back = guardStep(st, { risks: [risk('A', true)] })
    assert.strictEqual(back[0], '[burn-guard] server back — resuming',
      'recovery must precede the risk lines, or it reads as "resuming" while already resumed')
    assert.ok(back.some(l => l.includes('A: A detail')))
  })

  test('risk codes and control flags are separate — a risk named like a sentinel is still a risk', () => {
    // The old sentinels lived in the code set, so this input could have collided with them.
    const st = newGuardState()
    const lines = guardStep(st, { risks: [risk('__down', true)] } as BurnRiskReport)
    assert.deepStrictEqual(lines, ['[burn-guard] __down: __down detail'])
    assert.strictEqual(st.down, false, 'a server risk code must never be able to set the outage flag')
  })
})

suite('--out: the payload must survive a path whose directory does not exist', () => {
  test('writeOut creates the parent directory instead of discarding the answer', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentlens-out-'))
    const target = path.join(dir, 'nope', 'deep', 'a.json')
    // MEASURED before the fix: the tool call succeeded, the server did the work, and the last
    // statement threw ENOENT — exit 1 with the answer gone and nothing to retry from but the call.
    writeOut(target, { ok: true })
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(target, 'utf8')), { ok: true })
  })
})

suite('ops flags: a value that is itself a flag is a mistake, not a value', () => {
  // This suite must be unable to do damage even when the guard it tests is ABSENT — which is the
  // state it runs in during any falsification pass, and the state a regression would put it in.
  // MEASURED the first time it ran against the unguarded code: `--export-bodies --json` was accepted
  // as a destination, the CLI POSTed a real export, and the server wrote 345 MB / 542 raw-body files
  // into a directory named "--json" in the repo root — untracked, ungitignored, full of captured
  // request bodies. The CLI exiting did not stop it; the server had to be stopped. So the endpoint is
  // pointed at a port that refuses instantly: a regression now fails the assertion instead of
  // exporting the archive into the working tree.
  const DEAD = 'http://127.0.0.1:1'
  let prevUi: string | undefined
  setup(() => { prevUi = process.env.AGENTLENS_UI_URL; process.env.AGENTLENS_UI_URL = DEAD })
  teardown(() => {
    if (prevUi === undefined) delete process.env.AGENTLENS_UI_URL
    else process.env.AGENTLENS_UI_URL = prevUi
  })

  const rejects = async (argv: string[]): Promise<void> => {
    await assert.rejects(runDiagnosticsCli(argv), (e: Error) => e instanceof UsageError,
      `expected a UsageError for ${JSON.stringify(argv)}`)
  }

  test('--out swallowing the next flag is refused, not obeyed', async () => {
    // MEASURED before the fix: exit 0, a file literally named "--json" created in the cwd, and the
    // --json the caller asked for silently dropped. The request was misread twice and called success.
    await rejects(['--out', '--json'])
  })

  test('--out with nothing after it is refused', async () => {
    await rejects(['--out'])
  })

  test('--export-bodies / --since / --until refuse a flag as their value', async () => {
    await rejects(['--export-bodies', '--json'])
    await rejects(['--since', '--until'])
    await rejects(['--until', '--json'])
  })

  test('a real value is still accepted — the guard must not reject correct usage', async () => {
    // No subcommand, so this prints usage and returns without touching the network.
    const log = console.log
    console.log = (): void => { /* silence the usage block */ }
    try {
      await runDiagnosticsCli(['--out', path.join(os.tmpdir(), 'agentlens-ok.json')])
    } finally {
      console.log = log
    }
  })
})
