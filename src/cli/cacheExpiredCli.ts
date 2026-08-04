// src/cli/cacheExpiredCli.ts — `agentlenspro cache-expired`: has THIS project's main conversation
// outlived its prompt-cache TTL? One word on stdout, `true` or `false`.
//
// WHY A VERB FOR SOMETHING A TOOL ALREADY COMPUTES. `check_cache_expiry` answers the same question
// and stays the place the verdict is computed — this adds nothing to the model and duplicates none
// of it. What it adds is a SHAPE a shell can consume. Measured against the real consumer (the
// janitor asking "is the cache expired, true or false?"), the tool payload is three problems in a
// trench coat: the answer is `sessions[0].verdict` inside a JSON object, so the caller must parse;
// the exit code is 0 whether the cache is fresh or expired, so nothing can branch on `$?`; and the
// default target was the newest main session MACHINE-WIDE, which in a live probe returned a session
// in an unrelated repo with nothing saying so. The scoping half is fixed in the tool itself (its
// `project` arg); this file is the boolean half.
//
// THE ONE THING THIS MUST NEVER DO is answer `false` when it does not know. "The cache is warm" and
// "I could not tell" lead to opposite decisions — one says proceed, the other says find out first —
// so an unresolvable question exits 2 (the house EX_UNKNOWN) with stdout EMPTY, and never prints a
// word a caller could read as a verdict.

import { callTool } from './cliCore'
import { EXIT, UsageError } from './cliErrors'

export const CACHE_EXPIRED_USAGE = `agentlenspro cache-expired [flags]

Has this project's MAIN conversation outlived its prompt-cache TTL? Prints one word — 'true'
(expired: the next request re-writes the whole prefix at ~1.25x) or 'false' (still warm).

Scoped to the current project by default, because "my cache" is the only question worth a boolean;
the resolved session is announced on stderr so a piped stdout stays exactly one word.

flags:
  --project DIR        scope to DIR instead of the current directory
  --session ID         ask about one exact session id (skips the project pick)
  --threshold-minutes N  override the TTL with an explicit idle cutoff (e.g. 60 = "idle > 1h")
  --quiet, -q          print NOTHING; the exit code alone is the answer (see below)
  --json               the full verdict object instead of the word

exit:
  default    0 = answered, stdout is 'true' or 'false' · 2 = cannot answer (stdout empty) · 64 = bad flags
  --quiet    0 = EXPIRED · 1 = fresh · 2 = cannot answer · 64 = bad flags

  A shell predicate:  if agentlenspro cache-expired -q; then echo "cold — expect a full rewrite"; fi
  A value:            [ "$(agentlenspro cache-expired)" = true ] && ...`

/** The tool's row, narrowed to what a boolean needs. Everything else rides through in --json. */
interface ExpiryRow {
  verdict?: unknown
  sessionId?: unknown
  workspace?: unknown
  idleHuman?: unknown
  ttlMin?: unknown
  reason?: unknown
}

interface ExpiryPayload {
  sessions?: ExpiryRow[]
  scope?: { project?: unknown; sessionsInScope?: unknown }
  error?: unknown
}

/** Exit codes in --quiet mode. 0/1 is the universal predicate convention (`test`, `grep -q`), and
 *  2 keeps "cannot answer" distinct from "fresh" — the distinction the whole command exists for. */
const QUIET = { EXPIRED: 0, FRESH: 1 } as const

function flagValue(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name)
  if (i < 0) return undefined
  const v = argv[i + 1]
  // `--project --json` must not resolve to a directory literally named "--json".
  if (v === undefined || v.startsWith('--')) throw new UsageError(`${name} needs a value`)
  return v
}

const KNOWN = new Set(['--project', '--session', '--threshold-minutes', '--quiet', '-q', '--json', '--help', '-h'])
const VALUED = new Set(['--project', '--session', '--threshold-minutes'])

export async function runCacheExpiredCli(argv: string[]): Promise<number> {
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(CACHE_EXPIRED_USAGE)
    return EXIT.OK
  }
  // An unknown flag must never be silently ignored here: a caller who typo'd `--treshold-minutes`
  // would otherwise get a confident boolean measured against the wrong cutoff.
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (VALUED.has(a)) { i++; continue }
    if (!KNOWN.has(a)) throw new UsageError(`unknown flag "${a}" — see: agentlenspro cache-expired --help`)
  }

  const quiet = argv.includes('--quiet') || argv.includes('-q')
  const asJson = argv.includes('--json')
  const session = flagValue(argv, '--session')
  const thresholdRaw = flagValue(argv, '--threshold-minutes')
  let thresholdMinutes: number | undefined
  if (thresholdRaw !== undefined) {
    thresholdMinutes = Number(thresholdRaw)
    if (!Number.isFinite(thresholdMinutes) || thresholdMinutes <= 0) {
      throw new UsageError(`--threshold-minutes expects a positive number of minutes, got "${thresholdRaw}"`)
    }
  }
  // The project arg is passed EXPLICITLY (never left to the diagnostics cwd-forwarding) so this
  // verb's scope is decided in one readable place. `--session` addresses a session directly, so a
  // project filter there could only contradict it — omit it and let the id win.
  const args: Record<string, unknown> = session
    ? { sessionId: session }
    : { project: flagValue(argv, '--project') ?? process.cwd() }
  if (thresholdMinutes !== undefined) args.thresholdMinutes = thresholdMinutes

  // A cannot-answer, in the ONE shape every failure must take: stdout untouched, the WHY on stderr,
  // EX_UNKNOWN. Never a word on stdout — a caller reading stdout must never mistake a diagnosis for
  // a verdict.
  const cannotAnswer = (why: string): number => {
    console.error(`cannot answer: ${why}`)
    return EXIT.UNKNOWN
  }

  let payload: ExpiryPayload
  try {
    payload = await callTool('check_cache_expiry', args, false) as ExpiryPayload
  } catch (e) {
    // The verdict needs the server (it owns the session cards and the TTL-regime resolution). Being
    // honestly blind here beats a disk-only guess: this command's whole value is that `false` is
    // trustworthy. Deliberately NOT rethrown — an escaped throw exits 1, which in --quiet mode IS
    // the word "fresh".
    return cannotAnswer(`${(e as Error).message}. The verdict needs the running server — try: agentlenspro server start`)
  }

  if (typeof payload?.error === 'string') return cannotAnswer(payload.error)

  const row = payload?.sessions?.[0]
  if (!row) {
    const scoped = typeof payload?.scope?.project === 'string' ? payload.scope.project : null
    return cannotAnswer(
      scoped
        ? `no session found for project ${scoped}. If this project's conversation is running, its ` +
          'first LLM call may not be ingested yet; --project DIR names another, --session ID one exactly.'
        : 'no session matched.',
    )
  }

  const verdict = row.verdict
  if (verdict !== 'fresh' && verdict !== 'expired') {
    // 'unknown' from the tool means no LLM request was ever recorded for that session — a real
    // answer to a different question, and NOT a licence to print `false`.
    return cannotAnswer(
      `${typeof row.reason === 'string' ? row.reason : `verdict '${String(verdict)}'`}` +
      ` (session ${String(row.sessionId ?? '?').slice(0, 8)})`,
    )
  }

  const expired = verdict === 'expired'
  if (asJson) {
    console.log(JSON.stringify({ expired, ...payload }, null, 2))
    return EXIT.OK
  }
  if (quiet) return expired ? QUIET.EXPIRED : QUIET.FRESH

  // Which session was measured goes to STDERR: stdout stays exactly one word, and a caller that
  // named no project can still see which one it got — a wrong-repo answer must never be able to
  // masquerade as a right one (the defect this verb was built after).
  console.error(
    `session ${String(row.sessionId ?? '?').slice(0, 8)} in ${String(row.workspace ?? '?')} — ` +
    `idle ${String(row.idleHuman ?? '?')} vs ${String(row.ttlMin ?? '?')}min TTL`,
  )
  console.log(expired ? 'true' : 'false')
  return EXIT.OK
}
