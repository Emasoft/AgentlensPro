// src/lastCompact.ts — "how long ago did this project compact?", answered from the hook-event store.
//
// WHY THE HOOK STORE AND NOTHING ELSE. A compaction leaves several traces, and only one of them
// carries the two facts this question needs together. The transcript's summary entry proves a
// compaction happened but not whether a human typed /compact or the window auto-compacted; the OTEL
// `claude_code.compaction` span and the COMPACTION cache-break cause are INFERENCES from token
// shape. `PreCompact` is the event itself: Claude Code fires it as the compaction starts, with
// `trigger` ('manual' | 'auto') and `cwd` in the payload — verified against the live store, both
// triggers present. It is also plain NDJSON on disk, so this answers while the server is down.
//
// THE ANCHOR IS PreCompact, NOT PostCompact, because the question is when the compaction was
// EXECUTED. PostCompact is when it finished; it is reported alongside when a matching one exists,
// since "started 40min ago, still finishing" and "done 40min ago" are different situations.
//
// NOT-FOUND IS NEVER ZERO. "No compaction on record" must never render as "0s ago" — that is the
// opposite claim (just compacted) and it is the one mistake here that would actively mislead a
// caller deciding whether the prefix is fresh. The absence is returned as its own state, with the
// retention horizon named, because the store keeps ~31 days: "not in the retained window" is what
// the data supports, never "never happened".

import * as fs from 'fs'
import * as path from 'path'
import { readHookEvents, type HookEventRecord } from './hookEventStore'
import { formatIdle } from './cacheExpiry'

export type CompactTrigger = 'manual' | 'auto'

export interface LastCompactHit {
  found: true
  /** Epoch-ms the compaction STARTED (the PreCompact fire). */
  atMs: number
  atIso: string
  /** now − atMs. Never negative: a clock-skewed future stamp clamps to 0. */
  ageMs: number
  ageSeconds: number
  /** "2h 14m" · "5m 30s" · "45s" — the same formatter the cache-expiry verdict uses. */
  ageHuman: string
  /** 'manual' = someone typed /compact; 'auto' = the context window forced it. Unknown triggers
   *  pass through verbatim rather than being coerced into one of the two. */
  trigger: string
  sessionId: string | null
  cwd: string | null
  /** When the matching PostCompact was found: the completion stamp and how long it took. */
  completedAtMs: number | null
  completedAtIso: string | null
  durationMs: number | null
}

export interface LastCompactMiss {
  found: false
  /** How far back the scan actually looked — the honest bound on "no compaction". */
  windowDays: number
  reason: string
}

export type LastCompactResult = LastCompactHit | LastCompactMiss

export interface LastCompactOptions {
  /** Absolute project root; a record matches when its `cwd` is AT or UNDER it. Null = any project. */
  project?: string | null
  /** Restrict to one session id. */
  session?: string | null
  /** Restrict to one trigger. Omit for either — an auto-compact costs the same full rewrite a
   *  manual one does, so "when did this project last compact" means both unless asked otherwise. */
  trigger?: CompactTrigger | null
  /** How far back to scan. Defaults to the store's retention horizon; the store holds daily
   *  buckets, so a wide window costs a directory listing plus a few small reads. */
  windowDays?: number
  nowMs?: number
  /** Injected for tests; production passes <dataDir>/hook-events. */
  dir: string
}

/** Default scan horizon — the hook store's own retention (AGENTLENS_HOOK_EVENTS_RETENTION_DAYS,
 *  default 31). Scanning further cannot find anything: the buckets are gone. */
export const DEFAULT_COMPACT_WINDOW_DAYS = 31

/** Is `cwd` AT or UNDER `root`? Path-boundary aware: a bare startsWith makes /x/y match the
 *  sibling /x/y-old, and a worktree at <root>/.claude/worktrees/<n> must still count as the
 *  project — it is the same conversation lineage. */
export function cwdUnder(cwd: string | null | undefined, root: string): boolean {
  if (!cwd) return false
  const c = path.resolve(cwd).replace(/\/+$/, '')
  const r = path.resolve(root).replace(/\/+$/, '')
  return c === r || c.startsWith(`${r}/`)
}

function payloadStr(rec: HookEventRecord, key: string): string | null {
  const v = rec.payload?.[key]
  return typeof v === 'string' && v !== '' ? v : null
}

/**
 * Does this record belong to `root`, comparing the recorded cwd BOTH as written and as resolved?
 *
 * Symlinks are why, and it is not hypothetical: on macOS `/var` is a symlink to `/private/var`, so
 * a record whose cwd is `/var/…/proj` never matches a root the CLI resolved to `/private/var/…/proj`
 * — the project would report "never compacted" while its compaction sits in the store. The same
 * shape hits any symlinked checkout. The CLI resolves the ROOT; the payload arrives in whatever form
 * Claude Code stamped, so both sides are tried. A cwd that no longer exists cannot be resolved —
 * then the recorded string is all there is, and it is still compared.
 */
function matchesProject(cwd: string | null, root: string, memo: Map<string, string>): boolean {
  if (!cwd) return false
  if (cwdUnder(cwd, root)) return true
  let real = memo.get(cwd)
  if (real === undefined) {
    try { real = fs.realpathSync(cwd) } catch { real = cwd }
    memo.set(cwd, real)
  }
  return real !== cwd && cwdUnder(real, root)
}

/**
 * Newest compaction matching the filters, or an explicit miss.
 *
 * Reads PreCompact newest-first through the store's own bounded reader. The `limit` is generous
 * rather than 1: the filters (project, session, trigger) are applied HERE, so asking the store for
 * a single record would return the newest compaction on the MACHINE and then discard it as
 * out-of-scope, reporting "none" for a project that compacted minutes ago.
 */
export function findLastCompact(opts: LastCompactOptions): LastCompactResult {
  const nowMs = opts.nowMs ?? Date.now()
  const windowDays = opts.windowDays && opts.windowDays > 0 ? opts.windowDays : DEFAULT_COMPACT_WINDOW_DAYS
  const sinceMs = nowMs - windowDays * 86_400_000

  const pre = readHookEvents(opts.dir, { ev: 'PreCompact', sinceMs, limit: 1000 })
  const realMemo = new Map<string, string>()   // one realpath syscall per distinct cwd, not per record
  const match = pre.find(r => {
    if (opts.project && !matchesProject(payloadStr(r, 'cwd'), opts.project, realMemo)) return false
    if (opts.session && r.session !== opts.session) return false
    if (opts.trigger && payloadStr(r, 'trigger') !== opts.trigger) return false
    return true
  })

  if (!match) {
    const scope = [
      opts.project ? `project ${opts.project}` : null,
      opts.session ? `session ${opts.session}` : null,
      opts.trigger ? `trigger ${opts.trigger}` : null,
    ].filter(Boolean).join(', ')
    return {
      found: false,
      windowDays,
      reason:
        `no compaction recorded in the last ${windowDays} day(s)${scope ? ` for ${scope}` : ''}. ` +
        'That is "none on record", NOT "never" — the hook store retains a bounded window, and it is ' +
        'empty entirely if lifecycle capture was never installed (agentlenspro --install-hooks).',
    }
  }

  // The matching completion, when one is on record: same session, at or after the start, nearest.
  // Absent for a compaction still in flight, and for one whose PostCompact was lost — reported as
  // null either way rather than guessed from the next event of any kind.
  let completedAtMs: number | null = null
  if (match.session) {
    const post = readHookEvents(opts.dir, { ev: 'PostCompact', session: match.session, sinceMs: match.ts, limit: 50 })
    for (const p of post) {
      if (p.ts < match.ts) continue
      if (completedAtMs === null || p.ts < completedAtMs) completedAtMs = p.ts
    }
  }

  const ageMs = Math.max(0, nowMs - match.ts)
  return {
    found: true,
    atMs: match.ts,
    atIso: new Date(match.ts).toISOString(),
    ageMs,
    ageSeconds: Math.round(ageMs / 1000),
    ageHuman: formatIdle(ageMs),
    trigger: payloadStr(match, 'trigger') ?? 'unknown',
    sessionId: match.session ?? null,
    cwd: payloadStr(match, 'cwd'),
    completedAtMs,
    completedAtIso: completedAtMs === null ? null : new Date(completedAtMs).toISOString(),
    durationMs: completedAtMs === null ? null : Math.max(0, completedAtMs - match.ts),
  }
}
