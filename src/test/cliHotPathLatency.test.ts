import * as assert from 'assert'
import * as fs from 'fs'
import * as net from 'net'
import * as os from 'os'
import * as path from 'path'
import { spawn } from 'child_process'
import { HOT_PATH_BUDGET_MS, LATENCY_EXEMPT } from '../cli/main'
import { MAX_RATIO_ABSOLUTE_DEADLINE, oversubscription, skipIfUnmeasurable } from './loadAware'

// TRDD-E8XIC2PM — a latency guard for every command a harness runs on its hot path.
//
// The defect this generalizes: `statusline`, `hook` and `gate` each took 10.6 SECONDS with the server
// unreachable in a way that HANGS rather than refuses. The cause was not a missing timeout —
// `AbortSignal.timeout` fired correctly at 704 ms and bounded the REQUEST, while the aborted socket
// kept the event loop alive and the CLI ended by draining it. The three were fixed by hand; nothing
// stopped the NEXT hot-path command from shipping without the same guard.
//
// Two things make this a guard rather than a re-test:
//   1. it is driven by the classification that sits beside the dispatch, so a new `case` with no
//      classification fails here instead of joining the untested set silently;
//   2. it runs against an address that DROPS (10.255.255.1), never a closed port — a closed port
//      REFUSES instantly, which is precisely why a thorough "server down" suite stayed green while
//      the stall was live.

const CLI_JS = path.join(__dirname, '..', '..', '..', 'standalone', 'cli.js')
const MAIN_TS = path.join(__dirname, '..', '..', '..', 'src', 'cli', 'main.ts')
/** RFC1918, unrouted here: packets are BLACKHOLED, so a connect hangs until the OS gives up. */
const DROP_URL = 'http://10.255.255.1:3000'

interface RunResult { code: number | null; stdout: string; ms: number }

function run(args: string[], env: NodeJS.ProcessEnv, stdin: string): Promise<RunResult> {
  const t0 = Date.now()
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI_JS, ...args], { env })
    let stdout = ''
    child.stdout?.on('data', (d: Buffer) => { stdout += d.toString() })
    child.stderr?.on('data', () => { /* diagnostics only */ })
    child.on('close', (code) => resolve({ code, stdout, ms: Date.now() - t0 }))
    child.stdin?.write(stdin)
    child.stdin?.end()
  })
}

function baseEnv(home: string): NodeJS.ProcessEnv {
  const env = { ...process.env }
  for (const k of Object.keys(env)) if (k.startsWith('AGENTLENS_')) delete env[k]
  delete env.DATA_DIR; delete env.UI_PORT; delete env.MCP_PORT; delete env.OTLP_PORT
  return {
    ...env, HOME: home, USERPROFILE: home,
    AGENTLENS_UI_URL: DROP_URL, AGENTLENS_MCP_URL: `${DROP_URL}/mcp`,
    AGENTLENS_GATE_TIMEOUT: '1', AGENTLENS_HOOK_TIMEOUT: '1',
  }
}

/** Does this address actually DROP here? A sandbox that answers ECONNREFUSED / ENETUNREACH quickly
 *  turns every assertion below into a test of the fast path — it would pass against the very bug it
 *  exists to catch. Detect that and SKIP loudly rather than bank a green that means nothing. */
function addressDrops(): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.connect({ host: '10.255.255.1', port: 3000 })
    const done = (dropped: boolean) => { sock.destroy(); resolve(dropped) }
    const timer = setTimeout(() => done(true), 1_200)   // still pending ⇒ it is a black hole
    timer.unref?.()
    sock.on('error', () => { clearTimeout(timer); done(false) })
    sock.on('connect', () => { clearTimeout(timer); done(false) })
  })
}

// Per-command recipe: what to pass so the command actually runs its work. `stdin` matters for the
// hook family (they read the event payload from it) and is harmless elsewhere.
const HOOK_PAYLOAD = JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_input: { prompt: 'x' } })
const STATUSLINE_PAYLOAD = JSON.stringify({ session_id: 'aaaaaaaa', model: { id: 'claude-opus-5' }, cost: { total_cost_usd: 0.1 } })
const RECIPES: Record<string, { args: string[]; stdin: string }> = {
  hook: { args: ['hook'], stdin: HOOK_PAYLOAD },
  gate: { args: ['gate'], stdin: HOOK_PAYLOAD },
  statusline: { args: ['statusline'], stdin: STATUSLINE_PAYLOAD },
  'cache-expired': { args: ['cache-expired', '-q'], stdin: '' },
  'last-compact': { args: ['last-compact', '--seconds'], stdin: '' },
}

suite('CLI hot-path latency guard (TRDD-E8XIC2PM)', () => {
  test('every dispatched subcommand is classified: hot-path with a ceiling, or exempt with a REASON', () => {
    // Derived from the SOURCE, not from a hand-kept list — a duplicate list is what lets a new
    // command slip through, and that is the whole failure this criterion exists to prevent.
    const src = fs.readFileSync(MAIN_TS, 'utf8')
    const cases = [...src.matchAll(/^\s*case '([a-z_][a-z0-9_-]*)':/gmi)].map(m => m[1])
    assert.ok(cases.length >= 15, `expected the dispatch to be parsed, found ${cases.length} cases`)

    const unclassified: string[] = []
    const both: string[] = []
    for (const cmd of new Set(cases)) {
      const hot = Object.prototype.hasOwnProperty.call(HOT_PATH_BUDGET_MS, cmd)
      const exempt = Object.prototype.hasOwnProperty.call(LATENCY_EXEMPT, cmd)
      if (!hot && !exempt) unclassified.push(cmd)
      if (hot && exempt) both.push(cmd)
    }
    assert.deepStrictEqual(unclassified, [],
      `unclassified subcommand(s): add a ceiling to HOT_PATH_BUDGET_MS or a REASON to LATENCY_EXEMPT in src/cli/main.ts`)
    assert.deepStrictEqual(both, [], 'a command cannot be both hot-path and exempt')

    // The reverse direction: a classification for a command that no longer exists is dead weight
    // that makes the table look more complete than it is.
    const known = new Set(cases)
    const stale = [...Object.keys(HOT_PATH_BUDGET_MS), ...Object.keys(LATENCY_EXEMPT)].filter(c => !known.has(c))
    assert.deepStrictEqual(stale, [], 'classified command(s) no longer dispatched — remove them')

    for (const [cmd, reason] of Object.entries(LATENCY_EXEMPT)) {
      assert.ok(reason.length > 25, `${cmd}'s exemption needs a real reason, not a placeholder`)
    }
    for (const [cmd, ms] of Object.entries(HOT_PATH_BUDGET_MS)) {
      assert.ok(ms > 0 && ms <= 3_000, `${cmd}'s ceiling (${ms}ms) must be inside the harness's own hook timeout`)
    }
  })

  test('🐌 every hot-path command returns inside its ceiling against an address that DROPS', async function () {
    this.timeout(120_000)
    if (!fs.existsSync(CLI_JS)) { this.skip(); return }
    if (!await addressDrops()) {
      // Not a pass. This environment answers instead of blackholing, so the measurement is void.
      this.skip()
      return
    }
    // Same reasoning, second way the measurement can be void: a machine with no CPU headroom.
    // These ceilings are ABSOLUTE and not ours to relax — Claude Code kills a lifecycle hook at 2 s
    // and the gate at 3 s however busy the box is — so contention is gated at the MEASUREMENT, never
    // by widening a budget. Measured on this machine at 10.8x oversubscription: hook 5688 ms, gate
    // 2765 ms, statusline 2865 ms, all red, none of it a regression. A guard that reports the machine
    // instead of the code teaches its reader to ignore it, which is worse than not running.
    // Announced BEFORE the skip, because `ctx.skip()` throws — anything after it never runs, and a
    // silent skip is indistinguishable from a pass in the runner's output.
    const over = oversubscription()
    if (over > MAX_RATIO_ABSOLUTE_DEADLINE) {
      console.log(`[hot-path latency] SKIPPED: machine is ${over.toFixed(1)}x oversubscribed `
        + `(limit ${MAX_RATIO_ABSOLUTE_DEADLINE}x) — this measurement would report the machine, not the code.`)
    }
    if (skipIfUnmeasurable(this, MAX_RATIO_ABSOLUTE_DEADLINE)) return
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'al-lat-'))
    try {
      const slow: string[] = []
      for (const [cmd, budget] of Object.entries(HOT_PATH_BUDGET_MS)) {
        const recipe = RECIPES[cmd]
        assert.ok(recipe, `${cmd} is classified hot-path but has no recipe here — it would be counted as covered while never running`)
        const r = await run(recipe.args, baseEnv(home), recipe.stdin)
        if (r.ms >= budget) slow.push(`${cmd}: ${r.ms}ms >= ${budget}ms ceiling`)
      }
      assert.deepStrictEqual(slow, [], `a hung socket is holding the process open:\n  ${slow.join('\n  ')}`)
    } finally { fs.rmSync(home, { recursive: true, force: true }) }
  })

  test('the top-level FAILURE exit flushes too — a failed command must not truncate what it wrote', () => {
    // The same invariant, one level up, and it was missed when the hot-path commands were fixed:
    // `standalone/cli.ts`'s catch handler ended in a bare `process.exit()`. A command that had
    // already written a large payload to stdout and THEN failed would deliver a TRUNCATED payload
    // alongside a non-zero exit — which reads as a corrupt result rather than a clean failure.
    // Asserted on the source AND on the shipped bundle, because the bundle is what runs.
    const src = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'standalone', 'cli.ts'), 'utf8')
    // Measured on comment-STRIPPED code. The comment above that line names `process.exit()` as the
    // thing not to use, so a raw text match reddens on the correct version — a guard that fails on
    // good writing gets deleted, which is how the rule it protects dies.
    const catchBlock = src.slice(src.indexOf('.catch('))
      .split('\n').filter(l => !l.trimStart().startsWith('//')).join('\n')
    assert.ok(catchBlock.includes('exitNow('), 'the top-level catch must exit through the flushing path')
    assert.ok(!/\bprocess\.exit\(/.test(catchBlock), 'a bare process.exit() here discards a queued stdout write')
    if (fs.existsSync(CLI_JS)) {
      const bundle = fs.readFileSync(CLI_JS, 'utf8')
      assert.ok(bundle.includes('FAIL: '), 'the failure path is present in the shipped bundle')
    }
  })

  test('the exit path stays COMPLETE: a write past the pipe buffer is not discarded by exiting early', async () => {
    // The paired invariant, and the two pull in OPPOSITE directions: exiting early bounds the hang
    // and truncates the output; waiting for the flush completes the output and restores the hang.
    // It is asserted here on `exitNow` itself — the single function every hot-path command exits
    // through — so it also covers commands added later, which a per-command test cannot.
    // MEASURED against the wrong version: write 262,144 bytes then `process.exit()`, and a piped
    // reader receives 65,536 — exactly one pipe buffer.
    const BIG = 262_144
    const script = `const m = require(${JSON.stringify(path.join(__dirname, '..', 'cli', 'main.js'))});
      process.stdout.write('D'.repeat(${BIG}));
      m.exitNow(0);`
    const r = await new Promise<{ len: number; code: number | null }>((resolve) => {
      const child = spawn(process.execPath, ['-e', script], { env: process.env })
      let len = 0
      child.stdout?.on('data', (d: Buffer) => { len += d.length })
      child.on('close', (code) => resolve({ len, code }))
    })
    assert.strictEqual(r.code, 0)
    assert.strictEqual(r.len, BIG, `stdout was truncated to ${r.len} bytes — the exit discarded a queued pipe write`)
  })
})
