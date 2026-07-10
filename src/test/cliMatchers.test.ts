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
  HOOK_BIN: string
  GATE_BIN: string
  resolveOnPath: (name: string) => string | null
}

// out/test/test/ → repo root is three levels up; scripts/ sits beside out/ in the repo layout.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const cli = require(path.resolve(__dirname, '..', '..', '..', 'scripts', 'agentlens-cli.js')) as CliModule

const CMD = 'bash /repo/scripts/spy-agentlens.sh'         // lifecycle forwarder (contains "spy-agentlens")
const GATE_CMD = 'bash /repo/scripts/spy-agentlens-gate.sh' // burn gate (contains "spy-agentlens")

suite('agentlenspro-cli — rebuildEventMatchers (hook install/uninstall)', () => {
  test('install injects the gate entry on the ^(Task|Agent|Workflow|SendMessage)$ matcher, SYNC (no async)', () => {
    // A fresh PreToolUse event gains exactly the gate matcher with the gate command, timeout 3, sync.
    // SendMessage joined in P6: resuming a dead agent re-runs the request that killed it, so the
    // server gates messages too (narrower — cache-thrash / cold-resume only, never routine traffic).
    assert.strictEqual(cli.GATE_MATCHER, '^(Task|Agent|Workflow|SendMessage)$')
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

// ── P10 PATH-bin contract — the installer output is BARE bin names, never paths ──
// Homebrew's Cellar path moves on every version bump, so an absolute path registered
// into ~/.claude/settings.json dangles after `brew upgrade`. The installer therefore
// registers HOOK_BIN/GATE_BIN and the uninstaller must strip BOTH generations.
suite('agentlenspro-cli — PATH-bin hook registration (P10)', () => {
  test('bin names are the published package bins and contain no path separators', () => {
    // The registered command must be resolvable by the hook runner's shell via PATH alone.
    assert.strictEqual(cli.HOOK_BIN, 'agentlenspro-hook')
    assert.strictEqual(cli.GATE_BIN, 'agentlenspro-gate')
    for (const bin of [cli.HOOK_BIN, cli.GATE_BIN]) {
      assert.ok(!bin.includes('/') && !bin.includes('\\'), `${bin} must be a bare PATH name`)
    }
  })

  test('install registers the bare names verbatim on lifecycle and gate entries', () => {
    // What the installer writes is exactly the bin name — no runner prefix, no directory.
    // The forwarder lands on LIFECYCLE events (here: Stop); the gate on PreToolUse only —
    // the forwarder is deliberately NEVER registered on the tool events.
    const gateEv = cli.rebuildEventMatchers([], 'PreToolUse', false, cli.HOOK_BIN, cli.GATE_BIN)
    const gate = gateEv.rebuilt.find(m => m.matcher === cli.GATE_MATCHER)
    if (!gate) return assert.fail('gate matcher entry must be present after install')
    assert.strictEqual(gate.hooks[0].command, cli.GATE_BIN)
    assert.ok(!gateEv.rebuilt.some(m => m.hooks.some(h => h.command === cli.HOOK_BIN)),
      'the lifecycle forwarder must NOT be registered on PreToolUse')

    const lifecycleEv = cli.rebuildEventMatchers([], 'Stop', false, cli.HOOK_BIN, cli.GATE_BIN)
    const lifecycle = lifecycleEv.rebuilt.find(m => m.hooks.some(h => h.command === cli.HOOK_BIN))
    if (!lifecycle) return assert.fail('lifecycle forwarder entry must be present after install on Stop')
    assert.strictEqual(lifecycle.hooks[0].command, cli.HOOK_BIN)
  })

  test('migration: install over legacy absolute-path entries strips them and registers bare names', () => {
    // A settings.json written by an older version carries `bash /abs/spy-agentlens*.sh`
    // entries; a fresh install must replace them (never duplicate alongside them).
    const legacyStop: Matcher[] = [
      { hooks: [{ type: 'command', command: 'bash /usr/local/lib/node_modules/agentlenspro/scripts/spy-agentlens.sh', timeout: 2, async: true }] },
    ]
    const rStop = cli.rebuildEventMatchers(legacyStop, 'Stop', false, cli.HOOK_BIN, cli.GATE_BIN)
    assert.strictEqual(rStop.removedOurs, 1, 'legacy absolute-path forwarder must be stripped')
    assert.deepStrictEqual(rStop.rebuilt.flatMap(m => m.hooks.map(h => h.command)), [cli.HOOK_BIN])

    const legacyGate: Matcher[] = [
      { matcher: cli.GATE_MATCHER, hooks: [{ type: 'command', command: 'bash /usr/local/lib/node_modules/agentlenspro/scripts/spy-agentlens-gate.sh', timeout: 3 }] },
    ]
    const rGate = cli.rebuildEventMatchers(legacyGate, 'PreToolUse', false, cli.HOOK_BIN, cli.GATE_BIN)
    assert.strictEqual(rGate.removedOurs, 1, 'legacy absolute-path gate must be stripped')
    assert.deepStrictEqual(rGate.rebuilt.flatMap(m => m.hooks.map(h => h.command)), [cli.GATE_BIN])
  })

  test('uninstall strips BOTH generations — legacy absolute paths AND bare PATH names', () => {
    const mixed: Matcher[] = [
      { hooks: [{ type: 'command', command: 'bash /old/prefix/spy-agentlens.sh', timeout: 2, async: true }] },
      { hooks: [{ type: 'command', command: cli.HOOK_BIN, timeout: 2, async: true }] },
      { matcher: cli.GATE_MATCHER, hooks: [{ type: 'command', command: cli.GATE_BIN, timeout: 3 }] },
      { matcher: cli.GATE_MATCHER, hooks: [{ type: 'command', command: 'node C:\\old\\spy-agentlens-gate.mjs', timeout: 3 }] },
    ]
    const r = cli.rebuildEventMatchers(mixed, 'PreToolUse', true, cli.HOOK_BIN, cli.GATE_BIN)
    assert.strictEqual(r.removedOurs, 4, 'all four entries across both generations must be recognised as ours')
    assert.strictEqual(r.rebuilt.length, 0)
  })

  test('resolveOnPath finds an executable on PATH and returns null for a nonsense name', () => {
    // node is guaranteed present in the test environment; the negative case guards the
    // installer refusal path (registering a name the shell cannot find = silent dead hook).
    assert.ok(cli.resolveOnPath('node'), 'node must resolve on PATH')
    assert.strictEqual(cli.resolveOnPath('agentlenspro-definitely-not-a-bin-xyz'), null)
  })
})
