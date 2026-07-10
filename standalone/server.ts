/**
 * AgentLens standalone server — runs the dashboard outside VS Code.
 *
 * Three HTTP servers:
 *   OTLP_PORT (default 4318) — receives OTLP traces/logs from agents
 *   UI_PORT   (default 3000) — serves the dashboard and SSE
 *   MCP_PORT  (default 4316) — MCP endpoint for Claude Code and other agents
 */

import * as http from 'http'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { exec } from 'child_process'
import { summarizeSpans } from '../src/spanSummarizer'
import { calcTokenCostUsd } from '../src/pricing'
import { autoConfigureCodex, autoConfigureCopilotStandalone } from '../src/autoConfigNode'
import { ensureTelemetryConfig, ensureAgentLensStopHook } from '../src/telemetryConfig'
import { classifyOtlpPayload } from '../src/otlpParser'
import { resolveLogEventName, bareLogEventName, CLAUDE_RICH_LOG_EVENTS, BODY_POINTER_LOG_EVENTS } from '../src/otlpLogEvents'
import { startMcpHttpServer, labelBurnStatusAccounts } from '../src/mcpServer'
import { resolveCallContext, callBodyRegistry } from '../src/rawBodyContext'
import { appendHookEvent, readHookEvents, purgeHookEventBuckets, hookEventsDiskUsage, type HookEventRecord } from '../src/hookEventStore'
import { BodiesActivityTracker } from '../src/bodiesActivity'
import { evaluateAgentGate, buildAdvisory, readTranscriptContext, type AgentGateState, type GateThresholds, type LaunchSpawner } from '../src/agentGate'
import { checkBurnRisk } from '../src/burnGuard'
import { loadHookRuntimeConfig, saveHookRuntimeConfig } from '../src/hookRuntimeConfig'
import { ContextCompositionIndex } from '../src/contextCompositionIndex'
import { LogReader, type OpenCodeSqlFactory } from '../src/logReader'
import { readScratchFile } from '../src/generatedFiles'
import { StatuslineUsageReader } from '../src/statuslineUsage'
import {
  loadBurnConfig, gatherConsumptionEvents, computeBurnStatus, computeSessionStatus,
  type BurnAlert, type BurnStatus,
} from '../src/burnMonitor'
import { getCurrentAccount } from '../src/accountInfo'
import { buildContextComposition, resolveLoggedAncestor } from '../src/contextComposition'
import { buildContextHistory } from '../src/contextHistory'
import { generateSuggestions } from '../src/instructionAdvisor'
import { detectInstructionFiles, appendSuggestion } from '../src/instructionFiles'
import { atomicWriteFileSync, heapPressure, RequestLog } from '../src/serverRuntime'
import { appendToArchive, purgeArchiveVolumes, archiveDiskUsage, extractArchive } from '../src/bodyArchive'
import {
  loadLogOffsets, saveLogOffsets, loadPersistedCards, savePersistedCards,
  recordCollectorStart, recordCollectorHeartbeat, recordCollectorStop, computeCollectorGaps,
  type LifecycleStore,
} from '../src/collectorState'
import type { Span } from '../src/types'
import type { SessionSummaryCard, CollectorGap } from '../src/summarizers/summarizerTypes'

const OTLP_PORT  = parseInt(process.env.OTLP_PORT  ?? '4318')
const UI_PORT    = parseInt(process.env.UI_PORT    ?? '3000')
const MCP_PORT   = parseInt(process.env.MCP_PORT   ?? '4316')
const BIND_HOST  = process.env.BIND_HOST ?? '127.0.0.1'

const mediaDir  = path.join(__dirname, '..', 'media')
const DATA_DIR  = process.env.DATA_DIR ?? path.join(os.homedir(), '.agentlens')
const DATA_FILE = path.join(DATA_DIR, 'spans.json')
// TRDD-PJC8N1HO — durable-state sidecars (all under DATA_DIR, all written atomically):
const OFFSETS_FILE   = path.join(DATA_DIR, 'log-offsets.json')     // spec 3: logReader tail offsets
const CARDS_FILE     = path.join(DATA_DIR, 'log-sessions.json')    // spec 3: stripped log cards (fast restart)
const LIFECYCLE_FILE = path.join(DATA_DIR, 'collector-lifecycle.json') // spec 2: start/stop/heartbeat log
const REQUEST_LOG    = path.join(DATA_DIR, 'requests.log')         // spec 6: one line per HTTP request

// Ensure DATA_DIR exists before any sidecar is written (lifecycle/offsets/crash all live here). The
// spans loader below also mkdir's it, but the lifecycle start marker fires first, so do it up front.
try { if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true }) } catch { /* best effort */ }

// spec 6: request log (ring buffer + rotating file) so any future crash is attributable to a request.
const requestLog = new RequestLog(REQUEST_LOG)

// spec 2: collector lifecycle store — a start marker is appended on boot; heartbeats keep the current
// run's last-known-alive time fresh so a crash leaves a truthful gap boundary; a graceful stop records
// stoppedAt. computeCollectorGaps() turns this into the dashboard's "telemetry lost" bands.
let lifecycle: LifecycleStore = recordCollectorStart(LIFECYCLE_FILE)
function getCollectorGaps(): CollectorGap[] {
  try { return computeCollectorGaps(lifecycle) } catch { return [] }
}

// ── Build id for browser live-reload ──────────────────────────────────────────
// A cheap fingerprint of the served bundles' mtimes, computed ONCE at startup. Pushed over the
// existing dashboard SSE in every update payload; the injected client snippet reloads the page when
// the id it loaded with no longer matches. So: edit code → esbuild rebuild → dev-server restarts the
// server → the reconnecting browser sees a new id and refreshes itself. Guarded (reloads only on a
// real change vs the id embedded at load) so it can never loop.
function computeBuildId(): string {
  let sig = ''
  for (const f of ['dashboard.js', 'sidebar.js', 'dashboard.css']) {
    try { sig += `${f}:${fs.statSync(path.join(mediaDir, f)).mtimeMs}|` } catch { /* missing bundle — skip */ }
  }
  return sig || String(Date.now())
}
const BUILD_ID = computeBuildId()

// ── Span store with file persistence ─────────────────────────────────────────

let spans: Span[] = []
let sseClients: http.ServerResponse[] = []

// Hard cap on the in-memory span buffer. Unlike SessionStore's time-window trim, the standalone
// keeps a flat span array to rebuild the whole session list on demand — so with the FULL telemetry
// firehose now enabled (logs + metrics + traces + raw-body events from every active Claude Code
// session) it grew UNBOUNDED and OOM-killed the process (JS heap exhausted at ~4GB after ~19 min:
// FATAL "Ineffective mark-compacts near heap limit"). Capping to the most-recent MAX_SPANS keeps
// recent sessions (what diagnosis needs) while the process stays bounded. Default lowered
// 200k → 50k after the process was observed at 2.4GB RSS: firehose log events carry large
// payloads, so real spans average far more than the 1.6KB the 200k default assumed.
// Env override so a big machine can raise it: AGENTLENS_MAX_SPANS.
const MAX_SPANS = Math.max(10_000, Number(process.env.AGENTLENS_MAX_SPANS) || 50_000)

// ── Persistence: append-only NDJSON (SSD-wear fix) ────────────────────────────
// WHY THIS SHAPE: the previous implementation serialized the ENTIRE store (~200MB at cap) through
// a 1-second debounce — under the firehose that meant the whole file rewritten every few seconds,
// measured at 420GB written to disk in 4.4 hours (~2.3TB/day of SSD wear) while the file itself
// never grew. Append-only turns steady-state persistence into KB-scale appends; the full file is
// rewritten ONLY by compaction (when the file holds > 2× MAX_SPANS lines) and on shutdown.
// Format: one JSON span per line. The loader still accepts the legacy single-JSON-array file and
// migrates it to NDJSON once, atomically.

let pendingLines: string[] = []  // spans not yet appended to disk
let fileSpanCount = 0            // lines currently in DATA_FILE (drives compaction)
const SAVE_INTERVAL_MS = Math.max(1000, Number(process.env.AGENTLENS_SAVE_INTERVAL_MS) || 5000)

// Persistence accounting — the observable that would have caught the 420GB incident on day one.
// Every byte this process writes to DATA_DIR is counted here and reported by /api/server-stats,
// so "how much is the collector writing?" is one CLI call instead of a kernel-counter hunt.
const SERVER_STARTED_AT = Date.now()
const persistStats = {
  spanAppendWrites: 0, spanAppendBytes: 0,
  spanCompactions: 0, spanCompactBytes: 0,
  offsetsWrites: 0, offsetsBytes: 0,
  cardsWrites: 0, cardsBytes: 0,
  hookEventWrites: 0, hookEventBytes: 0,
  gateChecks: 0, gateDenies: 0, gateWarns: 0, gateAdvisories: 0,
  bodiesLastPurge: { at: 0, removedFiles: 0, freedBytes: 0, keptFiles: 0, keptBytes: 0 },
}

function spansToNdjson(list: Span[]): string {
  return list.length ? `${list.map(s => JSON.stringify(s)).join('\n')}\n` : ''
}

// Load persisted spans on startup — cap to the most-recent MAX_SPANS so a large historical
// store can't blow the heap on load either.
try {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true })
  if (fs.existsSync(DATA_FILE)) {
    const raw = fs.readFileSync(DATA_FILE, 'utf-8')
    let loaded: Span[] = []
    let migrated = false
    if (raw.trimStart().startsWith('[')) {
      loaded = JSON.parse(raw) as Span[] // legacy whole-array format
      migrated = true
    } else {
      // NDJSON. A crash mid-append can leave ONE truncated final line — skip corrupt lines
      // instead of losing the whole store (that is the crash-tolerance contract of this format).
      let skipped = 0
      for (const line of raw.split('\n')) {
        if (!line) continue
        try { loaded.push(JSON.parse(line) as Span) } catch { skipped++ }
      }
      if (skipped > 0) console.warn(`[AgentLens] spans store: skipped ${skipped} corrupt line(s)`)
    }
    spans = loaded.length > MAX_SPANS ? loaded.slice(-MAX_SPANS) : loaded
    fileSpanCount = loaded.length
    if (migrated) {
      // One-time migration: rewrite as NDJSON (atomic), dropping anything beyond the cap.
      atomicWriteFileSync(DATA_FILE, spansToNdjson(spans))
      fileSpanCount = spans.length
      console.log(`[AgentLens] Migrated legacy spans.json to NDJSON (${spans.length} spans kept)`)
    }
    console.log(`[AgentLens] Loaded ${spans.length} spans from ${DATA_FILE}${loaded.length > spans.length ? ` (capped from ${loaded.length})` : ''}`)
  }
} catch (e) {
  console.warn('[AgentLens] Could not load persisted data:', e)
}

/** Append the buffered spans; compact (full rewrite) only when the file is 2× over the cap. */
function flushSpanAppends(): void {
  if (pendingLines.length > 0) {
    try {
      const chunk = `${pendingLines.join('\n')}\n`
      fs.appendFileSync(DATA_FILE, chunk)
      persistStats.spanAppendWrites++
      persistStats.spanAppendBytes += chunk.length
      fileSpanCount += pendingLines.length
      pendingLines = []
    } catch (e) {
      console.warn('[AgentLens] Could not append spans:', e)
      // Retry next tick — but a bounded buffer: if appends keep failing (disk full, dir gone),
      // cap the buffer at one MAX_SPANS worth so the failure can't become its own memory leak.
      if (pendingLines.length > MAX_SPANS) pendingLines = pendingLines.slice(-MAX_SPANS)
      return
    }
  }
  if (fileSpanCount > MAX_SPANS * 2) {
    try {
      const body = spansToNdjson(spans)
      atomicWriteFileSync(DATA_FILE, body)
      persistStats.spanCompactions++
      persistStats.spanCompactBytes += body.length
      fileSpanCount = spans.length
    } catch (e) {
      console.warn('[AgentLens] Could not compact spans store:', e)
    }
  }
}
const spanFlushTimer = setInterval(flushSpanAppends, SAVE_INTERVAL_MS)
spanFlushTimer.unref()

/** Reset both the on-disk store and the append pipeline (the /api/clear + clearAll paths). */
function clearPersistedSpans(): void {
  pendingLines = []
  fileSpanCount = 0
  try { atomicWriteFileSync(DATA_FILE, '') } catch (e) { console.warn('[AgentLens] Could not clear data file:', e) }
}

function addSpan(span: Span) {
  if (span.receivedAt === undefined) span.receivedAt = Date.now()
  spans.push(span)
  pendingLines.push(JSON.stringify(span))
  // Bound the buffer so the firehose can't grow it without limit (the OOM fix above). Evict the
  // oldest overflow in one batch (amortized O(1)) rather than shift() per push. A ~5% slack above
  // MAX_SPANS avoids re-slicing on every single add once at the cap.
  if (spans.length > MAX_SPANS * 1.05) spans = spans.slice(-MAX_SPANS)
}

// ── otel-bodies retention: ARCHIVE, don't delete ──────────────────────────────
// Claude Code's OTEL_LOG_RAW_API_BODIES exporter writes one request+response JSON pair per API
// call into DATA_DIR/otel-bodies and never deletes anything (observed 23GB / ~45k files on a
// 98%-full disk). The user needs a MONTH of bodies for long-term diagnosis, so old bodies are
// MOVED into the compressed random-access archive (src/bodyArchive.ts — WAD-style monthly
// volumes, ~8-10× smaller), never destroyed before the retention window ends:
//   live dir  — the last AGENTLENS_BODIES_MAX_AGE_HOURS (default 72h), plain files
//   archive   — everything older, until AGENTLENS_BODIES_RETENTION_DAYS (default 31)
// The live-size cap (AGENTLENS_BODIES_MAX_GB, default 8) is an emergency valve that archives
// oldest-first — it also never deletes. The only true deletion is whole archive volumes older
// than the retention window. Every pass is logged; a silent cap would read as data loss.
const BODIES_DIR = path.join(DATA_DIR, 'otel-bodies')
const BODIES_ARCHIVE_DIR = path.join(DATA_DIR, 'otel-bodies-archive')
const BODIES_MAX_AGE_MS = Math.max(1, Number(process.env.AGENTLENS_BODIES_MAX_AGE_HOURS) || 72) * 3600e3
const BODIES_MAX_BYTES = Math.max(0.5, Number(process.env.AGENTLENS_BODIES_MAX_GB) || 8) * 1024 ** 3
const BODIES_RETENTION_DAYS = Math.max(1, Number(process.env.AGENTLENS_BODIES_RETENTION_DAYS) || 31)

let bodiesPassRunning = false
async function archiveOtelBodies(): Promise<void> {
  if (bodiesPassRunning) return // an hourly tick must never overlap a still-running first pass
  bodiesPassRunning = true
  try {
    let entries: { p: string; name: string; mtime: number; size: number }[] = []
    try {
      if (!fs.existsSync(BODIES_DIR)) return
      for (const f of fs.readdirSync(BODIES_DIR)) {
        if (!f.endsWith('.request.json') && !f.endsWith('.response.json')) continue
        try {
          const st = fs.statSync(path.join(BODIES_DIR, f))
          entries.push({ p: path.join(BODIES_DIR, f), name: f, mtime: st.mtimeMs, size: st.size })
        } catch { /* raced with a writer — skip */ }
      }
    } catch (e) {
      console.warn('[AgentLens] otel-bodies retention scan failed:', e)
      return
    }
    const cutoff = Date.now() - BODIES_MAX_AGE_MS
    let archived = 0
    let archivedBytes = 0
    const moveToArchive = async (e: { p: string; name: string; mtime: number; size: number }): Promise<void> => {
      try {
        const data = fs.readFileSync(e.p)
        appendToArchive(BODIES_ARCHIVE_DIR, e.name, data, e.mtime)
        fs.unlinkSync(e.p) // only after the archive append succeeded — a failure keeps the live file
        archived++
        archivedBytes += e.size
      } catch (err) {
        console.warn(`[AgentLens] could not archive ${e.name}:`, err)
      }
      // Yield between files: the first pass can chew tens of thousands of files, and a sync loop
      // would starve the OTLP/UI listeners for minutes.
      await new Promise(r => setImmediate(r))
    }
    const kept: typeof entries = []
    for (const e of entries) {
      if (e.mtime < cutoff) await moveToArchive(e)
      else kept.push(e)
    }
    entries = kept
    let totalBytes = entries.reduce((a, e) => a + e.size, 0)
    if (totalBytes > BODIES_MAX_BYTES) {
      entries.sort((a, b) => a.mtime - b.mtime) // oldest first
      for (const e of entries) {
        if (totalBytes <= BODIES_MAX_BYTES) break
        await moveToArchive(e)
        totalBytes -= e.size
      }
    }
    const purged = purgeArchiveVolumes(BODIES_ARCHIVE_DIR, BODIES_RETENTION_DAYS)
    persistStats.bodiesLastPurge = {
      at: Date.now(), removedFiles: archived, freedBytes: archivedBytes,
      keptFiles: entries.length, keptBytes: totalBytes,
    }
    if (archived > 0 || purged.removed.length > 0) {
      const arch = archiveDiskUsage(BODIES_ARCHIVE_DIR)
      console.log(`[AgentLens] otel-bodies retention: archived ${archived} file(s) (${(archivedBytes / 1024 ** 3).toFixed(2)}GB → archive now ${(arch.bytes / 1024 ** 3).toFixed(2)}GB/${arch.entries} lumps)` +
        `${purged.removed.length > 0 ? `; purged volume(s) ${purged.removed.join(', ')} (${(purged.freedBytes / 1024 ** 3).toFixed(2)}GB)` : ''}; live ${(totalBytes / 1024 ** 3).toFixed(2)}GB`)
    }
  } finally {
    bodiesPassRunning = false
  }
}
// Lifecycle hook events (spy-agentlens.sh → POST /api/hook-events): append-only NDJSON daily
// buckets. Signals JSONL/OTEL lack: StopFailure (rate-limit turn deaths), PreCompact trigger,
// exact session lifecycle. TRDD-Q6ZOUVK5.
const HOOK_EVENTS_DIR = path.join(DATA_DIR, 'hook-events')
const HOOK_EVENTS_RETENTION_DAYS = Math.max(1, Number(process.env.AGENTLENS_HOOK_EVENTS_RETENTION_DAYS) || 31)
const HOOK_EVENT_MAX_BYTES = 512 * 1024 // lifecycle payloads are small; a bigger body is a bug

function purgeHookEvents(): void {
  const r = purgeHookEventBuckets(HOOK_EVENTS_DIR, HOOK_EVENTS_RETENTION_DAYS)
  if (r.removed.length > 0) {
    console.log(`[AgentLens] hook-events retention: purged ${r.removed.length} bucket(s), ${(r.freedBytes / 1048576).toFixed(1)}MB`)
  }
}

void archiveOtelBodies() // enforce on boot — a long-dead server must not leave the corpus unbounded
purgeHookEvents()
const bodiesPurgeTimer = setInterval(() => { void archiveOtelBodies(); purgeHookEvents() }, 3600e3)
bodiesPurgeTimer.unref()

// ── Agent-launch burn gate + realtime activity (TRDD-GOD0108C) ────────────────
// The gate sits behind a PreToolUse hook, so every read here must be in-memory:
// (a) BodiesActivityTracker — incremental scan of the live bodies dir (CACHE_THRASH +
//     HUGE_REQUEST_BURST without the stat-every-file pass);
// (b) an in-memory hook-event ring fed by POST /api/hook-events (zero disk reads).
const bodiesActivity = new BodiesActivityTracker(BODIES_DIR)
function bodiesActivityReport(): ReturnType<BodiesActivityTracker['report']> {
  // Read-only: polling happens on the background timer below, NEVER on a request path — a
  // poll that lands on new multi-MB response files costs 100-400ms of JSON.parse, which was
  // measured as a request-latency outlier when the poll was throttled inline (TRDD-9CNHP8CN).
  return bodiesActivity.report(Date.now())
}
// Seed pass 3s after boot (stats the whole live dir once), then a 5s background cadence —
// ≤5s staleness is invisible against the 90s/5min risk windows, and request latency stays flat.
const bodiesSeedTimer = setTimeout(() => { try { bodiesActivity.poll() } catch { /* fail-open */ } }, 3000)
bodiesSeedTimer.unref()
const bodiesActivityTimer = setInterval(() => { try { bodiesActivity.poll() } catch { /* fail-open */ } }, 5000)
bodiesActivityTimer.unref()

const RECENT_EVENTS_CAP = 600
const recentHookEvents: HookEventRecord[] = []
// Boot-seed from disk so a fresh server isn't blind to a stall/fan-out from 5 minutes ago.
try { recentHookEvents.push(...readHookEvents(HOOK_EVENTS_DIR, { sinceMs: Date.now() - 3600e3, limit: 500 }).reverse()) } catch { /* none yet */ }
function pushRecentHookEvent(rec: HookEventRecord): void {
  recentHookEvents.push(rec)
  if (recentHookEvents.length > RECENT_EVENTS_CAP) recentHookEvents.splice(0, recentHookEvents.length - 500)
}

// Realtime hook switches (~/.agentlens/hook-config.json): registrations in settings.json are
// static per session, but every hook is a dumb curl HERE — so enable/disable + mode changes
// apply instantly to ALL running sessions machine-wide (GET/POST /api/hook-config, CLI --hooks).
// AGENTLENS_GATE_MODE=warn is honored as the pre-file default; the file wins once saved.
const HOOK_CONFIG_FILE = path.join(DATA_DIR, 'hook-config.json')
let hookRuntime = loadHookRuntimeConfig(HOOK_CONFIG_FILE)
const gateThresholds: Partial<GateThresholds> = (() => {
  const out: Partial<GateThresholds> = {}
  // Only DEFINED keys may land in the partial: spreading { key: undefined } over the
  // defaults would silently erase them ({...{a:1}, ...{a:undefined}} → a undefined).
  const set = (key: keyof GateThresholds, env: string): void => {
    const v = Number(process.env[env])
    if (Number.isFinite(v) && v > 0) out[key] = v
  }
  set('forkFatTokens', 'AGENTLENS_GATE_FORK_FAT_TOKENS')
  set('coldIdleMs', 'AGENTLENS_GATE_COLD_IDLE_MS')
  set('runaway60s', 'AGENTLENS_GATE_RUNAWAY_60S')
  set('fanoutWarn2min', 'AGENTLENS_GATE_FANOUT_WARN_2MIN')
  set('coldResumeWindowMs', 'AGENTLENS_GATE_COLD_RESUME_WINDOW_MS')
  return out
})()

function buildGateState(now: number, parent: { contextTokens: number | null; idleMs: number | null }): AgentGateState {
  let starts60 = 0
  let starts120 = 0
  let lastStop: HookEventRecord | null = null
  // Per-session launch attribution: SubagentStart payloads carry cwd + agent_type, so the
  // deny/warn messages can name WHO is fanning out, from WHERE, with WHAT agent kinds.
  const bySession = new Map<string, { cwd: string | null; types: Map<string, number>; count: number }>()
  for (const r of recentHookEvents) {
    if (r.ts > now) continue
    if (r.ev === 'SubagentStart') {
      if (now - r.ts <= 60_000) starts60++
      if (now - r.ts <= 120_000) {
        starts120++
        const sid = r.session ?? '?'
        const e = bySession.get(sid) ?? { cwd: null, types: new Map<string, number>(), count: 0 }
        e.count++
        const cwd = r.payload?.cwd
        if (!e.cwd && typeof cwd === 'string') e.cwd = cwd
        const t = r.payload?.agent_type
        if (typeof t === 'string') e.types.set(t, (e.types.get(t) ?? 0) + 1)
        bySession.set(sid, e)
      }
    } else if (r.ev === 'StopFailure' && (lastStop === null || r.ts > lastStop.ts)) {
      lastStop = r
    }
  }
  const spawners: LaunchSpawner[] = [...bySession.entries()]
    .sort((a, b) => b[1].count - a[1].count)
    .map(([session, e]) => ({
      session,
      cwd: e.cwd,
      count: e.count,
      agentTypes: [...e.types.entries()].sort((a, b) => b[1] - a[1]).map(([t, n]) => (n > 1 ? `${t}×${n}` : t)),
    }))
  const act = bodiesActivityReport()
  return {
    now,
    mode: hookRuntime.gateMode,
    parent,
    startsLast60s: starts60,
    startsLast2min: starts120,
    spawners,
    lastStopFailureMs: lastStop ? lastStop.ts : null,
    stall: lastStop
      ? { session: lastStop.session ?? null, cwd: typeof lastStop.payload?.cwd === 'string' ? lastStop.payload.cwd : null }
      : null,
    thrash: act.available ? act.thrash : null,
    premiumShare: act.premium.sampled > 0 ? act.premium.share : null,
    premiumModel: act.premium.lastModel,
    thresholds: gateThresholds,
  }
}

// PostToolUse advisory dedupe: ONE in-band injection per session+risk per 10min — per-call
// injections that later get stripped in place are themselves a cache-break cause (#778).
const advisoryIssued = new Map<string, number>()

// ── Single-instance guard (canonical instance only) ──────────────────────────
// EADDRINUSE on any of the three listeners already makes a same-port double start exit(1); the
// pidfile adds (a) a discoverable PID for `agentlens-cli --status/--stop-server` without a lsof
// hunt, and (b) a fast, explicit refusal BEFORE boot-time side effects (bodies purge, migration,
// auto-config) when a canonical server is already alive. Isolated-port instances (tests, headless
// proofs — see the canonical-instance gate in applyAutoConfig) never write it: they are meant to
// coexist and must not evict the real server's pidfile.
const PID_FILE = path.join(DATA_DIR, 'server.pid')
const IS_CANONICAL = OTLP_PORT === 4318
if (IS_CANONICAL) {
  try {
    const prior = Number(fs.readFileSync(PID_FILE, 'utf-8').trim())
    if (prior > 0 && prior !== process.pid) {
      try {
        process.kill(prior, 0) // throws when the process is gone — then the pidfile is stale
        console.error(`[AgentLens] Another AgentLens server is already running (pid ${prior}). Use \`agentlens-cli --status\` / \`--stop-server\`, or set OTLP_PORT for an isolated instance.`)
        process.exit(1)
      } catch { /* stale pidfile — take over below */ }
    }
  } catch { /* no pidfile — first start */ }
  try { atomicWriteFileSync(PID_FILE, String(process.pid)) } catch (e) { console.warn('[AgentLens] Could not write pidfile:', e) }
}

// ── Log file sessions ─────────────────────────────────────────────────────────

// Indexed by sessionId; OTEL-derived sessions (from spans) take precedence —
// when the same session ID appears in both, the OTEL version is used.
let logSessions: Map<string, SessionSummaryCard> = new Map()

function buildImportCardStandalone(raw: Record<string, unknown>): SessionSummaryCard {
  const num = (v: unknown, def = 0): number => (typeof v === 'number' ? v : def)
  const str = (v: unknown, def = ''): string => (typeof v === 'string' ? v : def)
  const arrStr = (v: unknown): string[] => (Array.isArray(v) ? v.filter(x => typeof x === 'string') as string[] : [])
  return {
    sessionId:         str(raw['sessionId']),
    traceId:           str(raw['traceId']),
    source:            (raw['source'] as SessionSummaryCard['source']) ?? 'claude_code',
    dataSource:        'log',
    workspace:         str(raw['workspace']),
    userRequest:       str(raw['userRequest']),
    model:             str(raw['model']),
    turns:             num(raw['turns']),
    totalLlmCalls:     num(raw['turns']),
    totalToolCalls:    num(raw['totalToolCalls']),
    inputTokens:       num(raw['inputTokens']),
    outputTokens:      num(raw['outputTokens']),
    cacheReadTokens:   num(raw['cacheReadTokens']),
    cacheCreateTokens: num(raw['cacheCreateTokens']),
    cacheHitRate:      num(raw['cacheHitRate']),
    durationMs:        num(raw['durationMs']),
    startTime:         str(raw['startTime'], new Date().toISOString()),
    filesRead:         arrStr(raw['filesRead']),
    filesChanged:      arrStr(raw['filesChanged']),
    filesSearched:     [],
    filesWritten:      [],
    toolCounts:        (typeof raw['toolCounts'] === 'object' && raw['toolCounts'] !== null ? raw['toolCounts'] : {}) as Record<string, number>,
    errors:            num(raw['errors']),
    outcome:           (raw['outcome'] as SessionSummaryCard['outcome']) ?? 'unknown',
    timeline:          [],
    backgroundSpans:   [],
    loopSignals:       Array.isArray(raw['loopSignals']) ? raw['loopSignals'] as SessionSummaryCard['loopSignals'] : [],
  }
}

let logReader = new LogReader()
// P7: overlays authoritative context size + cost from the Claude Code statusline usage log onto each
// card before it is served. No-op for sessions/agents that wrote no statusline line.
const statuslineReader = new StatuslineUsageReader()

// ── Burn monitor (TRDD-OG9PARZQ) ───────────────────────────────────────────────
// Realtime "smoke detector": rolling burn rate + rate-limit window budget + threshold alerts, computed
// over the already-ingested live data (OTEL api_request timeline events + statusline billing deltas).
const burnConfig = loadBurnConfig(process.env, os.homedir())

// Gathers the current machine-wide consumption event stream once, reused by the MCP accessors + the tick.
function gatherBurn(now = Date.now()) {
  const sessions = buildSessionSummary()?.sessions ?? []
  const events = gatherConsumptionEvents(sessions, statuslineReader.getBillingEvents(now), now)
  return { sessions, events, now }
}

// ── Context-composition index (TRDD-CTXQUERY, dashboard piece 1) ────────────────
// The LAZY, LRU-cached OTEL-raw-body composition layer the dashboard composition panel + the
// resident-blob flag read. It parses a session's request bodies ON DEMAND (never a background sweep)
// from the shared callBodyRegistry — the exact instance the MCP tools use, but a server-local one so
// the routes and the resident-blob tick share ONE cache. Pointer-only (token counts + refs, no bytes).
const compositionIndex = new ContextCompositionIndex()

// sessionId → project path, rebuilt per request from the live cards (same mapping the MCP tools use).
function compositionProjectResolver(): (id: string) => string | undefined {
  const map = new Map<string, string>()
  for (const s of buildSessionSummary()?.sessions ?? []) { map.set(s.sessionId, s.projectPath ?? s.workspace ?? 'unknown') }
  return (id: string) => map.get(id)
}

// ── Resident-blob proactive flag (TRDD-CTXQUERY, dashboard piece 3) ─────────────
// The eviction-candidate blobs (a big block re-read across many turns — the "525k images resident"
// case) surfaced as a proactive alert on the burn status. Computed on a SLOW cadence (not the 4s
// burn tick) over the BOUNDED live-registry scope (findResidentBlobs caps + LRU-caches), so a warm
// pass is cheap; the result rides every burn tick + /api/burn-status. Thresholds are deliberately
// high so only genuinely wasteful blobs flag (not every small block that rides two turns).
interface ResidentBlobAlert {
  sessionId: string; project: string; kind: string; label: string; isImage: boolean
  peakTokens: number; residentTurns: number; cumulativeReadTokens: number; cumulativeReadCostUsd: number
}
let latestResidentBlobs: ResidentBlobAlert[] = []
let residentScanRunning = false
async function scanResidentBlobs(): Promise<void> {
  if (residentScanRunning) return
  residentScanRunning = true
  try {
    const r = await compositionIndex.findResidentBlobs(undefined, { minResidentTurns: 3, minTokens: 20_000 }, compositionProjectResolver())
    latestResidentBlobs = r.blobs.slice(0, 10).map(b => ({
      sessionId: b.sessionId, project: b.project, kind: b.kind, label: b.label, isImage: b.isImage,
      peakTokens: b.peakTokens, residentTurns: b.residentTurns,
      cumulativeReadTokens: b.cumulativeReadTokens, cumulativeReadCostUsd: b.cumulativeReadCostUsd,
    }))
  } catch (e) {
    console.warn('[AgentLens] resident-blob scan error:', e)
  } finally {
    residentScanRunning = false
  }
}
// 30s cadence: bodies parse once then hit the LRU cache; a 4s recompute would waste work for no gain.
setInterval(() => { void scanResidentBlobs() }, 30_000)
void scanResidentBlobs()

// ── Burn-status enrichment for the dashboard (TRDD-BURNWDGT + CTXQUERY) ──────────
// computeBurnStatus is I/O-free (no account labels). The dashboard/SSE path enriches it with: the
// per-account window LABELS (email/org, resolved live from the current account), the CURRENT account
// identity + plan (so the burn monitor shows "who am I / what plan / how much of MY window is left"),
// and the proactive resident-blob flag. Pointer-only: no OAuth token ever touched — only the plan
// string + public identity fields from accountInfo.
function summarizeCurrentAccount() {
  const a = getCurrentAccount()
  if (!a || a.source === 'none') return null
  return {
    accountId: a.accountUuid, label: a.label, email: a.email, organizationName: a.organizationName,
    planType: a.planType, billingType: a.billingType, hasExtraUsageEnabled: a.hasExtraUsageEnabled,
  }
}
function enrichBurnStatus(status: BurnStatus) {
  return { ...labelBurnStatusAccounts(status, getCurrentAccount()), currentAccount: summarizeCurrentAccount(), residentBlobs: latestResidentBlobs }
}

// ── MCP server ────────────────────────────────────────────────────────────────

// Dedicated server on MCP_PORT (default 4316) — same port as the VS Code extension.
// Fire-and-forget: the HTTP MCP server keeps itself alive via its own listeners; we don't hold the
// handle (nothing shuts it down before process exit), so we don't bind it (avoids an unused-local).
startMcpHttpServer({
  getSessions: () => {
    const summary = buildSessionSummary()
    return summary?.sessions ?? []
  },
  // The standalone cards already carry their inline timeline (log-parsed), so the MCP diagnostics
  // read per-turn tokens off the card; composition is reconstructed on demand from the raw .jsonl —
  // the same route /api/composition/:id serves the browser. This makes the P4 inflation / cache-break
  // tools return real data over the in-session MCP (http://localhost:4316/mcp).
  getComposition: (id) => {
    // Reconstruct a fork/sub-agent (no own .jsonl) from the nearest LOGGED ancestor so the MCP
    // context-composition / cache-break tools drill too — walking the chain, not just one hop.
    const sess = buildSessionSummary()?.sessions ?? []
    const parentOf = (sid: string): string | undefined => sess.find(s => s.sessionId === sid)?.parentSessionId
    return buildContextComposition(id, resolveLoggedAncestor(id, parentOf) ?? parentOf(id))
  },
  // P8: full per-step context history (every block drillable to actual text + diff). Same fork/ancestor
  // fallback as getComposition so a fork/sub-agent reconstructs from its parent transcript.
  getHistory: (id) => {
    const sess = buildSessionSummary()?.sessions ?? []
    const parentOf = (sid: string): string | undefined => sess.find(s => s.sessionId === sid)?.parentSessionId
    return buildContextHistory(id, resolveLoggedAncestor(id, parentOf) ?? parentOf(id))
  },
  // TRDD-ICHAVFCS: resolve a call (sessionId + requestId/spanId) to its full literal context tree,
  // reconstructed from the raw OTEL request body indexed by the collector. Works for OTEL-only sessions.
  getCallContext: (sessionId, sel) => resolveCallContext(sessionId, sel),
  // TRDD-OG9PARZQ: realtime burn status + one-call session self-diagnostic for the fleet's Claudes.
  getBurnStatus: () => { const { sessions, events, now } = gatherBurn(); return computeBurnStatus(events, sessions, burnConfig, now) },
  getSessionStatus: (sel) => { const { sessions, events, now } = gatherBurn(); return computeSessionStatus(sessions, events, burnConfig, sel, now) },
  // TRDD-BURNWDGT: the current live OAuth account (identity + plan) for get_account_status + window labels.
  getAccount: () => getCurrentAccount(),
  // TRDD-GOD0108C: hot-path feeds for check_burn_risk — the in-memory event ring (zero disk)
  // and the incremental bodies tracker (CACHE_THRASH + huge-request burst without full stats).
  getRecentHookEvents: () => recentHookEvents,
  getBodiesActivity: () => bodiesActivityReport(),
  // TRDD-PJC8N1HO spec 2: an orienting agent sees where telemetry was lost, not just the sessions.
  getCollectorGaps,
}, MCP_PORT, BIND_HOST)

// ── Burn SSE tick + alerts (TRDD-OG9PARZQ) ─────────────────────────────────────
// Every few seconds compute the burn status, push it to the dashboard over the existing SSE channel,
// and for each NEW alert push an `alert` SSE (rendered as a banner + Alerts-tab entry) and — opt-in —
// fire a macOS notification. `firedBurnAlerts` dedupes so a standing condition notifies once until it
// clears (so a persistent firehose doesn't spam every tick).
const firedBurnAlerts = new Set<string>()

function pushBurnSse(payload: unknown): void {
  if (sseClients.length === 0) return
  const data = JSON.stringify(payload)
  sseClients = sseClients.filter(client => {
    try { client.write(`data: ${data}\n\n`); return true } catch { return false }
  })
}

// macOS notification, strictly opt-in (AGENTLENS_NOTIFY=1). osascript is escaped so an alert detail
// can never break out of the AppleScript string. No-op off macOS or when notify is disabled.
function macNotify(alert: BurnAlert): void {
  if (!burnConfig.notify || process.platform !== 'darwin') return
  const esc = (s: string) => s.replace(/["\\]/g, '\\$&').slice(0, 240)
  exec(`osascript -e 'display notification "${esc(alert.detail)}" with title "AgentLens: ${esc(alert.label)}"'`, () => {})
}

// The tick's latest status, reused by hot request paths (/api/burn-risk): recomputing
// gatherBurn per request measured ~270ms; the cache is at most 4s stale — invisible against
// the 5-min burn window it feeds (TRDD-9CNHP8CN).
let lastBurnStatus: ReturnType<typeof computeBurnStatus> | null = null

function tickBurn(): void {
  let status
  try {
    const { sessions, events, now } = gatherBurn()
    status = computeBurnStatus(events, sessions, burnConfig, now)
  } catch (e) {
    console.warn('[AgentLens] burn tick error:', e)
    return
  }
  lastBurnStatus = status
  pushBurnSse({ type: 'burnStatus', burnStatus: enrichBurnStatus(status) })

  const active = new Set<string>()
  for (const alert of status.alerts) {
    active.add(alert.id)
    if (firedBurnAlerts.has(alert.id)) continue
    firedBurnAlerts.add(alert.id)
    // Reuse the existing SSE `alert` channel — the dashboard renders it as a banner (spec 3).
    pushBurnSse({ type: 'alert', label: alert.label, detail: alert.detail, severity: alert.severity })
    macNotify(alert)
  }
  // Clear fired keys whose condition cleared so the alert can re-fire if it returns.
  for (const id of Array.from(firedBurnAlerts)) if (!active.has(id)) firedBurnAlerts.delete(id)
}
// 4s cadence gives ≤10s alert latency with margin (acceptance) without a heavy per-second rebuild.
setInterval(tickBurn, 4000)

function runLogScan() {
  const results = logReader.scan()
  // logReader.scan() returns ONLY sessions whose byte offset advanced (incremental tail — unchanged
  // files return null), so `changedCards` is exactly the set that grew this scan. That set drives
  // the immediate targeted push below; the heavier full-summary rebuild stays coalesced.
  const changedCards: SessionSummaryCard[] = []
  for (const { card, childCards } of results) {
    statuslineReader.overlay(card)
    logSessions.set(card.sessionId, card)
    changedCards.push(card)
    for (const child of childCards ?? []) { logSessions.set(child.sessionId, child); changedCards.push(child) }
  }
  if (changedCards.length > 0) {
    pushSessionChanged(changedCards)   // TRDD-U0UYC38A: targeted, immediate — sub-second drill refresh
    schedulePushUpdate()               // authoritative full refresh (sidebar/analytics, OTEL-wins) — coalesced
    scheduleDurableSave()              // TRDD-PJC8N1HO spec 3: persist offsets + cards so a restart resumes
  }
}

// TRDD-PJC8N1HO spec 2: keep the current run's last-known-alive time fresh so a crash leaves a truthful
// gap boundary. 30s cadence keeps the lifecycle file write-light. Also persists durable state on a slow
// beat so offsets survive even a long idle-then-crash with no scan activity.
setInterval(() => {
  recordCollectorHeartbeat(LIFECYCLE_FILE, lifecycle)
  scheduleDurableSave()
}, 30_000)

// Debounced scan triggered by fs.watch events — fires 300 ms after the last event.
let watchScanTimer: ReturnType<typeof setTimeout> | null = null
function scheduleWatchScan() {
  if (watchScanTimer) clearTimeout(watchScanTimer)
  watchScanTimer = setTimeout(() => { watchScanTimer = null; runLogScan() }, 300)
}

function setupLogWatcher() {
  for (const dir of logReader.getWatchDirs()) {
    try {
      fs.watch(dir, { recursive: true, persistent: false }, scheduleWatchScan)
    } catch { /* dir may not exist yet — poll will cover it */ }
  }
}

async function startLogIngestion() {
  // Initialize sql.js so we can read the OpenCode SQLite DB.
  try {
    const sqlJsDir = path.dirname(require.resolve('sql.js'))
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const initSqlJs = require('sql.js') as (cfg: { locateFile: (f: string) => string }) => Promise<OpenCodeSqlFactory>
    const sqlFactory = await initSqlJs({ locateFile: (f: string) => path.join(sqlJsDir, f) })
    logReader = new LogReader({ log: (msg) => console.log(msg), sqlFactory })
  } catch { /* no sql.js — OpenCode falls back to JSON */ }

  // TRDD-PJC8N1HO spec 3: FAST RESTART. Import persisted tail offsets so the first scan SKIPS every
  // unchanged file (0 cold-start full reads) instead of re-parsing ~12k files from byte 0, and restore
  // the stripped log cards so the dashboard list + MCP are fresh in <5s. The heavy per-step timeline is
  // re-parsed on demand (see /api/timeline). A missing/corrupt sidecar → the normal cold scan below.
  let restoredFromDisk = false
  const persistedCards = loadPersistedCards(CARDS_FILE)
  if (persistedCards && persistedCards.length > 0) {
    for (const card of persistedCards) logSessions.set(card.sessionId, card)
    restoredFromDisk = true
  }
  const persistedOffsets = loadLogOffsets(OFFSETS_FILE)
  if (persistedOffsets) {
    const { imported, skipped } = logReader.importFileState(persistedOffsets)
    console.log(`[AgentLens] Resumed ${imported} log tail offset${imported !== 1 ? 's' : ''} (${skipped} invalid/rotated → cold read)${restoredFromDisk ? `; restored ${persistedCards!.length} session cards` : ''}`)
  }

  // Register the poll first so it always runs, even if no files exist yet at startup.
  setInterval(runLogScan, 5_000)
  // Watch log directories for file-system events so updates appear immediately,
  // without waiting for the next poll interval.
  setupLogWatcher()
  console.log('[AgentLens] Log ingestion enabled — scanning local session files')

  const AGENT_KEY_LABEL: Record<string, string> = {
    claude:               'Claude Code',
    codex:                'Codex',
    copilot:              'Copilot CLI',
    copilot_vscode:       'Copilot (VS Code)',
    copilot_vscode_json:  'Copilot (VS Code)',
    opencode:             'OpenCode',
  }
  const AGENT_KEY_DIR: Record<string, string> = {
    claude:               '~/.claude/projects/',
    codex:                '~/.codex/sessions/',
    copilot:              '~/.copilot/session-state/',
    copilot_vscode:       '~/Library/…/workspaceStorage/',
    copilot_vscode_json:  '~/Library/…/workspaceStorage/',
    opencode:             '~/.local/share/opencode/',
  }

  const countByKey = new Map<string, number>()

  // OpenCode: one DB file = many sessions, handled separately.
  const ocResults = logReader.scanOpenCode()
  for (const { card } of ocResults) {
    logSessions.set(card.sessionId, card)
    countByKey.set('opencode', (countByKey.get('opencode') ?? 0) + 1)
  }

  // spec 3: when cards were restored from disk, the cold full-file batch below is UNNECESSARY (and is
  // exactly the minutes-long rescan we are eliminating) — the 5s poll + fs.watch already registered
  // above will incrementally pick up any file that changed while the collector was down. Push the
  // restored list to any connected browser and return.
  if (restoredFromDisk) {
    console.log(`[AgentLens] Fast restart — ${logSessions.size} sessions restored from disk; skipping cold rescan`)
    schedulePushUpdate()
    return
  }

  // Run the initial batch synchronously so logSessions is populated before the
  // browser's first HTTP request. The setImmediate approach deferred this past
  // the first page load, causing a blank screen on startup.
  let files: ReturnType<typeof logReader.collectFileMeta>
  try { files = logReader.collectFileMeta() } catch { return }

  for (const file of files) {
    if (file.agentKey === 'opencode') continue  // already handled above
    try {
      const result = logReader.parseFile(file.filePath, file.agentKey)
      if (result) {
        statuslineReader.overlay(result.card)
        logSessions.set(result.card.sessionId, result.card)
        for (const child of result.childCards ?? []) logSessions.set(child.sessionId, child)
        countByKey.set(file.agentKey, (countByKey.get(file.agentKey) ?? 0) + 1)
      }
    } catch { /* skip bad file */ }
  }

  // Merge copilot_vscode and copilot_vscode_json into one display row
  const displayCounts = new Map<string, { label: string; dir: string; count: number }>()
  for (const [key, count] of countByKey) {
    const displayKey = key === 'copilot_vscode_json' ? 'copilot_vscode' : key
    const existing = displayCounts.get(displayKey)
    if (existing) { existing.count += count } else {
      displayCounts.set(displayKey, { label: AGENT_KEY_LABEL[key] ?? key, dir: AGENT_KEY_DIR[key] ?? key, count })
    }
  }

  const total = [...displayCounts.values()].reduce((s, v) => s + v.count, 0)
  if (total === 0) return
  const lines = [...displayCounts.values()]
    .sort((a, b) => b.count - a.count)
    .map(v => `  ${v.label.padEnd(20)} ${String(v.count).padStart(4)}  (${v.dir})`)
    .join('\n')
  console.log(`[AgentLens] Loaded ${total} sessions from local logs:\n${lines}`)
  // Push loaded sessions to any SSE clients that connected before the scan finished.
  schedulePushUpdate()
}

// ── OTLP parsing ──────────────────────────────────────────────────────────────

type RawAttr = { key: string; value: Record<string, unknown> }

function toAttrs(raw: unknown): RawAttr[] {
  if (!Array.isArray(raw)) return []
  return raw.filter((a): a is RawAttr => {
    const o = a as Record<string, unknown>
    return typeof o.key === 'string' && typeof o.value === 'object' && o.value !== null
  })
}

function attrStr(attrs: RawAttr[], ...keys: string[]): string {
  for (const key of keys) {
    const a = attrs.find(x => x.key === key)
    if (!a) continue
    const v = a.value
    const s = v.stringValue ?? v.intValue ?? v.doubleValue
    if (s != null) return String(s)
  }
  return ''
}

function isCodexWebsocketSpanName(name: string): boolean {
  const lower = name.toLowerCase()
  return lower.startsWith('codex.') && lower.includes('websocket')
}

function isCodexWebsocketTraceSpan(name: string, attrs: RawAttr[]): boolean {
  const lower = name.toLowerCase()
  if (!lower.includes('websocket')) return false
  const eventName = attrStr(attrs, 'event.name', 'event_name', 'name', 'event').toLowerCase()
  const hasCodexAttr = Boolean(attrStr(attrs, 'codex.session.id', 'codex.conversation.id', 'codex.turn.id'))
  return lower.startsWith('codex.') || eventName.startsWith('codex.') || hasCodexAttr
}

function attrsFromBodyKv(body: unknown): RawAttr[] {
  if (typeof body !== 'object' || body === null) return []
  const obj = body as Record<string, unknown>
  const kv = obj.kvlistValue as Record<string, unknown> | undefined
  const values = kv?.values
  if (!Array.isArray(values)) return []
  const attrs: RawAttr[] = []
  for (const value of values) {
    const entry = value as Record<string, unknown>
    const key = typeof entry.key === 'string' ? entry.key : ''
    const attrValue = entry.value as Record<string, unknown> | undefined
    if (!key || typeof attrValue !== 'object' || attrValue === null) continue
    attrs.push({ key, value: attrValue })
  }
  return attrs
}

function mergeAttrs(...lists: RawAttr[][]): RawAttr[] {
  const out: RawAttr[] = []
  const seen = new Set<string>()
  for (const list of lists) {
    for (const attr of list) {
      if (seen.has(attr.key)) continue
      seen.add(attr.key)
      out.push(attr)
    }
  }
  return out
}

function agentLabelFromSpanName(name: string): string {
  if (name.startsWith('claude_code.')) return 'Claude Code'
  if (name.startsWith('codex.'))       return 'Codex'
  if (name === 'invoke_agent' || name.startsWith('copilot.')) return 'Copilot'
  return 'unknown'
}

function processTraces(payload: unknown, collectorPath = '/v1/traces'): { count: number; agent: string } {
  const p = payload as { resourceSpans?: Array<{ scopeSpans?: Array<{ spans?: unknown[] }> }> }
  const rawSpans = p?.resourceSpans?.flatMap(rs =>
    rs.scopeSpans?.flatMap(ss => ss.spans ?? []) ?? []
  ) ?? []
  let count = 0
  let agent = 'unknown'
  for (const raw of rawSpans) {
    const s = raw as Record<string, unknown>
    if (typeof s.traceId !== 'string' || typeof s.spanId !== 'string' || typeof s.name !== 'string') continue
    let attrs = toAttrs(s.attributes)
    if (isCodexWebsocketTraceSpan(s.name, attrs)) continue
    if (agent === 'unknown') agent = agentLabelFromSpanName(s.name)
    attrs = [...attrs, { key: '_agentlens.collector_path', value: { stringValue: collectorPath } }]
    addSpan({
      traceId: s.traceId,
      spanId: s.spanId,
      parentSpanId: (s.parentSpanId as string) || undefined,
      name: s.name,
      startTime: s.startTimeUnixNano as string,
      endTime: s.endTimeUnixNano as string,
      attributes: attrs,
      status: s.status as { code: number; message?: string } | undefined,
    })
    count++
  }
  return { count, agent }
}

// Dropped log-event names since boot (the final-gate rejects). The rich-event drop lived
// undetected for weeks BECAUSE drops were silent — this makes "what arrived and was rejected"
// observable in /api/server-stats. Bounded: past 50 names, new ones fold into '(other)'.
const droppedLogEvents = new Map<string, number>()
function noteDroppedLogEvent(name: string): void {
  const key = name || '(unnamed)'
  const prev = droppedLogEvents.get(key)
  if (prev === undefined && droppedLogEvents.size >= 50) {
    droppedLogEvents.set('(other)', (droppedLogEvents.get('(other)') ?? 0) + 1)
    return
  }
  droppedLogEvents.set(key, (prev ?? 0) + 1)
}

function processLogs(payload: unknown, collectorPath = '/v1/logs'): number {
  type SL = { logRecords?: unknown[] }
  type RL = { scopeLogs?: SL[]; resource?: { attributes?: unknown } }
  const p = payload as { resourceLogs?: RL[] }
  const fallback = `codex-${Date.now()}`
  let n = 0
  for (const rl of p?.resourceLogs ?? []) {
    const resourceAttrs = toAttrs(rl.resource?.attributes)
    for (const sl of rl.scopeLogs ?? []) {
      const scopeAttrs = toAttrs((sl as { scope?: { attributes?: unknown } }).scope?.attributes)
      for (const rec of sl.logRecords ?? []) {
        const r = rec as Record<string, unknown>
        const attrs = mergeAttrs(toAttrs(r.attributes), attrsFromBodyKv(r.body), scopeAttrs, resourceAttrs)
        // Name resolution + prefix normalization + gate sets shared with src/otlpCollector.ts via
        // src/otlpLogEvents.ts. This path DRIFTED once: it never gained the rich-event gate, so the
        // running server dropped every api_request/compaction/api_error event under BOTH naming
        // conventions while the unit-tested collector class passed (found 2026-07-10).
        const name = resolveLogEventName(attrStr(attrs, 'event.name', 'event_name', 'name', 'event'), r)
        const bare = bareLogEventName(name)
        // TRDD-ICHAVFCS: index pointers to the raw API request/response bodies (OTEL_LOG_RAW_API_BODIES)
        // so a call can be resolved to its body file and its full context tree reconstructed on demand.
        // Store only the lightweight pointer — never the multi-MB body — then skip (no timeline value).
        if (BODY_POINTER_LOG_EVENTS.has(bare)) {
          const sid = attrStr(attrs, 'session.id', 'session_id')
          const bodyRef = attrStr(attrs, 'body_ref', 'body.ref', 'bodyRef')
          const inlineBody = attrStr(attrs, 'body')
          // TRDD-BURNWDGT — capture the account_uuid from the body event's (resource) attributes so a
          // session's OAuth account is known at ingest in the standalone path too (identifier, not a secret).
          const acct = attrStr(attrs, 'user.account_uuid', 'user_account_uuid')
          if (sid && acct) { callBodyRegistry.recordAccount(sid, acct) }
          if (sid && (bodyRef || inlineBody)) {
            callBodyRegistry.record(sid, {
              kind: bare === 'api_request_body' ? 'request' : 'response',
              bodyRef: bodyRef || undefined,
              inlineBody: bodyRef ? undefined : (inlineBody || undefined),
              requestId: attrStr(attrs, 'request_id', 'request.id', 'requestId') || undefined,
              spanId: (typeof r.spanId === 'string' && r.spanId ? r.spanId : attrStr(attrs, 'span_id', 'spanId')) || undefined,
              model: attrStr(attrs, 'model') || undefined,
              querySource: attrStr(attrs, 'query_source', 'query.source') || undefined,
              ts: Date.now(),
            })
          }
          continue
        }
        // 2.1.206 attaches the tool name as snake_case `tool_name` (older builds: `tool.name`).
        const logToolName = attrStr(attrs, 'tool.name', 'tool_name')
        const isCodexEvent = name.startsWith('codex.')
        const isClaudeToolResult = bare === 'tool_result' && logToolName !== ''
        // Rich Claude Code LOG events — the per-call ground truth (exact cost + skill/plugin/agent
        // attribution) that get_cost_by_cause reads. Keyed by session.id like tool_result.
        const isClaudeRichEvent = CLAUDE_RICH_LOG_EVENTS.has(bare)
        if (!isCodexEvent && !isClaudeToolResult && !isClaudeRichEvent) {
          noteDroppedLogEvent(name)
          continue
        }
        if (isCodexEvent && isCodexWebsocketSpanName(name)) continue
        let traceId: string
        let spanName: string
        if (isClaudeToolResult || isClaudeRichEvent) {
          // PREFER session.id over the record's OTLP traceId: CC 2.1.206 propagates trace context
          // on log records, but that traceId groups the events only with EACH OTHER — never with
          // the session's llm_request spans (measured 2026-07-10: a 63-event trace held 35
          // api_request + 28 tool_result and ZERO llm_request spans). session.id keying keeps all
          // of a session's rich events in ONE group — the original design intent; the propagated
          // traceId is only the fallback for records lacking the attribute.
          traceId = attrStr(attrs, 'session.id', 'session_id')
            || ((typeof r.traceId === 'string' && r.traceId) ? r.traceId : fallback)
          // Store the span name PREFIXED regardless of the wire spelling — spanSummarizer keys its
          // rich-event handling (and token dedup vs llm_request spans) on claude_code.*.
          spanName = `claude_code.${bare}`
        } else {
          traceId = (typeof r.traceId === 'string' && r.traceId)
            ? r.traceId
            : attrStr(attrs, 'conversation.id', 'conversation_id', 'session.id', 'session_id') || fallback
          spanName = name
        }
        const spanId = (typeof r.spanId === 'string' && r.spanId)
          ? r.spanId
          : attrStr(attrs, 'span_id', 'spanId') || `cl-${Math.random().toString(36).slice(2, 10)}`
        let startTime = String(r.timeUnixNano ?? r.observedTimeUnixNano ?? '0')
        let endTime = startTime
        if (startTime === '0') {
          const timestamp = attrStr(attrs, 'event.timestamp')
          const ms = timestamp ? new Date(timestamp).getTime() : 0
          if (ms > 0) {
            const endNs = String(BigInt(ms) * BigInt(1_000_000))
            const durMs = parseInt(attrStr(attrs, 'duration_ms') || '0') || 0
            endTime = endNs
            startTime = durMs > 0
              ? String(BigInt(endNs) - BigInt(durMs) * BigInt(1_000_000))
              : endNs
          }
        }
        addSpan({ traceId, spanId, name: spanName, startTime, endTime, attributes: [...attrs, { key: '_agentlens.collector_path', value: { stringValue: collectorPath } }], status: undefined })
        n++
      }
    }
  }
  return n
}

// ── SSE push ──────────────────────────────────────────────────────────────────

function safeJson(data: unknown): string {
  return JSON.stringify(data)
    .replace(/<\//g, '<\\/')
    .replace(/<!--/g, '<\\!--')
    .replace(/\$\{/g, '\\${')
}

function computeSidebarPayload(summary: ReturnType<typeof summarizeSpans>, allSpans: Span[]) {
  const sessions = summary.sessions
  // newest-first (summarizeSpans returns in arbitrary order — sort by startTime)
  const sorted = [...sessions].sort((a, b) =>
    Date.parse(b.startTime || '0') - Date.parse(a.startTime || '0')
  )
  const latest = sorted[0] ?? null

  const AGENT_ORDER = ['copilot', 'claude_code', 'codex']
  const agentSources = [...new Set(sorted.map(s => s.source).filter(Boolean))]
    .sort((a, b) => {
      const ai = AGENT_ORDER.indexOf(a), bi = AGENT_ORDER.indexOf(b)
      return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi)
    })

  // Activity: most recent span received
  let lastMs = 0
  for (const span of allSpans) {
    const ms = span.receivedAt ?? 0
    if (ms > lastMs) lastMs = ms
  }
  const isActive = lastMs > 0 && (Date.now() - lastMs) < 20_000

  // Turn input tokens for sparkline from timeline
  const turnInputTokens = latest
    ? (latest.timeline ?? [])
        .filter(e => e.type === 'llm' && (e.inputTokens ?? 0) > 0)
        .map(e => e.inputTokens ?? 0)
    : []

  // Simple burn rate estimate for active sessions
  let burnRate: { tokensPerMinute: number; costPerHour: number } | null = null
  if (latest && isActive && latest.durationMs > 10_000) {
    const totalTokens = latest.inputTokens + latest.outputTokens
    const tpm = (totalTokens / latest.durationMs) * 60_000
    burnRate = { tokensPerMinute: Math.round(tpm), costPerHour: 0 }
  }

  const avgInputTokens = sorted.length > 0
    ? sorted.reduce((s, x) => s + x.inputTokens, 0) / sorted.length : 1
  const avgOutputTokens = sorted.length > 0
    ? sorted.reduce((s, x) => s + x.outputTokens, 0) / sorted.length : 1

  const currentSession = latest ? {
    source: latest.source,
    model: latest.model || '',
    userRequest: latest.userRequest || '',
    totalLlmCalls: latest.totalLlmCalls,
    totalToolCalls: latest.totalToolCalls,
    errors: latest.errors,
    cacheHitRate: latest.cacheHitRate,
    durationMs: latest.durationMs,
    startTime: latest.startTime,
    turnInputTokens,
    inputTokens: latest.inputTokens,
    outputTokens: latest.outputTokens,
    cacheReadTokens: latest.cacheReadTokens,
    cacheCreateTokens: latest.cacheCreateTokens,
    costUsd: calcTokenCostUsd(
      Math.max(0, latest.inputTokens - latest.cacheReadTokens - latest.cacheCreateTokens),
      latest.cacheReadTokens,
      latest.cacheCreateTokens,
      latest.outputTokens,
      latest.model,
    ),
  } : null

  return { isActive, lastActivityMs: lastMs, sessionCount: sessions.length, agentSources, currentSession, burnRate, avgInputTokens, avgOutputTokens }
}

// Legacy shape kept for data the Preact dashboard still reads
function computeSidebarData(summary: ReturnType<typeof summarizeSpans>, _allSpans: Span[]) {
  const sessions = summary.sessions

  const filesSet = new Set<string>()
  let errorCount = 0
  for (const sess of sessions) {
    for (const f of sess.filesChanged) filesSet.add(f)
    errorCount += sess.errors
  }
  const cacheHitPct = sessions.length > 0
    ? Math.round(sessions.reduce((a, s) => a + s.cacheHitRate, 0) / sessions.length * 100) : 0
  const avgTurns = sessions.length > 0
    ? Math.round(sessions.reduce((a, s) => a + s.totalLlmCalls, 0) / sessions.length * 10) / 10 : 0

  const AGENT_KEY_ORDER = ['copilot', 'claude_code', 'codex']
  const agentSources = [...new Set(sessions.map(s => s.source).filter(Boolean))].sort((a, b) => {
    const ai = AGENT_KEY_ORDER.indexOf(a), bi = AGENT_KEY_ORDER.indexOf(b)
    return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi)
  })

  const totalToolCalls = sessions.reduce((s, sess) => s + sess.totalToolCalls, 0)
  const latest = sessions.length > 0 ? sessions[sessions.length - 1] : null
  const latestSession = latest ? {
    source: latest.source,
    model: latest.model || '',
    totalLlmCalls: latest.totalLlmCalls,
    totalToolCalls: latest.totalToolCalls,
    durationMs: latest.durationMs,
    errors: latest.errors,
    cacheHitRate: latest.cacheHitRate,
  } : null

  return {
    sessionCount: sessions.length,
    turnCount: sessions.reduce((s, sess) => s + sess.totalLlmCalls, 0),
    totalInputTokens: sessions.reduce((s, sess) => s + sess.inputTokens, 0),
    totalOutputTokens: sessions.reduce((s, sess) => s + sess.outputTokens, 0),
    filesChangedCount: filesSet.size,
    errors: errorCount,
    totalToolCalls,
    cacheHitPct,
    avgTurns,
    agentSources,
    latestSession,
  }
}

function computeAnalyticsData(sessions: ReturnType<typeof summarizeSpans>['sessions']) {
  const dayMap: Record<string, { totalTokens: number; outputTokens: number; cacheReadTokens: number; cacheCreateTokens: number; costUsd: number; sessionCount: number }> = {}
  for (const sess of sessions) {
    if (!sess.startTime) continue
    const d = new Date(sess.startTime)
    if (isNaN(d.getTime())) continue
    const day = d.toISOString().slice(0, 10)
    if (!dayMap[day]) dayMap[day] = { totalTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 0, costUsd: 0, sessionCount: 0 }
    const r = dayMap[day]
    r.totalTokens += sess.inputTokens
    r.outputTokens += sess.outputTokens
    r.cacheReadTokens += sess.cacheReadTokens
    r.cacheCreateTokens += sess.cacheCreateTokens
    r.sessionCount++
  }
  const dailyStats = Object.entries(dayMap).map(([day, r]) => ({ day, ...r })).sort((a, b) => a.day.localeCompare(b.day))
  const totalTokens = sessions.reduce((s, sess) => s + sess.inputTokens + sess.outputTokens, 0)
  const times = sessions.map(s => s.startTime ? new Date(s.startTime).getTime() : 0).filter(t => t > 0)
  const lifetimeStats = {
    totalSessions: sessions.length,
    totalTokens,
    totalCostUsd: 0,
    oldestSessionMs: times.length > 0 ? Math.min(...times) : 0,
    newestSessionMs: times.length > 0 ? Math.max(...times) : 0,
  }
  return { dailyStats, lifetimeStats }
}

function buildSessionSummary(): ReturnType<typeof summarizeSpans> | null {
  let summary: ReturnType<typeof summarizeSpans> | null = null
  try { summary = summarizeSpans(spans) } catch (e) { console.warn('[AgentLens] summarizeSpans error:', e) }

  // Merge log-sourced sessions; OTEL wins on ID collision.
  if (logSessions.size > 0) {
    const otelIds = new Set((summary?.sessions ?? []).map(s => s.sessionId))
    const logOnly = [...logSessions.values()].filter(s => !otelIds.has(s.sessionId))
    if (logOnly.length > 0) {
      const merged = [...logOnly, ...(summary?.sessions ?? [])]
        .sort((a, b) => Date.parse(b.startTime || '0') - Date.parse(a.startTime || '0'))
      summary = { ...(summary ?? { backgroundSpans: [], efficiency: { totalInputTokens: 0, totalOutputTokens: 0, totalLlmCalls: 0, avgInputPerCall: 0, avgTtft: 0, cacheHitRate: 0, toolDefWaste: 0, sysInstructionWaste: 0, topTokenConsumers: [] } }), sessions: merged }
    }
  }
  return summary
}

// Drop the heavy per-session detail (full timeline + per-file ops) from the inlined/broadcast
// payload — across thousands of sessions these add up to tens of MB and freeze the browser on
// first paint. Both are fetched lazily per session via /api/timeline/:id (loadSessionDetail).
function stripSessionDetail(summary: ReturnType<typeof summarizeSpans> | null): ReturnType<typeof summarizeSpans> | null {
  if (!summary) return null
  return { ...summary, sessions: summary.sessions.map(s => ({ ...s, timeline: [], fileOps: undefined, generatedFiles: undefined, generatedFilesTruncated: undefined })) }
}

function buildUpdatePayload(): string {
  const sessionSummary = buildSessionSummary()
  const stripped = stripSessionDetail(sessionSummary)
  const sidebar = sessionSummary ? computeSidebarData(sessionSummary, spans) : null
  const sidebarLive = sessionSummary ? computeSidebarPayload(sessionSummary, spans) : null
  const analyticsData = sessionSummary ? computeAnalyticsData(sessionSummary.sessions) : null
  return JSON.stringify({
    type: 'update', buildId: BUILD_ID, summary: { toolCalls: {} }, sessionSummary: stripped, sidebar, analyticsData,
    // TRDD-PJC8N1HO spec 2: collector downtime windows ride every update so the dashboard renders the
    // "offline — telemetry lost" band without a separate fetch.
    collectorGaps: getCollectorGaps(),
    ...(sidebarLive ?? {}),
  })
}

function pushUpdate() {
  const data = buildUpdatePayload()
  sseClients = sseClients.filter(client => {
    try { client.write(`data: ${data}\n\n`); return true } catch { return false }
  })
}

// TRDD-U0UYC38A — targeted live-tail push. Emitted the instant a session's .jsonl grows (the scan
// only returns sessions whose byte offset advanced), carrying just the changed cards + their ids —
// NOT a full summarizeSpans rebuild. This is what makes a jsonl-derived session feel as live as an
// OTEL one: the browser merges the card into the list and, for the FOCUSED session, invalidates its
// History/composition caches so the drill views re-fetch the newest turns sub-second. The heavier
// full-summary push stays coalesced (schedulePushUpdate) so this immediate path can't reopen the
// OOM budget the coalesce protects. Cards are stripped of their heavy timeline/fileOps (fetched
// lazily per session), exactly like the full push does.
function pushSessionChanged(cards: SessionSummaryCard[]): void {
  if (cards.length === 0 || sseClients.length === 0) return
  const stripped = cards.map(s => ({ ...s, timeline: [], fileOps: undefined }))
  const data = JSON.stringify({ type: 'sessionChanged', sessionIds: stripped.map(s => s.sessionId), cards: stripped })
  sseClients = sseClients.filter(client => {
    try { client.write(`data: ${data}\n\n`); return true } catch { return false }
  })
}

// COALESCED update — this is the OOM fix (TRDD-0KNGDFQI). pushUpdate() runs a FULL
// summarizeSpans(up to MAX_SPANS) + sidebar + analytics + JSON.stringify; calling it on EVERY
// incoming OTLP POST (firehose rate = many/sec once logs+metrics+traces+raw-bodies are all enabled)
// produced allocation churn faster than GC could reclaim → the heap filled and the process was
// OOM-killed (FATAL mark-compact) in ~40s. Debouncing to at most once per PUSH_COALESCE_MS turns N
// firehose POSTs into ONE rebuild, so the working set stays bounded and RSS plateaus. Trailing-edge
// (not leading) so a burst emits exactly one update after it settles.
const PUSH_COALESCE_MS = 1000
let pushTimer: ReturnType<typeof setTimeout> | null = null
function schedulePushUpdate() {
  if (pushTimer) return
  pushTimer = setTimeout(() => { pushTimer = null; pushUpdate() }, PUSH_COALESCE_MS)
}

// ── Dashboard HTML ────────────────────────────────────────────────────────────

function getHtml(): string {
  const sessionSummary = buildSessionSummary()
  // Strip full timeline + per-file ops before inlining — they can be many MB across sessions.
  // Both are loaded lazily via /api/timeline/:sessionId after first paint.
  const sessionSummaryJson = safeJson(stripSessionDetail(sessionSummary))
  const sidebarLive = sessionSummary ? computeSidebarPayload(sessionSummary, spans) : {
    isActive: false, lastActivityMs: 0, sessionCount: 0, agentSources: [], currentSession: null, burnRate: null,
  }
  const sidebarInitJson = safeJson(sidebarLive)

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>AgentLens</title>
  <link rel="icon" href="/mascot.png" type="image/png">
  <link rel="stylesheet" href="/dashboard.css">
  <style>
    /* ── VS Code theme variable shim ─────────────────────────────────────── */
    :root {
      --vscode-editor-background:       #1e1e1e;
      --vscode-foreground:              #cccccc;
      --vscode-panel-border:            #3e3e42;
      --vscode-textLink-foreground:     #4fc3f7;
      --vscode-descriptionForeground:   #9d9d9d;
      --vscode-list-hoverBackground:    #2a2d2e;
      --vscode-editorWidget-background: #252526;
      --vscode-testing-iconFailed:      #f44747;
      --vscode-testing-iconPassed:      #4ec994;
      --vscode-font-family:             -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
      --vscode-dropdown-background:     #3c3c3c;
      --vscode-dropdown-border:         #616161;
      --vscode-dropdown-foreground:     #f0f0f0;
      --vscode-button-background:       #0e639c;
      --vscode-button-foreground:       #ffffff;
      --vscode-button-hoverBackground:  #1177bb;
    }

    /* ── Standalone layout ───────────────────────────────────────────────── */
    html, body { height: 100%; overflow: hidden; margin: 0; padding: 0; }
    body { padding: 0; }
    #sa-wrap { display: flex; height: 100vh; width: 100vw; overflow: hidden; }

    /* ── Sidebar panel ───────────────────────────────────────────────────── */
    #sa-sidebar {
      width: 260px;
      min-width: 260px;
      background: var(--vscode-editorWidget-background);
      border-right: 1px solid var(--vscode-panel-border);
      display: flex;
      flex-direction: column;
      flex-shrink: 0;
      overflow: hidden;
      transition: width 0.15s ease, min-width 0.15s ease;
    }
    #sa-sidebar.sa-collapsed { width: 0; min-width: 0; }

    /* Sidebar content — shared CSS classes with sidebarWebview.ts */
    .sb-card { background: var(--vscode-editor-background); border: 1px solid var(--vscode-panel-border); border-radius: 4px; padding: 8px 10px; margin-bottom: 6px; }
    .sb-section-label { font-size: 10px; text-transform: uppercase; letter-spacing: 0.4px; color: var(--vscode-descriptionForeground); margin-bottom: 4px; }
    .sb-row { display: flex; align-items: center; gap: 6px; }
    .sb-dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
    .sb-dot.active { background: #56D364; animation: sbPulse 1.5s ease-in-out infinite; }
    .sb-dot.idle { background: var(--vscode-descriptionForeground); opacity: 0.5; }
    @keyframes sbPulse { 0%,100% { opacity:1;transform:scale(1); } 50% { opacity:0.5;transform:scale(1.4); } }
    .sb-status { font-size: 12px; font-weight: 600; }
    .sb-muted { color: var(--vscode-descriptionForeground); font-size: 11px; }
    .sb-prompt { font-size: 10px; color: var(--vscode-foreground); opacity: 0.8; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; margin: 3px 0 2px; font-style: italic; }
    .sb-model { font-size: 10px; color: var(--vscode-textLink-foreground); margin-bottom: 4px; }
    #sa-sidebar canvas { display: block; width: 100%; height: 80px; }
    .sb-turn-label { font-size: 10px; color: var(--vscode-descriptionForeground); margin-top: 3px; }
    .sb-burn { font-size: 12px; font-weight: 600; color: var(--vscode-charts-green, #81c784); }
    .sb-counters { display: grid; grid-template-columns: repeat(4, 1fr); gap: 4px; text-align: center; }
    .sb-counter-val { font-size: 16px; font-weight: 700; color: var(--vscode-textLink-foreground); }
    .sb-counter-key { font-size: 9px; color: var(--vscode-descriptionForeground); text-transform: uppercase; letter-spacing: 0.3px; }
.sb-footer { display: flex; align-items: center; justify-content: space-between; padding: 6px 8px 8px; font-size: 11px; color: var(--vscode-descriptionForeground); border-top: 1px solid var(--vscode-panel-border); }
#sa-toast { position:fixed; bottom:20px; left:50%; transform:translateX(-50%); background:#333; color:#fff; padding:8px 16px; border-radius:4px; font-size:12px; z-index:9999; opacity:0; transition:opacity 0.2s; pointer-events:none; white-space:nowrap; box-shadow:0 2px 8px rgba(0,0,0,0.4); }
    #sa-toast.visible { opacity:1; }

    /* ── Main panel ──────────────────────────────────────────────────────── */
    #sa-main { flex: 1; overflow-y: auto; min-width: 0; padding: 0 18px 16px; }
    #app { min-height: 100%; }
  </style>
</head>
<body>
  <script>
    console.log('[AgentLens] HTML received', Date.now());
    window.__INITIAL_TOOL_CALLS__ = {};
    window.__INITIAL_SESSION_SUMMARY__ = ${sessionSummaryJson};
    window.__MASCOT_URI__ = '/help-mascot.png';
    window.__STANDALONE__ = true;
    window.__BUILD_ID__ = ${JSON.stringify(BUILD_ID)};

    // ── Client-side search support ────────────────────────────────────────────
    var __latestSessions__ = (window.__INITIAL_SESSION_SUMMARY__ && window.__INITIAL_SESSION_SUMMARY__.sessions) || [];
    window.addEventListener('message', function(e) {
      if (e.data && e.data.type === 'update' && e.data.sessionSummary && e.data.sessionSummary.sessions) {
        __latestSessions__ = e.data.sessionSummary.sessions;
      }
    });

    var _toastTimer;
    function showToast(msg) {
      var el = document.getElementById('sa-toast');
      if (!el) { el = document.createElement('div'); el.id = 'sa-toast'; document.body.appendChild(el); }
      el.textContent = msg;
      el.classList.add('visible');
      clearTimeout(_toastTimer);
      _toastTimer = setTimeout(function() { el.classList.remove('visible'); }, 3000);
    }

    function getNotifContainer() {
      var el = document.getElementById('sa-notif-container');
      if (!el) {
        el = document.createElement('div');
        el.id = 'sa-notif-container';
        el.style.cssText = 'position:fixed;bottom:20px;right:16px;z-index:9998;display:flex;flex-direction:column;gap:8px;max-width:320px;';
        document.body.appendChild(el);
      }
      return el;
    }

    // showActionNotification(label, prompt, color, preview, secondaryAction, dismissMs)
    // secondaryAction: { label: string, onClick: function } | null — rendered before Copy Prompt
    function showActionNotification(label, prompt, color, preview, secondaryAction, dismissMs) {
      color = color || '#f6a623';
      var container = getNotifContainer();
      var notif = document.createElement('div');
      notif.style.cssText = 'background:#252526;border:1px solid #3e3e42;border-left:3px solid ' + color + ';border-radius:4px;padding:10px 12px;font-size:12px;color:#ccc;box-shadow:0 2px 8px rgba(0,0,0,0.4);';

      var header = document.createElement('div');
      header.style.cssText = 'display:flex;justify-content:space-between;align-items:flex-start;gap:8px;margin-bottom:6px;';

      var labelEl = document.createElement('span');
      labelEl.style.cssText = 'font-weight:600;color:' + color + ';line-height:1.3;';
      labelEl.textContent = label;

      var closeBtn = document.createElement('button');
      closeBtn.textContent = '×';
      closeBtn.style.cssText = 'background:none;border:none;color:#888;cursor:pointer;font-size:16px;padding:0;line-height:1;flex-shrink:0;';
      closeBtn.onclick = function() { notif.remove(); };

      header.appendChild(labelEl);
      header.appendChild(closeBtn);
      notif.appendChild(header);

      if (preview) {
        var previewEl = document.createElement('div');
        previewEl.style.cssText = 'font-size:11px;color:#999;margin-bottom:8px;line-height:1.4;max-height:56px;overflow:hidden;';
        previewEl.textContent = preview;
        notif.appendChild(previewEl);
      }

      var actions = document.createElement('div');
      actions.style.cssText = 'display:flex;gap:6px;flex-wrap:wrap;';

      if (secondaryAction) {
        var secBtn = document.createElement('button');
        secBtn.textContent = secondaryAction.label;
        secBtn.style.cssText = 'background:none;border:1px solid #555;border-radius:3px;color:#ccc;cursor:pointer;font-size:11px;padding:4px 10px;';
        secBtn.onclick = function() { secondaryAction.onClick(); notif.remove(); };
        actions.appendChild(secBtn);
      }

      var copyBtn = document.createElement('button');
      copyBtn.textContent = 'Copy Prompt';
      copyBtn.style.cssText = 'background:none;border:1px solid ' + color + ';border-radius:3px;color:' + color + ';cursor:pointer;font-size:11px;padding:4px 10px;';
      copyBtn.onclick = function() {
        navigator.clipboard.writeText(prompt).then(function() {
          copyBtn.textContent = 'Copied!';
          copyBtn.style.borderColor = '#56D364';
          copyBtn.style.color = '#56D364';
          setTimeout(function() { notif.remove(); }, 1500);
        }).catch(function() {
          showToast('Could not copy — check browser clipboard permissions');
        });
      };
      actions.appendChild(copyBtn);

      notif.appendChild(actions);
      container.appendChild(notif);
      setTimeout(function() { notif.remove(); }, dismissMs || 30000);
    }

    window.acquireVsCodeApi = function() {
      return {
        getState: function() { return null; },
        setState: function() {},
        postMessage: function(msg) {
          if (msg.type === 'confirmClear') {
            if (confirm('Clear all AgentLens data? OTEL session data is deleted permanently. AgentLens log cache is cleared and will be rebuilt from your local agent log files (the log files themselves are not deleted).')) {
              fetch('/api/clear', { method: 'POST' });
              window.dispatchEvent(new MessageEvent('message', { data: { type: 'clearAll' } }));
            }
          } else if (msg.type === 'clearAll') {
            fetch('/api/clear', { method: 'POST' });
          } else if (msg.type === 'automation' && msg.prompt) {
            // Build full prompt matching VS Code format: [label] + session ID + body
            var sessionLine = msg.sessionId ? 'Session ID: ' + msg.sessionId + '\\n' : '';
            var autoFull = '[' + (msg.label || 'Automation') + ']\\n\\n' + sessionLine + msg.prompt;
            var autoPreview = msg.prompt.length > 160 ? msg.prompt.slice(0, 160) + '…' : msg.prompt;
            var autoLabel = 'Automation: ' + (msg.label || 'Automation');
            var viewAutomations = {
              label: 'View Automations',
              onClick: function() {
                window.dispatchEvent(new MessageEvent('message', { data: { type: 'switchTab', tab: 'settings-automation' } }));
              }
            };
            if (msg.writePromptsFile) {
              fetch('/api/write-prompts-file', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ agent: msg.agent, label: msg.label, prompt: autoFull })
              }).then(function() {
                var slug = msg.agent === 'claude_code' ? 'claude' : msg.agent === 'codex' ? 'codex' : 'copilot';
                showToast('Prompt written to agentlens-prompts-' + slug + '.md');
              }).catch(function() {
                showActionNotification(autoLabel, autoFull, '#f6a623', autoPreview, viewAutomations, 30000);
              });
            } else {
              showActionNotification(autoLabel, autoFull, '#f6a623', autoPreview, viewAutomations, 30000);
            }
          } else if (msg.type === 'askAI' && msg.prompt) {
            navigator.clipboard.writeText(msg.prompt).then(function() {
              showToast('Prompt copied to clipboard');
            }).catch(function() {
              showToast('Could not copy — check browser clipboard permissions');
            });
          } else if (msg.type === 'exportSessionData' || msg.type === 'exportSessionDataRedacted') {
            var redact = msg.type === 'exportSessionDataRedacted';
            var exportIds = Array.isArray(msg.sessionIds) ? new Set(msg.sessionIds) : null;
            var exportSessions = exportIds
              ? (__latestSessions__ || []).filter(function(s) { return exportIds.has(s.sessionId); })
              : (__latestSessions__ || []);
            var exportable = exportSessions.map(function(s) {
              return {
                sessionId:         s.sessionId,
                traceId:           s.traceId,
                source:            s.source,
                model:             s.model,
                startTime:         s.startTime,
                durationMs:        s.durationMs,
                turns:             s.totalLlmCalls,
                totalToolCalls:    s.totalToolCalls,
                inputTokens:       s.inputTokens,
                outputTokens:      s.outputTokens,
                cacheReadTokens:   s.cacheReadTokens,
                cacheCreateTokens: s.cacheCreateTokens,
                cacheHitRate:      s.cacheHitRate,
                errors:            s.errors,
                outcome:           s.outcome,
                toolCounts:        s.toolCounts,
                filesRead:    redact ? (s.filesRead    || []).map(function() { return '[redacted]'; }) : s.filesRead,
                filesChanged: redact ? (s.filesChanged || []).map(function() { return '[redacted]'; }) : s.filesChanged,
                loopSignals:  s.loopSignals,
                userRequest:  redact ? '[redacted]' : (s.userRequest || null),
              };
            });
            var now = new Date();
            var pad = function(n) { return String(n).padStart(2, '0'); };
            var ts = '' + now.getFullYear() + pad(now.getMonth() + 1) + pad(now.getDate()) +
                     '_' + pad(now.getHours()) + pad(now.getMinutes()) + pad(now.getSeconds());
            var filename = (redact ? 'export_redacted' : 'export') + '_sessions_' + ts + '.json';
            var blob = new Blob([JSON.stringify(exportable, null, 2)], { type: 'application/json' });
            var url = URL.createObjectURL(blob);
            var a = document.createElement('a');
            a.href = url; a.download = filename; a.click();
            URL.revokeObjectURL(url);
            showToast('Downloaded ' + filename);
          } else if (msg.type === 'openSidebar' || msg.type === 'closeSidebar') {
            window.dispatchEvent(new CustomEvent('agentlens:sidebar', { detail: { open: msg.type === 'openSidebar' } }));
          } else if (msg.type === 'searchSessions' && msg.query) {
            var q = msg.query;
            var filtered = __latestSessions__.filter(function(s) {
              if (q.text) {
                var t = q.text.toLowerCase();
                if (!(s.userRequest || '').toLowerCase().includes(t) && !(s.model || '').toLowerCase().includes(t)) return false;
              }
              if (q.source && s.source !== q.source) return false;
              if (q.since) { var ms = s.startTime ? new Date(s.startTime).getTime() : 0; if (ms < q.since) return false; }
              if (q.until) { var ms2 = s.startTime ? new Date(s.startTime).getTime() : 0; if (ms2 > q.until) return false; }
              return true;
            });
            var dir = q.orderDir === 'ASC' ? 1 : -1;
            filtered.sort(function(a, b) {
              if (q.orderBy === 'start_time') return dir * (new Date(a.startTime).getTime() - new Date(b.startTime).getTime());
              if (q.orderBy === 'total_tokens') return dir * ((a.inputTokens + a.outputTokens) - (b.inputTokens + b.outputTokens));
              if (q.orderBy === 'duration_ms') return dir * (a.durationMs - b.durationMs);
              if (q.orderBy === 'errors') return dir * (a.errors - b.errors);
              if (q.orderBy === 'cost_usd') return 0;
              return 0;
            });
            var offset = q.offset || 0; var limit = q.limit || 50;
            var page = filtered.slice(offset, offset + limit);
            setTimeout(function() {
              window.dispatchEvent(new MessageEvent('message', {
                data: { type: 'searchResults', sessions: page, totalCount: filtered.length, offset: offset, context: msg.context || 'search' }
              }));
            }, 0);
          } else if (msg.type === 'alert' && msg.label) {
            var alertColor = msg.severity === 'error' ? '#f44747' : msg.severity === 'info' ? '#4fc3f7' : '#f6a623';
            var alertPrompt = [
              "An alert was triggered in my AI coding session. Please explain what's happening and how I should respond.",
              '',
              'Alert: ' + msg.label,
            ].concat(msg.detail ? ['Detail: ' + msg.detail] : []).join('\\n');
            showActionNotification(
              'Alert: ' + msg.label,
              alertPrompt,
              alertColor,
              msg.detail || null,
              {
                label: 'View Alerts',
                onClick: function() {
                  window.dispatchEvent(new MessageEvent('message', { data: { type: 'switchTab', tab: 'alerts' } }));
                }
              },
              30000
            );
          } else if (msg.type === 'loadSessionDetail' && msg.sessionId) {
            fetch('/api/timeline/' + encodeURIComponent(msg.sessionId))
              .then(function(r) { return r.json(); })
              .then(function(data) {
                window.dispatchEvent(new MessageEvent('message', {
                  data: { type: 'sessionDetail', sessionId: msg.sessionId, timeline: data.timeline || [], fileOps: data.fileOps || [], generatedFiles: data.generatedFiles || [], generatedFilesTruncated: !!data.generatedFilesTruncated }
                }));
              })
              .catch(function(e) { console.warn('[AgentLens] timeline fetch failed', e); });
          } else if (msg.type === 'loadGeneratedFile' && msg.path) {
            fetch('/api/generated-file?path=' + encodeURIComponent(msg.path))
              .then(function(r) { return r.json(); })
              .then(function(data) {
                window.dispatchEvent(new MessageEvent('message', {
                  data: Object.assign({ type: 'generatedFileContent', path: msg.path }, data)
                }));
              })
              .catch(function(e) { console.warn('[AgentLens] generated-file fetch failed', e); });
          } else if (msg.type === 'loadContextComposition' && msg.sessionId) {
            var _compUrl = '/api/composition/' + encodeURIComponent(msg.sessionId);
            if (msg.parentSessionId) _compUrl += '?parent=' + encodeURIComponent(msg.parentSessionId);
            fetch(_compUrl)
              .then(function(r) { return r.json(); })
              .then(function(data) {
                window.dispatchEvent(new MessageEvent('message', {
                  data: { type: 'contextComposition', sessionId: msg.sessionId, composition: data.composition || null }
                }));
              })
              .catch(function(e) { console.warn('[AgentLens] composition fetch failed', e); });
          } else if (msg.type === 'loadContextHistory' && msg.sessionId) {
            // TRDD-W0RRL2FZ: uniform history loading — the webview always posts loadContextHistory
            // (VS Code: dashboardPanel handles it; standalone: this shim proxies the existing
            // /api/history route, which resolves the logged ancestor server-side). A failed fetch
            // dispatches history:null so the UI shows its honest "no transcript" message, never a
            // perpetual spinner.
            var _histUrl = '/api/history/' + encodeURIComponent(msg.sessionId);
            if (msg.parentSessionId) _histUrl += '?parent=' + encodeURIComponent(msg.parentSessionId);
            fetch(_histUrl)
              .then(function(r) { return r.json(); })
              .then(function(data) {
                window.dispatchEvent(new MessageEvent('message', {
                  data: { type: 'contextHistory', sessionId: msg.sessionId, history: data.history || null }
                }));
              })
              .catch(function(e) {
                console.warn('[AgentLens] history fetch failed', e);
                window.dispatchEvent(new MessageEvent('message', {
                  data: { type: 'contextHistory', sessionId: msg.sessionId, history: null }
                }));
              });
          }
        }
      };
    };

    // SSE → dispatch as window message (picked up by Preact app AND sidebar handler below)
    // Falls back to polling /api/summary every 2s if EventSource fails (e.g. Safari private mode).
    var _sseOk = false;
    var _pollTimer = null;
    function _startPolling() {
      if (_pollTimer) return;
      console.warn('[AgentLens] SSE unavailable — falling back to polling');
      _pollTimer = setInterval(function() {
        fetch('/api/summary')
          .then(function(r) { return r.json(); })
          .then(function(summary) {
            window.dispatchEvent(new MessageEvent('message', {
              data: { type: 'update', sessionSummary: summary }
            }));
          })
          .catch(function(e) { console.warn('[AgentLens] poll failed', e); });
      }, 2000);
    }
    var _es = new EventSource('/events');
    _es.onopen = function() {
      console.log('[AgentLens] SSE connected', Date.now());
      _sseOk = true;
      if (_pollTimer) { clearInterval(_pollTimer); _pollTimer = null; }
    };
    _es.onmessage = function(e) {
      var data = JSON.parse(e.data);
      // Live-reload: after a rebuild+restart the reconnecting SSE carries a new build id → refresh
      // once. Guarded on __BUILD_ID__ being set and actually differing so it can never loop.
      if (data && data.buildId && window.__BUILD_ID__ && data.buildId !== window.__BUILD_ID__) {
        console.log('[AgentLens] New build detected — reloading', data.buildId);
        location.reload();
        return;
      }
      // Server-pushed burn alert (TRDD-OG9PARZQ) → render as a dashboard banner. Only SERVER alerts
      // arrive over SSE; the Preact app SENDS client-alert messages, it doesn't receive them, so
      // rendering here (not dispatching to the app) avoids a double banner.
      if (data && data.type === 'alert' && data.label) {
        var burnColor = data.severity === 'error' ? '#f44747' : data.severity === 'info' ? '#4fc3f7' : '#f6a623';
        var burnPrompt = 'AgentLens burn alert: ' + data.label + (data.detail ? '\\n' + data.detail : '');
        showActionNotification('Alert: ' + data.label, burnPrompt, burnColor, data.detail || null, {
          label: 'View Alerts',
          onClick: function() { window.dispatchEvent(new MessageEvent('message', { data: { type: 'switchTab', tab: 'alerts' } })); }
        }, 30000);
        window.dispatchEvent(new MessageEvent('message', { data: data }));
        return;
      }
      window.dispatchEvent(new MessageEvent('message', { data: data }));
    };
    _es.onerror = function() {
      if (!_sseOk) {
        // Never connected — start polling immediately
        _startPolling();
      }
      // If it was connected before, browser will auto-reconnect; don't start polling yet
    };
  </script>

  <div id="sa-wrap">
    <!-- ── Sidebar (live session monitor) ────────────────────────────────── -->
    <div id="sa-sidebar">
      <div style="flex:1;overflow-y:auto;padding:8px 8px 8px;font-family:var(--vscode-font-family);color:var(--vscode-foreground)">
        <!-- Status row -->
        <div class="sb-card" style="margin-bottom:6px">
          <div class="sb-row" style="margin-bottom:2px">
            <span class="sb-dot idle" id="sb-dot"></span>
            <span class="sb-status" id="sb-status-text">Idle</span>
            <span style="flex:1"></span>
            <span id="sb-agent" class="sb-muted" style="display:flex;align-items:center"></span>
            <span id="sb-dur" class="sb-muted"></span>
          </div>
          <div id="sb-prompt" class="sb-prompt"></div>
          <div id="sb-model" class="sb-model"></div>
          <span id="sb-ago" class="sb-muted" style="font-size:10px"></span>
        </div>

        <!-- Session block (hidden when no sessions) -->
        <div id="sb-session-block" style="display:none">

          <!-- Key counters (shown first) -->
          <div class="sb-card">
            <div class="sb-counters">
              <div>
                <div class="sb-counter-val" id="sb-turns">—</div>
                <div class="sb-counter-key">Turns</div>
              </div>
              <div>
                <div class="sb-counter-val" id="sb-tools">—</div>
                <div class="sb-counter-key">Tools</div>
              </div>
              <div>
                <div class="sb-counter-val" id="sb-errors">—</div>
                <div class="sb-counter-key">Errors</div>
              </div>
              <div>
                <div class="sb-counter-val" id="sb-cache">—</div>
                <div class="sb-counter-key">Cache</div>
              </div>
            </div>
          </div>

          <!-- Context growth sparkline -->
          <div class="sb-card">
            <div class="sb-section-label">Context Growth</div>
            <canvas id="sb-sparkline"></canvas>
            <div id="sb-turn-label" class="sb-turn-label"></div>
            <div id="sb-sparkline-waiting" class="sb-muted" style="display:none;font-size:10px;font-style:italic;padding:2px 0">Waiting for data…</div>
          </div>

          <!-- Token breakdown (input / output) -->
          <div class="sb-card" id="sb-tokens-card">
            <div class="sb-section-label">Tokens</div>
            <div id="sb-token-bars" style="margin-top:4px"></div>
            <div id="sb-token-waiting" class="sb-muted" style="display:none;font-size:10px;font-style:italic;padding:2px 0">Waiting for data…</div>
          </div>

          <!-- Estimated cost -->
          <div class="sb-card" id="sb-cost-card">
            <div class="sb-section-label">Estimated Cost</div>
            <div id="sb-cost-val" style="font-size:16px;font-weight:700;color:var(--vscode-charts-green,#81c784)">—</div>
          </div>

          <!-- Burn rate -->
          <div class="sb-card" id="sb-burn-row">
            <div class="sb-section-label">Burn Rate</div>
            <div id="sb-burn" class="sb-burn"></div>
            <div id="sb-burn-waiting" class="sb-muted" style="display:none;font-size:10px;font-style:italic">Waiting for data…</div>
          </div>

        </div>

        <!-- Empty state (shown by render() when currentSession is null) -->
        <div id="sb-empty" class="sb-muted" style="text-align:center;padding:24px 0;font-size:11px;display:none">
          No sessions recorded yet
        </div>


      </div>

      <!-- Footer -->
      <div class="sb-footer">
        <span><span id="sb-session-count">0</span> sessions stored</span>
      </div>
    </div>

    <!-- ── Main dashboard ─────────────────────────────────────────────────── -->
    <div id="sa-main">
      <div id="app"></div>
    </div>
  </div>

  <script>
    console.log('[AgentLens] Inline setup done', Date.now());
    window.onerror = function(msg, src, line, col, err) {
      console.error('[AgentLens] JS error:', msg, src + ':' + line + ':' + col, err);
      var app = document.getElementById('app');
      if (app) {
        app.style.cssText = 'padding:20px;color:red;font-family:monospace;white-space:pre-wrap';
        app.textContent = 'JS ERROR: ' + msg + ' | At: ' + src + ':' + line + ':' + col + ' | ' + (err ? err.stack : '');
      }
    };
  </script>

  <script src="/dashboard.js" onload="console.log('[AgentLens] dashboard.js loaded', Date.now())"></script>

  <script>
    // Sidebar collapse driven by dashboard toggle
    var _sidebarEl = document.getElementById('sa-sidebar');
    window.addEventListener('agentlens:sidebar', function(e) {
      _sidebarEl.classList.toggle('sa-collapsed', !e.detail.open);
    });
</script>
  <script>var __SIDEBAR_INIT__ = ${sidebarInitJson};</script>
  <script src="/sidebar.js"></script>
</body>
</html>`
}

// ── Static file serving ───────────────────────────────────────────────────────

const MIME: Record<string, string> = {
  '.css': 'text/css',
  '.js':  'application/javascript',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
}

// ── Request instrumentation + heap-pressure guard (TRDD-PJC8N1HO specs 6, 7) ────

// spec 6: wrap res so we can record method/path/status/duration/bytes/heap for EVERY request. Before
// this, the crash logs showed only span-ingestion lines and the endpoint that OOM'd the process could
// not be identified. Byte counting wraps write/end (covers JSON responses, static files, and the SSE
// stream). Logging happens on 'finish' (or 'close' for a client that hangs up mid-response).
function instrumentResponse(req: http.IncomingMessage, res: http.ServerResponse, urlPath: string): void {
  const t0 = Date.now()
  let bytes = 0
  const origWrite = res.write.bind(res)
  const origEnd = res.end.bind(res)
  const add = (chunk: unknown): void => {
    if (chunk && typeof chunk !== 'function') {
      try { bytes += Buffer.byteLength(chunk as string | Buffer) } catch { /* non-buffer arg — ignore */ }
    }
  }
  res.write = ((chunk: unknown, ...rest: unknown[]) => { add(chunk); return (origWrite as (...a: unknown[]) => boolean)(chunk, ...rest) }) as typeof res.write
  res.end = ((chunk?: unknown, ...rest: unknown[]) => { add(chunk); return (origEnd as (...a: unknown[]) => http.ServerResponse)(chunk, ...rest) }) as typeof res.end
  let logged = false
  const finish = (): void => {
    if (logged) return
    logged = true
    requestLog.record({
      ts: new Date().toISOString(), method: req.method ?? 'GET', path: urlPath,
      status: res.statusCode, durationMs: Date.now() - t0, bytes,
      heapUsedMb: process.memoryUsage().heapUsed / 1048576,
    })
  }
  res.on('finish', finish)
  res.on('close', finish)
}

// spec 7: shed a heavy request with a LOUD 503 when the heap is already over the high-water mark,
// instead of letting its allocation tip an already-near-full heap into a fatal OOM that kills the whole
// collector. Fail loud PER REQUEST, not fail dead PER PROCESS (the FAIL-FAST project rule). Returns
// true when the request was shed (caller must return immediately). The offending request is attributed
// via the request log + a stderr line, so heap-pressure sheds are visible in the crash.log-adjacent record.
function heavyGuard(res: http.ServerResponse, urlPath: string, label: string): boolean {
  const p = heapPressure()
  if (!p.over) return false
  console.warn(`[AgentLens] heap-pressure shed: ${label} ${urlPath} — heap ${p.heapUsedMb.toFixed(0)}MB ≥ hwm ${p.hwmMb.toFixed(0)}MB (limit ${p.limitMb.toFixed(0)}MB)`)
  res.writeHead(503, { 'Content-Type': 'application/json', 'Retry-After': '2' })
  res.end(JSON.stringify({
    error: 'collector under heap pressure — request shed to stay alive',
    heapUsedMb: Math.round(p.heapUsedMb), hwmMb: Math.round(p.hwmMb), limitMb: Math.round(p.limitMb),
  }))
  return true
}

// ── Durable state persistence (TRDD-PJC8N1HO spec 3) ────────────────────────────

// Strip the heavy per-session detail before persisting a log card — the timeline/fileOps are the bulk
// (full cards don't even fit in one V8 string). The stripped card powers the restored dashboard list;
// the timeline is re-parsed on demand (LogReader.reparseSession) when a session is actually drilled.
function stripCardForPersist(c: SessionSummaryCard): SessionSummaryCard {
  return { ...c, timeline: [], fileOps: undefined, backgroundSpans: [], generatedFiles: undefined, generatedFilesTruncated: undefined }
}

// Persistence of the tail offsets + stripped log cards so a restart resumes instantly.
// WHY dirty-flag + slow interval and NOT a change-triggered debounce: the previous 5s debounce
// re-fired after every scan that touched a card, fully rewriting log-sessions.json (27MB) +
// log-offsets.json (3MB) as often as every 5 seconds under live sessions — tens of GB/day of SSD
// wear, the same disease as the spans.json incident in miniature. Both files mutate in place
// (cards update), so append-only doesn't fit; the lever is CADENCE. Offsets (small, drive the
// fast restart) write every 60s when dirty; cards (large, only refresh the restored dashboard
// list) every 5 min when dirty. Shutdown flushes both, so a graceful stop loses nothing.
let offsetsDirty = false
let cardsDirty = false
function scheduleDurableSave(): void { offsetsDirty = true; cardsDirty = true }
const OFFSETS_SAVE_MS = Math.max(10_000, Number(process.env.AGENTLENS_OFFSETS_SAVE_MS) || 60_000)
const CARDS_SAVE_MS = Math.max(30_000, Number(process.env.AGENTLENS_CARDS_SAVE_MS) || 300_000)
let lastCardsSave = 0

// Byte accounting via statSync after the write — a second JSON.stringify of a 27MB object just
// to count bytes would double the serialization cost of every save.
function sizeOf(file: string): number {
  try { return fs.statSync(file).size } catch { return 0 }
}
function saveOffsetsNow(): void {
  try {
    saveLogOffsets(OFFSETS_FILE, logReader.exportFileState())
    persistStats.offsetsWrites++
    persistStats.offsetsBytes += sizeOf(OFFSETS_FILE)
  } catch (e) { console.warn('[AgentLens] Could not save log offsets:', e) }
}
function saveCardsNow(): void {
  try {
    savePersistedCards(CARDS_FILE, [...logSessions.values()].map(stripCardForPersist))
    persistStats.cardsWrites++
    persistStats.cardsBytes += sizeOf(CARDS_FILE)
    lastCardsSave = Date.now()
  } catch (e) { console.warn('[AgentLens] Could not save log cards:', e) }
}
const durableSaveTimer = setInterval(() => {
  if (offsetsDirty) { offsetsDirty = false; saveOffsetsNow() }
  if (cardsDirty && Date.now() - lastCardsSave >= CARDS_SAVE_MS) { cardsDirty = false; saveCardsNow() }
}, OFFSETS_SAVE_MS)
durableSaveTimer.unref()

// ── UI server ─────────────────────────────────────────────────────────────────

const uiServer = http.createServer((req, res) => {
  const url = (req.url ?? '/').split('?')[0]
  instrumentResponse(req, res, url)
  res.setHeader('Access-Control-Allow-Origin', '*')

  if (url === '/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    })
    res.write(':\n\n') // initial ping
    res.write(`data: ${buildUpdatePayload()}\n\n`)
    sseClients.push(res)
    req.on('close', () => { sseClients = sseClients.filter(c => c !== res) })
    return
  }

  if (req.method === 'POST' && url === '/api/import') {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf-8')) as { sessions?: unknown[] }
        if (!Array.isArray(body.sessions)) {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'sessions array required' }))
          return
        }
        const VALID_SOURCES = new Set(['copilot', 'claude_code', 'codex', 'opencode'])
        let imported = 0
        let skipped = 0
        for (const raw of body.sessions) {
          if (typeof raw !== 'object' || raw === null) continue
          const s = raw as Record<string, unknown>
          const id = typeof s['sessionId'] === 'string' ? s['sessionId'] : ''
          if (!id || !VALID_SOURCES.has(s['source'] as string)) continue
          if (logSessions.has(id)) { skipped++; continue }
          const card = buildImportCardStandalone(s)
          logSessions.set(id, card)
          imported++
        }
        pushUpdate()
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ imported, skipped, failed: 0, total: body.sessions.length }))
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: String(e) }))
      }
    })
    return
  }

  // Everything an operator needs to answer "is it healthy, what is it costing my machine?" in one
  // call — process identity, memory, span-store state, and EXACT bytes this process has written
  // (the observable that would have caught the 420GB SSD incident on day one). Consumed by
  // `agentlens-cli --status` and usable by any watchdog.
  if (req.method === 'GET' && url === '/api/server-stats') {
    const mem = process.memoryUsage()
    const heap = heapPressure()
    const p = persistStats
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({
      pid: process.pid,
      startedAt: new Date(SERVER_STARTED_AT).toISOString(),
      uptimeSec: Math.round((Date.now() - SERVER_STARTED_AT) / 1000),
      ports: { ui: UI_PORT, mcp: MCP_PORT, otlp: OTLP_PORT },
      canonical: IS_CANONICAL,
      dataDir: DATA_DIR,
      memory: { rssMb: Math.round(mem.rss / 1048576), heapUsedMb: Math.round(heap.heapUsedMb), heapLimitMb: Math.round(heap.limitMb) },
      spans: { inMemory: spans.length, cap: MAX_SPANS, pendingAppends: pendingLines.length, fileLines: fileSpanCount, fileBytes: sizeOf(DATA_FILE) },
      logSessions: logSessions.size,
      persistence: {
        ...p,
        totalBytesWritten: p.spanAppendBytes + p.spanCompactBytes + p.offsetsBytes + p.cardsBytes + p.hookEventBytes,
        files: { spans: sizeOf(DATA_FILE), offsets: sizeOf(OFFSETS_FILE), cards: sizeOf(CARDS_FILE) },
      },
      bodies: { archive: archiveDiskUsage(BODIES_ARCHIVE_DIR), lastPass: p.bodiesLastPurge },
      hookEvents: { ...hookEventsDiskUsage(HOOK_EVENTS_DIR), receivedSinceBoot: p.hookEventWrites },
      gate: {
        mode: hookRuntime.gateMode, enabled: hookRuntime.gateEnabled,
        captureEnabled: hookRuntime.captureEnabled, advisorEnabled: hookRuntime.advisorEnabled,
        checks: p.gateChecks, denies: p.gateDenies, warns: p.gateWarns, advisories: p.gateAdvisories,
      },
      // Log-event names rejected at the ingest gate since boot — a silent-drop bug (rich events
      // discarded for weeks) is exactly what this exists to make visible.
      otlpDroppedLogEvents: Object.fromEntries(droppedLogEvents),
    }))
    return
  }

  // Lifecycle hook-event ingestion (scripts/spy-agentlens.sh fire-and-forget POST). Raw payload
  // is stored verbatim; classification happens at read time so the hook script stays a dumb pipe.
  if (req.method === 'POST' && url === '/api/hook-events') {
    const chunks: Buffer[] = []
    let received = 0
    let overflowed = false
    req.on('data', (c: Buffer) => {
      received += c.length
      if (received > HOOK_EVENT_MAX_BYTES) { overflowed = true; req.destroy() }
      else chunks.push(c)
    })
    req.on('end', () => {
      if (overflowed) return // destroyed mid-stream — no response possible
      try {
        const payload = JSON.parse(Buffer.concat(chunks).toString('utf-8')) as Record<string, unknown>
        if (!payload || typeof payload !== 'object' || typeof payload.hook_event_name !== 'string' || payload.hook_event_name === '') {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'payload must be a JSON object with hook_event_name' }))
          return
        }
        if (!hookRuntime.captureEnabled) {
          // Switch off = accept and DROP (the hook script must stay a fire-and-forget dumb
          // pipe; a non-2xx here would make disabled capture look like a server outage).
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ ok: true, dropped: 'captureEnabled=false' }))
          return
        }
        const { rec, bytes } = appendHookEvent(HOOK_EVENTS_DIR, payload)
        pushRecentHookEvent(rec) // the in-memory ring the gate + check_burn_risk read
        persistStats.hookEventWrites++
        persistStats.hookEventBytes += bytes
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: true }))
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: String(e instanceof Error ? e.message : e) }))
      }
    })
    return
  }

  if (req.method === 'GET' && url === '/api/hook-events') {
    const rawUrl = req.url ?? ''
    const qIdx = rawUrl.indexOf('?')
    const q = new URLSearchParams(qIdx >= 0 ? rawUrl.slice(qIdx + 1) : '')
    const num = (k: string): number | undefined => {
      const v = q.get(k)
      return v !== null && v !== '' && Number.isFinite(Number(v)) ? Number(v) : undefined
    }
    const events = readHookEvents(HOOK_EVENTS_DIR, {
      session: q.get('session') ?? undefined,
      ev: q.get('ev') ?? undefined,
      sinceMs: num('since'),
      untilMs: num('until'),
      limit: num('limit'),
    })
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ count: events.length, events }))
    return
  }

  // Realtime hook switches: read/change the running hooks' behavior for EVERY session at once
  // (the registrations are static; the server is the decision point — see hookRuntimeConfig).
  if (req.method === 'GET' && url === '/api/hook-config') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ config: hookRuntime, file: HOOK_CONFIG_FILE }))
    return
  }
  if (req.method === 'POST' && url === '/api/hook-config') {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => { if (chunks.reduce((n, b) => n + b.length, 0) < 8192) chunks.push(c) })
    req.on('end', () => {
      try {
        const patch = JSON.parse(Buffer.concat(chunks).toString('utf-8')) as Record<string, unknown>
        hookRuntime = saveHookRuntimeConfig(HOOK_CONFIG_FILE, hookRuntime, patch)
        console.log(`[AgentLens] hook config updated: gate=${hookRuntime.gateEnabled ? hookRuntime.gateMode : 'off'} capture=${hookRuntime.captureEnabled} advisor=${hookRuntime.advisorEnabled}`)
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ config: hookRuntime, applied: true }))
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: String(e instanceof Error ? e.message : e) }))
      }
    })
    return
  }

  // REST fast path for realtime risk checks (TRDD-9CNHP8CN): `--risk` / `--guard` hit this
  // instead of the MCP tool — no MCP session handshake, no lean shaping (the FULL risk list;
  // a capped list once hid the 6th risk from a naive caller). Same in-memory feeds as the gate.
  if (req.method === 'GET' && url === '/api/burn-risk') {
    try {
      // Before the first 4s tick (freshly booted server only), compute once inline.
      if (lastBurnStatus === null) {
        try {
          const { sessions, events, now } = gatherBurn()
          lastBurnStatus = computeBurnStatus(events, sessions, burnConfig, now)
        } catch { /* stays null — checkBurnRisk reports the feed as absent */ }
      }
      const report = checkBurnRisk({
        burnStatus: lastBurnStatus,
        recentEvents: recentHookEvents,
        bodiesActivity: bodiesActivityReport(),
      })
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(report))
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: String(e instanceof Error ? e.message : e) }))
    }
    return
  }

  // Agent-launch burn gate (TRDD-GOD0108C) — called by scripts/spy-agentlens-gate.sh from
  // PreToolUse/PostToolUse hooks matched on Agent|Task|Workflow. CONTRACT: the response body
  // IS the hook's stdout — 204/empty means "print nothing" (allow). Every failure path
  // returns an empty 204: a gate that can error a launch is worse than no gate (fail-open).
  if (req.method === 'POST' && url === '/api/agent-gate') {
    const chunks: Buffer[] = []
    let received = 0
    let overflowed = false
    req.on('data', (c: Buffer) => {
      received += c.length
      // 1MB cap: PreToolUse payloads carry the agent prompt, which can be tens of KB — but
      // a megabyte-scale body is a bug, and the gate must stay cheap.
      if (received > 1_048_576) { overflowed = true; req.destroy() }
      else chunks.push(c)
    })
    req.on('end', () => {
      if (overflowed) return
      try {
        const p = JSON.parse(Buffer.concat(chunks).toString('utf-8')) as Record<string, unknown>
        const now = Date.now()
        const sessionId = typeof p.session_id === 'string' ? p.session_id : 'unknown'
        const transcriptPath = typeof p.transcript_path === 'string' ? p.transcript_path : null
        // Real parent context (tokens from the transcript's last usage) + cache warmth (mtime).
        const parent = transcriptPath ? readTranscriptContext(transcriptPath, now) : { contextTokens: null, idleMs: null }
        const state = buildGateState(now, parent)
        persistStats.gateChecks++

        if (p.hook_event_name === 'PostToolUse') {
          if (!hookRuntime.advisorEnabled) { res.writeHead(204); res.end(); return }
          // In-band advisory to the MODEL after an agent wave — deduped per session+risk.
          const adv = buildAdvisory(state)
          if (adv) {
            const key = `${sessionId}:${adv.code}`
            const last = advisoryIssued.get(key) ?? 0
            if (now - last > 600_000) {
              advisoryIssued.set(key, now)
              if (advisoryIssued.size > 200) {
                // Prune the oldest half so a long-lived server never grows this unbounded.
                for (const [k, v] of [...advisoryIssued.entries()].sort((a, b) => a[1] - b[1]).slice(0, 100)) {
                  if (v <= now) advisoryIssued.delete(k)
                }
              }
              persistStats.gateAdvisories++
              pushBurnSse({ type: 'alert', label: `burn advisory (${adv.code})`, detail: adv.text, severity: 'warning' })
              res.writeHead(200, { 'Content-Type': 'application/json' })
              res.end(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: adv.text } }))
              return
            }
          }
          res.writeHead(204)
          res.end()
          return
        }

        // PreToolUse (default): decide before the launch happens.
        if (!hookRuntime.gateEnabled) { res.writeHead(204); res.end(); return }
        const d = evaluateAgentGate((p.tool_input ?? null) as Record<string, unknown> | null, state)
        if (d.decision === 'deny') {
          persistStats.gateDenies++
          // Mirror onto the dashboard's SSE alert channel — the notification panel shows
          // gate interventions live, same surface as the burn alerts.
          pushBurnSse({ type: 'alert', label: `burn-gate DENY (${d.code})`, detail: d.reason ?? '', severity: 'error' })
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({
            hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: d.reason },
            systemMessage: `[agentlens burn-gate] blocked an agent launch (${d.code}). The reason went to the agent so it can adapt; disable/downgrade in realtime: agentlens-cli --hooks gate=off|warn.`,
          }))
          return
        }
        if (d.decision === 'warn') {
          persistStats.gateWarns++
          pushBurnSse({ type: 'alert', label: `burn-gate warning (${d.code})`, detail: d.reason ?? '', severity: 'warning' })
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ systemMessage: d.reason }))
          return
        }
        res.writeHead(204)
        res.end()
      } catch {
        try { res.writeHead(204); res.end() } catch { /* socket already gone */ }
      }
    })
    return
  }

  // Archive operations (agentlens-cli --export-bodies / --purge-bodies). They live on the server
  // so the WAD format has exactly ONE implementation (src/bodyArchive.ts) — no CLI-side reader
  // to drift out of sync with the writer.
  if (req.method === 'POST' && url === '/api/bodies/export') {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf-8')) as { destDir?: string; sinceMs?: number; untilMs?: number }
        const destDir = body.destDir
        if (!destDir || !path.isAbsolute(destDir)) {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'destDir (absolute path) is required' }))
          return
        }
        if (path.resolve(destDir).startsWith(path.resolve(BODIES_ARCHIVE_DIR))) {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'destDir must not be inside the archive itself' }))
          return
        }
        const since = typeof body.sinceMs === 'number' ? body.sinceMs : 0
        const until = typeof body.untilMs === 'number' ? body.untilMs : Infinity
        const r = extractArchive(BODIES_ARCHIVE_DIR, destDir, e => e.mtimeMs >= since && e.mtimeMs <= until)
        console.log(`[AgentLens] bodies export: ${r.files} file(s), ${(r.bytes / 1048576).toFixed(1)}MB → ${destDir}`)
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ...r, destDir }))
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: String(e instanceof Error ? e.message : e) }))
      }
    })
    return
  }

  if (req.method === 'POST' && url === '/api/bodies/purge') {
    try {
      // Explicit destructive op from the CLI: delete EVERY archive volume. The live 72h window is
      // untouched (it regenerates hourly into the archive anyway); automatic ageing is handled by
      // the retention pass, so this endpoint is only for a deliberate manual reclaim.
      const usage = archiveDiskUsage(BODIES_ARCHIVE_DIR)
      let removed = 0
      for (const f of fs.existsSync(BODIES_ARCHIVE_DIR) ? fs.readdirSync(BODIES_ARCHIVE_DIR) : []) {
        if (!/^bodies-\d{4}-\d{2}\.wad(\.idx)?$/.test(f)) continue
        try { fs.unlinkSync(path.join(BODIES_ARCHIVE_DIR, f)); removed++ } catch { /* ignore */ }
      }
      console.log(`[AgentLens] bodies archive purged: ${usage.entries} lump(s), ${(usage.bytes / 1024 ** 3).toFixed(2)}GB freed`)
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ removedFiles: removed, freedBytes: usage.bytes, lumps: usage.entries }))
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: String(e instanceof Error ? e.message : e) }))
    }
    return
  }

  if (req.method === 'POST' && url === '/api/clear') {
    spans = []
    logSessions.clear()
    logReader.clearFileState()
    clearPersistedSpans()
    pushUpdate()          // send cleared state to clients immediately
    res.writeHead(200); res.end()
    // Re-ingest after the response is sent so the client sees the cleared state first.
    setImmediate(() => runLogScan())
    return
  }

  if (req.method === 'POST' && url === '/api/write-prompts-file') {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      try {
        const { agent, label, prompt } = JSON.parse(Buffer.concat(chunks).toString('utf-8')) as { agent: string; label: string; prompt: string }
        const agentSlug = agent === 'claude_code' ? 'claude' : agent === 'codex' ? 'codex' : 'copilot'
        const agentName = agent === 'claude_code' ? 'Claude' : agent === 'codex' ? 'Codex' : 'Copilot'
        const filename = `agentlens-prompts-${agentSlug}.md`
        const filePath = path.join(process.cwd(), filename)
        const timestamp = new Date().toISOString().replace('T', ' ').slice(0, 19)
        const entry = `## ${timestamp} — ${label}\n\n${prompt}\n\n---\n\n`
        let existing = ''
        try { existing = fs.readFileSync(filePath, 'utf-8') } catch { /* new file */ }
        const content = existing ? existing + entry : `# AgentLens Prompts — ${agentName}\n\n${entry}`
        fs.writeFileSync(filePath, content, 'utf-8')
        console.log(`[AgentLens] Prompt written to ${filePath}`)
      } catch (e) {
        console.warn('[AgentLens] write-prompts-file error:', e)
      }
      res.writeHead(200); res.end()
    })
    return
  }

  if (req.method === 'GET' && url?.startsWith('/api/instruction-suggestions')) {
    const parsed = new URL(url, 'http://localhost')
    const workspace = parsed.searchParams.get('workspace')?.trim()
    if (!workspace) {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'workspace query param is required' }))
      return
    }
    const sessions = (buildSessionSummary()?.sessions ?? [])
      .filter(s => (s.workspace ?? '') === workspace || s.workspace?.startsWith(workspace))
    const { readAllInstructionContent } = require('../src/instructionFiles') as typeof import('../src/instructionFiles')
    const existingText = readAllInstructionContent(workspace)
    const suggestions = generateSuggestions(sessions, existingText)
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(suggestions))
    return
  }

  if (req.method === 'GET' && url?.startsWith('/api/instruction-files')) {
    const parsed = new URL(url, 'http://localhost')
    const workspace = parsed.searchParams.get('workspace')?.trim()
    if (!workspace) {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'workspace query param is required' }))
      return
    }
    const files = detectInstructionFiles(workspace)
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(files))
    return
  }

  if (req.method === 'POST' && url === '/api/instructions/apply') {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      try {
        const { workspace, targetFile, appliedText, id } = JSON.parse(Buffer.concat(chunks).toString('utf-8')) as {
          workspace: string; targetFile: string; appliedText: string; id: string
        }
        if (!workspace || !targetFile || !appliedText || !id) {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'workspace, targetFile, appliedText, and id are required' }))
          return
        }
        const absPath = path.join(workspace, targetFile)
        appendSuggestion(absPath, appliedText, id)
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: true }))
      } catch (e) {
        console.warn('[AgentLens] /api/instructions/apply error:', e)
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: String(e) }))
      }
    })
    return
  }

  if (req.method === 'POST' && url === '/action') {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf-8')) as { type?: string }
        if (body.type === 'clearAll') {
          spans = []
          clearPersistedSpans()
          pushUpdate()
        }
      } catch (e) { console.warn('[AgentLens] Malformed /action body:', e) }
      res.writeHead(200); res.end()
    })
    return
  }

  if (req.method === 'GET' && url === '/api/summary') {
    const summary = buildSessionSummary()
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(stripSessionDetail(summary)))
    return
  }

  // TRDD-OG9PARZQ: realtime burn status (burn rate + window budget + alerts) for the dashboard and any
  // headless consumer. Same object get_burn_status returns over MCP.
  if (req.method === 'GET' && url === '/api/burn-status') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    try {
      const { sessions, events, now } = gatherBurn()
      res.end(JSON.stringify(enrichBurnStatus(computeBurnStatus(events, sessions, burnConfig, now))))
    } catch (e) {
      res.end(JSON.stringify({ error: String(e) }))
    }
    return
  }

  // TRDD-U0UYC38A: live-tail proof. `incrementalReads` counts changed logs re-parsed by tailing
  // only their appended bytes; `fullReads` counts from-0 (cold-start/fallback) parses. Appending to
  // a live session must bump incrementalReads while fullReads stays put — the "no full-file rescans
  // on each append" acceptance check.
  if (req.method === 'GET' && url === '/api/debug/log-scan-stats') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(logReader.getLogScanStats()))
    return
  }

  // spec 6: recent request log (ring buffer) — post-mortem attribution of a crash/pressure event.
  if (req.method === 'GET' && url === '/api/debug/requests') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ heap: heapPressure(), requests: requestLog.recent(200) }))
    return
  }

  // spec 2: collector downtime windows (also carried on the SSE update payload + get_recent_sessions).
  if (req.method === 'GET' && url === '/api/collector-gaps') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ collectorGaps: getCollectorGaps() }))
    return
  }

  if (req.method === 'GET' && url?.startsWith('/api/timeline/')) {
    const sessionId = decodeURIComponent(url.slice('/api/timeline/'.length))
    const summary = buildSessionSummary()
    let session = summary?.sessions.find(s => s.sessionId === sessionId) ?? null
    // TRDD-PJC8N1HO spec 3: a card RESTORED (stripped) from disk on startup has an empty timeline (its
    // file was skipped by the offset resume). When such a card is actually drilled, re-parse its ONE
    // file on demand to rebuild the timeline, then cache the full card in logSessions for next time.
    if (session && (session.timeline?.length ?? 0) === 0 && logSessions.has(sessionId)) {
      try {
        const reparsed = logReader.reparseSession(sessionId)
        if (reparsed) {
          statuslineReader.overlay(reparsed.card)
          logSessions.set(reparsed.card.sessionId, reparsed.card)
          session = reparsed.card
        }
      } catch { /* on-demand rebuild is best-effort — fall back to the stripped card's empty timeline */ }
    }
    res.writeHead(200, { 'Content-Type': 'application/json' })
    // TRDD-ZS1GDXVY: generatedFiles (session-level group + truncation flag) rides the lazy timeline
    // payload, not the bulk summary — stripSessionDetail drops it from /api/summary to keep it light.
    res.end(JSON.stringify({
      timeline: session?.timeline ?? [],
      fileOps: session?.fileOps ?? [],
      generatedFiles: session?.generatedFiles ?? [],
      generatedFilesTruncated: session?.generatedFilesTruncated ?? false,
    }))
    return
  }

  // TRDD-ZS1GDXVY: lazy content fetch for one generated/output file. Serves ONLY files under a Claude
  // scratch tree (isClaudeScratchPath) so this can never be turned into an arbitrary-file reader.
  // Capped at 200KB with an explicit truncation flag; a deleted file returns exists:false (never a
  // silent null). Localhost-only server, so returning local absolute-path content is in-scope.
  if (req.method === 'GET' && url === '/api/generated-file') {
    const rawUrl = req.url ?? ''
    const qIdx = rawUrl.indexOf('?')
    const filePath = qIdx >= 0 ? new URLSearchParams(rawUrl.slice(qIdx + 1)).get('path') ?? '' : ''
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(readScratchFile(filePath)))
    return
  }

  if (req.method === 'GET' && url?.startsWith('/api/composition/')) {
    // spec 7: shed under heap pressure rather than let a big reconstruction tip the heap into an OOM.
    if (heavyGuard(res, url, 'composition')) return
    // `url` has the query stripped (L1144); read the raw req.url for the ?parent= param.
    const sessionId = decodeURIComponent(url.slice('/api/composition/'.length))
    // A fork/sub-agent card carries parentSessionId (?parent=) — the parser falls back to the
    // parent's .jsonl when the fork has no own log, so its inherited context still drills.
    const rawUrl = req.url ?? ''
    const qIdx = rawUrl.indexOf('?')
    const parentHint = qIdx >= 0
      ? new URLSearchParams(rawUrl.slice(qIdx + 1)).get('parent') ?? undefined
      : undefined
    // Resolve the nearest ANCESTOR that actually has a log: the immediate parent hint may itself be a
    // logless sub-agent (agent-… → agent-… → real session), so walk the whole chain rather than
    // dead-ending after one hop. The graph comes from the session summary.
    const compSessions = buildSessionSummary()?.sessions ?? []
    const parentOf = (id: string): string | undefined => compSessions.find(s => s.sessionId === id)?.parentSessionId
    // Prefer the nearest LOGGED ancestor (drillable). If none has a log, still pass the immediate
    // parent so the parser returns an honest empty-with-reconstructedFrom composition — the UI then
    // shows "transcript lives in parent <id>" instead of a perpetual loading spinner.
    const parentSessionId = resolveLoggedAncestor(sessionId, parentOf) ?? parentOf(sessionId) ?? parentHint
    // Parse the raw .jsonl on demand — heavy work stays server-side, only the capped per-turn
    // summary crosses to the browser. null = no local Claude log for this session and no parent.
    buildContextComposition(sessionId, parentSessionId)
      .then(composition => {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ composition }))
      })
      .catch(e => {
        console.warn('[AgentLens] composition parse failed', e)
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ composition: null }))
      })
    return
  }

  if (req.method === 'GET' && url?.startsWith('/api/history/')) {
    // P8: full per-step context history (every block drillable to actual text + per-step diff).
    // Same ?parent= + nearest-logged-ancestor fallback as /api/composition so a fork/sub-agent
    // reconstructs from its parent transcript. The reconstruction carries the FULL block text, so a
    // huge session can be large — the browser drills progressively; this route returns the whole
    // reconstruction and the client renders lazily. null = no local Claude log and no parent.
    if (heavyGuard(res, url, 'history')) return
    const sessionId = decodeURIComponent(url.slice('/api/history/'.length))
    const rawUrl = req.url ?? ''
    const qIdx = rawUrl.indexOf('?')
    const parentHint = qIdx >= 0 ? new URLSearchParams(rawUrl.slice(qIdx + 1)).get('parent') ?? undefined : undefined
    const histSessions = buildSessionSummary()?.sessions ?? []
    const parentOf = (id: string): string | undefined => histSessions.find(s => s.sessionId === id)?.parentSessionId
    const parentSessionId = resolveLoggedAncestor(sessionId, parentOf) ?? parentOf(sessionId) ?? parentHint
    buildContextHistory(sessionId, parentSessionId)
      .then(history => {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ history }))
      })
      .catch(e => {
        console.warn('[AgentLens] history parse failed', e)
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ history: null }))
      })
    return
  }

  if (req.method === 'GET' && url?.startsWith('/api/callcontext/')) {
    // TRDD-ICHAVFCS: the full literal context of ONE llm call, reconstructed from the raw OTEL request
    // body captured via OTEL_LOG_RAW_API_BODIES. Path: /api/callcontext/:sessionId/:requestId or
    // /api/callcontext/:sessionId?span=:spanId. callContext=null → no raw body captured for that call
    // (the client renders an honest "not captured" note, never a spinner). `url` is the query-stripped
    // pathname; the ?span= hint is read from the raw req.url.
    if (heavyGuard(res, url, 'callcontext')) return
    const rest = url.slice('/api/callcontext/'.length)
    const parts = rest.split('/')
    const sessionId = decodeURIComponent(parts[0] ?? '')
    const requestId = parts[1] ? decodeURIComponent(parts[1]) : undefined
    const rawUrl = req.url ?? ''
    const qIdx = rawUrl.indexOf('?')
    const spanId = qIdx >= 0 ? new URLSearchParams(rawUrl.slice(qIdx + 1)).get('span') ?? undefined : undefined
    resolveCallContext(sessionId, { requestId, spanId })
      .then(callContext => {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ callContext }))
      })
      .catch(e => {
        console.warn('[AgentLens] callcontext build failed', e)
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ callContext: null }))
      })
    return
  }

  // TRDD-CTXQUERY (dashboard piece 1): the LAZY OTEL-raw-body composition summary for ONE session —
  // the peak-call block-type split (the breakdown bar) + the top resident (eviction-candidate) blobs,
  // each with a sample (turn, blockIndex) so the UI can drill to real content. Parses on demand from
  // the live callBodyRegistry (never a background sweep) and LRU-caches; a session with no captured
  // raw bodies returns an honest empty summary with a coverageNote, never a spinner.
  if (req.method === 'GET' && url?.startsWith('/api/composition-index/')) {
    if (heavyGuard(res, url, 'composition-index')) return
    const sessionId = decodeURIComponent(url.slice('/api/composition-index/'.length))
    compositionIndex.sessionCompositionSummary(sessionId, compositionProjectResolver())
      .then(summary => {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ summary }))
      })
      .catch(e => {
        console.warn('[AgentLens] composition-index build failed', e)
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ summary: null }))
      })
    return
  }

  // TRDD-CTXQUERY (dashboard piece 1): drill ONE block to its real content. Path:
  // /api/block-content/:sessionId/:turn/:blockIndex(?full=1). An IMAGE block returns metadata + a
  // body-file ref ONLY — never the base64 bytes (pointer-only, mirrors get_block_content).
  if (req.method === 'GET' && url?.startsWith('/api/block-content/')) {
    if (heavyGuard(res, url, 'block-content')) return
    const parts = url.slice('/api/block-content/'.length).split('/')
    const sessionId = decodeURIComponent(parts[0] ?? '')
    const turn = Number(parts[1])
    const blockIndex = Number(parts[2])
    const rawUrl = req.url ?? ''
    const qIdx = rawUrl.indexOf('?')
    const full = qIdx >= 0 && new URLSearchParams(rawUrl.slice(qIdx + 1)).get('full') === '1'
    if (!sessionId || !Number.isFinite(turn) || !Number.isFinite(blockIndex)) {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ block: null, error: 'bad sessionId/turn/blockIndex' }))
      return
    }
    compositionIndex.getBlockContent(sessionId, turn, blockIndex, { full })
      .then(block => {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ block }))
      })
      .catch(e => {
        console.warn('[AgentLens] block-content read failed', e)
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ block: null }))
      })
    return
  }

  if (url === '/' || url === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html' })
    res.end(getHtml())
    return
  }

  const filePath = path.join(mediaDir, url)
  const ext = path.extname(filePath)
  const mime = MIME[ext]
  if (mime && fs.existsSync(filePath) && filePath.startsWith(mediaDir)) {
    res.writeHead(200, { 'Content-Type': mime })
    fs.createReadStream(filePath).pipe(res)
    return
  }

  res.writeHead(404); res.end('Not found')
})

// ── OTLP server ───────────────────────────────────────────────────────────────

const otlpServer = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/agentlens/standalone') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ agentlens: true, kind: 'standalone' }))
    return
  }
  if (req.method !== 'POST') { res.writeHead(200); res.end(); return }
  const chunks: Buffer[] = []
  req.on('data', (c: Buffer) => chunks.push(c))
  req.on('end', () => {
    try {
      const payload = JSON.parse(Buffer.concat(chunks).toString('utf-8'))
      const kind = classifyOtlpPayload(payload)
      if (req.url === '/v1/traces' || kind === 'traces') {
        const { count, agent } = processTraces(payload, req.url ?? '/v1/traces')
        if (count > 0) console.log(`[AgentLens] Ingested ${count} span${count !== 1 ? 's' : ''} (${agent})`)
      } else if (req.url === '/v1/logs' || kind === 'logs') {
        const n = processLogs(payload, req.url ?? '/v1/logs')
        if (n > 0) console.log(`[AgentLens] ${n} log event${n !== 1 ? 's' : ''} ingested`)
      } else if (kind === 'metrics' || req.url === '/v1/metrics') {
        // Metrics are accepted so OTLP exporters do not retry, but AgentLens does not display them.
      } else {
        console.warn(`[AgentLens] ignored POST ${req.url ?? '/'}: unrecognized OTLP JSON payload`)
      }
      schedulePushUpdate()
      // Persistence is handled by the interval append-flush — no per-request save. A per-request
      // full-store rewrite here is what destroyed 420GB of SSD in 4 hours; never reintroduce it.
    } catch (e) {
      console.error('[AgentLens] Parse error:', e)
    }
    res.writeHead(200); res.end()
  })
})

// ── Start ─────────────────────────────────────────────────────────────────────

otlpServer.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`[AgentLens] Port ${OTLP_PORT} (OTLP) already in use — stop the process using it or set OTLP_PORT=<other> to use a different port.`)
    process.exit(1)
  }
  console.error('[AgentLens] OTLP server error:', err)
})

// Auto-configure Claude Code (full telemetry), Codex, and Copilot to point at this collector.
async function applyAutoConfig(): Promise<void> {
  // 1) FULL reversible telemetry env FIRST — it must record the TRUE prior state of
  //    ~/.claude/settings.json before anything else runs. Every settings.json write below
  //    goes through the transactional editor (scripts/safe_config_edit.py), sequentially,
  //    under its cross-process lock. Opt out with AGENTLENS_NO_TELEMETRY_CONFIG=1.
  //
  //    CANONICAL-INSTANCE GATE: only an instance listening on the DEFAULT OTLP port (4318) may
  //    write the GLOBAL ~/.claude/settings.json. Without this gate, any isolated-port instance
  //    (test runs, headless proofs, a second dev server) would "repair" the global
  //    OTEL_EXPORTER_OTLP_ENDPOINT to point at ITS OWN ephemeral port — observed 2026-07-07:
  //    a headless test on port 4387 silently repointed every new Claude Code session's
  //    telemetry at a dead port. Override for a deliberately non-default deployment with
  //    AGENTLENS_TELEMETRY_CONFIG=1 (explicit opt-IN beats an implicit hijack).
  const canonicalInstance = OTLP_PORT === 4318 || process.env.AGENTLENS_TELEMETRY_CONFIG === '1'
  // BOTH gates must cover BOTH writers (early return, not else-if). The legacy per-agent config
  // below ALSO mutates the global ~/.claude/settings.json, ~/.codex/config.toml and the VS Code
  // user settings with the CURRENT OTLP_PORT — when only step 1 was gated (observed 2026-07-07,
  // TRDD-W0RRL2FZ verification), an isolated test server on port 14319 sailed past the gate via
  // step 2 and silently repointed all three agents' telemetry endpoints at its ephemeral port.
  if (process.env.AGENTLENS_NO_TELEMETRY_CONFIG === '1') {
    console.log('[AgentLens] AGENTLENS_NO_TELEMETRY_CONFIG=1 — skipping automatic telemetry config.')
    return
  }
  if (!canonicalInstance) {
    console.log(`[AgentLens] Non-default OTLP port ${OTLP_PORT} — NOT touching the global telemetry config (set AGENTLENS_TELEMETRY_CONFIG=1 to force).`)
    return
  }
  try {
    const r = await ensureTelemetryConfig({ otlpPort: OTLP_PORT })
    if (r.changed) {
      console.log(`[AgentLens] Full telemetry config applied → ${r.settingsPath} (${r.added.length} added, ${r.overrode.length} overridden${r.backupPath ? `; backup ${r.backupPath}` : ''})`)
      console.log('[AgentLens] ⚠ Restart your Claude Code sessions for telemetry to take effect.')
    } else {
      console.log('[AgentLens] Full telemetry config already in place.')
    }
    // The automation Stop hook shares the same owning module + transactional editor as the
    // env keys, so ~/.claude/settings.json has exactly ONE write path — sequential, locked.
    const hook = await ensureAgentLensStopHook({ otlpPort: OTLP_PORT })
    if (hook.changed) {
      console.log('[AgentLens] Claude Code Stop hook installed — restart Claude Code to activate automation.')
    }
  } catch (e) {
    // Fail-safe at the server boundary: a bad settings.json shouldn't stop the dashboard —
    // the editor REFUSED and left the file untouched; we report and move on.
    console.warn(`[AgentLens] Could not apply telemetry config: ${e instanceof Error ? e.message : String(e)}`)
  }

  // 2) Then the OTHER agents' auto-config (Codex + Copilot) — also through the transactional
  //    editor (see autoConfigNode.ts), and only ever on the canonical instance per the gates.
  await applyOtherAgentsConfig()
}

// Codex + Copilot auto-config. Split out of applyAutoConfig so each concern stays readable.
// (The Claude Code writer that used to live here was DELETED after it wiped a user's
// settings.json on 2026-07-07 — Claude Code config is owned by src/telemetryConfig.ts.)
async function applyOtherAgentsConfig(): Promise<void> {
  try {
    const [codexResult, copilotResults] = await Promise.all([
      autoConfigureCodex(OTLP_PORT),
      autoConfigureCopilotStandalone(OTLP_PORT),
    ])
    if (codexResult.error) {
      console.warn(`[AgentLens] Could not auto-configure Codex: ${codexResult.error}`)
    } else if (codexResult.changed) {
      console.log(`[AgentLens] Codex configured — restart Codex in your terminal to activate tracing`)
    }
    const copilotChanged = copilotResults.filter(r => r.changed)
    const copilotErrors  = copilotResults.filter(r => r.error)
    if (copilotChanged.length > 0) {
      console.log(`[AgentLens] Copilot configured — reload VS Code window to activate tracing (Ctrl+Shift+P → "Reload Window")`)
    }
    for (const r of copilotErrors) {
      console.warn(`[AgentLens] Could not auto-configure Copilot: ${r.error}`)
    }
  } catch (e) {
    console.warn('[AgentLens] Auto-configure error:', e)
  }
}
applyAutoConfig()

otlpServer.listen(OTLP_PORT, BIND_HOST, () => {
  console.log(`[AgentLens] OTLP receiver → http://localhost:${OTLP_PORT}`)
})

uiServer.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`[AgentLens] Port ${UI_PORT} (UI) already in use — set UI_PORT=<other> to use a different port.`)
    process.exit(1)
  }
  console.error('[AgentLens] UI server error:', err)
})

uiServer.listen(UI_PORT, BIND_HOST, () => {
  const url = `http://localhost:${UI_PORT}`
  console.log(`[AgentLens] Dashboard      → ${url}`)
  console.log(`[AgentLens] MCP server     → http://localhost:${MCP_PORT}/mcp`)

  // Browser opening is OPT-IN ONLY (AGENTLENS_OPEN_BROWSER=1 or --open), matching
  // scripts/dev-server.js. It used to fire unconditionally, which threw a Safari window in the
  // user's face on EVERY server restart — dev/agent restarts are frequent and headless
  // (dev-browser) is the debugging path, so a surprise foreground browser is pure noise.
  if (process.env.AGENTLENS_OPEN_BROWSER === '1' || process.argv.includes('--open')) {
    const cmd = process.platform === 'darwin' ? `open "${url}"`
              : process.platform === 'win32'  ? `start "" "${url}"`
              : `xdg-open "${url}"`
    exec(cmd, err => { if (err) console.log(`\nOpen ${url} in your browser\n`) })
  }

  // Start log ingestion after the server is ready
  startLogIngestion()
})

// ── Graceful shutdown — flush data before exit ────────────────────────────────

function shutdown() {
  clearInterval(spanFlushTimer)
  clearInterval(durableSaveTimer)
  // TRDD-PJC8N1HO spec 4: atomic spans write. spec 3: flush offsets + stripped cards so the next start
  // resumes instantly. spec 2: record the graceful stop so the gap after it reads as a clean shutdown,
  // not a crash. All best-effort — a shutdown must never hang on a failed write.
  // One full NDJSON rewrite here is the compaction the append-only format defers to shutdown.
  try { atomicWriteFileSync(DATA_FILE, spansToNdjson(spans)); console.log(`\n[AgentLens] Saved ${spans.length} spans to ${DATA_FILE}`) } catch { /* ignore */ }
  try { saveOffsetsNow() } catch { /* ignore */ }
  try { saveCardsNow() } catch { /* ignore */ }
  try { recordCollectorStop(LIFECYCLE_FILE, lifecycle) } catch { /* ignore */ }
  if (IS_CANONICAL) { try { fs.unlinkSync(PID_FILE) } catch { /* ignore */ } }
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

// ── Crash accountability ──────────────────────────────────────────────────────
// A crash must (a) leave a readable record of WHY next to the data it was writing, and (b) try to
// flush the bounded in-flight buffers — otherwise the last SAVE_INTERVAL of spans evaporates and
// the lifecycle gap is the only trace. exit(1) after an uncaughtException is mandatory: the
// process state is unknown and limping on corrupts more than it saves (fail-fast project rule).
const CRASH_LOG = path.join(DATA_DIR, 'crash.log')
function recordCrash(kind: string, err: unknown): void {
  try {
    // Rotate at 1MB (one backup) — a crash-looping supervisor must not grow this unbounded.
    if (sizeOf(CRASH_LOG) > 1024 * 1024) { try { fs.renameSync(CRASH_LOG, `${CRASH_LOG}.1`) } catch { /* ignore */ } }
    const stack = err instanceof Error ? (err.stack ?? err.message) : String(err)
    const recent = requestLog.recent(5).map(r => `  ${r.ts} ${r.method} ${r.status} ${r.path}`).join('\n')
    fs.appendFileSync(CRASH_LOG, `${new Date().toISOString()} ${kind}: ${stack}\nlast requests:\n${recent}\n\n`)
  } catch { /* the crash record itself must never throw */ }
}
process.on('uncaughtException', (err) => {
  recordCrash('uncaughtException', err)
  try { flushSpanAppends() } catch { /* ignore */ }
  try { saveOffsetsNow() } catch { /* ignore */ }
  if (IS_CANONICAL) { try { fs.unlinkSync(PID_FILE) } catch { /* ignore */ } }
  console.error('[AgentLens] FATAL uncaughtException (recorded in crash.log):', err)
  process.exit(1)
})
process.on('unhandledRejection', (reason) => {
  // Logged, not fatal: rejected promises from library internals are recoverable noise, and
  // killing the collector for one would trade a diagnostic gap for a data gap.
  recordCrash('unhandledRejection', reason)
  console.warn('[AgentLens] unhandledRejection (recorded in crash.log):', reason)
})
