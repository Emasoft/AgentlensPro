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
  /** Content identity — a sha256 for a stored blob, or the literal text for an inline element. */
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
  return text.trimStart().toLowerCase().startsWith('x-anthropic-billing-header')
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
      return { index: j, element: curOrdered[j], previous: prevOrdered[i], appendOnly: false }
    }
    i++; j++
  }
  // The previous request is exhausted with nothing changed: whatever remains is appended content.
  while (i < prevOrdered.length && prevOrdered[i].keyExcluded) i++
  if (i < prevOrdered.length) {
    // The current request is SHORTER — content was removed, which breaks the prefix at that point.
    return { index: curOrdered.length, previous: prevOrdered[i], appendOnly: false }
  }
  while (j < curOrdered.length && curOrdered[j].keyExcluded) j++
  return { index: j < curOrdered.length ? j : -1, element: curOrdered[j], appendOnly: true }
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
    : { index: 0, element: curOrdered[0], appendOnly: false }
  const boundary = prevOrdered ? survivingBoundary(prevOrdered, divergence.index) : -1
  const lastBp = lastBreakpoint(curOrdered)

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
