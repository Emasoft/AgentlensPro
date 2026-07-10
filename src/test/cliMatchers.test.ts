import * as assert from 'assert'
import * as path from 'path'

// ── agentlenspro-cli hook-matcher internals (TRDD-GOD0108C install/uninstall) ─────
// Loads the REAL scripts/agentlens-cli.js as a CommonJS module (its main() is guarded by
// require.main === module, so requiring it runs no CLI). Exercises rebuildEventMatchers —
// the pure function that (un)installs the spy-agentlens hook entries — with no server.

interface HookCmd { type: string; command: string; timeout?: number; async?: boolean }
interface Matcher { matcher?: string; hooks: HookCmd[] }
interface RebuildResult { rebuilt: Matcher[]; removedOurs: number; removedSpyglass: number; installed: boolean }
interface CliModule {
  rebuildEventMatchers: (matchers: Matcher[], ev: string, uninstall: boolean, cmd: string, gateCmd: string) => RebuildResult
  GATE_MATCHER: string
  GATE_EVENTS: string[]
}

// out/test/test/ → repo root is three levels up; scripts/ sits beside out/ in the repo layout.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const cli = require(path.resolve(__dirname, '..', '..', '..', 'scripts', 'agentlens-cli.js')) as CliModule

const CMD = 'bash /repo/scripts/spy-agentlens.sh'         // lifecycle forwarder (contains "spy-agentlens")
const GATE_CMD = 'bash /repo/scripts/spy-agentlens-gate.sh' // burn gate (contains "spy-agentlens")

suite('agentlenspro-cli — rebuildEventMatchers (hook install/uninstall)', () => {
  test('install injects the gate entry on the ^(Task|Agent|Workflow)$ matcher, SYNC (no async)', () => {
    // A fresh PreToolUse event gains exactly the gate matcher with the gate command, timeout 3, sync.
    assert.strictEqual(cli.GATE_MATCHER, '^(Task|Agent|Workflow)$')
    const r = cli.rebuildEventMatchers([], 'PreToolUse', false, CMD, GATE_CMD)
    assert.strictEqual(r.installed, true)
    const gate = r.rebuilt.find(m => m.matcher === cli.GATE_MATCHER)
    if (!gate) return assert.fail('gate matcher entry must be present after install')
    assert.strictEqual(gate.hooks[0].command, GATE_CMD)
    assert.strictEqual(gate.hooks[0].timeout, 3)
    assert.ok(!('async' in gate.hooks[0]), 'gate hook must be SYNC — an async hook cannot deny')
  })

  test('install is idempotent: re-running over an already-installed list yields no duplicate entries', () => {
    // Feeding the first result back in strips-then-reappends our entry → identical list, one gate matcher.
    const first = cli.rebuildEventMatchers([], 'PreToolUse', false, CMD, GATE_CMD)
    const second = cli.rebuildEventMatchers(first.rebuilt, 'PreToolUse', false, CMD, GATE_CMD)
    assert.deepStrictEqual(second.rebuilt, first.rebuilt)
    assert.strictEqual(second.rebuilt.filter(m => m.matcher === cli.GATE_MATCHER).length, 1)
  })

  test('uninstall strips BOTH script families — the "spy-agentlens" needle matches .sh AND .mjs', () => {
    // One .sh forwarder + one .mjs gate registration; uninstall removes both, leaving nothing.
    const matchers: Matcher[] = [
      { hooks: [{ type: 'command', command: 'bash /x/spy-agentlens.sh', timeout: 2, async: true }] },
      { matcher: cli.GATE_MATCHER, hooks: [{ type: 'command', command: 'node /x/spy-agentlens-gate.mjs', timeout: 3 }] },
    ]
    const r = cli.rebuildEventMatchers(matchers, 'PreToolUse', true, CMD, GATE_CMD)
    assert.strictEqual(r.removedOurs, 2, 'both the .sh and .mjs entries must be recognised as ours')
    assert.strictEqual(r.rebuilt.length, 0)
    assert.strictEqual(r.installed, false)
  })

  test('foreign hooks from other tools are preserved untouched on both uninstall and install', () => {
    // A non-agentlens entry must survive; only our own entries are stripped, and our forwarder re-added.
    const foreign: Matcher = { hooks: [{ type: 'command', command: 'bash /other/janitor-hook.sh', timeout: 5 }] }
    const matchers: Matcher[] = [
      foreign,
      { hooks: [{ type: 'command', command: 'bash /x/spy-agentlens.sh', timeout: 2, async: true }] },
    ]
    const un = cli.rebuildEventMatchers(matchers, 'Stop', true, CMD, GATE_CMD)
    assert.strictEqual(un.removedOurs, 1)
    assert.deepStrictEqual(un.rebuilt, [foreign], 'foreign hook untouched, our entry gone')

    const inst = cli.rebuildEventMatchers(matchers, 'Stop', false, CMD, GATE_CMD)
    assert.strictEqual(inst.removedOurs, 1)
    assert.ok(inst.rebuilt.some(m => JSON.stringify(m) === JSON.stringify(foreign)), 'foreign hook preserved on install')
    assert.ok(inst.rebuilt.some(m => (m.hooks ?? []).some(h => h.command === CMD)), 'our lifecycle forwarder re-appended')
  })
})
