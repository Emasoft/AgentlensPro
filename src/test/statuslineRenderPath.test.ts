import * as assert from 'assert'
import { Readable } from 'stream'
import { parseStatuslineArgs, runStatuslineCommand } from '../cli/statuslineCapture'

/** A fresh stdin per call. `process.stdin` yields exactly one EOF per process, so a suite that
 *  invokes the wrapper more than once hangs on the second — which is why the entry point takes the
 *  stream as a parameter. */
const stdinOf = (s: string): NodeJS.ReadableStream => Readable.from([Buffer.from(s, 'utf-8')])
const SAMPLE = '{"session_id":"test","cost":{"total_cost_usd":0}}'

// TRDD-M8SV6LK5 — statuslineCapture.ts states three contracts in its header and breaks the second
// one in the degraded case. Both tests here are that file's own rules turned into assertions.
//
// Contract 1: a non-zero exit BLANKS the user's status line, so nothing of ours may cause one.
// Contract 2: the capture is fire-and-forget and "a hung socket must not hold the status line
//             hostage — a dropped sample is invisible, a frozen status line is not."
//
// The wrapper awaited the capture outright after the child, so a server that ACCEPTS and never
// answers cost the capture's whole 700ms timeout on the render path. MEASURED through the installed
// command: 102ms healthy vs **787ms** against an endpoint that drops — past Claude Code's own 300ms
// debounce, on every render. Tonight's server OOM produced exactly that state before it died.

/** An address that BLACKHOLES: accepts nothing and answers nothing, so the request runs to its
 *  timeout. A closed port refuses instantly and would pass against the broken version — which is
 *  precisely why the bug survived a suite that only ever tested "server down". */
const DROPS = 'http://10.255.255.1:3000'

function withEnv<T>(vars: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const prev: Record<string, string | undefined> = {}
  for (const k of Object.keys(vars)) { prev[k] = process.env[k]; if (vars[k] === undefined) delete process.env[k]; else process.env[k] = vars[k] as string }
  const restore = (): void => {
    for (const k of Object.keys(vars)) { if (prev[k] === undefined) delete process.env[k]; else process.env[k] = prev[k] as string }
  }
  return fn().then(v => { restore(); return v }, e => { restore(); throw e })
}

suite('statusline wrapper: a wedged server must not freeze the render', () => {
  test('🐌 the wait after the child is BOUNDED, not the capture\'s full timeout', async function () {
    this.timeout(30_000)
    // Skip loudly where the sandbox answers instead of blackholing — a pass there would be fake.
    const net = await import('net')
    const drops = await new Promise<boolean>(res => {
      const s = net.connect({ host: '10.255.255.1', port: 3000 })
      const t = setTimeout(() => { s.destroy(); res(true) }, 1_200)
      t.unref?.()
      s.on('error', () => { clearTimeout(t); s.destroy(); res(false) })
      s.on('connect', () => { clearTimeout(t); s.destroy(); res(false) })
    })
    if (!drops) this.skip()

    const t0 = Date.now()
    const code = await withEnv(
      { AGENTLENS_UI_URL: DROPS, AGENTLENS_STATUSLINE_TIMEOUT_MS: '700', AGENTLENS_STATUSLINE_RESIDUAL_MS: '50' },
      () => runStatuslineCommand(['--inner', 'true'], stdinOf(SAMPLE)),
    )
    const ms = Date.now() - t0

    assert.strictEqual(code, 0, 'contract 1: the inner command succeeded, so our exit must be 0')
    // The child (`true`) is ~immediate, so essentially all of this is the post-child wait. The old
    // code paid the full 700ms capture timeout here.
    assert.ok(ms < 400, `expected the post-child wait to be bounded, took ${ms}ms (the broken version paid ~700ms)`)
  })

  test('a healthy path still returns the inner command\'s exit code', async () => {
    // Contract 1 in both directions: success passes through...
    assert.strictEqual(await runStatuslineCommand(['--inner', 'true'], stdinOf(SAMPLE)), 0)
    // ...and so does the inner command's OWN failure, which is its prerogative, not ours to mask.
    assert.strictEqual(await runStatuslineCommand(['--inner', 'exit 3'], stdinOf(SAMPLE)), 3)
  })
})

suite('statusline wrapper: a malformed --inner must not blank the status line', () => {
  test('a flag where the command belongs is treated as ABSENT, never run', () => {
    // `sh -c "--subagent"` exits non-zero, and a non-zero exit blanks the user's status line — the
    // worst outcome this file has. Throwing would do the same thing by another route.
    assert.deepStrictEqual(parseStatuslineArgs(['--inner', '--subagent']), { inner: null, subagent: true })
    assert.deepStrictEqual(parseStatuslineArgs(['--inner']), { inner: null, subagent: false })
  })

  test('and running it exits 0 (capture-only), rather than taking the status line down', async () => {
    assert.strictEqual(await runStatuslineCommand(['--inner', '--subagent'], stdinOf(SAMPLE)), 0)
  })

  test('a real command is still honoured — the guard must not reject correct usage', () => {
    assert.deepStrictEqual(parseStatuslineArgs(['--inner', 'x.sh', '--subagent']), { inner: 'x.sh', subagent: true })
    // A command with flags INSIDE it is normal and must survive: only the first token is inspected.
    assert.deepStrictEqual(parseStatuslineArgs(['--inner', 'ccusage --json | jq .']).inner, 'ccusage --json | jq .')
  })
})
