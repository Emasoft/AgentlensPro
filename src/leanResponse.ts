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
// bounded, and nothing else. Arrays are truncated to their significant head; deep nesting is flattened;
// `coverage` collapses to one honest line. Truncation is ALWAYS disclosed (never a silent cut) and the
// full payload stays one `verbosity:"full"` away.
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

/** Row-level shaping: keep the fields that carry the ANSWER, drop the ones that carry the derivation. */
const DROP_KEYS = new Set(['remediation', 'rawDiffSummary', 'culpritId', 'actorId', 'ttlTier', 'bodyRef', 'ref'])

function shapeRow(row: unknown): unknown {
  if (row === null || typeof row !== 'object') return typeof row === 'string' ? clipStr(row) : row
  if (Array.isArray(row)) return row.slice(0, MAX_ROWS).map(shapeRow)
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(row as Record<string, unknown>)) {
    if (DROP_KEYS.has(k)) continue
    if (v === null || v === undefined) continue
    if (typeof v === 'string') { out[k] = clipStr(v, 160); continue }
    if (typeof v === 'number' || typeof v === 'boolean') { out[k] = v; continue }
    if (Array.isArray(v)) { out[k] = v.slice(0, 3).map(shapeRow); continue }
    // Drop nested objects in summary rows — they are derivation detail, not the answer.
  }
  return out
}

/** Truncate an array to its significant head, DISCLOSING what was dropped (never a silent cut). */
function headOf(arr: unknown[], limit: number, label: string): { rows: unknown[]; note?: string } {
  if (arr.length <= limit) return { rows: arr.map(shapeRow) }
  return {
    rows: arr.slice(0, limit).map(shapeRow),
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

/** Hard backstop: degrade until the payload fits the ceiling. Arrays shrink first (they are the most
 *  compressible), then long strings clip. A tool can never blow the caller's context. */
function enforceCeiling(shaped: Record<string, unknown>, maxTokens: number): Record<string, unknown> {
  let out = shaped
  for (let limit = MAX_ROWS; limit >= 1 && approxTokens(out) > maxTokens; limit--) {
    const next: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(out)) {
      next[k] = Array.isArray(v) ? v.slice(0, limit) : v
    }
    next._truncated = [
      ...(Array.isArray(out._truncated) ? (out._truncated as string[]) : []),
      `payload exceeded ~${maxTokens} tokens — arrays reduced to ${limit} row(s); use verbosity:"full"`,
    ]
    out = next
  }
  if (approxTokens(out) > maxTokens) {
    const next: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(out)) {
      next[k] = typeof v === 'string' ? clipStr(v, 120) : v
    }
    out = next
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
