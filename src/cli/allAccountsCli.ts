// src/cli/allAccountsCli.ts — `agentlenspro get_account_status --all`, answered WITHOUT the server.
//
// WHY IT BYPASSES THE SERVER. The plural answer is assembled entirely from files (the account-state
// timeline + the per-account usage archive), and its audience is a rotator deciding what to do about a
// machine that is already in trouble. Proxying it to a server that may itself be down turns the one
// useful answer into `cannot reach http://localhost:4316/mcp` — measured, before this existed. The
// singular form still goes over the wire: it needs live-session accessors only the server has.
//
// Same honesty contract as statusline-history: an empty roster is BLIND (exit 1, "cannot see"), never
// "no accounts".

import * as fs from 'fs'
import * as path from 'path'
import {
  listAllAccounts, selectAccountsWithHeadroom,
  type AccountStatusRow, type AccountWindow, type HeadroomSelection,
} from '../allAccounts'
import { loadToken } from '../subscriptionUsage'
import { EXIT as CLI_EXIT } from './cliErrors'
import { assertKnownFlags } from './argHelpers'

const KNOWN_FLAGS = new Set(['--help', '-h', '--out', '--model', '--threshold', '--with-headroom', '--json'])
const VALUED_FLAGS = new Set(['--out', '--model', '--threshold'])

export const ALL_ACCOUNTS_USAGE = `agentlenspro get_account_status --all [flags]

Every account this machine has been on — not just the live one. No credential is read: each row is
what was OBSERVED while that account was live, stamped, with a per-window freshness.

freshness, per window:
  fresh       measured inside the cache TTL
  aged        past the TTL but the window has NOT reset — the number is a LOWER bound
  rolled      the window reset AND this machine was already off the account when the new one began,
              so ~0% — INFERRED, not measured; audit it with the 'left' column
  stale       reset, but activity since cannot be excluded -> null with a reason
  unreadable  never observed -> null with a reason. NEVER an absent row: "cannot read this account"
              and "this account has no headroom" are opposite signals

flags:
  --json            machine-readable output (every field, including the reasons)
  --out FILE        write the full report to FILE; print only a one-line digest
  --model NAME      rotation query: which accounts still have headroom for this model's OWN weekly
                    window (e.g. --model fable; case-insensitive substring on the payload's model
                    name) AND in both account-wide windows. Adds a three-way verdict:
                      available            pick from the matches (best-first)
                      none-with-headroom   EVERY account is positively spent — switch model
                      indeterminate        no match but >=1 account unreadable — "cannot tell",
                                           never reported as "none"
  --with-headroom   rotation query without a model: accounts whose 5h AND 7d windows are both
                    under the threshold. Same verdict vocabulary.
  --threshold N     "used up" cut for the queries above, percent 1..100 (default 100 — only a
                    window AT 100%+ counts as spent; lower it to demand a safety margin)

With --json the rotation queries ADD a 'selection' block (which also names the live account) to
the unchanged full answer, so existing consumers of --all --json keep working.

exit: 0 = answered (including an honest "none-with-headroom") · 2 = BLIND (no account ever
observed — "cannot see", NOT "no accounts") · 64 = bad command line`

/** The house contract (./cliErrors): BLIND is the "could not answer honestly" code (2), usage is
 *  EX_USAGE (64). BLIND was 1 during development; unified with the CLI-wide exit vocabulary before
 *  the feature's first mainline release so no consumer ever meets the drifted values. */
export const EXIT = { OK: CLI_EXIT.OK, BLIND: CLI_EXIT.UNKNOWN, USAGE: CLI_EXIT.USAGE } as const

/** A window in one cell: the verdict, and the number only when there IS one. `-` is not 0. */
function cell(w: AccountWindow): string {
  return w.percent === null ? w.freshness : `${w.percent}% ${w.freshness}`
}

function row(a: AccountStatusRow): string[] {
  return [
    a.isLive ? '*' : '',
    String(a.accountId ?? '-').slice(0, 8),
    String(a.email ?? '-'),
    a.plan,
    cell(a.fiveHour),
    cell(a.sevenDay),
    a.observedAt === null ? 'never' : `${Math.round((a.staleSeconds ?? 0) / 60)}m ago`,
    a.leftAt === null ? '(on it)' : new Date(a.leftAt).toISOString().slice(5, 16).replace('T', ' '),
  ]
}

const HEAD = ['', 'account', 'email', 'plan', '5h window', '7d window', 'observed', 'left']

function table(rows: string[][]): string {
  const all = [HEAD, ...rows]
  const w = HEAD.map((_, i) => Math.max(...all.map(r => r[i].length)))
  const line = (r: string[]): string => r.map((s, i) => s.padEnd(w[i])).join('  ').trimEnd()
  return [line(HEAD), line(w.map(n => '-'.repeat(Math.max(1, n)))), ...rows.map(line)].join('\n')
}

/** The rotation verdict for humans: the one line a rotator's operator needs, with the "none" and
 *  "cannot tell" cases spelled out instead of implied by an empty table. */
function selectionText(sel: HeadroomSelection): string {
  const what = sel.query.model ? `'${sel.query.model}' headroom` : `headroom (5h AND 7d < ${sel.query.threshold}%)`
  const lines: string[] = [
    sel.liveAccountId
      ? `live account: ${sel.liveAccountId.slice(0, 8)}`
      : 'live account: unknown (no live account identified)',
  ]
  if (sel.verdict === 'available') {
    lines.push(`HEADROOM AVAILABLE for ${what} — ${sel.matches.length} account(s), best first:`)
    for (const m of sel.matches) {
      const gates = m.gates.map(g => `${g.gate} ${g.window.percent}%`).join(', ')
      lines.push(`  ${String(m.accountId ?? '-').slice(0, 8)}  ${m.email ?? '-'}${m.isLive ? '  (live)' : ''}  [${m.confidence}]  ${gates}`)
    }
  } else if (sel.verdict === 'none-with-headroom') {
    lines.push(`NO ACCOUNT HAS HEADROOM for ${what} — every observed account is positively spent.`)
    lines.push('Switch model (or wait for a reset), then re-query, e.g. with --with-headroom.')
  } else {
    lines.push(`INDETERMINATE for ${what} — no account qualifies, but not all could be read, so`)
    lines.push('"none" cannot be honestly claimed. Unreadable/undecided accounts below.')
  }
  for (const e of sel.exhausted) lines.push(`  spent: ${String(e.accountId ?? '-').slice(0, 8)}  ${e.email ?? '-'} — ${e.why}`)
  for (const u of sel.undecidable) lines.push(`  undecided: ${String(u.accountId ?? '-').slice(0, 8)}  ${u.email ?? '-'} — ${u.why}`)
  return lines.join('\n')
}

export function runAllAccountsCli(argv: string[]): number {
  if (argv.includes('--help') || argv.includes('-h')) { console.log(ALL_ACCOUNTS_USAGE); return EXIT.OK }
  // A typo'd flag used to be silently ignored and exit 0 (TRDD-PIB6T4RU).
  assertKnownFlags(argv, KNOWN_FLAGS, VALUED_FLAGS, 'agentlenspro get_account_status --all --help')
  const outIdx = argv.indexOf('--out')
  const outFile = outIdx >= 0 && argv[outIdx + 1] && !argv[outIdx + 1].startsWith('--') ? argv[outIdx + 1] : undefined

  // Rotation-query flags (TRDD-1UTH3B3V). A flag given without its value is a caller mistake and
  // must exit 64, not silently degrade into the unfiltered report a script would then mis-parse.
  const modelIdx = argv.indexOf('--model')
  if (modelIdx >= 0 && (!argv[modelIdx + 1] || argv[modelIdx + 1].startsWith('--'))) {
    console.error('--model needs a value (e.g. --model fable)'); return EXIT.USAGE
  }
  const model = modelIdx >= 0 ? argv[modelIdx + 1] : null
  const thIdx = argv.indexOf('--threshold')
  let threshold = 100
  if (thIdx >= 0) {
    threshold = Number(argv[thIdx + 1])
    if (!Number.isFinite(threshold) || threshold < 1 || threshold > 100) {
      console.error('--threshold needs a percent in 1..100'); return EXIT.USAGE
    }
  }
  const wantSelection = model !== null || argv.includes('--with-headroom') || thIdx >= 0

  const answer = listAllAccounts()
  if (answer.blind) {
    console.error('BLIND: no account has ever been observed on this machine.\n'
      + 'This is "cannot see", NOT "no accounts" — the account-state timeline is empty. It fills as '
      + 'the server observes sessions; if it never does, capture is not running.')
    return EXIT.BLIND
  }

  // WHEN EVERY ROW IS UNREADABLE, SAY WHY. A table of `unreadable` with no explanation reads as "the
  // tool is broken" — and the cause is usually one operational fact (no token this process may read),
  // which the user can act on in seconds once it is named. Diagnosing it here costs one file check.
  // Keyed on the LIVE account, not on "all of them". A non-live account with no reading is expected —
  // only its own credential can answer for it, and this machine may simply not have been on it since
  // capture began. The LIVE account having none is the state a readable token would fix, and it is
  // also the row a reader is most likely to be looking at.
  let diagnosis = ''
  const live = answer.accounts.find(a => a.isLive)
  if ((live ? live.observedAt === null : true) || answer.accounts.every(a => a.observedAt === null)) {
    const t = loadToken()
    diagnosis = t.token
      ? '\n\nNo account has a usage reading yet. A token IS readable, so the next refresh should fill '
        + 'this — the server captures one at startup, hourly, and on every account change.'
      : `\n\nNo account has a usage reading, and NO TOKEN is readable by this process (${t.reason}).`
        + (t.reason === 'opt_in_required'
          ? ' On macOS the credential lives in the login keychain and reading it is opt-in, because an\n'
            + 'un-ACL\'d read pops a password prompt. To let the SERVER refresh these numbers, set\n'
            + '  AGENTLENS_READ_KEYCHAIN_USAGE=1\n'
            + 'in the environment it starts in, then `agentlenspro server restart`. Setting it only for\n'
            + 'this CLI does nothing: the fetch happens server-side.'
          : '')
  }

  // A human needs the archive verdict as much as a program does (issue #9 §4): without it, rows that
  // can never refresh again look exactly like rows that simply have not changed.
  const archiveLine = answer.archive.maintained
    ? ''
    : `\n\n⚠ these rows are NOT being refreshed — ${answer.archive.reason}`

  const selection = wantSelection ? selectAccountsWithHeadroom(answer, { model, threshold }) : null

  const text = argv.includes('--json')
    // Additive: the full answer keeps its exact prior shape; a rotation query only ADDS `selection`.
    ? JSON.stringify(selection ? { ...answer, selection } : answer, null, 2)
    : (selection ? `${selectionText(selection)}\n\n` : '')
    + `${table(answer.accounts.map(row))}\n\n${answer.note}`
    + `\n\nReasons for every null are in --json; '*' marks the live account.${archiveLine}${diagnosis}`

  if (outFile) {
    fs.mkdirSync(path.dirname(path.resolve(outFile)), { recursive: true })
    fs.writeFileSync(outFile, text.endsWith('\n') ? text : `${text}\n`)
    console.log(`${answer.accounts.length} account(s) → ${outFile}`)
  } else {
    console.log(text)
  }
  return EXIT.OK
}
