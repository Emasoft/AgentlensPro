// TRDD-F1VX3M7C — the supervisor's exit policy. Fail-closed embed-key boot (and the DISABLED
// kill-switch) exit EX_CONFIG (78): a DELIBERATE config refusal, not a crash. Respawning it would
// just re-refuse forever — the documented hook-revive crash loop. So the supervisor treats 78 as
// TERMINAL (stop, don't restart) while every other non-clean exit is a crash that gets the
// backoff-respawn. The live handler's terminal branch calls process.exit(78), so the decision is
// factored into the pure predicate isTerminalExit() and pinned here without spawning a process.
import * as assert from 'assert'
import { isTerminalExit } from '../cli/serverControl'

suite('supervisor exit policy — EX_CONFIG(78) is terminal, crashes respawn (TRDD-F1VX3M7C)', () => {
  test('exit 78 (EX_CONFIG config refusal) is terminal — the supervisor must not respawn it', () => {
    assert.strictEqual(isTerminalExit(78), true)
  })
  test('a clean exit 0 is not a config refusal (it is a deliberate stop, handled elsewhere)', () => {
    assert.strictEqual(isTerminalExit(0), false)
  })
  test('a generic error exit 1 is a crash — respawns, not terminal', () => {
    assert.strictEqual(isTerminalExit(1), false)
  })
  test('a V8 OOM abort (code 134) is a crash — respawns, not terminal', () => {
    assert.strictEqual(isTerminalExit(134), false)
  })
  test('a signal kill (code null) is a crash — respawns, not terminal', () => {
    assert.strictEqual(isTerminalExit(null), false)
  })
})
