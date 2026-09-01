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

import * as fs from 'fs'
import * as path from 'path'
import { callTool } from './cliCore'
import { EXIT, UsageError } from './cliErrors'
import { assertKnownFlags } from './argHelpers'
import { statuslineRoot } from './statuslineHistoryCli'

export const CACHE_EXPIRED_USAGE = `agentlenspro cache-expired [flags]

Has this project's MAIN conversation outlived its prompt-cache TTL? Prints one word — 'true'
(expired: the next request re-writes the whole prefix at ~1.25x) or 'false' (still warm).

Scoped to the current project by default, because "my cache" is the only question worth a boolean;
the resolved session is announced on stderr so a piped stdout stays exactly one word.

On Claude Code >=2.1.252 the answer is AUTHORITATIVE, not inferred: the harness reports the cache
deadline itself (prompt_cache.expires_at in the statusline payload) and this verb reads the newest
captured sample off disk — no server needed. Older payloads fall back to the server's idle-time
inference, as does --threshold-minutes (an explicit inference override).

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

/** The AUTHORITATIVE answer, when Claude Code ≥2.1.252 has said it outright. The statusline payload
 *  now carries a `prompt_cache` block — `expires_at` (epoch SECONDS), `ttl`, `warm` — computed by
 *  the harness itself, so "is the cache expired?" needs no idle-time inference at all: it is a
 *  clock comparison against the newest sample's `expires_at`. Read off DISK (the capture WALs), so
 *  it works with the server down; older payloads without the block fall back to the server tool.
 *  Field names verified against a LIVE row on 2026-09-01 (TRDD-YE15B2JK step 1), flattened by
 *  `flattenSample` to `prompt_cache_expires_at` etc. */
interface AuthoritativeVerdict {
  expired: boolean
  sessionId: string
  workspace: string
  expiresAtMs: number
  ttl: string
  sampleTs: number
  warm: boolean
}

export function authoritativeFromWals(project: string | undefined, session: string | undefined): AuthoritativeVerdict | null {
  // WALs only: the newest sample of any RUNNING session is in a WAL within seconds (~3 s cadence).
  // A session whose newest row was already sealed into parquet has been idle long enough that the
  // server-side inference answers it fine — not worth a DuckDB dependency here. Scan the TWO newest
  // day partitions, not one: batches are filed by WRITE day, so a row can sit in the neighbouring
  // partition around midnight (the measured partition-slack trap).
  const streamDir = path.join(statuslineRoot(), 'main')
  let days: string[]
  try {
    days = fs.readdirSync(streamDir).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort().slice(-2)
  } catch {
    return null // no store at all — fall back
  }
  const wantProject = project ? path.resolve(project) : undefined
  let best: AuthoritativeVerdict | null = null
  for (const day of days) {
    const dir = path.join(streamDir, day)
    let wals: string[]
    try {
      wals = fs.readdirSync(dir).filter((f) => f.startsWith('wal-') && f.endsWith('.ndjson'))
    } catch { continue }
    for (const wal of wals) {
      let text: string
      try {
        text = fs.readFileSync(path.join(dir, wal), 'utf8')
      } catch { continue }
      for (const line of text.split('\n')) {
        if (!line) continue
        let row: Record<string, unknown>
        // The writer appends live; the LAST line can be mid-write. A torn line is skipped, never
        // fatal — every complete row before it still counts.
        try { row = JSON.parse(line) as Record<string, unknown> } catch { continue }
        const expSec = row.prompt_cache_expires_at
        const ts = row.ts
        if (typeof expSec !== 'number' || typeof ts !== 'number') continue // pre-2.1.252 payload
        if (session) {
          if (row.session_id !== session) continue
        } else if (wantProject) {
          const rowProject = typeof row.workspace_project_dir === 'string' ? path.resolve(row.workspace_project_dir) : null
          if (rowProject !== wantProject) continue
        }
        if (best && ts <= best.sampleTs) continue
        best = {
          expired: Date.now() >= expSec * 1000,
          sessionId: String(row.session_id ?? '?'),
          workspace: String(row.workspace_project_dir ?? row.cwd ?? '?'),
          expiresAtMs: expSec * 1000,
          ttl: String(row.prompt_cache_ttl ?? '?'),
          sampleTs: ts,
          warm: row.prompt_cache_warm === true,
        }
      }
    }
  }
  return best
}

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
  assertKnownFlags(argv, KNOWN, VALUED, 'agentlenspro cache-expired --help')

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
  const project = flagValue(argv, '--project') ?? process.cwd()
  const args: Record<string, unknown> = session
    ? { sessionId: session }
    : { project }
  if (thresholdMinutes !== undefined) args.thresholdMinutes = thresholdMinutes

  // AUTHORITATIVE PATH FIRST (Claude Code ≥2.1.252): the harness states the expiry outright in the
  // statusline payload, so when a sample carrying it exists, no inference and no server is needed.
  // `--threshold-minutes` is an explicit request for the idle-cutoff INFERENCE, so it keeps the
  // server path — an override the harness's own deadline would silently ignore is worse than none.
  if (thresholdMinutes === undefined) {
    const auth = authoritativeFromWals(session ? undefined : project, session)
    if (auth) {
      if (asJson) {
        console.log(JSON.stringify({ source: 'statusline-prompt-cache', ...auth }, null, 2))
        return EXIT.OK
      }
      if (quiet) return auth.expired ? QUIET.EXPIRED : QUIET.FRESH
      const mins = Math.round(Math.abs(auth.expiresAtMs - Date.now()) / 60000)
      console.error(
        `session ${auth.sessionId.slice(0, 8)} in ${auth.workspace} — harness-reported ` +
        `(ttl ${auth.ttl}) ${auth.expired ? `expired ${mins}min ago` : `expires in ${mins}min`}`,
      )
      console.log(auth.expired ? 'true' : 'false')
      return EXIT.OK
    }
  }

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
