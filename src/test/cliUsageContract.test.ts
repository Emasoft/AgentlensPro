import * as assert from 'assert'
import * as path from 'path'
import { spawn } from 'child_process'
import { cliMain, MANAGEMENT_VERBS } from '../cli/main'
import { UsageError } from '../cli/cliErrors'
import { serverCommand } from '../cli/serverControl'

// Two contract defects found by RUNNING every verb against the live server
// (reports/cli-audit/20260811_184145+0200-cli-verb-matrix.md), not by reading the code — which is
// the point: both were invisible to review because each site is locally reasonable.
//
//   B. `agentlenspro server` (no subcommand) exited 1. Every sibling verb with the identical
//      "required argument missing" shape — budget, watch, ctxmap — exits 64. cliErrors.ts reserves
//      1 as the watchers' ABORT signal, so a caller branching on the exit code cannot tell "you
//      forgot the subcommand" from "the server threw", and a batch guarded by `budget --watch`
//      would treat a typo as a legitimate abort.
//
//   C. `agentlenspro help <verb>` failed for EVERY management verb with
//      `FAIL: unknown tool "budget" (agentlenspro list)` — and the remedy it names does not lead
//      anywhere, because `list` enumerates diagnostics tools only, never CLI verbs. CLAUDE.md
//      documents `agentlenspro help <tool>`, so generalizing it to a verb is the natural thing to
//      try and it dead-ends.
//
// The management-verb help answers from static USAGE with no socket, matching the `--help` path's
// existing doctrine (owner directive 2026-08-05: help is TOTAL — describe, never do) rather than
// inventing a second rule. That doctrine already applies to `get_account_status --help`, so
// routing `help get_account_status` the same way makes the two forms agree instead of diverging.

const CLI_JS = path.join(__dirname, '..', '..', '..', 'standalone', 'cli.js')

function runCli(args: string[]): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI_JS, ...args], { env: { ...process.env } })
    let stderr = ''
    child.stdout?.on('data', () => { /* payload not under test here */ })
    child.stderr?.on('data', (d: Buffer) => { stderr += d.toString() })
    child.on('close', (code) => resolve({ code, stderr }))
    child.stdin?.end()
  })
}

/** Run `fn` with console.log captured, so a help path can be asserted without spawning a process. */
async function captureLog(fn: () => Promise<number>): Promise<{ code: number; out: string }> {
  const original = console.log
  let out = ''
  console.log = (...a: unknown[]) => { out += a.map(String).join(' ') + '\n' }
  try {
    const code = await fn()
    return { code, out }
  } finally { console.log = original }
}

suite('CLI usage contract', () => {
  test('a missing required subcommand is a UsageError, so it reads as 64 and never as the watchers ABORT 1', async () => {
    // Asserted on the ERROR TYPE, not the exit code, because that is where the decision is made:
    // standalone/cli.ts maps `e instanceof UsageError ? EXIT.USAGE : 1`. A test that only checked
    // the spawned exit code would still pass if someone hardcoded 64 at the throw site and left
    // the type wrong, which would then diverge from every other verb the next time the mapping moved.
    await assert.rejects(
      () => serverCommand([]),
      (e: unknown) => {
        assert.ok(e instanceof UsageError,
          `server with no subcommand must throw UsageError (got ${(e as Error)?.constructor?.name}) — `
          + 'a plain Error maps to exit 1, which cliErrors.ts reserves for the watchers ABORT signal')
        assert.match((e as Error).message, /start\|stop\|restart\|status/,
          'the message must still name the accepted subcommands')
        return true
      })
  })

  test('🐌 end-to-end: the shipped bundle exits 64 for `server` with no subcommand', async function () {
    this.timeout(30_000)
    // The type assertion above is the mechanism; this is the contract a caller actually observes.
    // Both are kept: the unit test explains WHY, this one proves the wiring is really connected.
    const r = await runCli(['server'])
    assert.strictEqual(r.code, 64,
      `\`agentlenspro server\` must exit 64 (EX_USAGE), got ${r.code}. stderr: ${r.stderr.trim()}`)
  })

  test('`help <verb>` answers for EVERY management verb, with no socket and no dead-end', async () => {
    // Derived from MANAGEMENT_VERBS itself, never a hand-copied list — a verb added there but not
    // here would otherwise rejoin the broken set silently, which is exactly how this shipped.
    const broken: string[] = []
    for (const verb of MANAGEMENT_VERBS) {
      const { code, out } = await captureLog(() => cliMain(['help', verb], async () => undefined))
      if (code !== 0) { broken.push(`${verb}: exit ${code}`); continue }
      if (!out.includes('agentlenspro')) broken.push(`${verb}: printed no usage text`)
    }
    assert.deepStrictEqual(broken, [],
      'every management verb must answer `help <verb>`; a failure here is the `unknown tool` dead-end returning')
  })

  test('`help <unknown>` is NOT swallowed into usage — a typo must still be reported', async () => {
    // The paired invariant, and the direction the fix could easily overshoot: if `help <anything>`
    // printed USAGE and returned 0, a mistyped verb would look like a successful help request and
    // the user would never learn the name was wrong. Only KNOWN management verbs may short-circuit.
    // Either shape satisfies the invariant: the diagnostics path THROWS (standalone/cli.ts maps
    // that to a non-zero exit) and a future refactor might return a code instead. What must never
    // happen is usage text with a success code, so assert on that rather than on the mechanism —
    // pinning the throw would make this fail on a harmless refactor and teach its reader to
    // delete it.
    let answeredSuccessfully = false
    try {
      const { code } = await captureLog(() => cliMain(['help', 'definitely-not-a-verb'], async () => undefined))
      answeredSuccessfully = code === 0
    } catch { /* thrown = reported = correct */ }
    assert.strictEqual(answeredSuccessfully, false,
      'an unknown name must not be answered with usage and a success code')
  })
})
