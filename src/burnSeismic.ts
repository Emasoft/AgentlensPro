// src/burnSeismic.ts — the burn-event SEISMOGRAPH. Reconstructs a per-minute COST series from the
// raw session transcripts and runs the proven statistical stack in src/seismicStats.ts over it, so a
// "what burned my window" answer is a reproducible measurement, not an opinion.
//
// Why COST and not tool-call count: a window meters by $ (a cold cache-WRITE ≈ full-price; a
// cache-READ ≈ 0.1×), so the seismic SIGNAL is USD/min, reconstructed from each turn's
// message.usage {input, cache_creation=cold WRITE, cache_read, output} × the model's real rates
// (src/shared/pricing.ts — the single pricing source; no inlined table). Every event is decomposed
// into the two burn MODES the fleet actually suffers — CACHE_THRASH (cold-write dominated: an
// unstable MCP tool surface / model|effort switch cold-invalidates the whole prefix) and
// MARATHON RE-READ (read dominated: a fat session re-reads its huge prefix every turn).
//
// The statistics (each a NAMED, unit-tested method — see seismicStats.ts). The null is the series'
// TRUE generative structure — a MARKED POINT PROCESS: cost/min = (Poisson turn count) × (lognormal
// per-turn cost). v1 asserted a Gaussian null on raw $/min (non-negative, skewed, zero-inflated) and
// its p-values were therefore mis-calibrated; v2's factorization gives each factor its CORRECT tail:
//   • RATE test:       turns/bucket ~ Poisson(λ̂), exact tail; λ̂ = trimmed background MLE
//   • INTENSITY test:  log per-turn cost over ACTIVE buckets (hurdle) → robust median/MAD →
//                      Iglewicz–Hoaglin modified-z → normal tail (log licenses the Gaussian)
//   • combination:     Fisher 1932, χ²₄ closed form (independent by Poisson thinning) — and the
//                      decomposition IS the root cause: rate-driven ⇒ fan-out; intensity ⇒ fat turns
//   • significance:    Benjamini–Hochberg FDR (valid under PRDS — Benjamini–Yekutieli 2001) or the
//                      arbitrary-dependence Benjamini–Yekutieli variant; plus a calibration
//                      self-check on the background buckets
//   • segmentation:    PELT (Killick–Fearnhead–Eckley 2012) on log1p(cost) — exact penalized
//                      changepoints; events = segments holding FDR-significant buckets
//   • diagnostics:     STA/LTA trigger (Allen 1978) + CUSUM (Page 1954)
//   • magnitude:       log₁₀(peakExcess/baseline) (Gutenberg–Richter analogue); ranking by EXCESS
//
// Data extraction is DuckDB streaming C++ over the NDJSON (transcripts reach ~2 GB with base64
// images; maximum_object_size is raised past the largest line so a fat line SKIPS, never aborts).

import * as fs from 'fs'
import * as path from 'path'
import { claudeProjectsDirs } from './logReader'
import { lookupRates } from './shared/pricing'
import {
  median, robustBaseline, modifiedZ, modifiedZScores, normalSf, poissonSF, fisherCombine,
  benjaminiHochberg, benjaminiYekutieli, staLta, cusum, pelt, magnitude,
  type RobustBaseline,
} from './seismicStats'
import { SPAWN_TOOLS, type SpawnCall } from './causingToolCall'

const MAX_OBJECT_SIZE = 268_435_456
const sqlStr = (s: string): string => `'${s.replace(/'/g, "''")}'`

export type SeismicScope = 'fleet' | 'workspace' | 'session'

export interface ResolveSeismicOptions {
  scope: SeismicScope
  /** For scope='workspace': the workspace path (its slug dir is scanned). */
  workspace?: string
  /** For scope='session': the session id (or unique prefix). */
  sessionId?: string
  /** Lower time bound (ms) — only transcripts touched at/after this (minus slack) are considered. */
  sinceMs: number
  /** scope='fleet': include subagent transcripts (…/subagents/*.jsonl). Default false (the spawners). */
  includeSubagents?: boolean
  /** Cap the file set (most-recently-modified first). Default 300. */
  maxFiles?: number
  /** Override the Claude projects dirs — tests only. */
  projectsDirs?: string[]
}

/** A session file active in the window has mtime ≥ its last activity ≥ sinceMs; widen by an hour so a
 *  session that went idle just after the window opens is not missed (DuckDB re-filters by ts anyway). */
const MTIME_SLACK_MS = 3600_000

/** Resolve the transcript file set for a seismic analysis by scope. Never throws; returns []. */
export function resolveSeismicFiles(o: ResolveSeismicOptions): string[] {
  const bases = o.projectsDirs ?? claudeProjectsDirs()
  const floor = o.sinceMs - MTIME_SLACK_MS
  const cap = o.maxFiles ?? 300
  const isUuidJsonl = (name: string): boolean => /^[0-9a-f-]{36}\.jsonl$/i.test(name)

  if (o.scope === 'session') {
    if (!o.sessionId) return []
    const out: string[] = []
    for (const base of bases) {
      let subs: string[]
      try { subs = fs.readdirSync(base) } catch { continue }
      for (const sub of subs) {
        const dir = path.join(base, sub)
        let names: string[]
        try { names = fs.readdirSync(dir) } catch { continue }
        for (const n of names) {
          if (n.endsWith('.jsonl') && (n === `${o.sessionId}.jsonl` || n.startsWith(o.sessionId))) out.push(path.join(dir, n))
        }
      }
    }
    return out
  }

  const cand: { p: string; mtime: number }[] = []
  const wantDirs: string[] = []
  if (o.scope === 'workspace') {
    if (!o.workspace) return []
    const slug = o.workspace.replace(/[^A-Za-z0-9]/g, '-')
    for (const base of bases) wantDirs.push(path.join(base, slug))
  }
  const walk = (dir: string, allowSub: boolean): void => {
    let entries: fs.Dirent[]
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      const full = path.join(dir, e.name)
      if (e.isDirectory()) { if (allowSub && e.name === 'subagents') walk(full, true); continue }
      if (!e.name.endsWith('.jsonl')) continue
      if (o.scope === 'fleet' && !o.includeSubagents && !isUuidJsonl(e.name)) continue
      try {
        const st = fs.statSync(full)
        if (st.mtimeMs < floor) continue
        cand.push({ p: full, mtime: st.mtimeMs })
      } catch { /* raced/unreadable — skip */ }
    }
  }
  if (o.scope === 'workspace') {
    for (const d of wantDirs) walk(d, o.includeSubagents ?? false)
  } else { // fleet: every slug dir under every base
    for (const base of bases) {
      let subs: string[]
      try { subs = fs.readdirSync(base) } catch { continue }
      for (const sub of subs) walk(path.join(base, sub), o.includeSubagents ?? false)
    }
  }
  return cand.sort((a, b) => b.mtime - a.mtime).slice(0, cap).map(c => c.p)
}

export interface BurnSeismicOptions {
  /** Transcript files to analyse (resolved by the caller — a workspace, the fleet, one session). */
  files: string[]
  /** Lower bound of the analysed window (ISO). Default: 24 h before now. */
  sinceIso?: string
  /** Bucket width in minutes. Default 1. */
  bucketMinutes?: number
  /** Iglewicz–Hoaglin outlier flag (λ-trimming + intensity z). Default 3.5. */
  modZThreshold?: number
  /** FDR level for the combined per-bucket test. Default 0.01. */
  fdrAlpha?: number
  /** FDR procedure: 'bh' (Benjamini–Hochberg — valid under the PRDS positive dependence our
   *  one-sided, positively-correlated minute buckets exhibit; Benjamini–Yekutieli 2001 Thm 1.2)
   *  or 'by' (Benjamini–Yekutieli — guaranteed under ARBITRARY dependence, ~ln(m) conservative).
   *  Default 'bh'. */
  fdrMethod?: 'bh' | 'by'
  /** STA / LTA window minutes and trigger thresholds (Allen 1978). Defaults 3 / 60, on 4, off 1.5. */
  staMinutes?: number
  ltaMinutes?: number
  staLtaOn?: number
  staLtaOff?: number
  /** CUSUM allowance K and decision interval H, in units of σ̂. Defaults 0.5 and 5. */
  cusumKSigma?: number
  cusumHSigma?: number
  /** PELT penalty β override (default 2·ln n — BIC). */
  peltPenalty?: number
  /** Report caps. */
  topEvents?: number
  topSessions?: number
  /** Distribution p-value engine: 'auto' uses the `stochastic` community extension if it LOADs
   *  (an independent, community-vetted implementation), else the unit-tested TS core; 'stochastic'
   *  requires it; 'internal' forces the TS core. Default 'auto'. */
  pvalueEngine?: 'auto' | 'stochastic' | 'internal'
  /** Test seam — override the DuckDB module. */
  duckdb?: typeof import('@duckdb/node-api')
}

export interface SeismicBucket {
  iso: string
  costUsd: number
  writeUsd: number
  readUsd: number
  outputUsd: number
  turns: number
  /** Iglewicz–Hoaglin modified z of the log per-turn cost (the INTENSITY signal); 0 for an
   *  inactive bucket. Log scale: per-turn cost is a product of positive factors, so the Gaussian
   *  tail is asserted only after the symmetrizing transform. */
  modZ: number
  /** RATE p — exact Poisson exceedance P(X ≥ turns | λ̂). Counts are Poisson: calibrated as-is. */
  pValueRate: number
  /** INTENSITY p — lognormal upper tail normalSf(modZ); 1 for an inactive bucket (no evidence). */
  pValueIntensity: number
  /** COMBINED p — Fisher's method over (rate, intensity), χ²₄ closed form. Drives the FDR. */
  pValue: number
  /** Survived the FDR procedure at α on the combined p-values (a statistically-significant anomaly). */
  fdrSignificant: boolean
  staLtaRatio: number
}

export type BurnMode = 'CACHE_THRASH' | 'MARATHON_REREAD' | 'MIXED'

/** Root-cause class from the rate×intensity decomposition (which factor carries the evidence)
 *  crossed with the write/read split of the EXCESS: FANOUT_RATE = many-turns burst (spawn storm);
 *  FAT_TURN_THRASH = few turns, cold-write dominated (prefix cold-invalidation); FAT_TURN_MARATHON
 *  = few turns, read dominated (fat prefix re-read); COMPOUND = both factors carry evidence. */
export type EventCause = 'FANOUT_RATE' | 'FAT_TURN_THRASH' | 'FAT_TURN_MARATHON' | 'COMPOUND'

export type CulpritTag = 'COLD_REWRITE' | 'MODEL_SWITCH'

/** One session's contribution to one event, with its cause markers. */
export interface EventCulprit {
  session: string
  project: string
  /** The session's $ inside the event window. */
  eventUsd: number
  /** eventUsd minus the session's own out-of-event baseline rate × duration (≥ 0). */
  excessUsd: number
  writeUsd: number
  readUsd: number
  outputUsd: number
  turns: number
  /** COLD_REWRITE: a single turn's cache_creation ≥ 80% of the session's max prefix (full-prefix
   *  rewrite signature; needs a real ≥50k prefix). MODEL_SWITCH: >1 distinct model in the event. */
  tags: CulpritTag[]
  models: string[]
}

export interface SeismicEvent {
  fromIso: string
  toIso: string
  durMin: number
  costUsd: number
  /** costUsd − baseline-median $/bucket × duration, clamped ≥ 0 — the anomaly "energy released". */
  excessUsd: number
  writeUsd: number
  readUsd: number
  outputUsd: number
  turns: number
  peakUsd: number
  peakIso: string
  peakModZ: number
  peakStaLta: number
  /** Smallest COMBINED p inside the event, plus the per-factor minima behind the cause label. */
  minP: number
  minPRate: number
  minPIntensity: number
  /** log₁₀(peakExcess/baseline) — Gutenberg–Richter analogue. */
  magnitude: number
  /** Write/read language of the event $ (window-verdict continuity). */
  dominantMode: BurnMode
  /** The statistical root-cause class (rate vs intensity evidence × excess W/R split). */
  cause: EventCause
  /** Sessions ranked by their excess inside THIS event (top 5), with cause markers. */
  culprits: EventCulprit[]
}

export interface SeismicSession {
  session: string
  project: string
  costUsd: number
  writeUsd: number
  readUsd: number
  outputUsd: number
  turns: number
  /** Largest single-turn cache-read prefix seen — the "fatness" of the session. */
  maxPrefixTokens: number
  /** Σ of this session's per-event excess — "how much of the ANOMALIES did it drive" (the ranking
   *  key: a big spender at steady baseline is not a culprit; a spike driver is). */
  eventExcessUsd: number
}

export type SeismicReason = 'no-files' | 'duckdb-unavailable' | 'no-costed-turns'

export interface BurnSeismicResult {
  windowSinceIso: string
  bucketMinutes: number
  filesAnalysed: number
  totalUsd: number
  totalWriteUsd: number
  totalReadUsd: number
  totalOutputUsd: number
  totalTurns: number
  bucketCount: number
  /** Robust baseline of the per-bucket COST series (median/MAD/σ̂). */
  baseline: RobustBaseline
  /** Robust background turn rate λ̂ of the Poisson RATE test. */
  poissonLambda: number
  /** Robust baseline of log per-turn cost over ACTIVE buckets (the INTENSITY null). */
  intensityBaseline: RobustBaseline
  fdrAlpha: number
  fdrMethod: 'bh' | 'by'
  fdrThreshold: number
  fdrSignificantCount: number
  /** Honesty metric: share of BACKGROUND (non-significant) buckets with combined p < 0.05 —
   *  ≈ 0.05 when the null is calibrated. null when the background is too small to estimate. */
  calibration: { alpha: number; observedBackgroundShare: number | null }
  /** Which engine produced the distribution p-values (disclosed for reproducibility):
   *  'stochastic' = the community DuckDB extension; 'internal' = the unit-tested TS core. */
  pvalueEngine: 'stochastic' | 'internal'
  /** The burn mode that dominates the window's TOTAL $ (read-share vs write-share). */
  dominantModeOverall: BurnMode
  /** One-line plain-language bottom line derived from the totals + event count. */
  verdict: string
  /** CUSUM change-point instants (ISO). */
  changePoints: string[]
  /** PELT segment boundaries (ISO of each new segment's first bucket). */
  peltChangepoints: string[]
  events: SeismicEvent[]
  mainshock?: SeismicEvent
  sessions: SeismicSession[]
  spawnsInMainshock: SpawnCall[]
  buckets: SeismicBucket[]
  reason?: SeismicReason
}

interface RawRow { bucket: string; filename: string; model: string; inp: number; cc: number; cr: number; out: number; turns: number; maxcc: number; maxcr: number }

const numOf = (v: unknown): number => (v == null ? 0 : Number(v))
/** Per-component USD for one model's token sums, via the single pricing source. */
function costParts(model: string, inp: number, cc: number, cr: number, out: number): { w: number; r: number; o: number; i: number } {
  const rates = lookupRates(model)
  if (!rates) return { w: 0, r: 0, o: 0, i: 0 }
  return {
    i: (inp / 1e6) * rates.inputPerMTok,
    r: (cr / 1e6) * rates.cacheReadPerMTok,
    w: (cc / 1e6) * rates.cacheWritePerMTok,
    o: (out / 1e6) * rates.outputPerMTok,
  }
}

const isoToMs = (isoNaiveUtc: string): number => new Date(isoNaiveUtc.replace(' ', 'T') + 'Z').getTime()
const msToBucketIso = (ms: number): string => new Date(ms).toISOString().replace('T', ' ').replace(/\..*/, '')

type Query = (sql: string) => Promise<Record<string, unknown>[]>

/** Try to make the `stochastic` community extension available: LOAD (if already cached) or, when
 *  install is allowed, INSTALL FROM community then LOAD. Never throws unless install is REQUIRED. */
async function loadStochastic(query: Query, require: boolean): Promise<boolean> {
  try { await query('LOAD stochastic;'); return true } catch { /* not cached — try install below */ }
  try { await query('INSTALL stochastic FROM community; LOAD stochastic;'); return true } catch (e) {
    if (require) throw new Error(`pvalueEngine='stochastic' requested but the extension could not be installed: ${String(e).split('\n')[0]}`)
    return false
  }
}

/** Per-bucket distribution p-values computed BY the `stochastic` extension (independent of the TS
 *  core): the RATE tail P(X ≥ turns | λ) (exact Poisson) and the INTENSITY tail 1−Φ(z) of the
 *  log per-turn-cost modified-z. One SQL pass over an inline values table; the Fisher combination
 *  stays in JS (closed form — exact either way). */
async function extPValues(query: Query, turns: number[], zIntensity: number[], lambda: number): Promise<{ pRate: number[]; pIntensity: number[] }> {
  const rows = turns.map((t, i) => `(${i}, ${Math.max(0, Math.round(t))}, ${Number.isFinite(zIntensity[i]) ? zIntensity[i] : 0})`).join(',')
  // P(X ≥ k) = P(X > k) + P(X = k) = complement(λ,k) + pmf(λ,k) — avoids the k−1 negative-arg edge.
  const out = await query(`
    WITH t(i, turns, modz) AS (VALUES ${rows})
    SELECT i,
      dist_poisson_cdf_complement(${lambda}, turns) + dist_poisson_pdf(${lambda}, turns) AS p_pois,
      dist_normal_cdf_complement(0.0, 1.0, modz) AS p_norm
    FROM t ORDER BY i;`)
  const pRate = new Array<number>(turns.length).fill(1)
  const pIntensity = new Array<number>(turns.length).fill(1)
  for (const r of out) {
    const i = Number(r.i)
    pRate[i] = Math.max(0, Math.min(1, Number(r.p_pois)))
    pIntensity[i] = Math.max(0, Math.min(1, Number(r.p_norm)))
  }
  return { pRate, pIntensity }
}

/**
 * Run the full seismic pipeline over the transcript set. Returns a structured, reproducible result
 * (or an empty result with a typed reason — never a fabricated event).
 */
export async function burnSeismic(opts: BurnSeismicOptions): Promise<BurnSeismicResult> {
  const bucketMinutes = opts.bucketMinutes ?? 1
  const modZThreshold = opts.modZThreshold ?? 3.5
  const fdrAlpha = opts.fdrAlpha ?? 0.01
  const fdrMethod = opts.fdrMethod ?? 'bh'
  const staMin = opts.staMinutes ?? 3
  const ltaMin = opts.ltaMinutes ?? 60
  const staOn = opts.staLtaOn ?? 4
  const staOff = opts.staLtaOff ?? 1.5
  const cusumK = opts.cusumKSigma ?? 0.5
  const cusumH = opts.cusumHSigma ?? 5
  const topEvents = opts.topEvents ?? 10
  const topSessions = opts.topSessions ?? 10
  const sinceIso = opts.sinceIso ?? new Date(Date.now() - 24 * 3600_000).toISOString()

  const zeroBaseline: RobustBaseline = { median: 0, mad: 0, meanAD: 0, sigmaHat: 0 }
  const empty = (reason: SeismicReason): BurnSeismicResult => ({
    windowSinceIso: sinceIso, bucketMinutes, filesAnalysed: opts.files.length,
    totalUsd: 0, totalWriteUsd: 0, totalReadUsd: 0, totalOutputUsd: 0, totalTurns: 0, bucketCount: 0,
    baseline: zeroBaseline, poissonLambda: 0, intensityBaseline: zeroBaseline,
    fdrAlpha, fdrMethod, fdrThreshold: 0, fdrSignificantCount: 0,
    calibration: { alpha: 0.05, observedBackgroundShare: null }, pvalueEngine: 'internal',
    dominantModeOverall: 'MIXED', verdict: '',
    changePoints: [], peltChangepoints: [], events: [], sessions: [], spawnsInMainshock: [], buckets: [], reason,
  })

  const files = opts.files.filter(f => fs.existsSync(f))
  if (files.length === 0) return empty('no-files')

  let duck: typeof import('@duckdb/node-api')
  try { duck = opts.duckdb ?? await import('@duckdb/node-api') } catch { return empty('duckdb-unavailable') }

  const fileList = files.map(sqlStr).join(', ')
  const readJson = `read_json([${fileList}], format='newline_delimited',
      columns={timestamp:'VARCHAR', type:'VARCHAR', message:'JSON'},
      maximum_object_size=${MAX_OBJECT_SIZE}, ignore_errors=true, filename=true)`
  const BK = `INTERVAL '${bucketMinutes} minute'`

  const inst = await duck.DuckDBInstance.create(':memory:')
  const con = await inst.connect()
  const query = async (sql: string): Promise<Record<string, unknown>[]> =>
    (await con.runAndReadAll(sql)).getRowObjects()

  try {
    // A) ONE aggregation, per (bucket, filename, model): token sums + turn count + the MAX
    // single-turn cache_creation / cache_read. Session-resolved so per-event attribution needs no
    // second scan; the single-turn maxima are what the COLD_REWRITE signature (one turn's cc ≈ the
    // session's whole prefix) and the fatness figure (max prefix) are defined on — bucket SUMS
    // cannot express either.
    const rawRows = (await query(`
      WITH raw AS (
        SELECT time_bucket(${BK}, CAST(timestamp AS TIMESTAMP)) AS bucket, filename,
               json_extract_string(message,'$.model') AS model,
               TRY_CAST(json_extract_string(message,'$.usage.input_tokens') AS BIGINT) AS inp,
               TRY_CAST(json_extract_string(message,'$.usage.cache_creation_input_tokens') AS BIGINT) AS cc,
               TRY_CAST(json_extract_string(message,'$.usage.cache_read_input_tokens') AS BIGINT) AS cr,
               TRY_CAST(json_extract_string(message,'$.usage.output_tokens') AS BIGINT) AS out
        FROM ${readJson}
        WHERE type='assistant' AND timestamp >= ${sqlStr(sinceIso)} AND json_extract(message,'$.usage') IS NOT NULL
      )
      SELECT CAST(bucket AS VARCHAR) AS bucket, filename, coalesce(model,'?') AS model,
             sum(coalesce(inp,0)) AS inp, sum(coalesce(cc,0)) AS cc,
             sum(coalesce(cr,0)) AS cr, sum(coalesce(out,0)) AS out, count(*) AS turns,
             max(coalesce(cc,0)) AS maxcc, max(coalesce(cr,0)) AS maxcr
      FROM raw GROUP BY 1,2,3 ORDER BY 1;`)).map((r): RawRow => ({
      bucket: String(r.bucket), filename: String(r.filename), model: String(r.model),
      inp: numOf(r.inp), cc: numOf(r.cc), cr: numOf(r.cr), out: numOf(r.out), turns: numOf(r.turns),
      maxcc: numOf(r.maxcc), maxcr: numOf(r.maxcr),
    }))
    if (rawRows.length === 0) { con.closeSync(); inst.closeSync(); return empty('no-costed-turns') }

    // Densify onto a continuous minute grid so quiet minutes count as the true zero baseline, and
    // keep the session-resolved view for attribution.
    interface CellAgg { cost: number; w: number; r: number; o: number; turns: number; maxCc: number; models: Set<string> }
    const bucketMs = bucketMinutes * 60_000
    const perBucket = new Map<string, { cost: number; w: number; r: number; o: number; turns: number }>()
    const perCell = new Map<string, CellAgg>() // `${bucket}|${filename}`
    const perSession = new Map<string, { cost: number; w: number; r: number; o: number; turns: number; maxPrefix: number }>()
    for (const row of rawRows) {
      const p = costParts(row.model, row.inp, row.cc, row.cr, row.out)
      const rowCost = p.i + p.r + p.w + p.o
      const acc = perBucket.get(row.bucket) ?? { cost: 0, w: 0, r: 0, o: 0, turns: 0 }
      acc.cost += rowCost; acc.w += p.w; acc.r += p.r; acc.o += p.o; acc.turns += row.turns
      perBucket.set(row.bucket, acc)
      const cellKey = `${row.bucket}|${row.filename}`
      const cell = perCell.get(cellKey) ?? { cost: 0, w: 0, r: 0, o: 0, turns: 0, maxCc: 0, models: new Set<string>() }
      cell.cost += rowCost; cell.w += p.w; cell.r += p.r; cell.o += p.o; cell.turns += row.turns
      cell.maxCc = Math.max(cell.maxCc, row.maxcc); cell.models.add(row.model)
      perCell.set(cellKey, cell)
      const sess = perSession.get(row.filename) ?? { cost: 0, w: 0, r: 0, o: 0, turns: 0, maxPrefix: 0 }
      sess.cost += rowCost; sess.w += p.w; sess.r += p.r; sess.o += p.o; sess.turns += row.turns
      sess.maxPrefix = Math.max(sess.maxPrefix, row.maxcr)
      perSession.set(row.filename, sess)
    }
    const loMs = isoToMs(rawRows[0].bucket)
    const hiMs = isoToMs(rawRows[rawRows.length - 1].bucket)
    const grid: { iso: string; cost: number; w: number; r: number; o: number; turns: number }[] = []
    for (let ms = loMs; ms <= hiMs; ms += bucketMs) {
      const iso = msToBucketIso(ms)
      const a = perBucket.get(iso) ?? { cost: 0, w: 0, r: 0, o: 0, turns: 0 }
      grid.push({ iso, ...a })
    }

    const cost = grid.map(g => g.cost)
    const turns = grid.map(g => g.turns)

    // COST-series robust baseline — for excess/magnitude/diagnostics only. It is deliberately NOT
    // a Gaussian null: raw $/min is non-negative, right-skewed, zero-inflated, so v1's
    // normalSf(modZ(cost)) produced mis-calibrated p-values. The calibrated null is the MARKED
    // POINT PROCESS below: cost/min = (Poisson turn count) × (lognormal per-turn cost).
    const baseline = robustBaseline(cost)

    // RATE null: robust background turn rate λ̂ — the trimmed Poisson MLE (mean of the buckets
    // whose count modified-z is not extreme, so a burst cannot inflate its own baseline).
    const turnModZ = modifiedZScores(turns, robustBaseline(turns))
    const bg = turns.filter((_, i) => Math.abs(turnModZ[i]) <= modZThreshold)
    const lambda = bg.length ? bg.reduce((s, v) => s + v, 0) / bg.length
      : turns.reduce((s, v) => s + v, 0) / Math.max(1, turns.length)

    // INTENSITY null: log per-turn cost over ACTIVE buckets only (the hurdle — a quiet minute is a
    // zero of the OCCUPANCY process, not a tiny cost; folding it in would bias median/MAD low and
    // inflate every active minute's z). The log transform is what licenses a Gaussian tail on
    // multiplicative per-turn cost (prefix size × rate × …).
    const isActive = (i: number): boolean => grid[i].turns > 0 && grid[i].cost > 0
    const active: number[] = []
    for (let i = 0; i < grid.length; i++) if (isActive(i)) active.push(i)
    const logPerTurn = active.map(i => Math.log(cost[i] / turns[i]))
    const intensityBaseline = logPerTurn.length ? robustBaseline(logPerTurn) : zeroBaseline
    const zIntensity = new Array<number>(grid.length).fill(0)
    for (let k = 0; k < active.length; k++) {
      zIntensity[active[k]] = modifiedZ(logPerTurn[k], intensityBaseline.median, intensityBaseline.mad, intensityBaseline.meanAD)
    }

    // Distribution tails from the `stochastic` community extension when available (an independent,
    // community-vetted engine cross-checked against our core to Δ≤2e-16 Poisson / ≤7e-8 normal —
    // disclosed in the result), else the unit-tested TS core.
    const want = opts.pvalueEngine ?? 'auto'
    const useExt = want === 'internal' ? false : await loadStochastic(query, want === 'stochastic')
    let pRate: number[]
    let pIntensity: number[]
    if (useExt) {
      const pv = await extPValues(query, turns, zIntensity, lambda)
      pRate = pv.pRate; pIntensity = pv.pIntensity
    } else {
      pRate = turns.map(t => poissonSF(t, lambda))
      pIntensity = zIntensity.map(normalSf)
    }
    // An inactive bucket carries NO intensity evidence: p ≡ 1 regardless of engine (its z slot is a
    // placeholder 0 that would otherwise read as p=0.5 and dilute Fisher for the whole series).
    for (let i = 0; i < grid.length; i++) if (!isActive(i)) pIntensity[i] = 1
    const pvalueEngine: 'stochastic' | 'internal' = useExt ? 'stochastic' : 'internal'

    // COMBINED per-bucket test: Fisher's method over (rate, intensity) — independent under H₀ by
    // Poisson thinning — then the FDR procedure bounds the false-discovery rate among flagged
    // buckets at α. BH is valid under our positively-correlated one-sided buckets (PRDS,
    // Benjamini–Yekutieli 2001 Thm 1.2); 'by' gives the arbitrary-dependence guarantee.
    const pCombined = turns.map((_, i) => fisherCombine(pRate[i], pIntensity[i]))
    const bh = (fdrMethod === 'by' ? benjaminiYekutieli : benjaminiHochberg)(pCombined, fdrAlpha)

    // STA/LTA (impulsive-onset) + CUSUM (regime-shift) diagnostics on the COMPRESSED cost series —
    // log1p tames the heavy tail so one mega-spike cannot blind the windowed averages.
    const logCost = cost.map(c => Math.log1p(c))
    const logBase = robustBaseline(logCost)
    const sta = staLta(logCost, staMin, ltaMin, staOn, staOff)
    const K = cusumK * logBase.sigmaHat
    const H = cusumH * logBase.sigmaHat
    const cp = H > 0 ? cusum(logCost, logBase.median, K, H) : { splus: [], sminus: [], alarms: [] }
    const changePoints = cp.alarms.map(i => grid[i].iso)

    const buckets: SeismicBucket[] = grid.map((g, i) => ({
      iso: g.iso, costUsd: g.cost, writeUsd: g.w, readUsd: g.r, outputUsd: g.o, turns: g.turns,
      modZ: zIntensity[i], pValueRate: pRate[i], pValueIntensity: pIntensity[i], pValue: pCombined[i],
      fdrSignificant: bh.rejected[i], staLtaRatio: sta.ratio[i],
    }))

    // SEGMENTATION — PELT (exact penalized changepoint detection) on log1p(cost) partitions the
    // window into statistically distinct regimes; an EVENT is a segment containing ≥1
    // FDR-significant bucket. Boundaries come from the changepoint method, significance from the
    // calibrated per-bucket tests — no ad-hoc gap-bridging. When PELT under-segments (a lone spike
    // merged into a long quiet regime whose mean is NOT elevated), the event shrinks to the
    // significant core so quiet minutes cannot dilute it; an elevated segment (a sustained plateau,
    // where only some buckets individually clear FDR) is taken WHOLE — that regime IS the event.
    const p = pelt(logCost, opts.peltPenalty !== undefined ? { penalty: opts.peltPenalty } : undefined)
    const peltChangepoints = p.changepoints.map(i => grid[i].iso)

    const modeOf = (w: number, r: number, total: number): BurnMode => {
      const wf = total > 0 ? w / total : 0, rf = total > 0 ? r / total : 0
      if (wf >= 0.5 && wf >= rf) return 'CACHE_THRASH'
      if (rf >= 0.5 && rf > wf) return 'MARATHON_REREAD'
      return 'MIXED'
    }
    const refCost = Math.max(baseline.median, 1e-9)
    const medianW = median(grid.map(g => g.w))
    const medianR = median(grid.map(g => g.r))
    // Evidence score −ln p, capped so p=0 (underflow) stays finite and comparable.
    const evScore = (x: number): number => -Math.log(Math.max(x, 1e-320))

    // Per-event per-session attribution from the session-resolved cells. Excess is measured against
    // the session's OWN out-of-event rate — a big steady spender contributes little excess; a spike
    // driver contributes most. sessionEventExcess accumulates across ALL events for the ranking.
    const idxOf = new Map<string, number>(grid.map((g, i) => [g.iso, i]))
    const sessionEventExcess = new Map<string, number>()
    const buildCulprits = (from: number, to: number): EventCulprit[] => {
      const durBuckets = to - from + 1
      const agg = new Map<string, { usd: number; w: number; r: number; o: number; turns: number; maxCc: number; models: Set<string> }>()
      for (const [key, cell] of perCell) {
        const sep = key.indexOf('|') // the bucket iso never contains '|'; the path after it may
        const idx = idxOf.get(key.slice(0, sep))
        if (idx === undefined || idx < from || idx > to) continue
        const filename = key.slice(sep + 1)
        const a = agg.get(filename) ?? { usd: 0, w: 0, r: 0, o: 0, turns: 0, maxCc: 0, models: new Set<string>() }
        a.usd += cell.cost; a.w += cell.w; a.r += cell.r; a.o += cell.o; a.turns += cell.turns
        a.maxCc = Math.max(a.maxCc, cell.maxCc)
        for (const m of cell.models) a.models.add(m)
        agg.set(filename, a)
      }
      const out: EventCulprit[] = []
      for (const [filename, a] of agg) {
        const sess = perSession.get(filename)
        if (!sess) continue
        const outsideBuckets = Math.max(1, grid.length - durBuckets)
        const baselineRate = Math.max(0, sess.cost - a.usd) / outsideBuckets
        const excess = Math.max(0, a.usd - baselineRate * durBuckets)
        const tags: CulpritTag[] = []
        // COLD_REWRITE needs a REAL prefix (≥50k): without the floor a fresh session's first turn
        // (cc>0, max prefix≈0) would trivially satisfy cc ≥ 0.8·0 and tag every newborn session.
        if (sess.maxPrefix >= 50_000 && a.maxCc >= 0.8 * sess.maxPrefix) tags.push('COLD_REWRITE')
        if (a.models.size > 1) tags.push('MODEL_SWITCH')
        out.push({
          session: path.basename(filename, '.jsonl'),
          project: path.basename(path.dirname(filename)),
          eventUsd: a.usd, excessUsd: excess, writeUsd: a.w, readUsd: a.r, outputUsd: a.o,
          turns: a.turns, tags, models: [...a.models].sort(),
        })
        sessionEventExcess.set(filename, (sessionEventExcess.get(filename) ?? 0) + excess)
      }
      return out.sort((x, y) => y.excessUsd - x.excessUsd).slice(0, 5)
    }

    const finalize = (from: number, to: number): SeismicEvent => {
      let costUsdE = 0, w = 0, r = 0, o = 0, tn = 0, peakUsd = 0, peakIso = grid[from].iso
      let peakModZ = 0, peakSta = 0, minP = 1, minPRate = 1, minPIntensity = 1
      for (let i = from; i <= to; i++) {
        const b = buckets[i]
        costUsdE += b.costUsd; w += b.writeUsd; r += b.readUsd; o += b.outputUsd; tn += b.turns
        if (b.costUsd > peakUsd) { peakUsd = b.costUsd; peakIso = b.iso }
        if (b.modZ > peakModZ) peakModZ = b.modZ
        if (b.staLtaRatio > peakSta) peakSta = b.staLtaRatio
        if (b.pValue < minP) minP = b.pValue
        if (b.pValueRate < minPRate) minPRate = b.pValueRate
        if (b.pValueIntensity < minPIntensity) minPIntensity = b.pValueIntensity
      }
      const durBuckets = to - from + 1
      const excessUsd = Math.max(0, costUsdE - baseline.median * durBuckets)
      // Which factor carries the statistical evidence decides the cause class; at intensity
      // dominance the W/R split of the COMPONENT excesses separates thrash from marathon.
      const excessW = Math.max(0, w - medianW * durBuckets)
      const excessR = Math.max(0, r - medianR * durBuckets)
      const sRate = evScore(minPRate)
      const sInt = evScore(minPIntensity)
      const cause: EventCause = sRate >= 2 * sInt ? 'FANOUT_RATE'
        : sInt >= 2 * sRate ? (excessW >= excessR ? 'FAT_TURN_THRASH' : 'FAT_TURN_MARATHON')
          : 'COMPOUND'
      return {
        fromIso: grid[from].iso, toIso: grid[to].iso,
        durMin: (isoToMs(grid[to].iso) - isoToMs(grid[from].iso)) / 60_000 + bucketMinutes,
        costUsd: costUsdE, excessUsd, writeUsd: w, readUsd: r, outputUsd: o, turns: tn,
        peakUsd, peakIso, peakModZ, peakStaLta: peakSta, minP, minPRate, minPIntensity,
        magnitude: magnitude(Math.max(0, peakUsd - baseline.median), refCost),
        dominantMode: modeOf(w, r, costUsdE), cause,
        culprits: buildCulprits(from, to),
      }
    }

    const rawEvents: SeismicEvent[] = []
    for (const seg of p.segments) {
      let first = -1, last = -1
      for (let i = seg.from; i <= seg.to; i++) {
        if (bh.rejected[i]) { if (first < 0) first = i; last = i }
      }
      if (first < 0) continue
      let segCost = 0
      for (let i = seg.from; i <= seg.to; i++) segCost += cost[i]
      const elevated = segCost / (seg.to - seg.from + 1) > baseline.median
      rawEvents.push(elevated ? finalize(seg.from, seg.to) : finalize(first, last))
    }
    // Events rank by EXCESS (the anomaly's energy), not raw $ — raw totals conflate the baseline.
    const events = rawEvents.sort((a, b) => b.excessUsd - a.excessUsd)
    const mainshock = events[0]

    // B) sessions from the already-aggregated per-session map (no second scan). Ranked by their
    // ACCUMULATED EVENT EXCESS — "who drove the anomalies" — with total $ as the tiebreak; a big
    // spender at steady baseline is background, not a culprit.
    const sessions: SeismicSession[] = [...perSession.entries()].map(([filename, s]) => ({
      session: path.basename(filename, '.jsonl'),
      project: path.basename(path.dirname(filename)),
      costUsd: s.cost, writeUsd: s.w, readUsd: s.r, outputUsd: s.o, turns: s.turns,
      maxPrefixTokens: s.maxPrefix,
      eventExcessUsd: sessionEventExcess.get(filename) ?? 0,
    })).sort((a, b) => (b.eventExcessUsd - a.eventExcessUsd) || (b.costUsd - a.costUsd)).slice(0, topSessions)

    // C) spawn calls inside the mainshock, verbatim + timestamped (the trigger calls, if any).
    let spawnsInMainshock: SpawnCall[] = []
    if (mainshock) {
      const toList = SPAWN_TOOLS.map(sqlStr).join(', ')
      // The window filter MUST compare CAST timestamps: the raw column is ISO-T ('…T11:27:00Z')
      // while the bucket bounds are naive ('… 11:27:00'), and a VARCHAR compare of the two formats
      // breaks at char 11 ('T' > ' '), silently passing EVERY line of the day — the live fleet run
      // listed 01:14 spawns inside an 11:27 mainshock before this cast.
      const spawnRows = await query(`
        WITH lines AS (
          SELECT CAST(timestamp AS TIMESTAMP) AS ts, filename, message FROM ${readJson}
          WHERE type='assistant'
            AND CAST(timestamp AS TIMESTAMP) >= TIMESTAMP ${sqlStr(mainshock.fromIso)}
            AND CAST(timestamp AS TIMESTAMP) < TIMESTAMP ${sqlStr(mainshock.toIso)} + ${BK}
        ),
        blocks AS (SELECT ts, filename, UNNEST(json_extract(message,'$.content[*]')) AS block FROM lines)
        SELECT CAST(ts AS VARCHAR) AS ts, json_extract_string(block,'$.name') AS tool,
               json_extract_string(block,'$.input.subagent_type') AS subagent_type,
               json_extract_string(block,'$.input.model') AS model,
               CAST(json_extract(block,'$.input') AS VARCHAR) AS input, filename
        FROM blocks WHERE json_extract_string(block,'$.type')='tool_use'
          AND json_extract_string(block,'$.name') IN (${toList}) ORDER BY ts;`)
      spawnsInMainshock = spawnRows.map((r, i): SpawnCall => ({
        n: i + 1, iso: String(r.ts), tool: String(r.tool),
        subagentType: r.subagent_type == null ? null : String(r.subagent_type),
        model: r.model == null ? null : String(r.model),
        input: String(r.input), sessionId: path.basename(String(r.filename), '.jsonl'),
      }))
    }

    // Calibration honesty check: among BACKGROUND (non-flagged) buckets, the share with combined
    // p < 0.05 should be ≤ 0.05 under a calibrated null (Poisson discreteness makes the rate test
    // conservative, so slightly BELOW is expected; far ABOVE means the null is mis-specified —
    // exactly the defect this v2 exists to eliminate). null when the background is too small.
    const bgIdx = pCombined.map((_, i) => i).filter(i => !bh.rejected[i])
    const observedBackgroundShare = bgIdx.length >= 20
      ? bgIdx.filter(i => pCombined[i] < 0.05).length / bgIdx.length
      : null

    const totalWriteUsd = grid.reduce((s, g) => s + g.w, 0)
    const totalReadUsd = grid.reduce((s, g) => s + g.r, 0)
    const totalOutputUsd = grid.reduce((s, g) => s + g.o, 0)
    const totalUsd = cost.reduce((s, v) => s + v, 0)
    const dominantModeOverall = modeOf(totalWriteUsd, totalReadUsd, totalUsd)
    const rp = totalUsd > 0 ? Math.round((100 * totalReadUsd) / totalUsd) : 0
    const wp = totalUsd > 0 ? Math.round((100 * totalWriteUsd) / totalUsd) : 0
    const fatCount = sessions.filter(s => s.maxPrefixTokens >= 300_000).length
    const fanoutEvents = events.filter(e => e.cause === 'FANOUT_RATE').length
    const thrashEvents = events.filter(e => e.cause === 'FAT_TURN_THRASH').length
    const causeTail = `${thrashEvents} thrash spike(s), ${fanoutEvents} fan-out burst(s) among ${events.length} event(s).`
    const verdict = dominantModeOverall === 'MARATHON_REREAD'
      ? `MARATHON RE-READ dominates: ${rp}% of $ is sustained cache-READ across ${fatCount} fat (≥300k-prefix) sessions re-reading every turn; cold-WRITE adds ${wp}%. ${causeTail}`
      : dominantModeOverall === 'CACHE_THRASH'
        ? `CACHE_THRASH dominates: ${wp}% of $ is cold cache-WRITE (prefix cold-invalidation); sustained re-read is ${rp}%. ${causeTail}`
        : `MIXED: cache-READ ${rp}% (re-read) vs cold-WRITE ${wp}% (thrash) are comparable. ${causeTail}`
    return {
      windowSinceIso: sinceIso, bucketMinutes, filesAnalysed: files.length,
      totalUsd, totalWriteUsd, totalReadUsd, totalOutputUsd,
      totalTurns: turns.reduce((s, v) => s + v, 0), bucketCount: grid.length,
      baseline, poissonLambda: lambda, intensityBaseline,
      fdrAlpha, fdrMethod, fdrThreshold: bh.threshold, fdrSignificantCount: bh.nRejected,
      calibration: { alpha: 0.05, observedBackgroundShare },
      pvalueEngine, dominantModeOverall, verdict, changePoints, peltChangepoints,
      events: events.slice(0, topEvents), mainshock, sessions, spawnsInMainshock, buckets,
    }
  } finally {
    con.closeSync()
    inst.closeSync()
  }
}

const money = (x: number): string => '$' + x.toFixed(2)
const pctOf = (a: number, b: number): string => (b > 0 ? Math.round((100 * a) / b) : 0) + '%'

/** Professional, seismology-styled text report of the analysis (for the CLI + investigate_burn). */
export function renderBurnSeismic(r: BurnSeismicResult): string {
  if (r.reason) return `burn-seismic: no analysis (${r.reason})`
  const L: string[] = []
  L.push('BURN EVENT — COST SEISMOGRAM v2 (marked-point-process null, calibrated statistics)')
  L.push(`  window since ${r.windowSinceIso}   bucket ${r.bucketMinutes}m   files ${r.filesAnalysed}`)
  L.push(`  series: ${r.bucketCount} buckets, ${r.totalTurns} costed turns, ${money(r.totalUsd)} total`)
  L.push(`    split: cache-WRITE(cold) ${money(r.totalWriteUsd)} (${pctOf(r.totalWriteUsd, r.totalUsd)})` +
         `  cache-READ ${money(r.totalReadUsd)} (${pctOf(r.totalReadUsd, r.totalUsd)})` +
         `  output ${money(r.totalOutputUsd)} (${pctOf(r.totalOutputUsd, r.totalUsd)})`)
  L.push(`  null model: turns ~ Poisson(λ̂=${r.poissonLambda.toFixed(2)}/bucket) × per-turn cost ~ lognormal` +
         ` (log-median ${r.intensityBaseline.median.toFixed(2)}, log-MAD ${r.intensityBaseline.mad.toFixed(2)}); Fisher-combined (χ²₄)`)
  L.push(`  cost baseline (median/MAD): ${money(r.baseline.median)}/min, MAD ${money(r.baseline.mad)}`)
  L.push(`  p-value engine: ${r.pvalueEngine === 'stochastic' ? 'stochastic community extension (independent)' : 'internal TS core (unit-tested vs textbook + stochastic Δ≤2e-16)'}`)
  L.push(`  significance: ${r.fdrMethod.toUpperCase()} FDR α=${r.fdrAlpha} on combined p → ${r.fdrSignificantCount} significant buckets (crit p ≤ ${r.fdrThreshold.toExponential(2)})`)
  L.push(`  calibration: background share with p<0.05 = ${r.calibration.observedBackgroundShare === null ? 'n/a (background too small)' : (100 * r.calibration.observedBackgroundShare).toFixed(1) + '% (expected ≤5% — Poisson-discrete conservative)'}`)
  L.push(`  segmentation: PELT changepoints ${r.peltChangepoints.length}   |   CUSUM alarms ${r.changePoints.length}`)
  if (r.verdict) L.push(`  VERDICT: ${r.verdict}`)

  if (!r.mainshock) { L.push('  no statistically significant event in window.'); return L.join('\n') }

  L.push('')
  L.push(`EVENT CATALOG (PELT segments with FDR-significant buckets, ranked by EXCESS $):`)
  L.push('   #  onset (UTC)          dur   excess$    total$   mag   p(comb)     cause')
  r.events.forEach((e, i) => {
    L.push(`  ${String(i + 1).padStart(2)}  ${e.fromIso}  ${String(e.durMin).padStart(4)}m  ` +
      `${money(e.excessUsd).padStart(8)}  ${money(e.costUsd).padStart(8)}  ${e.magnitude.toFixed(1)}  ` +
      `${e.minP.toExponential(1).padStart(9)}   ${e.cause}`)
  })

  const m = r.mainshock
  L.push('')
  L.push(`MAINSHOCK  ${m.fromIso} → ${m.toIso}  (~${m.durMin} min)   excess ${money(m.excessUsd)} of ${money(m.costUsd)}, ${m.turns} turns`)
  L.push(`  cause: ${m.cause}   evidence: rate p ${m.minPRate.toExponential(1)} vs intensity p ${m.minPIntensity.toExponential(1)}   magnitude ${m.magnitude.toFixed(2)}`)
  L.push(`  peak ${money(m.peakUsd)}/bucket at ${m.peakIso}   intensity-z ${m.peakModZ.toFixed(1)}   STA/LTA ${m.peakStaLta.toFixed(1)}`)
  L.push(`  decomposition: cold-WRITE ${money(m.writeUsd)} (${pctOf(m.writeUsd, m.costUsd)})  READ ${money(m.readUsd)} (${pctOf(m.readUsd, m.costUsd)})  output ${money(m.outputUsd)} (${pctOf(m.outputUsd, m.costUsd)})   mode: ${m.dominantMode}`)
  if (m.culprits.length) {
    L.push('  CULPRITS (sessions by excess inside this event):')
    for (const c of m.culprits) {
      const tagStr = c.tags.length ? `  [${c.tags.join(', ')}]` : ''
      L.push(`    ${money(c.excessUsd).padStart(8)} excess of ${money(c.eventUsd).padStart(8)}  ${String(c.turns).padStart(4)}t  ` +
        `W/R/O ${pctOf(c.writeUsd, c.eventUsd)}/${pctOf(c.readUsd, c.eventUsd)}/${pctOf(c.outputUsd, c.eventUsd)}  ` +
        `${c.session.slice(0, 8)} · ${c.project}${tagStr}`)
    }
  }

  L.push('')
  L.push('TOP SESSIONS (ranked by accumulated EVENT EXCESS — who drove the anomalies):')
  L.push('   evtExcess$    total$   turns   maxPrefix   W/R/O split       session · project')
  for (const s of r.sessions) {
    const split = `${pctOf(s.writeUsd, s.costUsd)}/${pctOf(s.readUsd, s.costUsd)}/${pctOf(s.outputUsd, s.costUsd)}`
    L.push(`  ${money(s.eventExcessUsd).padStart(10)}  ${money(s.costUsd).padStart(9)}  ${String(s.turns).padStart(5)}  ${String(s.maxPrefixTokens).padStart(9)}   ${split.padEnd(15)}  ${s.session.slice(0, 8)} · ${s.project}`)
  }

  L.push('')
  L.push(`SPAWN CALLS INSIDE MAINSHOCK (${r.spawnsInMainshock.length}) — verbatim, time-ordered:`)
  if (r.spawnsInMainshock.length === 0) {
    L.push('  (none — the mainshock is cost-driven (cache thrash / re-read), not a new fan-out)')
  } else {
    for (const c of r.spawnsInMainshock) {
      const tag = [c.tool, c.subagentType && `subagent_type=${c.subagentType}`, c.model && `model=${c.model}`].filter(Boolean).join(' ')
      const shown = c.input.length > 300 ? c.input.slice(0, 300) + `…(+${c.input.length - 300}b)` : c.input
      L.push(`  ${c.n}. ${c.iso}  [${c.sessionId.slice(0, 8)}]  ${tag}`)
      L.push(`       ${shown}`)
    }
  }
  return L.join('\n')
}
