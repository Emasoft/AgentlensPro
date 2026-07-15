// get_body_writers (TRDD-1FEIW17E) — identify and rank the sessions writing raw OTEL bodies.
// A Claude session keeps its launch-time OTEL_LOG_RAW_API_BODIES env until restarted, so stale
// sessions keep writing ~0.7–1.9MB request bodies per LLM call. This module answers: WHICH
// sessions, at what rate, and how much total — so the user restarts exactly the right terminals.
//
// Attribution unit = the REQUEST body: its tail carries metadata.user_id (escaped JSON with
// session_id) reachable by the same bounded 6KB read bodiesActivity already uses. Response bodies
// carry NO session metadata (the realtime previous_message_id chain lags one call and never covers
// a session's last response), and requests dominate bytes by ~an order of magnitude (each one
// re-serializes the whole conversation) — so responses are reported IN AGGREGATE, never guessed.
//
// Two sources, merged WITHOUT double counting:
//   live dir  — the now picture: recent rate + active flag (files not yet reclaimed, ≤72h)
//   store     — all-time ingested history (capture-ts correct post schema-v2)
// A live file whose src_name already has a store row is not re-counted: total = store + live-only.

import * as fs from 'fs'
import * as path from 'path'
import { extractRequestAttribution } from './bodiesActivity'
import { allOf, Store } from './store/db'

export interface LiveSessionAgg {
  sessionId: string | null
  /** name+bytes kept per file so the merge can subtract already-ingested files exactly. */
  files: { name: string; bytes: number }[]
  bytes: number
  recentFiles: number
  recentBytes: number
  firstMs: number
  lastMs: number
  /** model of the most recent attributed request — what the session is running NOW. */
  model: string | null
}

export interface LiveBodiesScan {
  available: boolean
  dir: string
  scannedFiles: number
  sessions: LiveSessionAgg[]
  responses: { files: { name: string; bytes: number }[]; bytes: number; recentBytes: number; lastMs: number }
}

/** One full pass over the live bodies dir. One-shot diagnostic (not a hot-path poll): stat every
 *  file, bounded-read every request. ~10k files ≈ well under a second on APFS. */
export function scanLiveBodyWriters(dir: string, nowMs: number, windowMs: number): LiveBodiesScan {
  const empty: LiveBodiesScan = {
    available: false, dir, scannedFiles: 0, sessions: [],
    responses: { files: [], bytes: 0, recentBytes: 0, lastMs: 0 },
  }
  let names: string[]
  try {
    names = fs.readdirSync(dir)
  } catch {
    return empty // dir absent (fresh install / capture off) — report available:false, never throw
  }
  const bySession = new Map<string | null, LiveSessionAgg>()
  const responses: LiveBodiesScan['responses'] = { files: [], bytes: 0, recentBytes: 0, lastMs: 0 }
  const recentFloor = nowMs - windowMs
  let scanned = 0
  const latestModelT = new Map<string | null, number>()
  for (const name of names) {
    const isReq = name.endsWith('.request.json')
    const isResp = name.endsWith('.response.json')
    if (!isReq && !isResp) continue
    let st: fs.Stats
    try {
      st = fs.statSync(path.join(dir, name))
    } catch {
      continue // raced with the reclaim pass
    }
    scanned++
    if (isResp) {
      responses.files.push({ name, bytes: st.size })
      responses.bytes += st.size
      if (st.mtimeMs >= recentFloor) responses.recentBytes += st.size
      if (st.mtimeMs > responses.lastMs) responses.lastMs = st.mtimeMs
      continue
    }
    const attr = extractRequestAttribution(path.join(dir, name), st.size)
    let agg = bySession.get(attr.sessionId)
    if (!agg) {
      agg = { sessionId: attr.sessionId, files: [], bytes: 0, recentFiles: 0, recentBytes: 0, firstMs: st.mtimeMs, lastMs: 0, model: null }
      bySession.set(attr.sessionId, agg)
    }
    agg.files.push({ name, bytes: st.size })
    agg.bytes += st.size
    if (st.mtimeMs < agg.firstMs) agg.firstMs = st.mtimeMs
    if (st.mtimeMs > agg.lastMs) agg.lastMs = st.mtimeMs
    if (st.mtimeMs >= recentFloor) {
      agg.recentFiles++
      agg.recentBytes += st.size
    }
    if (attr.model && st.mtimeMs >= (latestModelT.get(attr.sessionId) ?? 0)) {
      agg.model = attr.model
      latestModelT.set(attr.sessionId, st.mtimeMs)
    }
  }
  return { available: true, dir, scannedFiles: scanned, sessions: [...bySession.values()], responses }
}

export interface StoreWriterTotals {
  sessions: { sessionId: string | null; files: number; bytes: number; firstMs: number; lastMs: number; model: string | null }[]
  responses: { files: number; bytes: number }
  /** src_names ingested recently — the exact overlap set with the live dir (retention ≤72h, so a
   *  recentFloor a day wider covers every file that can still be on disk). */
  recentSrcNames: Set<string>
}

/** All-time per-session totals from the durable store (requests only — see the module header). */
export async function queryStoreWriterTotals(store: Store, recentFloorMs: number): Promise<StoreWriterTotals> {
  const body = allOf(store, 'body')
  const sess = (await store.con.runAndReadAll(
    `SELECT session_id,
            COUNT(*) AS files,
            CAST(COALESCE(SUM(raw_bytes), 0) AS BIGINT) AS bytes,
            CAST(epoch_ms(MIN(ts)) AS BIGINT) AS first_ms,
            CAST(epoch_ms(MAX(ts)) AS BIGINT) AS last_ms,
            arg_max(model, ts) AS model
     FROM ${body} WHERE kind = 'request' GROUP BY session_id`,
  )).getRowObjects()
  const resp = (await store.con.runAndReadAll(
    `SELECT COUNT(*) AS files, CAST(COALESCE(SUM(raw_bytes), 0) AS BIGINT) AS bytes
     FROM ${body} WHERE kind = 'response'`,
  )).getRowObjects()
  const recent = (await store.con.runAndReadAll(
    `SELECT src_name FROM ${body} WHERE CAST(epoch_ms(ts) AS BIGINT) >= ${Math.round(recentFloorMs)}`,
  )).getRowObjects()
  return {
    sessions: sess.map(r => ({
      sessionId: r.session_id === null ? null : String(r.session_id),
      files: Number(r.files),
      bytes: Number(r.bytes),
      firstMs: Number(r.first_ms),
      lastMs: Number(r.last_ms),
      model: r.model === null ? null : String(r.model),
    })),
    responses: { files: Number(resp[0]?.files ?? 0), bytes: Number(resp[0]?.bytes ?? 0) },
    recentSrcNames: new Set(recent.map(r => String(r.src_name))),
  }
}

export interface BodyWriterRow {
  sessionId: string | null
  workspace: string | null
  source: string | null
  model: string | null
  /** Wrote a request within activeMin — this session's process is STILL capturing bodies. */
  active: boolean
  lastWriteMs: number | null
  recentFiles: number
  recentBytes: number
  /** recentBytes over the window — the ranking's primary key. */
  rateMBmin: number
  liveFiles: number
  liveBytes: number
  storeFiles: number
  storeBytes: number
  /** storeBytes + live files NOT yet ingested — exact union, no double counting. */
  totalBytes: number
}

export interface BodyWritersReport {
  available: boolean
  dir: string
  scannedFiles: number
  windowMin: number
  activeMin: number
  /** Ranked: rateMBmin desc, then totalBytes desc. Capped at `limit`; totalWriters is the full count. */
  writers: BodyWriterRow[]
  totalWriters: number
  responses: { liveFiles: number; liveBytes: number; storeFiles: number; storeBytes: number; totalBytes: number }
  note: string
  /** Preformatted ranked table — what the CLI digest prints. */
  text: string
}

const MB = 1e6
function fmtBytes(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}GB`
  if (n >= MB) return `${(n / MB).toFixed(1)}MB`
  return `${(n / 1e3).toFixed(0)}KB`
}

export function buildBodyWritersReport(opts: {
  live: LiveBodiesScan
  store: StoreWriterTotals | null
  cards: { sessionId: string; workspace: string; source: string }[]
  nowMs: number
  windowMs: number
  activeMs: number
  limit: number
}): BodyWritersReport {
  const { live, store, cards, nowMs, windowMs, activeMs, limit } = opts
  const windowMin = Math.round(windowMs / 60_000)
  const activeMin = Math.round(activeMs / 60_000)
  const cardBy = new Map(cards.map(c => [c.sessionId, c]))
  const rows = new Map<string | null, BodyWriterRow>()
  const blank = (sessionId: string | null): BodyWriterRow => ({
    sessionId,
    workspace: sessionId ? cardBy.get(sessionId)?.workspace ?? null : null,
    source: sessionId ? cardBy.get(sessionId)?.source ?? null : null,
    model: null, active: false, lastWriteMs: null,
    recentFiles: 0, recentBytes: 0, rateMBmin: 0,
    liveFiles: 0, liveBytes: 0, storeFiles: 0, storeBytes: 0, totalBytes: 0,
  })

  for (const s of store?.sessions ?? []) {
    const r = blank(s.sessionId)
    r.storeFiles = s.files
    r.storeBytes = s.bytes
    r.totalBytes = s.bytes
    r.lastWriteMs = s.lastMs
    r.model = s.model
    rows.set(s.sessionId, r)
  }
  for (const agg of live.sessions) {
    let r = rows.get(agg.sessionId)
    if (!r) {
      r = blank(agg.sessionId)
      rows.set(agg.sessionId, r)
    }
    r.liveFiles = agg.files.length
    r.liveBytes = agg.bytes
    r.recentFiles = agg.recentFiles
    r.recentBytes = agg.recentBytes
    r.rateMBmin = agg.recentBytes / MB / (windowMs / 60_000)
    r.active = agg.lastMs >= nowMs - activeMs
    if (r.lastWriteMs === null || agg.lastMs > r.lastWriteMs) r.lastWriteMs = agg.lastMs
    if (agg.model) r.model = agg.model // live beats store: it is what the session runs NOW
    // Exact union: only live files the store has NOT ingested add to the total. Without a store
    // (down/absent) the live bytes ARE the only known total.
    const notIngested = store ? agg.files.filter(f => !store.recentSrcNames.has(f.name)) : agg.files
    r.totalBytes += notIngested.reduce((a, f) => a + f.bytes, 0)
  }

  const ranked = [...rows.values()].sort((a, b) => (b.rateMBmin - a.rateMBmin) || (b.totalBytes - a.totalBytes))
  const writers = ranked.slice(0, Math.max(1, limit))

  const respLiveNotIngested = store
    ? live.responses.files.filter(f => !store.recentSrcNames.has(f.name)).reduce((a, f) => a + f.bytes, 0)
    : live.responses.bytes
  const responses = {
    liveFiles: live.responses.files.length,
    liveBytes: live.responses.bytes,
    storeFiles: store?.responses.files ?? 0,
    storeBytes: store?.responses.bytes ?? 0,
    totalBytes: (store?.responses.bytes ?? 0) + respLiveNotIngested,
  }

  const note = (store
    ? 'totals = ingested store history + not-yet-ingested live files (exact union). '
    : 'STORE UNAVAILABLE — totals cover only the live dir (≤72h retained). ')
    + 'Attribution unit = request bodies (responses carry no session metadata and are aggregated below). '
    + `active = wrote a request within ${activeMin}m — that session's process still captures raw bodies until restarted.`

  const lines: string[] = []
  lines.push(`raw-body writers — rate over last ${windowMin}m, ranked by rate then total (${rows.size} writer(s), showing ${writers.length})`)
  const home = process.env.HOME ?? ''
  for (const w of writers) {
    const act = w.active ? '●ACTIVE' : '       '
    const sid = w.sessionId ? `${w.sessionId.slice(0, 8)}…` : 'unattributed'
    const ws = w.workspace ? (home && w.workspace.startsWith(home) ? `~${w.workspace.slice(home.length)}` : w.workspace) : '?'
    const last = w.lastWriteMs ? `${Math.round((nowMs - w.lastWriteMs) / 60_000)}m ago` : 'never'
    lines.push(
      `${act} ${sid}  ${w.rateMBmin.toFixed(2)}MB/min  recent ${fmtBytes(w.recentBytes)}/${w.recentFiles}  total ${fmtBytes(w.totalBytes)}/${w.storeFiles + w.liveFiles}  last ${last}  ${w.model ?? '?'}  ${ws}`,
    )
  }
  lines.push(`responses (unattributable by design): live ${fmtBytes(responses.liveBytes)}/${responses.liveFiles}, total ${fmtBytes(responses.totalBytes)}`)
  lines.push(note)

  return {
    available: live.available || store !== null,
    dir: live.dir,
    scannedFiles: live.scannedFiles,
    windowMin, activeMin,
    writers,
    totalWriters: rows.size,
    responses,
    note,
    text: lines.join('\n'),
  }
}
