/**
 * Exact per-element cache classification (TRDD-2LH25PBB).
 *
 * Given the elements of one request and the elements of the previous request OF THE SAME STREAM,
 * decide for every element whether it was re-read from the prompt cache, re-written into it, or sent
 * as uncached fresh input. Runtime-neutral and pure: no I/O, no Node, no DOM — the store calls it at
 * ingest to precompute the boundary, and the dashboard calls it to render.
 *
 * Every rule below was MEASURED on this machine on 2026-09-03, not inferred from documentation, and
 * three of them are counter-intuitive enough that getting them wrong yields a confident false
 * verdict rather than an obvious failure. The evidence lives in
 * reports/trace-redesign/20260903_195756+0200-pairing-and-system0.md.
 */

/** The order the cache prefix is built in. NOT the order the fields appear in the JSON body. */
export const CACHE_ORDER = ['tools', 'system', 'messages'] as const
export type CachePath = (typeof CACHE_ORDER)[number]

/** One addressable piece of a request: a tool schema, a system block, or a message. */
export interface RequestElement {
  path: CachePath
  /** Index within its own field, as sent. */
  idx: number
  /**
   * Content identity. MUST be built with `elementKey()` (or a hash of its output) — raw bytes are
   * not the identity here, and using them agreed with billed usage on 0 of 300 measured turns.
   */
  key: string
  /** Exact byte length. Never an estimate. */
  bytes: number
  /** True when this element carries a `cache_control` marker, i.e. the prefix is stored here. */
  breakpoint: boolean
  /**
   * True when the element is NOT part of the cache key, so changing it costs nothing. The known
   * case is the `x-anthropic-billing-header` system block — see `isKeyExcludedText`.
   */
  keyExcluded?: boolean
}

export type ElementClass =
  | 'cache-read' // byte-identical prefix, re-read at the cheap rate
  | 'cache-write' // inside the cacheable region but past the surviving boundary
  | 'fresh-input' // beyond the last breakpoint, so not cached at all this turn

/**
 * The billing header changes on EVERY request (it carries `cc_prev_req`) and is NOT part of the
 * cache key: measured over 738/738 consecutive main-thread pairs, `cache_read` was never 0 (min
 * 55,547, median 457,521, mean hit ratio 0.99235) even though this block differed every time.
 *
 * This predicate is load-bearing. Treating the header as key material puts the first divergence at
 * cache-order index 84 on every single turn, which would classify all ~138 later elements as a
 * re-write and report a total prefix loss on an account measurably running at 99% hit.
 */
export function isKeyExcludedText(text: string): boolean {
  // Accepts the STORED form too. The element as captured is the whole JSON block,
  // `{"type":"text","text":"x-anthropic-billing-header: …"}`, so a prefix test on the raw block
  // returns false and the exclusion silently does nothing — measured during validation.
  return /x-anthropic-billing-header/i.test(text.slice(0, 200))
}

const CACHE_CONTROL = 'cache_control'

function stripCacheControl(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(stripCacheControl)
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (k === CACHE_CONTROL) continue
      out[k] = stripCacheControl(val)
    }
    return out
  }
  return v
}

/**
 * Content identity for an element — the value `RequestElement.key` MUST be built from.
 *
 * Raw bytes are NOT the identity, and using them falsifies the whole classifier: measured over 300
 * real turns, raw-byte identity agreed with billed usage on 0 of them (median structural read share
 * 0.267 against a billed 0.998), while this normalization agrees on 296 (median error 1.6e-4).
 *
 * The reason is that Claude Code moves its trailing `cache_control` marker onto each new last
 * message, and the move mutates that message TWICE:
 *   (a) the key toggles: `…,"is_error":false,"cache_control":{…}}` <-> `…,"is_error":false}`
 *   (b) the shape changes: `content:"…"` <-> `content:[{"type":"text","text":"…","cache_control":{…}}]`
 *       — a bare string has nowhere to hang a marker, so it gets wrapped.
 * A purely textual strip fixes (a) only and still fails 176 of 300 turns; both must be normalized.
 *
 * Anthropic does not bill either mutation as a change — the billed read share stays at 0.998 through
 * them — so the marker and its wrapper are outside the cache key, the same status the billing header
 * has. Unparseable input falls back to the raw text rather than throwing, so a capture oddity
 * degrades to byte identity instead of losing the element.
 */
export function elementKey(raw: string): string {
  try {
    const parsed = JSON.parse(raw) as unknown
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const obj = parsed as Record<string, unknown>
      if (typeof obj['content'] === 'string') {
        obj['content'] = [{ type: 'text', text: obj['content'] }]
      }
    }
    return JSON.stringify(stripCacheControl(parsed))
  } catch {
    return raw
  }
}

const rankOf = (p: CachePath): number => CACHE_ORDER.indexOf(p)

/**
 * Elements in cache order: every tool, then every system block, then every message.
 *
 * The wire body of a real request puts messages FIRST, then system, then tools (measured:
 * `messages[476]` at byte 1,581,228, `system[2]` at 1,582,883, `system[3]` at 1,598,483). Diffing in
 * wire order would report a changed early message as invalidating all 84 tool schemas — false, and
 * false in the expensive direction.
 */
export function cacheOrder(elements: readonly RequestElement[]): RequestElement[] {
  return [...elements].sort((a, b) => rankOf(a.path) - rankOf(b.path) || a.idx - b.idx)
}

export interface Divergence {
  /** Index into the cache-ordered CURRENT elements, or -1 when the two are identical so far. */
  index: number
  /**
   * The same point expressed in the PREVIOUS request's coordinates. The two differ whenever the
   * requests hold a different number of key-excluded elements, because the walk skips those
   * independently on each side. `survivingBoundary` scans the previous request, so it must be given
   * this one; passing `index` there silently mixes coordinate systems and mis-places the boundary.
   */
  prevIndex: number
  /** The element that differs, when there is one. */
  element?: RequestElement
  /** Its counterpart in the previous request, when the position existed there. */
  previous?: RequestElement
  /** True when the current request only appended — no existing element changed. */
  appendOnly: boolean
}

/**
 * The first element whose content differs from the previous request, walking in cache order and
 * ignoring key-excluded elements on both sides.
 */
export function firstDivergence(
  prevOrdered: readonly RequestElement[],
  curOrdered: readonly RequestElement[],
): Divergence {
  let i = 0
  let j = 0
  while (i < prevOrdered.length && j < curOrdered.length) {
    if (prevOrdered[i].keyExcluded) { i++; continue }
    if (curOrdered[j].keyExcluded) { j++; continue }
    if (prevOrdered[i].key !== curOrdered[j].key) {
      return { index: j, prevIndex: i, element: curOrdered[j], previous: prevOrdered[i], appendOnly: false }
    }
    i++; j++
  }
  // The previous request is exhausted with nothing changed: whatever remains is appended content.
  while (i < prevOrdered.length && prevOrdered[i].keyExcluded) i++
  if (i < prevOrdered.length) {
    // The current request is SHORTER — content was removed, which breaks the prefix at that point.
    return { index: curOrdered.length, prevIndex: i, previous: prevOrdered[i], appendOnly: false }
  }
  while (j < curOrdered.length && curOrdered[j].keyExcluded) j++
  const appended = j < curOrdered.length
  return { index: appended ? j : -1, prevIndex: appended ? i : -1, element: curOrdered[j], appendOnly: true }
}

/**
 * The last surviving index: the prefix is stored at `cache_control` breakpoints, so what survives is
 * the prefix up to the last breakpoint STRICTLY BEFORE the first divergence — not up to the
 * divergence itself. A change one byte after a breakpoint costs everything back to that breakpoint.
 *
 * THE BREAKPOINTS THAT MATTER ARE THE PREVIOUS REQUEST'S, NOT THIS ONE'S. Cache entries are written
 * where the marker sat when the entry was created, and Claude Code MOVES its trailing marker onto
 * each new last message. Snapping against the current request's markers therefore discards the entry
 * the previous turn actually stored and reports the whole conversation as re-written: measured on an
 * append-only turn, that mistake produced a structural read share of 0.907 against a billed 0.996.
 * The current request's own markers describe what it will store for the NEXT turn.
 *
 * Returns -1 when no such breakpoint precedes the divergence, meaning nothing survives even if the
 * bytes before it were identical — the measured behaviour that re-wrote 89 identical tool schemas
 * with `cache_read` 0.
 *
 * `divergenceIndex` of -1 (nothing diverged) means everything the previous request stored survives.
 */
export function survivingBoundary(
  prevOrdered: readonly RequestElement[],
  divergenceIndex: number,
): number {
  const limit = divergenceIndex < 0 ? prevOrdered.length : divergenceIndex
  let last = -1
  for (let i = 0; i < limit && i < prevOrdered.length; i++) {
    if (prevOrdered[i].breakpoint) last = i
  }
  return last
}

/**
 * The surviving boundary expressed in the CURRENT request's coordinates — what `classifyTurn` must
 * use, because it thresholds `curOrdered` positions.
 *
 * `survivingBoundary` scans the PREVIOUS request and returns an index into it. Clamping that number
 * into range does NOT translate it: the two coordinate systems drift by exactly the difference in
 * key-excluded elements before the divergence. Measured by the review fork on a pair whose content
 * was entirely identical — every element had to be `cache-read`, and the last one came back
 * `cache-write` because prev's index for it was cur's index for its predecessor.
 *
 * Dormant in production today (a request carries exactly one billing header, so the drift is 0) and
 * live the moment a second key-excluded element type exists, which `keyExcluded` is designed to
 * allow. Translating is cheap; relying on the drift staying 0 is not.
 */
export function survivingBoundaryInCur(
  prevOrdered: readonly RequestElement[],
  curOrdered: readonly RequestElement[],
  divergence: Divergence,
): number {
  const prevLimit = divergence.prevIndex < 0 ? prevOrdered.length : divergence.prevIndex
  const curLimit = divergence.index < 0 ? curOrdered.length : divergence.index
  let i = 0
  let j = 0
  let lastCur = -1
  // Walk the aligned region the same way the divergence walk did, so element i of prev is paired
  // with element j of cur, and record the CUR index of the last prev-side breakpoint.
  while (i < prevLimit && j < curLimit && i < prevOrdered.length && j < curOrdered.length) {
    if (prevOrdered[i].keyExcluded) { i++; continue }
    if (curOrdered[j].keyExcluded) { j++; continue }
    if (prevOrdered[i].breakpoint) lastCur = j
    i++; j++
  }
  return lastCur
}

/** The last `cache_control` marker in the request: content beyond it is never cached this turn. */
export function lastBreakpoint(curOrdered: readonly RequestElement[]): number {
  for (let i = curOrdered.length - 1; i >= 0; i--) if (curOrdered[i].breakpoint) return i
  return -1
}

export interface ClassifiedElement extends RequestElement {
  /** Position in cache order — the index the stored boundary is compared against. */
  position: number
  cls: ElementClass
}

export interface TurnClassification {
  elements: ClassifiedElement[]
  divergence: Divergence
  /** Last index re-read from cache; -1 when nothing survived. Store this per body. */
  boundary: number
  /** Last cacheable index. Elements past it are uncached fresh input. */
  lastBreakpointIndex: number
  bytes: { cacheRead: number; cacheWrite: number; freshInput: number }
}

/**
 * Classify every element of `cur` against `prev`. Pass `prev` as null for the first request of a
 * stream, where nothing can have been cached yet.
 */
export function classifyTurn(
  prev: readonly RequestElement[] | null,
  cur: readonly RequestElement[],
): TurnClassification {
  const curOrdered = cacheOrder(cur)
  const prevOrdered = prev ? cacheOrder(prev) : null
  const divergence = prevOrdered
    ? firstDivergence(prevOrdered, curOrdered)
    : { index: 0, prevIndex: 0, element: curOrdered[0], appendOnly: false }
  // TRANSLATED into the current request's coordinates, not merely clamped into range. Clamping a
  // prev-coordinate index leaves it off by the number of extra key-excluded elements, which
  // misclassifies the last element of an otherwise unchanged request (review-fork finding F1).
  const rawBoundary = prevOrdered ? survivingBoundaryInCur(prevOrdered, curOrdered, divergence) : -1
  const boundary = Math.min(rawBoundary, curOrdered.length - 1)
  // A breakpoint can only extend the cacheable region, never shrink what already survived, so the
  // cacheable end is at least the boundary. Without this, a previous request whose trailing marker
  // sat past this request's own last marker would classify surviving elements as fresh input.
  const lastBp = Math.max(lastBreakpoint(curOrdered), boundary)

  const elements: ClassifiedElement[] = curOrdered.map((el, position) => ({
    ...el,
    position,
    cls: position <= boundary ? 'cache-read' : position <= lastBp ? 'cache-write' : 'fresh-input',
  }))

  const bytes = { cacheRead: 0, cacheWrite: 0, freshInput: 0 }
  for (const el of elements) {
    if (el.cls === 'cache-read') bytes.cacheRead += el.bytes
    else if (el.cls === 'cache-write') bytes.cacheWrite += el.bytes
    else bytes.freshInput += el.bytes
  }
  return { elements, divergence, boundary, lastBreakpointIndex: lastBp, bytes }
}

export interface BilledUsage {
  cacheReadTokens: number
  cacheCreateTokens: number
}

export interface Reconciliation {
  /** Structural read share of cacheable bytes, 0..1. */
  structuralShare: number
  /** Billed read share of cache traffic, 0..1. */
  billedShare: number
  agrees: boolean
  /** Absolute difference of the two shares, 0..1. */
  delta: number
}

/**
 * Compare the structural boundary against what Anthropic actually billed. The billed usage is the
 * ORACLE and the structural diff is the explanation of it; when they disagree the disagreement is
 * the finding and must be displayed, never resolved in favour of the nicer number.
 *
 * Shares are compared rather than absolute counts because the structural side is measured in bytes
 * and the billed side in tokens. `tolerance` is the share difference treated as agreement.
 *
 * KNOWN GAP, measured: on 4 of 300 validated turns the structural boundary is right and billed still
 * disagrees, in two shapes. Two were TTL/eviction — one pair was BYTE-IDENTICAL (same body_id) after
 * a 1,422 s idle gap and still paid a ~600k full-prefix write, which no content diff can ever
 * explain. The other two hit a cache entry written by an EARLIER turn whose trailing marker sat
 * before a mid-list edit, so `survivingBoundary(prev, …)` cannot see the entry that was actually
 * used and falls back to the system head. Both are why billed is the oracle and why a disagreement
 * must be shown rather than smoothed away.
 *
 * KNOWN BIAS, stated rather than hidden: bytes-per-token is not constant across content. Dense JSON
 * tool schemas tokenize at a different rate than prose, so a turn whose cached region is mostly
 * schema and whose written region is mostly prose can differ by a few points while the
 * classification is perfectly correct. The tolerance absorbs that; it does not remove it. The exact
 * comparison needs measured per-region token counts (`count_tokens` differencing) and is why the
 * trace offers that on demand instead of pretending bytes are tokens.
 */
export function reconcile(
  c: TurnClassification,
  billed: BilledUsage,
  tolerance = 0.05,
): Reconciliation {
  const cacheableBytes = c.bytes.cacheRead + c.bytes.cacheWrite
  const billedTotal = billed.cacheReadTokens + billed.cacheCreateTokens
  const structuralShare = cacheableBytes > 0 ? c.bytes.cacheRead / cacheableBytes : 0
  const billedShare = billedTotal > 0 ? billed.cacheReadTokens / billedTotal : 0
  const delta = Math.abs(structuralShare - billedShare)
  return { structuralShare, billedShare, agrees: delta <= tolerance, delta }
}
