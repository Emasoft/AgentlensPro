// src/cli/cacheStateCli.ts — `agentlenspro cache-state`: is THIS project's main conversation riding
// a WARM prompt-cache prefix right now, or is it COLD? One word on stdout, and the exit code IS the
// answer (0 = warm, 1 = cold, 2 = cannot answer).
//
// WHY A SECOND VERB NEXT TO cache-expired (TRDD-DCWJY2JJ, issue #19). Same row, opposite question.
// `cache-expired` answers "has the deadline passed?" as `true`/`false` with exit 0 = answered, so a
// consumer that wants to branch on "can I still ride the warm prefix?" had to invert it in the shell
// and got no word to log. This is that row PROJECTED to one word plus the predicate exit codes. It
// resolves the row through the same reader (`authoritativeFromWals`) — never a second copy of the
// selection logic — and keeps the same tri-state contract: a question that cannot be resolved exits
// 2 with stdout EMPTY, never `cold`. "The cache is cold" and "I could not tell" lead to opposite
// actions (re-plan the turn vs find out first), so they must never share a word.
//
// THE VERDICT IS ANCHORED ON THE DEADLINE, NOT ON THE RAW `warm` BIT. `prompt_cache_warm` is the
// harness's verdict AT SAMPLE TIME, and the status line refreshes only on activity, so an idle
// session's newest row keeps saying `warm:true` long past its `expires_at` — stale in exactly one
// direction, toward the wrong action ("hold"). MEASURED on 26,690 live rows (this machine,
// 2026-09-01, CC 2.1.258): `warm:false` appeared ONLY with an already-passed deadline (4,141 rows,
// lead −1.4 s … −43 min) and `warm:true` ONLY with a future one (22,398 rows) — the bit is a snapshot
// of the same comparison the clock makes here. So: cold iff the clock is past `expires_at` OR the
// harness itself said not-warm; warm only when both agree. The bit is kept in the formula so a
// future payload that says not-warm with a live deadline still reads cold, the safe direction.

import { authoritativeFromWals, type AuthoritativeVerdict } from './cacheExpiredCli'
import { EXIT } from './cliErrors'
import { assertKnownFlags, flagValue } from './argHelpers'

export const CACHE_STATE_USAGE = `agentlenspro cache-state [flags]

Is this project's MAIN conversation's prompt cache warm or cold RIGHT NOW? Prints one word —
'warm' (the next request re-reads the prefix at ~0.1x) or 'cold' (it re-writes the whole prefix at
~1.25x/2x) — and the exit code is the same answer, so a shell can branch without reading stdout.

Scoped to the current project by default; the resolved session is announced on stderr so a piped
stdout stays exactly one word. Authoritative, not inferred: Claude Code >=2.1.252 states the cache
deadline itself (prompt_cache.expires_at in the status-line payload) and this verb reads the newest
captured sample off disk — no server needed. Cold iff that deadline has passed or the harness itself
reported the cache not warm.

flags:
  --project DIR        scope to DIR instead of the current directory
  --session ID         ask about one exact session id (skips the project pick)
  --json               the stored prompt_cache fields verbatim, plus state, session_id, captured_at

exit:
  0 = warm · 1 = cold · 2 = cannot answer (stdout EMPTY: no recent sample carries the block —
  the session is idle past the WAL window, absent, or on a Claude Code before 2.1.252) · 64 = bad flags

  A shell predicate:  if agentlenspro cache-state >/dev/null; then echo "warm — keep the turn small"; fi
  A value:            [ "$(agentlenspro cache-state)" = cold ] && echo "expect a full prefix rewrite"
  The stale case:     agentlenspro cache-state || [ $? = 2 ] && ...   # 2 is NOT cold`

/** Exit codes: the 0/1 predicate convention (`test`, `grep -q`), with 2 (the house EX_UNKNOWN) kept
 *  distinct from cold — the distinction the whole verb exists for. */
export const CACHE_STATE_EXIT = { WARM: 0, COLD: 1 } as const

/** The one-word verdict, or `null` for "cannot answer". Exported so the unit test pins the formula
 *  itself, not just the CLI shell around it. A PASSED deadline settles it alone (cold, whatever the
 *  bit says); a live deadline needs the harness's bit — `true` warm, `false` cold, and a row that
 *  carries the deadline but NO bit is `null`, never cold: the contract is that an unresolvable
 *  question exits 2, and "cold" is a verdict a caller acts on. */
export function cacheStateOf(row: Pick<AuthoritativeVerdict, 'expiresAtMs' | 'warm'>, nowMs = Date.now()): 'warm' | 'cold' | null {
  if (nowMs >= row.expiresAtMs) return 'cold'
  if (row.warm === null) return null
  return row.warm ? 'warm' : 'cold'
}

const KNOWN = new Set(['--project', '--session', '--json', '--help', '-h'])
const VALUED = new Set(['--project', '--session'])

export function runCacheStateCli(argv: string[]): number {
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(CACHE_STATE_USAGE)
    return EXIT.OK
  }
  // A typo'd flag must never be silently ignored: `--sesion X` would otherwise answer for the
  // current project with full confidence.
  assertKnownFlags(argv, KNOWN, VALUED, 'agentlenspro cache-state --help')

  const asJson = argv.includes('--json')
  const session = flagValue(argv, '--session', 'a session id')
  // `--session` addresses one session directly, so a project filter could only contradict it.
  const project = flagValue(argv, '--project', 'a directory') ?? process.cwd()
  const row = authoritativeFromWals(session ? undefined : project, session)

  if (!row) {
    // The ONE shape every cannot-answer takes: stdout untouched, the WHY on stderr, EX_UNKNOWN.
    // Deliberately NO fall-through to the server's idle-time inference here (unlike cache-expired):
    // a session whose newest row was already sealed into parquet has been idle long enough that
    // "cannot answer" IS the honest word, and a DuckDB read for a one-word verb is not worth its cost.
    console.error(
      `cannot answer: no status-line sample with a prompt_cache block for ` +
      `${session ? `session ${session}` : `project ${project}`} — the session is idle past the WAL ` +
      `window, absent, or on a Claude Code before 2.1.252. For the inferred answer: agentlenspro cache-expired`,
    )
    return EXIT.UNKNOWN
  }

  const state = cacheStateOf(row)
  if (state === null) {
    // A deadline with no warm bit: the harness said WHEN the cache lapses but not whether it is
    // warm now. Printing `cold` here would be the proxy read the contract forbids.
    console.error(
      `cannot answer: the newest sample for session ${row.sessionId.slice(0, 8)} carries a prompt_cache ` +
      `deadline (${row.ttl}, expires in ${Math.round((row.expiresAtMs - Date.now()) / 60000)}min) but no warm bit`,
    )
    return EXIT.UNKNOWN
  }
  if (asJson) {
    // The stored fields VERBATIM (flattened `prompt_cache_*` keys exactly as captured), so the
    // consumer pins its reader to what the harness actually sends, not to changelog prose.
    console.log(JSON.stringify({ state, session_id: row.sessionId, captured_at: row.sampleTs, ...row.promptCache }, null, 2))
  } else {
    // Which session was measured goes to STDERR: stdout stays exactly one word, and a wrong-repo
    // answer can never masquerade as a right one.
    const mins = Math.round(Math.abs(row.expiresAtMs - Date.now()) / 60000)
    console.error(
      `session ${row.sessionId.slice(0, 8)} in ${row.workspace} — harness-reported (ttl ${row.ttl}, ` +
      `warm ${row.warm}) ${Date.now() >= row.expiresAtMs ? `expired ${mins}min ago` : `expires in ${mins}min`}`,
    )
    console.log(state)
  }
  return state === 'warm' ? CACHE_STATE_EXIT.WARM : CACHE_STATE_EXIT.COLD
}
