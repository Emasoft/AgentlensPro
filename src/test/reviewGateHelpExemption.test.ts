/**
 * TRDD-J2K6IM4R — the three rules inside `hasStandaloneHelp` that the first test of the
 * `--help` exemption (reviewGateTriggers.test.ts) did not pin on the must-still-arm side.
 *
 * Why these live in their own file: each case is one test, so a regression names the rule that
 * broke instead of stopping a shared loop at its first failing entry. Each was shown able to
 * fail on 2026-10-05 by removing the rule it names from the source.
 *
 * The invocations are improbable on purpose: the gate classifies command TEXT before anything
 * runs, and it must arm whenever the text could still reach a write handler.
 */
import * as assert from 'assert'
import { commandWriteReason } from '../cli/reviewGateTriggers'

const CWD = '/proj'

suite('review gate: the --help exemption must still arm (TRDD-J2K6IM4R)', () => {
  test('a --help after a bare `--` and another token is positional data, so the verb still arms', () => {
    // Pins `if (args[i] === '--') return false`. The older case `... -- --help` does not: there
    // the token before --help is `--`, which the option-value guard already rejects.
    assert.strictEqual(
      commandWriteReason('fastedit edit f.ts --replace x --snippet s -- x --help', CWD),
      'fastedit edit',
    )
  })

  test('-h directly after an option is the value of that option, so the verb still arms', () => {
    // Pins the option-value guard for the short spelling; every older must-arm case used --help.
    assert.strictEqual(commandWriteReason('fastedit edit f.ts --dry-run -h', CWD), 'fastedit edit')
  })

  test('memgrep write verb with --help directly after an option still arms', () => {
    // Pins the guard at the memgrep call site; the older test covers memgrep only on the exempt side.
    assert.strictEqual(
      commandWriteReason('memgrep new-mem-atom --title --help', CWD),
      'memgrep new-mem-atom',
    )
  })
})
