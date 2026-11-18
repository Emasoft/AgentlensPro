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
import { dataDir } from '../dataDir'
import { readHookEvents } from '../hookEventStore'
import { toLifecycleEvent, type ResumeStaleness } from '../lifecycleEvents'
import { hookCaptureStop } from './killSwitch'
import { queryStatusline } from '../statuslineStore'

/** The harness's OWN resume-staleness verdict (CC 2.1.251 `SessionStart source=resume`) for one
 *  session — --json ONLY, never the one-word stdout contract those two fields feed. Reads the
 *  newest SessionStart hook record for this exact session id straight off disk (no server), the
 *  same store `last-compact` already reads without one. Walks the newest 20 SessionStart records newest-first and returns the first
 *  one that carries a resume verdict (a newer non-resume SessionStart is skipped, an older resume still answers). `null` covers four cases alike: no
 *  SessionStart on record, none of the 20 carries a resume verdict (pre-2.1.251, or not a resume), or the record reached first predates the armed
 *  kill-switch (see below) — all four mean
 *  "nothing to add", not an error. */
export function latestResumeStaleness(sessionId: string): ResumeStaleness | null {
  const recs = readHookEvents(path.join(dataDir(), 'hook-events'), { session: sessionId, ev: 'SessionStart', limit: 20 })
  // B6 (TRDD-RBBEX59R e): under the kill-switch no SessionStart is stored, so a record stamped before the flag file's mtime may be only the
  // last resume from BEFORE the switch (a later resume of this session would be missing). Records come newest-first and the FIRST one
  // older than the arm time ends the walk with null, even when an older record would carry a resume verdict; a resume stamped at or after
  // the arm time still resolves. Env half only: there is no arm time, so every record is untrusted and the result is null. Not knowable =
  // nothing to add, the same null the no-data cases return.
  const stopped = hookCaptureStop()
  for (const rec of recs) {
    if (stopped && (stopped.armedAtMs === null || rec.ts < stopped.armedAtMs)) return null
    const ev = toLifecycleEvent(rec)
    if (ev?.resumeStaleness) return ev.resumeStaleness
  }
  return null
}

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
 *  clock comparison against the newest sample's `expires_at`. Read off DISK (the capture write-ahead files first, then the last seven days of the store, sealed parts included), so
 *  it works with the server down; older payloads without the block fall back to the server tool.
 *  Field names verified against a LIVE row on 2026-09-01 (TRDD-YE15B2JK step 1), flattened by
 *  `flattenSample` to `prompt_cache_expires_at` etc. */
export interface AuthoritativeVerdict {
  expired: boolean
  sessionId: string
  workspace: string
  expiresAtMs: number
  ttl: string
  sampleTs: number
  /** The harness's own warm bit, TRI-STATE: `null` when the row carries a deadline but no bit. It
   *  used to be collapsed to `=== true`, which turned "no bit" into "not warm" — and `cache-state`
   *  then printed `cold` for a question it could not resolve (the adversarial review of
   *  TRDD-DCWJY2JJ caught it; unreachable on every captured row so far, but the published contract
   *  said never). `cache-expired` itself never branches on this — it reads `expired`. */
  warm: boolean | null
  /** Every `prompt_cache_*` key of the row, VERBATIM as the store flattened it. `cache-state --json`
   *  prints these so a consumer pins its reader to the fields the harness actually sends; a field
   *  added upstream (e.g. `prompt_cache_probe`, seen NULL on 2026-09-02) rides through untouched. A row read from a sealed part carries every prompt_cache column of the window, null where the sample had no such field. */
  promptCache: Record<string, unknown>
}

/** A write-ahead file larger than this is read from its LAST bytes only (TRDD-ETFX9JFM box 3): the newest rows are
 *  at the end, and reading a multi-hundred-MiB file whole for a one-word verb was the measured cost. A session with
 *  no row in that tail is answered by `authoritativeFromParts`, whose DuckDB reader streams the whole file. */
export const WAL_TAIL_BYTES = 32 * 1024 * 1024

/** The text of a write-ahead file, or of its last `maxBytes` bytes when it is larger. In the cut case the first
 *  line is partial, so everything up to and including the first newline is dropped. */
export function readWalTail(file: string, maxBytes: number = WAL_TAIL_BYTES): string {
  const size = fs.statSync(file).size
  if (size <= maxBytes) return fs.readFileSync(file, 'utf8')
  const fd = fs.openSync(file, 'r')
  try {
    const buf = Buffer.alloc(maxBytes)
    const got = fs.readSync(fd, buf, 0, maxBytes, size - maxBytes)
    const text = buf.subarray(0, got).toString('utf8')
    const nl = text.indexOf('\n')
    return nl < 0 ? '' : text.slice(nl + 1)
  } finally {
    fs.closeSync(fd)
  }
}

/** ONE parsed sample row -> a verdict, or null when the row does not answer the filter. Shared by the write-ahead
 *  scan and the store query so the two paths cannot drift (TRDD-ETFX9JFM). */
function verdictFromRow(row: Record<string, unknown>, session: string | undefined, wantProject: string | undefined): AuthoritativeVerdict | null {
  const expSec = row.prompt_cache_expires_at
  const ts = row.ts
  if (typeof expSec !== 'number' || typeof ts !== 'number') return null // pre-2.1.252 payload
  if (session) {
    if (row.session_id !== session) return null
  } else if (wantProject) {
    const rowProject = typeof row.workspace_project_dir === 'string' ? path.resolve(row.workspace_project_dir) : null
    if (rowProject !== wantProject) return null
  }
  return {
    expired: Date.now() >= expSec * 1000,
    sessionId: String(row.session_id ?? '?'),
    workspace: String(row.workspace_project_dir ?? row.cwd ?? '?'),
    expiresAtMs: expSec * 1000,
    ttl: String(row.prompt_cache_ttl ?? '?'),
    sampleTs: ts,
    warm: typeof row.prompt_cache_warm === 'boolean' ? row.prompt_cache_warm : null,
    promptCache: Object.fromEntries(Object.entries(row).filter(([k]) => k.startsWith('prompt_cache_'))),
  }
}

export function authoritativeFromWals(project: string | undefined, session: string | undefined): AuthoritativeVerdict | null {
  // Write-ahead files only: the newest sample of any RUNNING session is in one within seconds (~3 s cadence).
  // A session whose newest row was already sealed into a part is answered by `authoritativeFromParts`
  // (TRDD-ETFX9JFM); callers use `authoritativeFromStore`, which asks both. Scan the TWO newest day
  // partitions, not one: batches are filed by WRITE day, so a row can sit in the neighbouring partition
  // around midnight (the measured partition-slack trap).
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
        text = readWalTail(path.join(dir, wal))
      } catch { continue }
      for (const line of text.split('\n')) {
        if (!line) continue
        let row: Record<string, unknown>
        // The writer appends live; the LAST line can be mid-write. A torn line is skipped, never
        // fatal — every complete row before it still counts.
        try { row = JSON.parse(line) as Record<string, unknown> } catch { continue }
        if (best && typeof row.ts === 'number' && row.ts <= best.sampleTs) continue
        const v = verdictFromRow(row, session, wantProject)
        if (v) best = v
      }
    }
  }
  return best
}

/** How far back `authoritativeFromParts` reads. Measured on the live store 2026-11-18 (recorded on TRDD-ETFX9JFM):
 *  this query without the session filter, two runs each: 2 days about 0.3 s of CPU and 65 MB, 7 days about 0.45 s and
 *  77 MB; with no bound DuckDB ran out of memory at 1.8 GiB. This function itself, 7 days with the project filter:
 *  161 ms, 0.21 s of CPU, 85 MB. Seven days covers a session sealed before a weekend. */
export const PARTS_LOOKBACK_MS = 7 * 86_400_000

/** The same verdict from the last seven days of the store (sealed parts, and the write-ahead files the store
 *  relation also reads), through the DuckDB reader the CLI already ships. Asked only when the write-ahead scan
 *  found no row (TRDD-ETFX9JFM): with the server down, an idle session whose last sample was sealed got no answer.
 *  One newest row per session that carries the prompt_cache block. The columns are NAMED, not `to_json(s)`: the
 *  all-column form failed on a window with no bound (the failing column was not identified). Each `prompt_cache_*` column comes back as JSON text, so
 *  nested values survive; a column the sample did not carry is null (a write-ahead row has no such key at all).
 *  Null when there is no store. */
export async function authoritativeFromParts(project: string | undefined, session: string | undefined): Promise<AuthoritativeVerdict | null> {
  const wantProject = project ? path.resolve(project) : undefined
  const sessionSql = session ? ` AND s.session_id = '${session.replace(/'/g, "''")}'` : ''
  const sql = 'SELECT s.ts AS ts, s.session_id AS session_id, s.workspace_project_dir AS workspace_project_dir, s.cwd AS cwd, '
    + `CAST(to_json(COLUMNS('^prompt_cache_')) AS VARCHAR) FROM samples s WHERE s.prompt_cache_expires_at IS NOT NULL${sessionSql} `
    + 'QUALIFY row_number() OVER (PARTITION BY s.session_id ORDER BY s.ts DESC) = 1'
  const rows = await queryStatusline(statuslineRoot(), 'main', sql, { sinceMs: Date.now() - PARTS_LOOKBACK_MS })
  if (rows === null) return null
  let best: AuthoritativeVerdict | null = null
  for (const r of rows) {
    const row: Record<string, unknown> = { ts: Number(r.ts), session_id: r.session_id, workspace_project_dir: r.workspace_project_dir, cwd: r.cwd }
    for (const [k, v] of Object.entries(r)) {
      if (k.startsWith('prompt_cache_')) row[k] = v === null ? null : JSON.parse(String(v))
    }
    const v = verdictFromRow(row, session, wantProject)
    if (v && (!best || v.sampleTs > best.sampleTs)) best = v
  }
  return best
}

/** What both verbs call: the write-ahead scan first (no DuckDB start for a running session), the store only when
 *  it finds nothing. Known gap, its own card (TRDD-NY373D41): a row sealed by one writer that is NEWER than the
 *  newest write-ahead row of another writer is missed, because the store is asked only on a miss. */
export async function authoritativeFromStore(project: string | undefined, session: string | undefined): Promise<AuthoritativeVerdict | null> {
  return authoritativeFromWals(project, session) ?? await authoritativeFromParts(project, session)
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
    const auth = await authoritativeFromStore(session ? undefined : project, session)
    if (auth) {
      if (asJson) {
        const resumeStaleness = latestResumeStaleness(auth.sessionId)
        console.log(JSON.stringify(
          { source: 'statusline-prompt-cache', ...auth, ...(resumeStaleness ? { resumeStaleness } : {}) },
          null, 2,
        ))
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
