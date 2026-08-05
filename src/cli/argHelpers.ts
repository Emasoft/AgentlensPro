// src/cli/argHelpers.ts — flag-parsing primitives shared by the long-lived watcher commands.
// Extracted because `watch` and `budget` had grown their own private copies, and two copies of a
// validator is how one of them quietly stops rejecting something the other still catches.

import { UsageError } from './cliErrors'

/** A numeric flag value. Rejects a missing value and NaN rather than coercing to 0 — a silent 0
 *  threshold would make a watcher alert on everything, which reads as a broken feed.
 *  Infinity is rejected too: `--interval 1e999` would otherwise clamp to a finite bound and
 *  quietly mean something else than what was typed. */
export function numArg(v: string | undefined, flag: string): number {
  if (v === undefined || v === '') throw new UsageError(`${flag} expects a number`)
  const n = Number(v)
  if (!Number.isFinite(n)) throw new UsageError(`${flag} expects a finite number, got "${v}"`)
  return n
}

/** A string flag value. A following `--flag` means the value was omitted; taking it as the value
 *  would silently consume the next flag and change what the command does.
 *
 *  `what` names the expected value ("a path", "a destination directory") for commands where the
 *  generic wording is not enough to act on. It defaults to the original text, so existing callers —
 *  and the tests that assert their messages — are unchanged.
 *
 *  MEASURED, on the three surfaces that did NOT route through here: `agentlenspro --out --json`
 *  exited 0 and wrote a file literally named "--json"; `agentlenspro env user --out --json` did the
 *  same; and `agentlenspro --export-bodies --json` exported **345 MB / 542 raw request bodies** into
 *  a directory named "--json" in the cwd. This file's own header warns that a second copy of a
 *  validator is how one of them quietly stops rejecting — those three were the case where there was
 *  no copy at all. Every flag that takes a value goes through this function. */
export function strArg(v: string | undefined, flag: string, what = 'a value'): string {
  if (!v || v.startsWith('--')) throw new UsageError(`${flag} expects ${what}`)
  return v
}

export function clamp(v: number, lo: number, hi: number): number {
  if (!Number.isFinite(v)) return lo
  return Math.min(hi, Math.max(lo, v))
}
