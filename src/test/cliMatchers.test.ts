import * as assert from 'assert'
import {
  rebuildEventMatchers, isOurHookCommand, resolveOnPath,
  GATE_MATCHER, HOOK_CMD, GATE_CMD, REVIEW_CMD, CLI_BIN, LEGACY_HOOK_BIN, LEGACY_GATE_BIN,
  type HookMatcher,
} from '../cli/hookInstall'

// ── agentlenspro hook-matcher internals (TRDD-GOD0108C install/uninstall; v2 command
// strings per TRDD-7284WCW7) ──────────────────────────────────────────────────────────
// Exercises rebuildEventMatchers — the pure function that (un)installs the AgentlensPro
// hook entries — with no server. Since v2.0.0 the registered commands are the SUBCOMMAND
// STRINGS `agentlenspro hook` / `agentlenspro gate` of the single executable; the v1
// PATH-bin names and the v0 absolute-path spy scripts are legacy generations that install
// must migrate and uninstall must strip.

suite('agentlenspro — rebuildEventMatchers (hook install/uninstall)', () => {
  test('install injects the gate entry on the agent-launch + Read matcher, SYNC (no async)', () => {
    // A fresh PreToolUse event gains exactly the gate matcher with the gate command, timeout 3, sync.
    // SendMessage joined in P6: resuming a dead agent re-runs the request that killed it, so the
    // server gates messages too (narrower — cache-thrash / cold-resume only, never routine traffic).
    // Read joined 2026-07-28 for the image cache-guard — the one non-rare tool in the matcher. Its
    // cost is bounded on the CLI side (runGateCheck answers a non-image Read locally, no network),
    // NOT by the matcher, so this string is pinned here to make widening it a deliberate act:
    // every name added is a hook process on every one of that tool's calls.
    assert.strictEqual(GATE_MATCHER, '^(Task|Agent|Workflow|SendMessage|Read)$')
    const r = rebuildEventMatchers([], 'PreToolUse', false, HOOK_CMD, GATE_CMD)
    assert.strictEqual(r.installed, true)
    const gate = r.rebuilt.find(m => m.matcher === GATE_MATCHER)
    if (!gate) return assert.fail('gate matcher entry must be present after install')
    assert.strictEqual(gate.hooks[0].command, GATE_CMD)
    // 5s since the 2026-08-14 owner report (load-130+ made the old 3s fire routinely — see
    // gateMatcher's WHY); the pin exists so a timeout change is a deliberate act, not drift.
    assert.strictEqual(gate.hooks[0].timeout, 5)
    assert.ok(!('async' in gate.hooks[0]), 'gate hook must be SYNC — an async hook cannot deny')
  })

  test('install is idempotent: re-running over an already-installed list yields no duplicate entries', () => {
    // Feeding the first result back in strips-then-reappends our entry → identical list, one gate matcher.
    const first = rebuildEventMatchers([], 'PreToolUse', false, HOOK_CMD, GATE_CMD)
    const second = rebuildEventMatchers(first.rebuilt, 'PreToolUse', false, HOOK_CMD, GATE_CMD)
    assert.deepStrictEqual(second.rebuilt, first.rebuilt)
    assert.strictEqual(second.rebuilt.filter(m => m.matcher === GATE_MATCHER).length, 1)
  })

  test('uninstall strips BOTH v0 script families — the "spy-agentlens" needle matches .sh AND .mjs', () => {
    // One .sh forwarder + one .mjs gate registration; uninstall removes both, leaving nothing.
    const matchers: HookMatcher[] = [
      { hooks: [{ type: 'command', command: 'bash /x/spy-agentlens.sh', timeout: 2, async: true }] },
      { matcher: GATE_MATCHER, hooks: [{ type: 'command', command: 'node /x/spy-agentlens-gate.mjs', timeout: 3 }] },
    ]
    const r = rebuildEventMatchers(matchers, 'PreToolUse', true, HOOK_CMD, GATE_CMD)
    assert.strictEqual(r.removedOurs, 2, 'both the .sh and .mjs entries must be recognised as ours')
    assert.strictEqual(r.rebuilt.length, 0)
    assert.strictEqual(r.installed, false)
  })

  test('foreign hooks from other tools are preserved untouched on both uninstall and install', () => {
    // A non-agentlens entry must survive; only our own entries are stripped, and our forwarder re-added.
    const foreign: HookMatcher = { hooks: [{ type: 'command', command: 'bash /other/janitor-hook.sh', timeout: 5 }] }
    const matchers: HookMatcher[] = [
      foreign,
      { hooks: [{ type: 'command', command: 'bash /x/spy-agentlens.sh', timeout: 2, async: true }] },
    ]
    const un = rebuildEventMatchers(matchers, 'Stop', true, HOOK_CMD, GATE_CMD)
    assert.strictEqual(un.removedOurs, 1)
    assert.deepStrictEqual(un.rebuilt, [foreign], 'foreign hook untouched, our entry gone')

    const inst = rebuildEventMatchers(matchers, 'Stop', false, HOOK_CMD, GATE_CMD)
    assert.strictEqual(inst.removedOurs, 1)
    assert.ok(inst.rebuilt.some(m => JSON.stringify(m) === JSON.stringify(foreign)), 'foreign hook preserved on install')
    assert.ok(inst.rebuilt.some(m => (m.hooks ?? []).some(h => h.command === HOOK_CMD)), 'our lifecycle forwarder re-appended')
  })
})

// ── v2 command-string contract — ONE executable, subcommand registrations ─────────────
// Homebrew's Cellar path moves on every version bump, so an absolute path registered into
// ~/.claude/settings.json dangles after `brew upgrade`. Since v2.0.0 the registration is
// the bare `agentlenspro` bin (the single package bin — npm/Homebrew keep the PATH shim
// current) plus a subcommand argument; the installer must migrate BOTH older generations.
suite('agentlenspro — v2 command-string hook registration', () => {
  test('registered commands are `agentlenspro hook`/`agentlenspro gate` — bare bin + subcommand, no path separators', () => {
    // The command must resolve via PATH alone: first token is the ONE published bin.
    assert.strictEqual(HOOK_CMD, 'agentlenspro hook')
    assert.strictEqual(GATE_CMD, 'agentlenspro gate')
    for (const cmd of [HOOK_CMD, GATE_CMD]) {
      assert.strictEqual(cmd.split(' ')[0], CLI_BIN, 'first token must be the published bin')
      assert.ok(!cmd.includes('/') && !cmd.includes('\\'), `${cmd} must contain no path separators`)
    }
  })

  test('install registers the command strings verbatim on lifecycle and gate entries', () => {
    // What the installer writes is exactly the subcommand string — no runner prefix, no directory.
    // The forwarder lands on LIFECYCLE events (here: Stop); the gate on PreToolUse only —
    // the forwarder is deliberately NEVER registered on the tool events.
    const gateEv = rebuildEventMatchers([], 'PreToolUse', false, HOOK_CMD, GATE_CMD)
    const gate = gateEv.rebuilt.find(m => m.matcher === GATE_MATCHER)
    if (!gate) return assert.fail('gate matcher entry must be present after install')
    assert.strictEqual(gate.hooks[0].command, GATE_CMD)
    assert.ok(!gateEv.rebuilt.some(m => m.hooks.some(h => h.command === HOOK_CMD)),
      'the lifecycle forwarder must NOT be registered on PreToolUse')

    const lifecycleEv = rebuildEventMatchers([], 'Stop', false, HOOK_CMD, GATE_CMD)
    const lifecycle = lifecycleEv.rebuilt.find(m => m.hooks.some(h => h.command === HOOK_CMD))
    if (!lifecycle) return assert.fail('lifecycle forwarder entry must be present after install on Stop')
    assert.strictEqual(lifecycle.hooks[0].command, HOOK_CMD)
  })

  test('migration: install over v0 absolute-path entries strips them and registers the v2 command strings', () => {
    // A settings.json written by v0 carries `bash /abs/spy-agentlens*.sh` entries; a fresh
    // install must replace them (never duplicate alongside them).
    const legacyStop: HookMatcher[] = [
      { hooks: [{ type: 'command', command: 'bash /usr/local/lib/node_modules/agentlenspro/scripts/spy-agentlens.sh', timeout: 2, async: true }] },
    ]
    const rStop = rebuildEventMatchers(legacyStop, 'Stop', false, HOOK_CMD, GATE_CMD)
    assert.strictEqual(rStop.removedOurs, 1, 'legacy absolute-path forwarder must be stripped')
    // Stop also carries the review gate (REVIEW_EVENTS) alongside the lifecycle forwarder.
    assert.deepStrictEqual(rStop.rebuilt.flatMap(m => m.hooks.map(h => h.command)), [HOOK_CMD, REVIEW_CMD])

    const legacyGate: HookMatcher[] = [
      { matcher: GATE_MATCHER, hooks: [{ type: 'command', command: 'bash /usr/local/lib/node_modules/agentlenspro/scripts/spy-agentlens-gate.sh', timeout: 3 }] },
    ]
    const rGate = rebuildEventMatchers(legacyGate, 'PreToolUse', false, HOOK_CMD, GATE_CMD)
    assert.strictEqual(rGate.removedOurs, 1, 'legacy absolute-path gate must be stripped')
    assert.deepStrictEqual(rGate.rebuilt.flatMap(m => m.hooks.map(h => h.command)), [GATE_CMD])
  })

  test('migration: install over v1 PATH-bin entries (agentlenspro-hook/-gate) rewrites them to v2 command strings', () => {
    // v1 registered the bare wrapper-bin names; those bins no longer exist in v2 — a dangling
    // registration would silently never fire, so install must rewrite it.
    const v1: HookMatcher[] = [
      { hooks: [{ type: 'command', command: LEGACY_HOOK_BIN, timeout: 2, async: true }] },
    ]
    const r = rebuildEventMatchers(v1, 'Stop', false, HOOK_CMD, GATE_CMD)
    assert.strictEqual(r.removedOurs, 1, 'v1 PATH-bin forwarder must be stripped')
    assert.deepStrictEqual(r.rebuilt.flatMap(m => m.hooks.map(h => h.command)), [HOOK_CMD, REVIEW_CMD])
  })

  test('migration: install over the loose review-gate .js scripts removes them — the verb replaced them (TRDD-6QV50JNN)', () => {
    // Both the loose script and `agentlenspro review-gate` on one event run the same gate twice
    // against the same tmp state file, so the breakers burn at double rate. The installer never
    // registered the scripts, so until this needle existed it never removed them either.
    for (const [ev, script] of [['Stop', 'stop-spawn-review-fork.js'], ['SubagentStop', 'subagent-stop-spawn-review-fork.js']] as const) {
      const live: HookMatcher[] = [
        { hooks: [{ type: 'command', command: `node "$HOME/.claude/hooks/${script}"` }] },
        { hooks: [{ type: 'command', command: HOOK_CMD, timeout: 2, async: true }] },
        { hooks: [{ type: 'command', command: REVIEW_CMD, timeout: 10 }] },
      ]
      const r = rebuildEventMatchers(live, ev, false, HOOK_CMD, GATE_CMD)
      assert.strictEqual(r.removedOurs, 3, `${ev}: the loose script must be stripped along with our two entries`)
      assert.deepStrictEqual(r.rebuilt.flatMap(m => m.hooks.map(h => h.command)), [HOOK_CMD, REVIEW_CMD], `${ev}: exactly one gate remains`)
      assert.ok(!isOurHookCommand('node "$HOME/.claude/hooks/cvoice_stop.sh"'), 'a neighbouring user hook is not ours')
    }
  })

  test('uninstall strips ALL THREE generations — v0 absolute paths, v1 PATH bins, v2 command strings', () => {
    const mixed: HookMatcher[] = [
      { hooks: [{ type: 'command', command: 'bash /old/prefix/spy-agentlens.sh', timeout: 2, async: true }] },
      { hooks: [{ type: 'command', command: LEGACY_HOOK_BIN, timeout: 2, async: true }] },
      { hooks: [{ type: 'command', command: HOOK_CMD, timeout: 2, async: true }] },
      { matcher: GATE_MATCHER, hooks: [{ type: 'command', command: LEGACY_GATE_BIN, timeout: 3 }] },
      { matcher: GATE_MATCHER, hooks: [{ type: 'command', command: GATE_CMD, timeout: 3 }] },
      { matcher: GATE_MATCHER, hooks: [{ type: 'command', command: 'node C:\\old\\spy-agentlens-gate.mjs', timeout: 3 }] },
    ]
    const r = rebuildEventMatchers(mixed, 'PreToolUse', true, HOOK_CMD, GATE_CMD)
    assert.strictEqual(r.removedOurs, 6, 'all six entries across the three generations must be recognised as ours')
    assert.strictEqual(r.rebuilt.length, 0)
  })

  test('isOurHookCommand matches every generation but never a foreign command', () => {
    // The needle set is the migration contract: too narrow orphans old entries, too wide
    // eats another tool's hooks.
    assert.ok(isOurHookCommand('bash /x/spy-agentlens.sh'))
    assert.ok(isOurHookCommand('node /x/spy-agentlens-gate.mjs'))
    assert.ok(isOurHookCommand(LEGACY_HOOK_BIN))
    assert.ok(isOurHookCommand(LEGACY_GATE_BIN))
    assert.ok(isOurHookCommand(HOOK_CMD))
    assert.ok(isOurHookCommand(GATE_CMD))
    assert.ok(isOurHookCommand('agentlenspro  gate'), 'extra whitespace between bin and verb still matches')
    assert.strictEqual(isOurHookCommand('bash /other/janitor-hook.sh'), false)
    assert.strictEqual(isOurHookCommand('agentlenspro list'), false, 'other subcommands are not hook registrations')
    assert.strictEqual(isOurHookCommand('agentlensprod hookx'), false, 'word boundaries must hold')
    assert.strictEqual(isOurHookCommand(undefined), false)
  })

  test('resolveOnPath finds an executable on PATH and returns null for a nonsense name', () => {
    // node is guaranteed present in the test environment; the negative case guards the
    // installer refusal path (registering a name the shell cannot find = silent dead hook).
    assert.ok(resolveOnPath('node'), 'node must resolve on PATH')
    assert.strictEqual(resolveOnPath('agentlenspro-definitely-not-a-bin-xyz'), null)
  })
})
