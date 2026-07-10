// investigate_burn — ONE-command window-burn investigation (TRDD-TW14MO7A).
//
// Born from the 2026-07-10 incident: a 5h rate-limit window drained twice; root-causing it
// took ~15 manual CLI calls + ad-hoc scans, and the FIRST attribution was wrong. This module
// encodes that whole investigation: scan the OTEL bodies corpus for a time window, measure
// the billed usage exactly (from response bodies — Anthropic's own numbers, never estimates),
// attribute requests to workspace/model/agent-kind, detect the known burn patterns, rank them,
// and compose a plain-language verdict WITH the numbers. The caller gets the culprits in one
// call; deeper drilling stays on the other tools + SQL.
//
// Honesty invariants (same discipline as buildTokensByCause): coverage is always reported
// (files present vs scanned, caps hit); every finding carries its evidence numbers and a
// confidence; anything the detectors cannot claim stays in the explicit unattributed remainder.

import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { calcTokenCostUsd } from './shared/pricing'
import { readHookEvents } from './hookEventStore'

export const BURN_CAUSES = [
  'FORK_STORM',            // fan-out forked a fat parent into a cold cache — N × full-prefix writes
  'SUBAGENT_BOOT_TAX',     // many fresh agents each paying the claudeMd+tools boot cost
  'PREMIUM_MODEL_FANOUT',  // fan-out burst on a top-price model
  'FAT_SESSION_REWRITES',  // one session repeatedly rewriting a large prefix (compact/model-switch/TTL)
  'IDLE_FLEET_KEEPWARM',   // background sessions kept cache-warm by periodic fires
  'IMAGE_BLOB_RESIDENT',   // image bytes resident in context, re-sent every turn
  'RATE_LIMIT_COLD_RESUME',// fan-out resumed into a TTL-expired cache right after a limit stall
] as const
export type BurnCause = typeof BURN_CAUSES[number]

export interface BurnFinding {
  cause: BurnCause
  equivTokens: number          // input-equivalents attributed to this pattern (cc*1.25 + cr*0.1)
  shareOfWindow: number        // 0..1 of the window's total input-equivalents
  confidence: 'high' | 'medium' | 'low'
  verdict: string              // one sentence, with numbers
  evidence: Record<string, unknown>
}

export interface BurnInvestigation {
  window: { fromIso: string; untilIso: string; hours: number }
  coverage: {
    requestFilesScanned: number
    responseFilesScanned: number
    bytesOnDisk: number
    complete: boolean
    note: string
  }
  totals: {
    calls: number
    cacheCreationTokens: number
    cacheReadTokens: number
    outputTokens: number
    inputEquivTokens: number   // cc*1.25 + cr*0.1 — the window-drain currency
    estCostUsd: number
    byHour: { hour: string; calls: number; cacheCreation: number; cacheRead: number; equiv: number }[]
    byModel: { model: string; calls: number; cacheCreation: number; cacheRead: number; outputTokens: number; equiv: number; estCostUsd: number }[]
  }
  attribution: {
    workspace: string
    model: string
    kind: 'interactive' | 'subagent'
    requests: number
    bytesSent: number
    firstIso: string
    lastIso: string
  }[]
  findings: BurnFinding[]
  verdict: string
}

export interface InvestigateOptions {
  bodiesDir?: string
  hookEventsDir?: string
  windowHours?: number         // default 5 (a rate-limit window)
  untilMs?: number             // default now
  maxFiles?: number            // scan cap per kind (default 8000)
}

interface RespRec { ts: number; model: string; cc: number; cr: number; out: number; inp: number }
interface ReqRec {
  ts: number
  size: number
  model: string
  workspace: string            // '' when the Environment block is absent (subagent-shaped)
  fingerprint: string          // first-message identity — same value ⇒ same inherited transcript
  imageBytes: number           // approx base64 image payload found in the sampled chunks
}

const SPIKE_CC = 100_000       // a cache_creation this large is a full-prefix (re)write
const CLUSTER_MS = 10 * 60_000 // spikes within 10 min belong to one event (a fan-out wave)
const equivOf = (cc: number, cr: number): number => cc * 1.25 + cr * 0.1

// ── corpus scan ───────────────────────────────────────────────────────────────

function listWindow(dir: string, suffix: string, sinceMs: number, untilMs: number, cap: number):
  { files: { p: string; mtime: number; size: number }[]; present: number } {
  let names: string[]
  try { names = fs.readdirSync(dir) } catch { return { files: [], present: 0 } }
  const files: { p: string; mtime: number; size: number }[] = []
  let present = 0
  for (const f of names) {
    if (!f.endsWith(suffix)) continue
    let st: fs.Stats
    try { st = fs.statSync(path.join(dir, f)) } catch { continue }
    if (st.mtimeMs < sinceMs || st.mtimeMs > untilMs) continue
    present++
    files.push({ p: path.join(dir, f), mtime: st.mtimeMs, size: st.size })
  }
  // Over cap: keep the LARGEST files (they carry the burn); count the drop in coverage.
  files.sort((a, b) => b.size - a.size)
  return { files: files.slice(0, cap), present }
}

function scanResponses(files: { p: string; mtime: number }[]): RespRec[] {
  const out: RespRec[] = []
  for (const f of files) {
    try {
      const d = JSON.parse(fs.readFileSync(f.p, 'utf-8')) as Record<string, unknown>
      let body = (d.body ?? d) as Record<string, unknown>
      if (typeof body === 'string') body = JSON.parse(body) as Record<string, unknown>
      const u = (body.usage ?? {}) as Record<string, number>
      out.push({
        ts: f.mtime,
        model: String(body.model ?? '?'),
        cc: u.cache_creation_input_tokens || 0,
        cr: u.cache_read_input_tokens || 0,
        out: u.output_tokens || 0,
        inp: u.input_tokens || 0,
      })
    } catch { /* not a usage-bearing response — skip, counted in coverage */ }
  }
  return out.sort((a, b) => a.ts - b.ts)
}

const WS_RE = /Primary working directory: ([^\\\n"]+)/
const MODEL_RE = /"model"\s*:\s*"([^"]+)"/
// A base64 image payload inside content blocks; we only need "is a big blob present and how big".
const IMG_RE = /"data"\s*:\s*"([A-Za-z0-9+/=]{20000,})/g

/**
 * Bounded per-request read: head chunk for model + fingerprint, then chunked forward search
 * for the Environment block (it sits AFTER the messages in fat transcripts — the exact reason
 * the incident's first shallow scan misattributed everything).
 */
function scanRequest(f: { p: string; mtime: number; size: number }, maxScanBytes: number): ReqRec | null {
  let fd: number
  try { fd = fs.openSync(f.p, 'r') } catch { return null }
  try {
    const CHUNK = 512 * 1024
    const buf = Buffer.alloc(Math.min(CHUNK, maxScanBytes))
    let offset = 0
    let model = '?'
    let workspace = ''
    let fingerprint = ''
    let imageBytes = 0
    let carry = ''
    while (offset < f.size && offset < maxScanBytes) {
      const n = fs.readSync(fd, buf, 0, buf.length, offset)
      if (n <= 0) break
      // Keep a 256-byte carry across chunk borders so the regexes can't be split-blinded.
      const text = carry + buf.toString('utf-8', 0, n)
      if (model === '?') {
        const m = MODEL_RE.exec(text)
        if (m) model = m[1]
      }
      if (!fingerprint) {
        // Identity of the FIRST message: same inherited transcript ⇒ same fingerprint.
        const i = text.indexOf('"messages"')
        if (i >= 0 && text.length - i > 2600) fingerprint = djb2(text.slice(i, i + 2600))
      }
      if (!workspace) {
        const m = WS_RE.exec(text)
        if (m) workspace = m[1].trim()
      }
      for (const m of text.matchAll(IMG_RE)) imageBytes += m[1].length
      if (workspace && fingerprint && model !== '?' && offset > 2 * CHUNK && imageBytes === 0) break
      carry = text.slice(-256)
      offset += n
    }
    return { ts: f.mtime, size: f.size, model, workspace, fingerprint, imageBytes }
  } finally {
    fs.closeSync(fd)
  }
}

function djb2(s: string): string {
  let h = 5381
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0
  return h.toString(36)
}

// ── detectors ─────────────────────────────────────────────────────────────────

interface Cluster { spikes: RespRec[]; fromTs: number; toTs: number; cc: number; coldSpikes: number }

function clusterSpikes(resps: RespRec[]): Cluster[] {
  const spikes = resps.filter(r => r.cc > SPIKE_CC)
  const clusters: Cluster[] = []
  for (const s of spikes) {
    const last = clusters[clusters.length - 1]
    if (last && s.ts - last.toTs <= CLUSTER_MS) {
      last.spikes.push(s)
      last.toTs = s.ts
      last.cc += s.cc
      if (s.cr < s.cc * 0.1) last.coldSpikes++
    } else {
      clusters.push({ spikes: [s], fromTs: s.ts, toTs: s.ts, cc: s.cc, coldSpikes: s.cr < s.cc * 0.1 ? 1 : 0 })
    }
  }
  return clusters
}

function reqsIn(reqs: ReqRec[], fromTs: number, toTs: number, padMs = 60_000): ReqRec[] {
  return reqs.filter(r => r.ts >= fromTs - padMs && r.ts <= toTs + padMs)
}

const iso = (ms: number): string => new Date(ms).toISOString()

function detectStormsAndRewrites(
  resps: RespRec[], reqs: ReqRec[], totalEquiv: number,
  stopFailureTimes: number[],
): BurnFinding[] {
  const findings: BurnFinding[] = []
  for (const c of clusterSpikes(resps)) {
    const equiv = equivOf(c.cc, 0)
    if (equiv < totalEquiv * 0.02 && c.cc < 1_000_000) continue // below reporting floor
    const nearby = reqsIn(reqs, c.fromTs, c.toTs).filter(r => r.size > SPIKE_CC * 2) // ≥~2 bytes/token of a spike
    const fams = new Map<string, number>()
    for (const r of nearby) fams.set(r.fingerprint, (fams.get(r.fingerprint) ?? 0) + 1)
    const biggestFam = Math.max(0, ...fams.values())
    const wss = new Set(nearby.map(r => r.workspace).filter(Boolean))
    const postStall = stopFailureTimes.some(t => c.fromTs - t >= 0 && c.fromTs - t <= 15 * 60_000)
    const base = {
      equivTokens: Math.round(equiv),
      shareOfWindow: totalEquiv > 0 ? equiv / totalEquiv : 0,
      evidence: {
        window: `${iso(c.fromTs)} → ${iso(c.toTs)}`,
        fullPrefixWrites: c.spikes.length,
        coldWrites: c.coldSpikes,
        cacheCreationTokens: c.cc,
        largestWriteTokens: Math.max(...c.spikes.map(s => s.cc)),
        sharedTranscriptRequests: biggestFam,
        distinctFingerprints: fams.size,
        workspaces: [...wss].slice(0, 5),
        postRateLimitStall: postStall,
      },
    }
    if (c.spikes.length >= 3 && biggestFam >= 3 && c.coldSpikes >= 2) {
      // Many simultaneous full writes of the SAME inherited transcript = a fork storm.
      findings.push({
        ...base, cause: 'FORK_STORM', confidence: 'high',
        verdict: `${c.spikes.length} full-prefix cache writes (${c.coldSpikes} fully cold, largest ${fmtK(Math.max(...c.spikes.map(s => s.cc)))}) in ${mins(c.toTs - c.fromTs)} — ${biggestFam} requests share ONE inherited transcript: a fan-out forked a fat parent into a cold cache${postStall ? ', right after a rate-limit stall (TTL-expired cache)' : ''}.`,
      })
      if (postStall) {
        findings.push({
          cause: 'RATE_LIMIT_COLD_RESUME', equivTokens: Math.round(equiv), shareOfWindow: base.shareOfWindow,
          confidence: 'high',
          verdict: `The fork storm at ${iso(c.fromTs)} began ≤15min after a StopFailure (rate-limit turn death): the stall outlived the 5-min cache TTL, so every fork rebuilt the parent prefix from scratch. Do not resume fan-outs into a cold window.`,
          evidence: { clusterStart: iso(c.fromTs), stopFailures: stopFailureTimes.map(iso).slice(-5) },
        })
      }
    } else if (c.spikes.length >= 3 && fams.size >= 3 && biggestFam <= 2) {
      findings.push({
        ...base, cause: 'SUBAGENT_BOOT_TAX', confidence: 'medium',
        verdict: `${c.spikes.length} distinct agents each paid a ${fmtK(Math.round(c.cc / c.spikes.length))} boot write in ${mins(c.toTs - c.fromTs)} (${fams.size} distinct transcripts) — a fresh-agent fan-out; every agent re-pays the CLAUDE.md/rules + tool-schema base.`,
      })
    } else {
      findings.push({
        ...base, cause: 'FAT_SESSION_REWRITES', confidence: c.spikes.length >= 2 ? 'medium' : 'low',
        verdict: `${c.spikes.length} full-prefix rewrite(s) totalling ${fmtK(c.cc)} cache-write tokens around ${iso(c.fromTs)}${wss.size ? ` in ${[...wss][0]}` : ''} — a large session re-writing its whole prefix (compaction, model switch, or a >5-min idle gap).`,
      })
    }
  }
  return findings
}

function detectPremiumFanout(resps: RespRec[], reqs: ReqRec[], totalEquiv: number): BurnFinding[] {
  // A burst of subagent-shaped calls on a model that prices above the rest of the window's traffic.
  const byModel = new Map<string, RespRec[]>()
  for (const r of resps) byModel.set(r.model, [...(byModel.get(r.model) ?? []), r])
  const findings: BurnFinding[] = []
  for (const [model, calls] of byModel) {
    if (calls.length < 50) continue
    const cc = calls.reduce((a, r) => a + r.cc, 0)
    const cr = calls.reduce((a, r) => a + r.cr, 0)
    const outT = calls.reduce((a, r) => a + r.out, 0)
    const equiv = equivOf(cc, cr)
    if (equiv < totalEquiv * 0.15) continue
    // Burst density: ≥50 calls inside some 30-min span.
    let burst = 0
    for (let i = 0, j = 0; i < calls.length; i++) {
      while (calls[i].ts - calls[j].ts > 30 * 60_000) j++
      burst = Math.max(burst, i - j + 1)
    }
    if (burst < 50) continue
    const subagentReqs = reqsIn(reqs, calls[0].ts, calls[calls.length - 1].ts)
      .filter(r => r.model === model)
    const noWs = subagentReqs.filter(r => !r.workspace).length
    if (subagentReqs.length === 0 || noWs / subagentReqs.length < 0.5) continue
    const usd = calcTokenCostUsd(0, cr, cc, outT, model)
    findings.push({
      cause: 'PREMIUM_MODEL_FANOUT',
      equivTokens: Math.round(equiv),
      shareOfWindow: totalEquiv > 0 ? equiv / totalEquiv : 0,
      confidence: 'high',
      verdict: `${calls.length} calls on ${model} (peak ${burst} in 30min), ${Math.round(100 * noWs / subagentReqs.length)}% subagent-shaped — a fan-out ran on this model (est $${usd.toFixed(2)}). If ${model} became the DEFAULT recently, fresh fan-out agents inherited it; pin cheaper models for fan-out work.`,
      evidence: { model, calls: calls.length, peak30min: burst, cacheCreationTokens: cc, cacheReadTokens: cr, outputTokens: outT, estCostUsd: Number(usd.toFixed(2)) },
    })
  }
  return findings
}

function detectIdleKeepwarm(reqs: ReqRec[], resps: RespRec[], totalEquiv: number): BurnFinding[] {
  // Workspaces with long-span, low-write, periodic traffic = sessions kept warm while nobody works.
  const byWs = new Map<string, ReqRec[]>()
  for (const r of reqs) if (r.workspace) byWs.set(r.workspace, [...(byWs.get(r.workspace) ?? []), r])
  const idle: { ws: string; n: number; span: number; medianGapS: number }[] = []
  for (const [ws, rs] of byWs) {
    if (rs.length < 12) continue
    rs.sort((a, b) => a.ts - b.ts)
    const span = rs[rs.length - 1].ts - rs[0].ts
    if (span < 2 * 3600_000) continue
    const gaps = rs.slice(1).map((r, i) => r.ts - rs[i].ts).sort((a, b) => a - b)
    const median = gaps[Math.floor(gaps.length / 2)] / 1000
    if (median < 60 || median > 900) continue // periodic keep-warm cadence, not active work
    idle.push({ ws, n: rs.length, span, medianGapS: Math.round(median) })
  }
  if (idle.length === 0) return []
  // The keep-warm bill is cache_read-dominated; attribute the window's low-write read share.
  const lowWriteCr = resps.filter(r => r.cc < 5_000).reduce((a, r) => a + r.cr, 0)
  const equiv = lowWriteCr * 0.1 * (Math.min(1, idle.length / Math.max(1, byWs.size)))
  return [{
    cause: 'IDLE_FLEET_KEEPWARM',
    equivTokens: Math.round(equiv),
    shareOfWindow: totalEquiv > 0 ? equiv / totalEquiv : 0,
    confidence: idle.length >= 3 ? 'high' : 'medium',
    verdict: `${idle.length} background session(s) show periodic keep-warm traffic over 2h+ (median gap ${idle[0].medianGapS}s): ${idle.map(i => shortWs(i.ws)).slice(0, 4).join(', ')}. Each fire re-reads that session's full prefix. Disarm/close sessions you are not using.`,
    evidence: { workspaces: idle.map(i => ({ workspace: i.ws, requests: i.n, spanHours: Number((i.span / 3600_000).toFixed(1)), medianGapS: i.medianGapS })), lowWriteCacheReadTokens: lowWriteCr },
  }]
}

function detectImageResidency(reqs: ReqRec[], totalEquiv: number): BurnFinding[] {
  const withImg = reqs.filter(r => r.imageBytes > 200_000)
  if (withImg.length < 3) return []
  const byFam = new Map<string, ReqRec[]>()
  for (const r of withImg) byFam.set(r.fingerprint, [...(byFam.get(r.fingerprint) ?? []), r])
  const findings: BurnFinding[] = []
  for (const [, rs] of byFam) {
    if (rs.length < 3) continue
    const totalImg = rs.reduce((a, r) => a + r.imageBytes, 0)
    const tok = Math.round(totalImg / 4)
    findings.push({
      cause: 'IMAGE_BLOB_RESIDENT',
      equivTokens: Math.round(tok * 0.1), // resident blobs mostly ride as cache reads once written
      shareOfWindow: totalEquiv > 0 ? (tok * 0.1) / totalEquiv : 0,
      confidence: 'medium',
      verdict: `${rs.length} requests of one conversation carry ~${fmtK(Math.round(rs[0].imageBytes / 4))} tokens of base64 image data EACH (${fmtK(tok)} cumulative) — images pasted once ride forward every turn. Analyze images in a subagent or compact them away.`,
      evidence: { requests: rs.length, perRequestImageBytes: rs[0].imageBytes, cumulativeImageTokens: tok },
    })
  }
  return findings
}

// ── helpers ───────────────────────────────────────────────────────────────────

const fmtK = (n: number): string => n >= 1_000_000 ? `${(n / 1e6).toFixed(1)}M` : `${Math.round(n / 1000)}k`
const mins = (ms: number): string => `${Math.max(1, Math.round(ms / 60_000))}min`
const shortWs = (ws: string): string => ws.replace(os.homedir(), '~')

// ── entry point ───────────────────────────────────────────────────────────────

export function investigateBurn(opts: InvestigateOptions = {}): BurnInvestigation {
  const bodiesDir = opts.bodiesDir ?? path.join(os.homedir(), '.agentlens', 'otel-bodies')
  const hookDir = opts.hookEventsDir ?? path.join(os.homedir(), '.agentlens', 'hook-events')
  const hours = Math.min(48, Math.max(0.25, opts.windowHours ?? 5))
  const untilMs = opts.untilMs ?? Date.now()
  const sinceMs = untilMs - hours * 3600_000
  const cap = Math.min(20_000, Math.max(100, opts.maxFiles ?? 8000))

  const reqList = listWindow(bodiesDir, '.request.json', sinceMs, untilMs, cap)
  const respList = listWindow(bodiesDir, '.response.json', sinceMs, untilMs, cap)
  const resps = scanResponses(respList.files)
  const reqs: ReqRec[] = []
  for (const f of reqList.files) {
    const r = scanRequest(f, 6 * 1024 * 1024)
    if (r) reqs.push(r)
  }
  reqs.sort((a, b) => a.ts - b.ts)

  // Totals — exact billed usage from the responses.
  let cc = 0; let cr = 0; let outT = 0
  const byHour = new Map<string, { calls: number; cc: number; cr: number }>()
  const byModel = new Map<string, { calls: number; cc: number; cr: number; out: number }>()
  for (const r of resps) {
    cc += r.cc; cr += r.cr; outT += r.out
    const h = new Date(r.ts).toISOString().slice(0, 13)
    const hb = byHour.get(h) ?? { calls: 0, cc: 0, cr: 0 }
    hb.calls++; hb.cc += r.cc; hb.cr += r.cr
    byHour.set(h, hb)
    const mb = byModel.get(r.model) ?? { calls: 0, cc: 0, cr: 0, out: 0 }
    mb.calls++; mb.cc += r.cc; mb.cr += r.cr; mb.out += r.out
    byModel.set(r.model, mb)
  }
  const totalEquiv = equivOf(cc, cr)
  const estCostUsd = [...byModel.entries()]
    .reduce((a, [m, v]) => a + calcTokenCostUsd(0, v.cr, v.cc, v.out, m), 0)

  // Hook-event correlation (optional store — absent when --install-hooks was never run).
  const stopFailures = readHookEvents(hookDir, { ev: 'StopFailure', sinceMs, untilMs, limit: 100 })
    .map(e => e.ts)

  const findings = [
    ...detectStormsAndRewrites(resps, reqs, totalEquiv, stopFailures),
    ...detectPremiumFanout(resps, reqs, totalEquiv),
    ...detectIdleKeepwarm(reqs, resps, totalEquiv),
    ...detectImageResidency(reqs, totalEquiv),
  ].sort((a, b) => b.equivTokens - a.equivTokens)

  // Attribution table (workspace × model), interactive vs subagent-shaped.
  const attr = new Map<string, { requests: number; bytes: number; first: number; last: number }>()
  for (const r of reqs) {
    const kind = r.workspace ? 'interactive' : 'subagent'
    // '\n'-joined key: workspace paths may contain spaces but never newlines.
    const key = `${r.workspace || '(subagent/no-env-block)'}\n${r.model}\n${kind}`
    const a = attr.get(key) ?? { requests: 0, bytes: 0, first: Infinity, last: 0 }
    a.requests++; a.bytes += r.size
    a.first = Math.min(a.first, r.ts); a.last = Math.max(a.last, r.ts)
    attr.set(key, a)
  }

  const attributedShare = findings.reduce((a, f) => a + f.shareOfWindow, 0)
  const top = findings.slice(0, 3)
  const verdict = resps.length === 0
    ? 'No API traffic found in the window — nothing burned here (check the window bounds or the bodies dir).'
    : top.length === 0
      ? `No known burn pattern detected: ${fmtK(Math.round(totalEquiv))} input-equivalent tokens across ${resps.length} calls look like ordinary traffic (largest single write ${fmtK(Math.max(0, ...resps.map(r => r.cc)))}).`
      : `Top culprit${top.length > 1 ? 's' : ''}: ` +
        top.map((f, i) => `${i + 1}. ${f.cause} (${fmtK(f.equivTokens)} equiv, ${(f.shareOfWindow * 100).toFixed(0)}%) — ${f.verdict}`).join(' ') +
        ` Window total: ${fmtK(Math.round(totalEquiv))} input-equivalents (${fmtK(cc)} cache-write + ${fmtK(cr)} cache-read), est $${estCostUsd.toFixed(2)}.` +
        (attributedShare < 0.5 ? ` NOTE: detectors attribute only ${(attributedShare * 100).toFixed(0)}% of the window — the remainder is unclassified ordinary traffic; drill with the other tools/SQL.` : '')

  return {
    window: { fromIso: iso(sinceMs), untilIso: iso(untilMs), hours },
    coverage: {
      requestFilesScanned: reqList.files.length,
      responseFilesScanned: respList.files.length,
      bytesOnDisk: reqList.files.reduce((a, f) => a + f.size, 0),
      complete: reqList.files.length === reqList.present && respList.files.length === respList.present,
      note: reqList.files.length === reqList.present
        ? 'full coverage of the window'
        : `CAP HIT: scanned the ${reqList.files.length} largest of ${reqList.present} request files (responses ${respList.files.length}/${respList.present}) — totals reflect the scanned set only`,
    },
    totals: {
      calls: resps.length,
      cacheCreationTokens: cc,
      cacheReadTokens: cr,
      outputTokens: outT,
      inputEquivTokens: Math.round(totalEquiv),
      estCostUsd: Number(estCostUsd.toFixed(2)),
      byHour: [...byHour.entries()].sort().map(([hour, v]) => ({
        hour, calls: v.calls, cacheCreation: v.cc, cacheRead: v.cr, equiv: Math.round(equivOf(v.cc, v.cr)),
      })),
      byModel: [...byModel.entries()]
        .map(([model, v]) => ({
          model, calls: v.calls, cacheCreation: v.cc, cacheRead: v.cr, outputTokens: v.out,
          equiv: Math.round(equivOf(v.cc, v.cr)),
          estCostUsd: Number(calcTokenCostUsd(0, v.cr, v.cc, v.out, model).toFixed(2)),
        }))
        .sort((a, b) => b.equiv - a.equiv),
    },
    attribution: [...attr.entries()]
      .map(([key, a]) => {
        const [workspace, model, kind] = key.split('\n')
        return {
          workspace: shortWs(workspace), model, kind: kind as 'interactive' | 'subagent',
          requests: a.requests, bytesSent: a.bytes, firstIso: iso(a.first), lastIso: iso(a.last),
        }
      })
      .sort((a, b) => b.bytesSent - a.bytesSent)
      .slice(0, 20),
    findings,
    verdict,
  }
}
