// src/cli/cliErrors.ts — the exit-code contract shared by the long-lived watcher commands.
//
// standalone/cli.ts maps every THROWN error to exit 1. That is fine for a human, and wrong for a
// harness: `budget --watch` uses exit 1 to mean "abort the run", so a mistyped flag would look
// exactly like a legitimate abort and kill a batch for the wrong reason — while the operator
// reads "abort" and goes looking for a burn that never happened. A caller-error therefore needs
// a code of its own, and this repo already speaks sysexits (the server exits EX_CONFIG 78 on a
// config refusal), so EX_USAGE 64 is the house answer rather than a new invention.

/** A caller mistake — a bad flag, a missing value, an impossible combination. Distinct from a
 *  runtime failure so the two can never share an exit code. */
export class UsageError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UsageError'
  }
}

export const EXIT = {
  /** Normal completion, or a verdict that permits the run to proceed. */
  OK: 0,
  /** The watcher's own signal to stop the work it is guarding. */
  ABORT: 1,
  /** The question could not be answered honestly (no calibration, no value in the feed). */
  UNKNOWN: 2,
  /** sysexits EX_USAGE — the command line was wrong. Never emitted by a healthy invocation. */
  USAGE: 64,
} as const

export type ExitCode = (typeof EXIT)[keyof typeof EXIT]
