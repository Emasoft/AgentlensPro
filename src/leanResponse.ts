// TOKEN ECONOMY — every MCP tool response is shaped here before it leaves the server.
//
// WHY THIS EXISTS (measured, 2026-07-09): a diagnostic tool's *code* is free, but its *output* is not.
// A tool result lands in the caller's conversation transcript, and the Anthropic API is stateless — the
// whole transcript is re-sent on EVERY subsequent turn. So a 12 KB JSON blob is not paid once; it is
// paid again on every later turn until compaction. In a 1.2M-token marathon session that single blob
// silently costs more than the entire analysis it reports.
//
// THE CONTRACT: a diagnostic tool must RETURN THE ANSWER, not the raw data to derive it. The server
// already computes the verdict, the ranking, and the remediation — the caller should get exactly that,
// bounded, and nothing else. Arrays are truncated to their significant head; `coverage` collapses to
// one honest line; the fields listed in DROP_KEYS (derivation detail) are removed. Truncation is
// ALWAYS disclosed (never a silent cut) and the full payload stays one `verbosity:"full"` away.
//
// NESTED OBJECTS ARE KEPT. They were flattened away until 2026-07-27, on the premise that nesting
// meant derivation — false for any tool whose answer is a structured object, and it silently deleted
// 87% of get_window_budget's leaves, 84% of get_burn_status's, and the authoritative
// usageWindows.fiveHourPct from get_account_status. Depth cannot decide the question: within one
// window object `pctConsumed` (answer) and `breakdown` (derivation) are peers, both all-scalar. So
// the split is DECLARED in DROP_KEYS and nowhere else, and the ceiling below is what bounds cost.
//
// The ceiling is enforced at the end as a hard backstop: if a shaped payload still exceeds the budget,
// it is progressively degraded (arrays shrink, then long strings clip) until it fits. A tool can never
// blow the caller's context, no matter what the underlying data looks like.

export type Verbosity = 'summary' | 'full'

/** ~4 chars/token is the standard rough estimator; we only need the order of magnitude for a cap. */
const CHARS_PER_TOKEN = 4
/** Default ceiling for a summary response (~1.2k tokens). Chosen so a dozen calls stay under ~15k. */
const DEFAULT_MAX_TOKENS = 1200
const MAX_ROWS = 5
const MAX_STR = 400
/** Elements kept from an array nested inside a row (a disclosure marker is appended when it cuts). */
const MAX_NESTED_ROWS = 3
/** Recursion guard ONLY — a cycle/pathology backstop, never the semantic filter. Measured across the
 *  shipped tools the deepest real answer is depth 3 (`accounts[].budget.fiveHour.*`), so 4 clears
 *  every tool with room to spare. What counts as derivation is decided by DROP_KEYS, not by depth:
 *  `fiveHour.pctConsumed` (answer) and `fiveHour.breakdown` (derivation) sit at the SAME depth and
 *  are both all-scalar, so no structural rule can separate them. */
const MAX_DEPTH = 4

export interface LeanOptions {
  verbosity?: Verbosity
  maxTokens?: number
}

function approxTokens(v: unknown): number {
  return Math.ceil(JSON.stringify(v ?? '').length / CHARS_PER_TOKEN)
}

function clipStr(s: string, max = MAX_STR): string {
  return s.length <= max ? s : `${s.slice(0, max)}… (+${s.length - max} chars)`
}

/** Collapse a verbose `coverage` object into ONE honest line — the scan scope must never be hidden,
 *  but it also never needs 8 fields to be understood. */
function coverageLine(cov: unknown): string | undefined {
  if (!cov || typeof cov !== 'object') return undefined
  const c = cov as Record<string, unknown>
  if (typeof c.note === 'string' && c.note) return clipStr(c.note, 240)
  if (c.complete === true) return 'complete scan'
  return undefined
}

/**
 * Row-level shaping: keep the fields that carry the ANSWER, drop the ones that carry the derivation.
 *
 * This set is the ONE place the answer/derivation split is declared, and it is deliberately a
 * DENY-list rather than an allow-list: a missing entry costs a few extra (ceiling-capped, visible)
 * tokens, whereas a missing allow-list entry would silently delete a tool's answer — which is exactly
 * the defect this shaper shipped with. Keep-by-default fails safe; drop-by-default fails silent.
 *
 * `breakdown` — the per-bucket {input, output, cacheRead, cacheCreation, …} split that hangs off
 * every window/rate object. Measured across the live payloads of get_window_budget and
 * get_burn_status it is derivation in 100% of its occurrences and never an answer; the totals beside
 * it (consumedTokens / consumedCostUsd / consumedBillableWeighted) carry the verdict.
 *
 * `remediation` is NOT here, though it once was: it is genuinely returned (cacheBreakTimeline.ts,
 * mcpServer.ts:2436) and four tool descriptions advertise it as part of the answer ("an ordered
 * `remediation` list ranked by what actually dominates the cost"). Dropping it made those tools
 * promise a fix hint they never delivered.
 *
 * The machine-identity keys below (culpritId/actorId/bodyRef/ttlTier) stay dropped because each has
 * a human-readable sibling that survives — culpritSummary, actor, cause.
 */
const DROP_KEYS = new Set(['rawDiffSummary', 'culpritId', 'actorId', 'ttlTier', 'bodyRef', 'ref', 'breakdown'])

function shapeRow(row: unknown, depth = 0): unknown {
  if (row === null || typeof row !== 'object') return typeof row === 'string' ? clipStr(row) : row
  // NB: `.map(shapeRow)` would hand the array INDEX to `depth` — always pass it explicitly.
  if (Array.isArray(row)) return row.slice(0, MAX_ROWS).map(r => shapeRow(r, depth))
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(row as Record<string, unknown>)) {
    if (DROP_KEYS.has(k)) continue
    if (v === null || v === undefined) continue
    if (typeof v === 'string') { out[k] = clipStr(v, 160); continue }
    if (typeof v === 'number' || typeof v === 'boolean') { out[k] = v; continue }
    if (Array.isArray(v)) {
      const kept = v.slice(0, MAX_NESTED_ROWS).map(r => shapeRow(r, depth + 1))
      // Disclose the cut — the file's contract is that truncation is NEVER silent.
      out[k] = v.length > MAX_NESTED_ROWS
        ? [...kept, `… +${v.length - MAX_NESTED_ROWS} more — use verbosity:"full"`]
        : kept
      continue
    }
    // Nested object: KEEP it (recursing), because for a structured tool the nested object IS the
    // answer — accounts[].budget.fiveHour.pctConsumed, usageWindows.fiveHourPct, risks[].evidence.
    // DROP_KEYS above is what removes derivation; depth is only a pathology guard.
    if (depth + 1 >= MAX_DEPTH) {
      out[k] = `… ${Object.keys(v as object).length} field(s) elided at depth ${MAX_DEPTH} — use verbosity:"full"`
      continue
    }
    out[k] = shapeRow(v, depth + 1)
  }
  return out
}

/** Truncate an array to its significant head, DISCLOSING what was dropped (never a silent cut). */
function headOf(arr: unknown[], limit: number, label: string): { rows: unknown[]; note?: string } {
  // `.map(shapeRow)` would hand the array INDEX to `depth`, so element N would be shaped as if it sat
  // N levels deep and its answer would elide at the depth guard — the top-level rows of every
  // array-shaped tool (get_window_budget's accounts, check_burn_risk's risks) start at depth 0.
  if (arr.length <= limit) return { rows: arr.map(r => shapeRow(r, 0)) }
  return {
    rows: arr.slice(0, limit).map(r => shapeRow(r, 0)),
    note: `showing top ${limit} of ${arr.length} ${label} — call with verbosity:"full" for all`,
  }
}

/** Generic shaper: verdict/notes first, then the significant head of the biggest ranked array. */
function shapeGeneric(result: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  const notes: string[] = []

  // 1. Scalars + the verdict-bearing fields lead the payload — this IS the answer.
  for (const [k, v] of Object.entries(result)) {
    if (k === 'coverage') continue
    if (typeof v === 'string') { out[k] = clipStr(v, k === 'verdict' ? 600 : MAX_STR); continue }
    if (typeof v === 'number' || typeof v === 'boolean') out[k] = v
  }

  // 2. Arrays → truncated heads, each disclosing its own truncation.
  for (const [k, v] of Object.entries(result)) {
    if (!Array.isArray(v) || v.length === 0) continue
    const { rows, note } = headOf(v, MAX_ROWS, k)
    out[k] = rows
    if (note) notes.push(`${k}: ${note}`)
  }

  // 3. Nested objects: keep only their scalar summary (one level), never the whole tree.
  for (const [k, v] of Object.entries(result)) {
    if (k === 'coverage' || Array.isArray(v) || v === null || typeof v !== 'object') continue
    const shaped = shapeRow(v)
    if (shaped && Object.keys(shaped as object).length) out[k] = shaped
  }

  const cov = coverageLine(result.coverage)
  if (cov) out.coverage = cov
  if (notes.length) out._truncated = notes
  return out
}

/** Deepest object-nesting level in a value (a flat object is 1; arrays are transparent). */
function objectDepth(v: unknown): number {
  if (v === null || typeof v !== 'object') return 0
  if (Array.isArray(v)) return v.reduce<number>((m, x) => Math.max(m, objectDepth(x)), 0)
  let deepest = 0
  for (const x of Object.values(v as Record<string, unknown>)) deepest = Math.max(deepest, objectDepth(x))
  return deepest + 1
}

/** Replace every nested object sitting at or below `maxLevel` with a disclosed marker. Root is
 *  level 0, so maxLevel=2 keeps the root's direct children and elides their children. */
function pruneBelow(v: unknown, maxLevel: number, level = 0): unknown {
  if (v === null || typeof v !== 'object') return v
  if (Array.isArray(v)) return v.map(x => pruneBelow(x, maxLevel, level))
  const out: Record<string, unknown> = {}
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
    if (x !== null && typeof x === 'object' && !Array.isArray(x)) {
      out[k] = level + 1 >= maxLevel
        ? `… ${Object.keys(x as object).length} field(s) elided — use verbosity:"full"`
        : pruneBelow(x, maxLevel, level + 1)
      continue
    }
    out[k] = pruneBelow(x, maxLevel, level)
  }
  return out
}

/** Clip long strings at EVERY level, not just the root — a deep payload's bulk is rarely top-level. */
function clipDeep(v: unknown, max: number): unknown {
  if (typeof v === 'string') return clipStr(v, max)
  if (v === null || typeof v !== 'object') return v
  if (Array.isArray(v)) return v.map(x => clipDeep(x, max))
  const out: Record<string, unknown> = {}
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) out[k] = clipDeep(x, max)
  return out
}

/** Keep the first `maxKeys` entries of every object, disclosing the count dropped. The last resort:
 *  a payload can be too big by being WIDE (many sibling keys) rather than deep or array-heavy, and
 *  by the time this runs the deep values are already elision markers, so little is lost. */
function narrowTo(v: unknown, maxKeys: number): unknown {
  if (v === null || typeof v !== 'object') return v
  if (Array.isArray(v)) return v.map(x => narrowTo(x, maxKeys))
  const entries = Object.entries(v as Record<string, unknown>)
  const out: Record<string, unknown> = {}
  for (const [k, x] of entries.slice(0, maxKeys)) out[k] = narrowTo(x, maxKeys)
  if (entries.length > maxKeys) out._elidedKeys = `+${entries.length - maxKeys} more field(s) — use verbosity:"full"`
  return out
}

/** Hard backstop: degrade until the payload fits the ceiling, disclosing every step that changes
 *  anything. Arrays shrink first (most compressible), then object DEPTH is pruned, then object WIDTH,
 *  then long strings clip at every level.
 *
 *  Depth and width both exist because nested objects are now kept. Without depth, a tool whose bulk is
 *  one deep object is unrecoverable once arrays are down to a single row; without width, a wide flat
 *  object floors out above the ceiling no matter how deeply pruned — which made the "can never blow
 *  the caller's context" promise false until a test proved it. A tool can never blow the caller's
 *  context, whatever the data looks like. */
function enforceCeiling(shaped: Record<string, unknown>, maxTokens: number): Record<string, unknown> {
  let out = shaped
  // ONE ceiling note, rewritten in place — never one per iteration. Each loop below steps its limit
  // down repeatedly (arrays 3→2→1, width 16→8→4→2→1), and appending a note per step was wrong twice
  // over: the intermediate lines are FALSE by the time the loop settles ("arrays reduced to 3" when
  // they ended at 1), and ~15 of them at ~110 chars each is ~190 tokens of disclosure that the
  // ceiling then cannot absorb. Measured: a payload degraded against a 60-token ceiling came out at
  // 203 tokens, of which 7 notes WERE essentially the whole payload — the function breaching its own
  // promise with the text explaining that it had not. One replaceable note is bounded and true.
  const CEILING_NOTE = 'payload exceeded'
  let applied = new Map<string, string>()

  /** Apply a degradation; keep it only if it actually shrank the payload — disclosure INCLUDED, so a
   *  stage that cannot pay for its own note is rejected and the next iteration simply degrades
   *  harder. No-op stages (a payload with no arrays, say) never emit a note for work they did not do.
   *  Notes from EARLIER phases (the shaper's own coverage note) are preserved; only the ceiling's own
   *  line is replaced. */
  const stage = (candidate: Record<string, unknown>, kind: string, detail: string): boolean => {
    const merged = new Map(applied).set(kind, detail)
    const note = `${CEILING_NOTE} ~${maxTokens} tokens — `
      + [...merged].map(([k, d]) => `${k} ${d}`).join(', ')
      + '; use verbosity:"full"'
    const kept = (Array.isArray(out._truncated) ? (out._truncated as string[]) : [])
      .filter(n => !n.startsWith(CEILING_NOTE))
    const next: Record<string, unknown> = { ...candidate, _truncated: [...kept, note] }
    if (approxTokens(next) >= approxTokens(out)) return false
    applied = merged
    out = next
    return true
  }

  for (let limit = MAX_ROWS; limit >= 1 && approxTokens(out) > maxTokens; limit--) {
    const next: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(out)) next[k] = Array.isArray(v) ? v.slice(0, limit) : v
    stage(next, 'arrays', `→ ${limit} row(s)`)
  }

  for (let level = objectDepth(out) - 1; level >= 1 && approxTokens(out) > maxTokens; level--) {
    stage(pruneBelow(out, level) as Record<string, unknown>, 'nesting', `→ elided below level ${level}`)
  }

  for (let keys = 16; keys >= 1 && approxTokens(out) > maxTokens; keys = Math.floor(keys / 2)) {
    stage(narrowTo(out, keys) as Record<string, unknown>, 'width', `→ ${keys} field(s)`)
  }

  if (approxTokens(out) > maxTokens) {
    stage(clipDeep(out, 120) as Record<string, unknown>, 'strings', '→ clipped to 120 chars')
  }
  return out
}

/**
 * Shape a tool result for the caller's context.
 *
 * `verbosity:"full"` returns the payload untouched (the escape hatch for a genuine deep drill).
 * Otherwise the result is reduced to: scalars + verdict + the head of each ranked array + a one-line
 * coverage note, under a hard token ceiling, with every truncation disclosed in `_truncated`.
 *
 * Non-object results (a pre-rendered `{format,text}` table, a string) pass through unchanged except for
 * the ceiling — those are already the tool's own concise rendering.
 */
export function leanify(result: unknown, opts: LeanOptions = {}): unknown {
  const verbosity: Verbosity = opts.verbosity === 'full' ? 'full' : 'summary'
  if (verbosity === 'full') return result
  const maxTokens = opts.maxTokens ?? DEFAULT_MAX_TOKENS
  if (result === null || result === undefined) return result

  // A pre-rendered text payload ({format,text}) is the tool's own compact rendering — only cap it.
  if (typeof result === 'object' && !Array.isArray(result) && typeof (result as { text?: unknown }).text === 'string') {
    const r = result as { format?: unknown; text: string }
    const budget = maxTokens * CHARS_PER_TOKEN
    return r.text.length <= budget
      ? result
      : { ...r, text: `${r.text.slice(0, budget)}\n… truncated (${r.text.length} chars) — use verbosity:"full"` }
  }
  if (typeof result !== 'object') return result
  if (Array.isArray(result)) {
    const { rows, note } = headOf(result, MAX_ROWS, 'rows')
    return enforceCeiling(note ? { rows, _truncated: [note] } : { rows }, maxTokens)
  }
  return enforceCeiling(shapeGeneric(result as Record<string, unknown>), maxTokens)
}
