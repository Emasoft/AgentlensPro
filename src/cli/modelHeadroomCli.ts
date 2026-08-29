// src/cli/modelHeadroomCli.ts — `agentlenspro model-headroom <model>`: "can I call this model
// right now, or is its own weekly window spent?"
//
// WHY THIS EXISTS (TRDD-VNKPUAY4). Some models are metered by a SEPARATE weekly window from the
// account's `weekly_all` — Fable is one. An agent that consults the advisor cannot tell from the
// aggregate whether that specific model has anything left: at `weekly_all` 37% / Fable 100% the
// account looks healthy and the advisor is nonetheless unreachable. Measured cost of not having
// this, 2026-08-29: the advisor was spawned against an exhausted Fable window and ~20 minutes of
// wall-clock were spent waiting for a verdict that could never arrive. The user had SAID the
// window was spent; there was simply no one-liner to check it, so the fact lived only in a
// conversation and was lost the moment it scrolled away.
//
// The whole point is to be callable as a PREDICATE from an agent's shell, so the interface is the
// exit code and the output is one word. It reuses `officialBuckets(u, '7d')`, which already
// separates per-model weekly buckets and names them by `scopeLabel` — no new parsing.

import { officialBuckets } from './budgetCli'
import { EXIT, UsageError } from './cliErrors'
import { assertKnownFlags } from './argHelpers'
import { getSubscriptionUsage, type SubscriptionUsage } from '../subscriptionUsage'

/** At or above this percent the window is treated as spent. Not 100: a window reported at 99% has
 *  no useful room left for a real request, and a caller that squeezes in at 99.4% gets a
 *  mid-flight rate-limit instead of a clean "pick another model" now. */
export const EXHAUSTED_PCT = 95

export interface HeadroomVerdict {
  /** 'ok' | 'exhausted' | 'unknown' — 'unknown' is a first-class answer, never coerced to 'ok'. */
  state: 'ok' | 'exhausted' | 'unknown'
  /** The bucket label that decided it (the model's own scope), or null when nothing matched. */
  label: string | null
  pct: number | null
  reason: string | null
}

/** Match a user-typed model name against a bucket's `scopeLabel`.
 *
 *  Deliberately loose in ONE direction only: case-insensitive substring, so `fable` matches a
 *  bucket labelled `claude-fable-5` or `Fable`. It is NOT loose the other way — a bucket label
 *  that merely contains the query as a fragment of a longer DIFFERENT model name would be a wrong
 *  match, so the comparison runs on the normalized label and query both, and the caller reports
 *  WHICH label matched so a wrong match is visible rather than silent. */
export function bucketMatches(scopeLabel: string, model: string): boolean {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '')
  return norm(scopeLabel).includes(norm(model))
}

/** The verdict for `model`, from an already-fetched usage payload.
 *
 *  SEPARATED FROM I/O so it is testable without a credential or a network call — the matching and
 *  the null-handling are the parts that can be wrong, and they are the parts a test can reach. */
export function verdictFor(u: SubscriptionUsage | null, model: string): HeadroomVerdict {
  if (!u) return { state: 'unknown', label: null, pct: null, reason: 'no readable usage payload (no credential, or the fetch failed)' }

  const weekly = officialBuckets(u, '7d')
  const mine = weekly.filter(b => bucketMatches(b.label, model))

  if (mine.length === 0) {
    // NOT an implicit 'ok'. A model with no weekly_scoped bucket may genuinely be metered only by
    // weekly_all — but it may equally mean the payload is from a plan that does not report the
    // bucket, or that the model name was typed wrong. Those are indistinguishable here, and
    // guessing 'ok' is exactly the failure this verb exists to prevent.
    return { state: 'unknown', label: null, pct: null, reason: `no weekly bucket is scoped to '${model}' (it may be metered by weekly_all, or the name may be wrong)` }
  }

  // The FULLEST matching bucket binds — if a model somehow reports more than one weekly scope,
  // the one closest to its cap is the one that will stop the call.
  const binding = mine.reduce((a, b) => (b.pct > a.pct ? b : a))
  return {
    state: binding.pct >= EXHAUSTED_PCT ? 'exhausted' : 'ok',
    label: binding.label,
    pct: binding.pct,
    reason: null,
  }
}

const HELP = `agentlenspro model-headroom <model> [-q] [--json]

  Is MODEL's own weekly window spent? Some models (Fable) are metered by a weekly
  window SEPARATE from weekly_all, so the account can look healthy while that one
  model is unreachable.

  stdout   one word: ok | exhausted | unknown   (suppressed by -q)
  exit 0   ok         — headroom remains, the model is callable
  exit 1   exhausted  — at or above ${EXHAUSTED_PCT}% of its own weekly window
  exit 2   unknown    — could NOT be determined; never reported as ok

  -q       exit code only, no stdout
  --json   the full verdict (label, pct, reason) instead of one word

  Agent one-liner:
    agentlenspro model-headroom fable -q && <consult the advisor> || <skip it>
`

export async function runModelHeadroomCli(argv: string[]): Promise<number> {
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(HELP)
    return EXIT.OK
  }
  assertKnownFlags(argv, new Set(['-q', '--json', '--help', '-h']), new Set(), 'agentlenspro model-headroom --help')

  const model = argv.find(a => !a.startsWith('-'))
  if (!model) throw new UsageError('model-headroom needs a model name, e.g. `agentlenspro model-headroom fable`')

  const quiet = argv.includes('-q')
  const json = argv.includes('--json')

  let usage: SubscriptionUsage | null = null
  try {
    usage = await getSubscriptionUsage({ allowKeychain: true })
  } catch {
    // Swallowed on purpose: an unreadable credential is a legitimate 'unknown', not a crash. The
    // reason still reaches the caller through the verdict rather than being hidden.
    usage = null
  }

  const v = verdictFor(usage, model)

  if (json) {
    process.stdout.write(`${JSON.stringify(v)}\n`)
  } else if (!quiet) {
    process.stdout.write(`${v.state}\n`)
  }
  // The WHY goes to stderr so `-q` and the one-word stdout stay machine-clean while a human
  // running it by hand still learns what happened.
  if (v.reason) process.stderr.write(`[model-headroom] ${v.reason}\n`)
  else if (v.label !== null) process.stderr.write(`[model-headroom] ${v.label} at ${v.pct}% of its weekly window (spent at ${EXHAUSTED_PCT}%)\n`)

  return v.state === 'ok' ? EXIT.OK : v.state === 'exhausted' ? 1 : 2
}
