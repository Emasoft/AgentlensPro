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
// The statistics (each a NAMED, unit-tested method — see seismicStats.ts):
//   • robust baseline: median + MAD → Iglewicz–Hoaglin modified-z (immune to the outliers detected)
//   • significance:    Poisson exceedance p-value on per-bucket TURN COUNT, robust λ from the
//                      non-anomalous background, then Benjamini–Hochberg FDR (proven false-discovery
//                      bound) — the anomaly set is defensible, not a hand-picked threshold
//   • event interval:  STA/LTA trigger (Allen 1978) on the cost signal — a mathematically-defined
//                      onset/offset, not a fixed window
//   • change-point:    CUSUM (Page 1954) — the regime-shift instant
//   • magnitude:       log₁₀(peak/baseline) (Gutenberg–Richter analogue) for ranking
//
// Data extraction is DuckDB streaming C++ over the NDJSON (transcripts reach ~2 GB with base64
// images; maximum_object_size is raised past the largest line so a fat line SKIPS, never aborts).

import * as fs from 'fs'
import * as path from 'path'
import { claudeProjectsDirs } from './logReader'
import { lookupRates } from './shared/pricing'
import {
  robustBaseline, modifiedZScores, normalSf, poissonSF, benjaminiHochberg, staLta, cusum, magnitude,
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

export type SeismicSignal = 'cost' | 'count'

export interface BurnSeismicOptions {
  /** Transcript files to analyse (resolved by the caller — a workspace, the fleet, one session). */
  files: string[]
  /** Lower bound of the analysed window (ISO). Default: 24 h before now. */
  sinceIso?: string
  /** Bucket width in minutes. Default 1. */
  bucketMinutes?: number
  /** Which series drives baseline/modZ/STA-LTA/CUSUM. Default 'cost' (the correct instrument). */
  signal?: SeismicSignal
  /** Iglewicz–Hoaglin outlier flag. Default 3.5. */
  modZThreshold?: number
  /** Benjamini–Hochberg FDR level. Default 0.01. */
  fdrAlpha?: number
  /** Bucket-gap bridged between two significant buckets in one event (a lull inside a burst). Default 2. */
  gapMinutes?: number
  /** STA / LTA window minutes and trigger thresholds (Allen 1978). Defaults 3 / 60, on 4, off 1.5. */
  staMinutes?: number
  ltaMinutes?: number
  staLtaOn?: number
  staLtaOff?: number
  /** CUSUM allowance K and decision interval H, in units of σ̂. Defaults 0.5 and 5. */
  cusumKSigma?: number
  cusumHSigma?: number
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
  /** Iglewicz–Hoaglin modified z of the primary signal. */
  modZ: number
  /** One-sided p-value of the primary (cost) signal — normalSf(modZ). Drives significance/FDR. */
  pValue: number
  /** Corroborating Poisson exceedance p-value of this bucket's TURN COUNT under the background rate. */
  pValuePoisson: number
  /** Survived Benjamini–Hochberg FDR at α on the primary p-values (a statistically-significant anomaly). */
  fdrSignificant: boolean
  staLtaRatio: number
}

export type BurnMode = 'CACHE_THRASH' | 'MARATHON_REREAD' | 'MIXED'

export interface SeismicEvent {
  fromIso: string
  toIso: string
  durMin: number
  costUsd: number
  writeUsd: number
  readUsd: number
  outputUsd: number
  turns: number
  peakUsd: number
  peakIso: string
  peakModZ: number
  peakStaLta: number
  /** Most significant (smallest) Poisson p-value inside the event. */
  minP: number
  /** log₁₀(peak/baseline) — Gutenberg–Richter analogue. */
  magnitude: number
  dominantMode: BurnMode
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
}

export type SeismicReason = 'no-files' | 'duckdb-unavailable' | 'no-costed-turns'

export interface BurnSeismicResult {
  windowSinceIso: string
  bucketMinutes: number
  signal: SeismicSignal
  filesAnalysed: number
  totalUsd: number
  totalWriteUsd: number
  totalReadUsd: number
  totalOutputUsd: number
  totalTurns: number
  bucketCount: number
  baseline: RobustBaseline
  /** Robust background turn rate λ used for the Poisson significance test. */
  poissonLambda: number
  fdrAlpha: number
  fdrThreshold: number
  fdrSignificantCount: number
  /** Which engine produced the distribution p-values (disclosed for reproducibility):
   *  'stochastic' = the community DuckDB extension; 'internal' = the unit-tested TS core. */
  pvalueEngine: 'stochastic' | 'internal'
  /** The burn mode that dominates the window's TOTAL $ (read-share vs write-share). */
  dominantModeOverall: BurnMode
  /** One-line plain-language bottom line derived from the totals + event count. */
  verdict: string
  /** CUSUM change-point instants (ISO). */
  changePoints: string[]
  events: SeismicEvent[]
  mainshock?: SeismicEvent
  sessions: SeismicSession[]
  spawnsInMainshock: SpawnCall[]
  buckets: SeismicBucket[]
  reason?: SeismicReason
}

interface RawRow { bucket: string; model: string; inp: number; cc: number; cr: number; out: number; turns: number }
interface SessRow { filename: string; model: string; cc: number; cr: number; out: number; inp: number; turns: number; maxcr: number }

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
 *  core): the upper-tail Poisson exceedance P(X ≥ turns | λ) and the normal SF 1−Φ(modZ). One SQL
 *  pass over an inline values table. */
async function extPValues(query: Query, turns: number[], modZ: number[], lambda: number): Promise<{ pPoisson: number[]; pPrimary: number[] }> {
  const rows = turns.map((t, i) => `(${i}, ${Math.max(0, Math.round(t))}, ${Number.isFinite(modZ[i]) ? modZ[i] : 0})`).join(',')
  // P(X ≥ k) = P(X > k) + P(X = k) = complement(λ,k) + pmf(λ,k) — avoids the k−1 negative-arg edge.
  const out = await query(`
    WITH t(i, turns, modz) AS (VALUES ${rows})
    SELECT i,
      dist_poisson_cdf_complement(${lambda}, turns) + dist_poisson_pdf(${lambda}, turns) AS p_pois,
      dist_normal_cdf_complement(0.0, 1.0, modz) AS p_norm
    FROM t ORDER BY i;`)
  const pPoisson = new Array<number>(turns.length).fill(1)
  const pPrimary = new Array<number>(turns.length).fill(1)
  for (const r of out) {
    const i = Number(r.i)
    pPoisson[i] = Math.max(0, Math.min(1, Number(r.p_pois)))
    pPrimary[i] = Math.max(0, Math.min(1, Number(r.p_norm)))
  }
  return { pPoisson, pPrimary }
}

/**
 * Run the full seismic pipeline over the transcript set. Returns a structured, reproducible result
 * (or an empty result with a typed reason — never a fabricated event).
 */
export async function burnSeismic(opts: BurnSeismicOptions): Promise<BurnSeismicResult> {
  const bucketMinutes = opts.bucketMinutes ?? 1
  const signal = opts.signal ?? 'cost'
  const modZThreshold = opts.modZThreshold ?? 3.5
  const fdrAlpha = opts.fdrAlpha ?? 0.01
  const staMin = opts.staMinutes ?? 3
  const ltaMin = opts.ltaMinutes ?? 60
  const staOn = opts.staLtaOn ?? 4
  const staOff = opts.staLtaOff ?? 1.5
  const cusumK = opts.cusumKSigma ?? 0.5
  const cusumH = opts.cusumHSigma ?? 5
  const topEvents = opts.topEvents ?? 10
  const topSessions = opts.topSessions ?? 10
  const sinceIso = opts.sinceIso ?? new Date(Date.now() - 24 * 3600_000).toISOString()

  const empty = (reason: SeismicReason): BurnSeismicResult => ({
    windowSinceIso: sinceIso, bucketMinutes, signal, filesAnalysed: opts.files.length,
    totalUsd: 0, totalWriteUsd: 0, totalReadUsd: 0, totalOutputUsd: 0, totalTurns: 0, bucketCount: 0,
    baseline: { median: 0, mad: 0, meanAD: 0, sigmaHat: 0 }, poissonLambda: 0,
    fdrAlpha, fdrThreshold: 0, fdrSignificantCount: 0, pvalueEngine: 'internal',
    dominantModeOverall: 'MIXED', verdict: '',
    changePoints: [], events: [], sessions: [], spawnsInMainshock: [], buckets: [], reason,
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
    // A) per-(bucket, model) raw token sums + turn count.
    const rawRows = (await query(`
      WITH raw AS (
        SELECT time_bucket(${BK}, CAST(timestamp AS TIMESTAMP)) AS bucket,
               json_extract_string(message,'$.model') AS model,
               TRY_CAST(json_extract_string(message,'$.usage.input_tokens') AS BIGINT) AS inp,
               TRY_CAST(json_extract_string(message,'$.usage.cache_creation_input_tokens') AS BIGINT) AS cc,
               TRY_CAST(json_extract_string(message,'$.usage.cache_read_input_tokens') AS BIGINT) AS cr,
               TRY_CAST(json_extract_string(message,'$.usage.output_tokens') AS BIGINT) AS out
        FROM ${readJson}
        WHERE type='assistant' AND timestamp >= ${sqlStr(sinceIso)} AND json_extract(message,'$.usage') IS NOT NULL
      )
      SELECT CAST(bucket AS VARCHAR) AS bucket, coalesce(model,'?') AS model,
             sum(coalesce(inp,0)) AS inp, sum(coalesce(cc,0)) AS cc,
             sum(coalesce(cr,0)) AS cr, sum(coalesce(out,0)) AS out, count(*) AS turns
      FROM raw GROUP BY 1,2 ORDER BY 1;`)).map((r): RawRow => ({
      bucket: String(r.bucket), model: String(r.model),
      inp: numOf(r.inp), cc: numOf(r.cc), cr: numOf(r.cr), out: numOf(r.out), turns: numOf(r.turns),
    }))
    if (rawRows.length === 0) { con.closeSync(); inst.closeSync(); return empty('no-costed-turns') }

    // Densify onto a continuous minute grid so quiet minutes count as the true zero baseline.
    const bucketMs = bucketMinutes * 60_000
    const perBucket = new Map<string, { cost: number; w: number; r: number; o: number; turns: number }>()
    for (const row of rawRows) {
      const p = costParts(row.model, row.inp, row.cc, row.cr, row.out)
      const acc = perBucket.get(row.bucket) ?? { cost: 0, w: 0, r: 0, o: 0, turns: 0 }
      acc.cost += p.i + p.r + p.w + p.o; acc.w += p.w; acc.r += p.r; acc.o += p.o; acc.turns += row.turns
      perBucket.set(row.bucket, acc)
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
    const primary = signal === 'count' ? turns : cost

    // Robust baseline + modified-z on the primary signal.
    const baseline = robustBaseline(primary)
    const modZ = modifiedZScores(primary, baseline)

    // Robust background turn rate λ = mean turns of the non-anomalous background (|count modified-z|
    // ≤ threshold) so the burst can't inflate its own baseline (the Poisson MLE, contamination-guarded).
    const turnModZ = modifiedZScores(turns, robustBaseline(turns))
    const bg = turns.filter((_, i) => Math.abs(turnModZ[i]) <= modZThreshold)
    const lambda = bg.length ? bg.reduce((s, v) => s + v, 0) / bg.length
      : turns.reduce((s, v) => s + v, 0) / Math.max(1, turns.length)

    // SIGNIFICANCE — distribution p-values from the `stochastic` community extension when available
    // (an independent, community-vetted engine cross-checked against our core to Δ≤2e-16 Poisson /
    // ≤7e-8 normal), else the unit-tested TS core. Primary = normal SF of the robust modified-z
    // (already on the ~N(0,1) scale); corroborating = exact Poisson exceedance on TURN COUNTS.
    const want = opts.pvalueEngine ?? 'auto'
    const useExt = want === 'internal' ? false : await loadStochastic(query, want === 'stochastic')
    let pPrimary: number[]
    let pPoisson: number[]
    if (useExt) {
      const pv = await extPValues(query, turns, modZ, lambda)
      pPrimary = pv.pPrimary; pPoisson = pv.pPoisson
    } else {
      pPrimary = modZ.map(normalSf); pPoisson = turns.map(t => poissonSF(t, lambda))
    }
    const pvalueEngine: 'stochastic' | 'internal' = useExt ? 'stochastic' : 'internal'

    // Benjamini–Hochberg on the primary p-values bounds the false-discovery rate among flagged
    // buckets at α — a defensible anomaly set, not a hand-picked cutoff.
    const bh = benjaminiHochberg(pPrimary, fdrAlpha)

    // STA/LTA (impulsive-onset detector) + CUSUM (regime-shift) as diagnostics on the primary signal.
    const sta = staLta(primary, staMin, ltaMin, staOn, staOff)
    const K = cusumK * baseline.sigmaHat
    const H = cusumH * baseline.sigmaHat
    const cp = H > 0 ? cusum(primary, baseline.median, K, H) : { splus: [], sminus: [], alarms: [] }
    const changePoints = cp.alarms.map(i => grid[i].iso)

    const buckets: SeismicBucket[] = grid.map((g, i) => ({
      iso: g.iso, costUsd: g.cost, writeUsd: g.w, readUsd: g.r, outputUsd: g.o, turns: g.turns,
      modZ: modZ[i], pValue: pPrimary[i], pValuePoisson: pPoisson[i], fdrSignificant: bh.rejected[i],
      staLtaRatio: sta.ratio[i],
    }))

    // EVENTS = maximal runs of FDR-significant buckets, bridging a lull of ≤ gapBuckets. This works
    // for a SUSTAINED burn (a tremor: STA/LTA won't trigger because STA≈LTA) as well as an impulsive
    // one; STA/LTA and CUSUM ride along each event as diagnostics.
    const gapBuckets = Math.max(0, Math.round(opts.gapMinutes ?? 2))
    const modeOf = (w: number, r: number, total: number): BurnMode => {
      const wf = total > 0 ? w / total : 0, rf = total > 0 ? r / total : 0
      if (wf >= 0.5 && wf >= rf) return 'CACHE_THRASH'
      if (rf >= 0.5 && rf > wf) return 'MARATHON_REREAD'
      return 'MIXED'
    }
    const refCost = Math.max(baseline.median, 1e-9)
    const finalize = (from: number, to: number): SeismicEvent => {
      let costUsd = 0, w = 0, r = 0, o = 0, tn = 0, peakUsd = 0, peakIso = grid[from].iso
      let peakModZ = 0, peakSta = 0, minP = 1
      for (let i = from; i <= to; i++) {
        const b = buckets[i]
        costUsd += b.costUsd; w += b.writeUsd; r += b.readUsd; o += b.outputUsd; tn += b.turns
        if (b.costUsd > peakUsd) { peakUsd = b.costUsd; peakIso = b.iso }
        if (b.modZ > peakModZ) peakModZ = b.modZ
        if (b.staLtaRatio > peakSta) peakSta = b.staLtaRatio
        if (b.pValue < minP) minP = b.pValue
      }
      return {
        fromIso: grid[from].iso, toIso: grid[to].iso,
        durMin: (isoToMs(grid[to].iso) - isoToMs(grid[from].iso)) / 60_000 + bucketMinutes,
        costUsd, writeUsd: w, readUsd: r, outputUsd: o, turns: tn,
        peakUsd, peakIso, peakModZ, peakStaLta: peakSta, minP,
        magnitude: magnitude(peakUsd, refCost), dominantMode: modeOf(w, r, costUsd),
      }
    }
    const rawEvents: SeismicEvent[] = []
    let runFrom = -1, lastSig = -1
    for (let i = 0; i < buckets.length; i++) {
      if (!buckets[i].fdrSignificant) continue
      if (runFrom >= 0 && i - lastSig - 1 > gapBuckets) { rawEvents.push(finalize(runFrom, lastSig)); runFrom = -1 }
      if (runFrom < 0) runFrom = i
      lastSig = i
    }
    if (runFrom >= 0) rawEvents.push(finalize(runFrom, lastSig))
    const events = rawEvents.sort((a, b) => b.costUsd - a.costUsd)
    const mainshock = events[0]

    // B) per-session totals across the whole window → the biggest burners.
    const sessRows = (await query(`
      WITH raw AS (
        SELECT filename, json_extract_string(message,'$.model') AS model,
               TRY_CAST(json_extract_string(message,'$.usage.input_tokens') AS BIGINT) AS inp,
               TRY_CAST(json_extract_string(message,'$.usage.cache_creation_input_tokens') AS BIGINT) AS cc,
               TRY_CAST(json_extract_string(message,'$.usage.cache_read_input_tokens') AS BIGINT) AS cr,
               TRY_CAST(json_extract_string(message,'$.usage.output_tokens') AS BIGINT) AS out
        FROM ${readJson}
        WHERE type='assistant' AND timestamp >= ${sqlStr(sinceIso)} AND json_extract(message,'$.usage') IS NOT NULL
      )
      SELECT filename, coalesce(model,'?') AS model,
             sum(coalesce(inp,0)) AS inp, sum(coalesce(cc,0)) AS cc, sum(coalesce(cr,0)) AS cr,
             sum(coalesce(out,0)) AS out, count(*) AS turns, max(coalesce(cr,0)) AS maxcr
      FROM raw GROUP BY 1,2;`)).map((r): SessRow => ({
      filename: String(r.filename), model: String(r.model), inp: numOf(r.inp), cc: numOf(r.cc),
      cr: numOf(r.cr), out: numOf(r.out), turns: numOf(r.turns), maxcr: numOf(r.maxcr),
    }))
    const sessMap = new Map<string, SeismicSession>()
    for (const s of sessRows) {
      const session = path.basename(s.filename, '.jsonl')
      const project = path.basename(path.dirname(s.filename))
      const p = costParts(s.model, s.inp, s.cc, s.cr, s.out)
      const acc = sessMap.get(s.filename) ?? { session, project, costUsd: 0, writeUsd: 0, readUsd: 0, outputUsd: 0, turns: 0, maxPrefixTokens: 0 }
      acc.costUsd += p.i + p.r + p.w + p.o; acc.writeUsd += p.w; acc.readUsd += p.r; acc.outputUsd += p.o
      acc.turns += s.turns; acc.maxPrefixTokens = Math.max(acc.maxPrefixTokens, s.maxcr)
      sessMap.set(s.filename, acc)
    }
    const sessions = [...sessMap.values()].sort((a, b) => b.costUsd - a.costUsd).slice(0, topSessions)

    // C) spawn calls inside the mainshock, verbatim + timestamped (the trigger calls, if any).
    let spawnsInMainshock: SpawnCall[] = []
    if (mainshock) {
      const toList = SPAWN_TOOLS.map(sqlStr).join(', ')
      const spawnRows = await query(`
        WITH lines AS (
          SELECT CAST(timestamp AS TIMESTAMP) AS ts, filename, message FROM ${readJson}
          WHERE type='assistant' AND timestamp >= ${sqlStr(mainshock.fromIso)}
            AND timestamp <= ${sqlStr(new Date(isoToMs(mainshock.toIso) + bucketMs).toISOString())}
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

    const totalWriteUsd = grid.reduce((s, g) => s + g.w, 0)
    const totalReadUsd = grid.reduce((s, g) => s + g.r, 0)
    const totalOutputUsd = grid.reduce((s, g) => s + g.o, 0)
    const totalUsd = cost.reduce((s, v) => s + v, 0)
    const dominantModeOverall = modeOf(totalWriteUsd, totalReadUsd, totalUsd)
    const rp = totalUsd > 0 ? Math.round((100 * totalReadUsd) / totalUsd) : 0
    const wp = totalUsd > 0 ? Math.round((100 * totalWriteUsd) / totalUsd) : 0
    const fatCount = sessions.filter(s => s.maxPrefixTokens >= 300_000).length
    const thrashEvents = events.filter(e => e.dominantMode === 'CACHE_THRASH').length
    const verdict = dominantModeOverall === 'MARATHON_REREAD'
      ? `MARATHON RE-READ dominates: ${rp}% of $ is sustained cache-READ across ${fatCount} fat (≥300k-prefix) sessions re-reading every turn; ${thrashEvents} discrete cold-WRITE (thrash) spikes add ${wp}%.`
      : dominantModeOverall === 'CACHE_THRASH'
        ? `CACHE_THRASH dominates: ${wp}% of $ is cold cache-WRITE (prefix cold-invalidation); sustained re-read is ${rp}%.`
        : `MIXED: cache-READ ${rp}% (re-read) vs cold-WRITE ${wp}% (thrash) are comparable; ${thrashEvents} discrete thrash spikes.`
    return {
      windowSinceIso: sinceIso, bucketMinutes, signal, filesAnalysed: files.length,
      totalUsd, totalWriteUsd, totalReadUsd, totalOutputUsd,
      totalTurns: turns.reduce((s, v) => s + v, 0), bucketCount: grid.length,
      baseline, poissonLambda: lambda, fdrAlpha, fdrThreshold: bh.threshold,
      fdrSignificantCount: bh.nRejected, pvalueEngine, dominantModeOverall, verdict, changePoints,
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
  L.push('BURN EVENT — COST SEISMOGRAM (proven statistical anomaly analysis)')
  L.push(`  window since ${r.windowSinceIso}   bucket ${r.bucketMinutes}m   signal ${r.signal}   files ${r.filesAnalysed}`)
  L.push(`  series: ${r.bucketCount} buckets, ${r.totalTurns} costed turns, ${money(r.totalUsd)} total`)
  L.push(`    split: cache-WRITE(cold) ${money(r.totalWriteUsd)} (${pctOf(r.totalWriteUsd, r.totalUsd)})` +
         `  cache-READ ${money(r.totalReadUsd)} (${pctOf(r.totalReadUsd, r.totalUsd)})` +
         `  output ${money(r.totalOutputUsd)} (${pctOf(r.totalOutputUsd, r.totalUsd)})`)
  L.push(`  robust baseline (median/MAD): median ${money(r.baseline.median)}/min, MAD ${money(r.baseline.mad)}, σ̂ ${money(r.baseline.sigmaHat)}`)
  L.push(`  p-value engine: ${r.pvalueEngine === 'stochastic' ? 'stochastic community extension (independent)' : 'internal TS core (unit-tested vs textbook + stochastic Δ≤2e-16)'}`)
  L.push(`  significance: Benjamini–Hochberg FDR α=${r.fdrAlpha} on robust-z cost p-values → ${r.fdrSignificantCount} significant buckets (crit p ≤ ${r.fdrThreshold.toExponential(2)})`)
  L.push(`  corroboration: Poisson turn-rate λ=${r.poissonLambda.toFixed(2)}/min   |   CUSUM change-points: ${r.changePoints.length}${r.changePoints.length ? ' (' + r.changePoints[0] + ' …)' : ''}`)
  if (r.verdict) L.push(`  VERDICT: ${r.verdict}`)

  if (!r.mainshock) { L.push('  no FDR-significant event in window.'); return L.join('\n') }

  L.push('')
  L.push(`EVENT CATALOG (FDR-significant runs, ranked by $ released):`)
  L.push('   #  onset (UTC)          dur    total$    peak$/min  mag   modZ    p(cost)      mode')
  r.events.forEach((e, i) => {
    L.push(`  ${String(i + 1).padStart(2)}  ${e.fromIso}  ${String(e.durMin).padStart(4)}m  ` +
      `${money(e.costUsd).padStart(8)}  ${money(e.peakUsd).padStart(8)}  ${e.magnitude.toFixed(1)}  ` +
      `${e.peakModZ.toFixed(1)}  ${e.minP.toExponential(1).padStart(9)}   ${e.dominantMode}`)
  })

  const m = r.mainshock
  L.push('')
  L.push(`MAINSHOCK  ${m.fromIso} → ${m.toIso}  (~${m.durMin} min)   ${money(m.costUsd)} released, ${m.turns} turns`)
  L.push(`  magnitude ${m.magnitude.toFixed(2)} (log₁₀ peak/baseline)   peak modified-z ${m.peakModZ.toFixed(1)}   STA/LTA ${m.peakStaLta.toFixed(1)}   min p ${m.minP.toExponential(2)}`)
  L.push(`  decomposition: cold-WRITE ${money(m.writeUsd)} (${pctOf(m.writeUsd, m.costUsd)})  READ ${money(m.readUsd)} (${pctOf(m.readUsd, m.costUsd)})  output ${money(m.outputUsd)} (${pctOf(m.outputUsd, m.costUsd)})`)
  L.push(`  dominant mode: ${m.dominantMode}`)

  L.push('')
  L.push('TOP SESSIONS BY $ (whole window):')
  L.push('     total$   turns   maxPrefix   W/R/O split          session · project')
  for (const s of r.sessions) {
    const split = `${pctOf(s.writeUsd, s.costUsd)}/${pctOf(s.readUsd, s.costUsd)}/${pctOf(s.outputUsd, s.costUsd)}`
    L.push(`  ${money(s.costUsd).padStart(9)}  ${String(s.turns).padStart(5)}  ${String(s.maxPrefixTokens).padStart(9)}   ${split.padEnd(16)}  ${s.session.slice(0, 8)} · ${s.project}`)
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
