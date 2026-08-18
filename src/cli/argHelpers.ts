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

/** A named flag's value, looked up by name rather than consumed positionally.
 *
 *  An ABSENT flag returns undefined — legal, and what an optional flag means. A flag that IS PRESENT
 *  with a missing or flag-shaped value is a UsageError, because returning undefined there is a silent
 *  DROP: the command runs as if the flag had never been typed and reports success.
 *
 *  That is the more dangerous half of what strArg guards, and it was live in two views.
 *  MEASURED: `statusline-history sessions --session --json` discarded the filter and returned **14
 *  sessions instead of 1** with exit 0 — a WRONG ANSWER, not a missing file — and `ctxmap --list
 *  --limit --json` silently fell back to the default 20. Both had a local helper that mapped a
 *  flag-shaped value to undefined specifically to avoid writing a file named "--json"; avoiding the
 *  junk file was right, and discarding the caller's intent to do it was not.
 *
 *  `bareOk` is for a flag that is legally valueless — `--project` alone means "the directory I am
 *  in", so `--project --json` is the documented spelling, not a mistake, and must not be refused. */
export function flagValue(argv: string[], name: string, what = 'a value', bareOk = false): string | undefined {
  const i = argv.indexOf(name)
  if (i < 0) return undefined
  const v = argv[i + 1]
  if (bareOk && (v === undefined || v.startsWith('--'))) return undefined
  return strArg(v, name, what)
}

export function clamp(v: number, lo: number, hi: number): number {
  if (!Number.isFinite(v)) return lo
  return Math.min(hi, Math.max(lo, v))
}

/** Refuse any `--flag`/`-x` token not in `known`. `valued` names the subset that consumes the
 *  NEXT token as its value (skipped rather than checked against `known`) — everything else,
 *  including bare positionals like a view or subcommand name, is the caller's own job to judge.
 *
 *  Extracted from `cacheExpiredCli.ts` and `lastCompactCli.ts`, which had each grown an
 *  identical copy of this loop (TRDD-PIB6T4RU): a typo'd flag was silently ignored by every
 *  OTHER command (`list --definitely-not-a-real-flag`, `server status --x`,
 *  `statusline-history project --x` all exited 0), because nothing routed them through the one
 *  place this was already enforced. One shared loop means a fix here fixes every caller instead
 *  of the two that happened to have their own copy. */
export function assertKnownFlags(argv: string[], known: ReadonlySet<string>, valued: ReadonlySet<string>, helpHint: string): void {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (valued.has(a)) { i++; continue }
    if (a.startsWith('-') && !known.has(a)) throw new UsageError(`unknown flag "${a}" — see: ${helpHint}`)
  }
}
