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
import { listAllAccounts, type AccountStatusRow, type AccountWindow } from '../allAccounts'

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
  --json       machine-readable output (every field, including the reasons)
  --out FILE   write the full report to FILE; print only a one-line digest`

export const EXIT = { OK: 0, BLIND: 1, USAGE: 2 } as const

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

export function runAllAccountsCli(argv: string[]): number {
  if (argv.includes('--help') || argv.includes('-h')) { console.log(ALL_ACCOUNTS_USAGE); return EXIT.OK }
  const outIdx = argv.indexOf('--out')
  const outFile = outIdx >= 0 && argv[outIdx + 1] && !argv[outIdx + 1].startsWith('--') ? argv[outIdx + 1] : undefined

  const answer = listAllAccounts()
  if (answer.blind) {
    console.error('BLIND: no account has ever been observed on this machine.\n'
      + 'This is "cannot see", NOT "no accounts" — the account-state timeline is empty. It fills as '
      + 'the server observes sessions; if it never does, capture is not running.')
    return EXIT.BLIND
  }

  const text = argv.includes('--json')
    ? JSON.stringify(answer, null, 2)
    : `${table(answer.accounts.map(row))}\n\n${answer.note}`
    + `\n\nReasons for every null are in --json; '*' marks the live account.`

  if (outFile) {
    fs.mkdirSync(path.dirname(path.resolve(outFile)), { recursive: true })
    fs.writeFileSync(outFile, text.endsWith('\n') ? text : `${text}\n`)
    console.log(`${answer.accounts.length} account(s) → ${outFile}`)
  } else {
    console.log(text)
  }
  return EXIT.OK
}
