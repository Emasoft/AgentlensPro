/**
 * Bounded in-memory timeline retention (TRDD-66IXMIGN, fix for TRDD-MFSUMOJ9).
 *
 * TWO bounds, both required — measured, not assumed. The first heap autopsy showed 2.83M retained
 * strings (~330B avg): every entry of every session, so entry COUNT must be capped. Re-running the
 * OOM repro with only the count cap still died: 1.6M strings / 983MB — the mass had concentrated
 * in multi-hundred-KB per-entry payloads (sub-agent prompts, full tool outputs) inside the
 * retained tail. So retained BYTES must be bounded too: a per-entry field cap plus a per-card
 * byte budget. This module is the ONE choke point for all of it — do not re-encode the eviction
 * policy at a push site.
 */
import type { TimelineEntry } from './shared/summarizerTypes'

export const TIMELINE_MAX_ENTRIES_ENV = 'AGENTLENS_TIMELINE_MAX_ENTRIES'
export const TIMELINE_MAX_BYTES_ENV = 'AGENTLENS_TIMELINE_MAX_BYTES'
export const DEFAULT_TIMELINE_MAX_ENTRIES = 2000
/** Per-card budget for retained heavy text, in UTF-16 code units (≈ bytes for ASCII-heavy
 *  transcript text; the point is a bound, not an exact byte count). */
export const DEFAULT_TIMELINE_MAX_BYTES = 2 * 1024 * 1024
/** Cap for any single heavy text field retained in memory (fullResult, prompt, …). Chosen so a
 *  drill-down still shows a substantial head of the output while one 1MB tool result cannot eat a
 *  card's whole byte budget in a handful of entries. */
export const FIELD_MAX_CHARS = 32 * 1024
/** Floor below which the dashboard's trace view stops being useful — a smaller configured value
 *  is clamped up rather than honored. */
const MIN_FLOOR = 50
const MIN_BYTES_FLOOR = 64 * 1024

/** A card-shaped holder: anything carrying a timeline plus the retention counters. Both
 *  `SessionSummaryCard` and logReader's `CardAccum` satisfy it structurally. */
export interface TimelineHolder {
  timeline: TimelineEntry[]
  timelineTruncatedCount?: number
  /** Running cost of the retained entries' heavy fields; maintained by pushBounded/attachFullResult. */
  timelineRetainedBytes?: number
}

export const TIMELINE_HOT_AGE_ENV = 'AGENTLENS_TIMELINE_HOT_AGE_HOURS'
export const DEFAULT_TIMELINE_HOT_AGE_HOURS = 24

let resolvedMaxEntries: number | null = null
let resolvedMaxBytes: number | null = null
let resolvedHotAgeMs: number | null = null

function resolvePositiveInt(env: NodeJS.ProcessEnv, key: string, def: number, floor: number): number {
  const raw = env[key]?.trim()
  if (!raw) return def
  const n = Number(raw)
  // Fail-fast: a present-but-malformed knob crashes at boot instead of silently running unbounded.
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`${key}=${JSON.stringify(raw)} is not a positive integer`)
  }
  return Math.max(floor, n)
}

/** Resolve the entry cap once per process from the ambient environment (memoized — hot path).
 *  An explicit `env` argument (tests) is never memoized. */
export function timelineMaxEntries(env?: NodeJS.ProcessEnv): number {
  if (env === undefined && resolvedMaxEntries !== null) return resolvedMaxEntries
  const v = resolvePositiveInt(env ?? process.env, TIMELINE_MAX_ENTRIES_ENV, DEFAULT_TIMELINE_MAX_ENTRIES, MIN_FLOOR)
  if (env === undefined) resolvedMaxEntries = v
  return v
}

/** Resolve the per-card byte budget once per process (memoized, same contract as above). */
export function timelineMaxBytes(env?: NodeJS.ProcessEnv): number {
  if (env === undefined && resolvedMaxBytes !== null) return resolvedMaxBytes
  const v = resolvePositiveInt(env ?? process.env, TIMELINE_MAX_BYTES_ENV, DEFAULT_TIMELINE_MAX_BYTES, MIN_BYTES_FLOOR)
  if (env === undefined) resolvedMaxBytes = v
  return v
}

/**
 * Force a FLAT copy of a string. `String.prototype.slice` on a large string returns a V8
 * SlicedString that RETAINS THE ENTIRE PARENT — measured on this very bug: a 200-char
 * `resultSummary` slice pinned a 352KB tool output, and `userRequest.slice(0, 500)` pinned a
 * 481KB sub-agent prompt (retainer-edge walk on the third OOM repro, TRDD-66IXMIGN). The Buffer
 * round-trip allocates a fresh flat string with no parent reference. Never "simplify" a
 * truncation back to a bare `.slice()` — that reintroduces the leak while every length-based
 * accounting still looks correct.
 */
export function flatten(s: string): string {
  return Buffer.from(s, 'utf8').toString('utf8')
}

/** Truncate to `maxChars` WITHOUT retaining the parent (see `flatten`). The one sanctioned way
 *  to shorten a transcript-derived string that will be retained. */
export function snip(s: string, maxChars: number): string {
  return s.length <= maxChars ? s : flatten(s.slice(0, maxChars))
}

/** How recently a session must have been active for its card to carry a timeline OUT OF THE
 *  PARSER. Fifth-repro lesson (TRDD-66IXMIGN): per-card bounds don't survive a 12k-file boot
 *  scan — the scan's own results array holds every card before any server-side demotion can run,
 *  so cold sessions must be stripped AT PARSE TIME. */
export function timelineHotAgeMs(env?: NodeJS.ProcessEnv): number {
  if (env === undefined && resolvedHotAgeMs !== null) return resolvedHotAgeMs
  const v = resolvePositiveInt(env ?? process.env, TIMELINE_HOT_AGE_ENV, DEFAULT_TIMELINE_HOT_AGE_HOURS, 1) * 3600_000
  if (env === undefined) resolvedHotAgeMs = v
  return v
}

/** Drop a card's retained timeline (headers stay; the drill view rebuilds from the transcript
 *  if the session turns hot again). Keeps the truncation counter honest. */
export function stripTimeline(holder: TimelineHolder): void {
  if (holder.timeline.length === 0) return
  holder.timelineTruncatedCount = (holder.timelineTruncatedCount ?? 0) + holder.timeline.length
  holder.timeline = []
  holder.timelineRetainedBytes = 0
}

/** Truncate a heavy text field for retention. The marker names what was cut so a drill-down
 *  reader knows the tail exists in the source transcript rather than suspecting a broken parse. */
export function capText(s: string, maxChars: number = FIELD_MAX_CHARS): string {
  if (s.length <= maxChars) return s
  return flatten(s.slice(0, maxChars)) + `\n…[retention: ${s.length - maxChars} chars truncated]`
}

/** Approximate retained cost of one entry: the heavy text fields a transcript can inflate. */
export function entryCost(e: TimelineEntry): number {
  return (e.fullResult?.length ?? 0) + (e.responseText?.length ?? 0) + (e.thinking?.length ?? 0)
    + (e.toolInput?.length ?? 0) + (e.resultSummary?.length ?? 0) + (e.errorMessage?.length ?? 0)
    + e.label.length
}

/** Evict oldest-first until both bounds hold. Keeps the byte accounting consistent. */
function enforceBounds(holder: TimelineHolder, maxEntries: number, maxBytes: number): void {
  const tl = holder.timeline
  let bytes = holder.timelineRetainedBytes ?? 0
  let evict = tl.length > maxEntries ? tl.length - maxEntries : 0
  for (let i = 0; i < evict; i++) bytes -= entryCost(tl[i])
  // Keep at least the newest entry even if it alone busts the budget (legacy uncapped fields).
  while (bytes > maxBytes && evict < tl.length - 1) { bytes -= entryCost(tl[evict]); evict++ }
  if (evict > 0) {
    tl.splice(0, evict)
    holder.timelineTruncatedCount = (holder.timelineTruncatedCount ?? 0) + evict
  }
  holder.timelineRetainedBytes = bytes
}

/**
 * Append an entry, evicting oldest-first once either bound overflows.
 *
 * The COUNT bound is AMORTIZED (the array may grow to `max + max/4` before one splice trims it
 * back to `max`) because a per-push `splice(0, 1)` would be O(n²) over a big transcript on the
 * ingest hot path. The BYTE bound is checked on every push — the compare is O(1) and byte
 * overflows are exactly the case that must not linger.
 *
 * Evicted entries referenced elsewhere (logReader's pendingToolResults map holds entry refs while
 * a tool_result is in flight) simply become detached objects: a late-arriving result mutates an
 * object no longer retained, which is harmless — the entry was already gone from the view.
 */
export function pushBounded(holder: TimelineHolder, entry: TimelineEntry, maxEntries: number, maxBytes: number = timelineMaxBytes()): void {
  holder.timeline.push(entry)
  const bytes = (holder.timelineRetainedBytes ?? 0) + entryCost(entry)
  holder.timelineRetainedBytes = bytes
  const slack = Math.ceil(maxEntries / 4)
  if (holder.timeline.length > maxEntries + slack || bytes > maxBytes) {
    enforceBounds(holder, maxEntries, maxBytes)
  }
}

/**
 * Attach a tool's full output to an already-pushed entry, keeping the byte accounting true.
 * The field itself is capped (FIELD_MAX_CHARS) so one giant output cannot eat the card's whole
 * budget, then the card's bounds are re-enforced. Mutating `entry.fullResult` directly instead of
 * calling this desynchronizes `timelineRetainedBytes` — that is why this helper exists.
 */
export function attachFullResult(holder: TimelineHolder, entry: TimelineEntry, text: string): void {
  const before = entry.fullResult?.length ?? 0
  entry.fullResult = capText(text)
  holder.timelineRetainedBytes = (holder.timelineRetainedBytes ?? 0) + entry.fullResult.length - before
  if (holder.timelineRetainedBytes > timelineMaxBytes()) {
    enforceBounds(holder, timelineMaxEntries(), timelineMaxBytes())
  }
}

/**
 * Trim an existing timeline to the retention bounds, keeping the NEWEST (tail). Used on
 * boot-restore and on slice merge: the durable delta log may hold giant cards written before the
 * cap existed, and loading them uncapped would rebuild the exact heap the cap exists to prevent.
 * Returns the number of entries evicted (caller decides where to record it).
 */
export function capTimeline(timeline: TimelineEntry[], maxEntries: number, maxBytes: number = timelineMaxBytes()): number {
  const keepStart = Math.max(0, timeline.length - maxEntries)
  let bytes = 0
  let i = timeline.length - 1
  for (; i >= keepStart; i--) {
    bytes += entryCost(timeline[i])
    if (bytes > maxBytes) break // timeline[i] overflows the budget → keep only (i+1 .. end)
  }
  let start = i >= keepStart ? i + 1 : keepStart
  // Keep at least the newest entry even if it alone busts the budget (legacy uncapped fields).
  if (timeline.length > 0 && start >= timeline.length) start = timeline.length - 1
  if (start > 0) timeline.splice(0, start)
  return start
}
