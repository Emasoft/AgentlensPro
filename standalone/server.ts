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
import { exec, execFile } from 'child_process'
import { summarizeSpans } from '../src/spanSummarizer'
import { packageVersion } from '../src/packageVersion'
import { dataDir as agentlensDataDir } from '../src/dataDir'
import { VersionedCache } from '../src/derivedCache'
import { startLoopWatchdog } from '../src/loopWatchdog'
import { mergeOtelAndLogSessions, linkSubagentTranscripts, graftOtelAttribution } from '../src/feedMergePolicy'
import { calcTokenCostUsd } from '../src/shared/pricing'
import { contextTokens } from '../src/shared/tokenBuckets'
import { ensureEmbedKey, resolveViewerRole, VIEWER_HEADER, type ViewerRole } from '../src/embedAuth'
import { countFallback, fallbackTotals } from '../src/shared/fallbackCounters'
import { autoConfigureCodex, autoConfigureCopilotStandalone } from '../src/autoConfigNode'
import { ensureTelemetryConfig, ensureAgentLensStopHook } from '../src/telemetryConfig'
import { classifyOtlpPayload } from '../src/otlpParser'
import { resolveLogEventName, bareLogEventName, CLAUDE_RICH_LOG_EVENTS, BODY_POINTER_LOG_EVENTS } from '../src/otlpLogEvents'
import { startMcpHttpServer, labelBurnStatusAccounts } from '../src/mcpServer'
import { isDisallowedCrossOrigin, setAllowedOriginCors } from '../src/httpOrigin'
import { resolveCallContext, callBodyRegistry } from '../src/rawBodyContext'
import { appendHookEvent, readHookEvents, purgeHookEventBuckets, hookEventsDiskUsage, verifyAppendedLine, quarantineSpoolFile, type HookEventRecord, type AppendPosition } from '../src/hookEventStore'
import { extractLifecycleEvents, type LifecycleKind } from '../src/lifecycleEvents'
import { scanCacheRiskCommands, type CacheRiskKind } from '../src/cacheRiskCommands'
import { buildDroppedLogEventRecord, appendDroppedLogEvent, purgeLogEventBuckets, logEventsDiskUsage } from '../src/logEventSink'
import { BodiesActivityTracker } from '../src/bodiesActivity'
import { evaluateAgentGate, evaluateSendMessageGate, buildAdvisory, readTranscriptContext, resolveMessageTargetLiveness, type AgentGateState, type GateThresholds, type LaunchSpawner } from '../src/agentGate'
import { checkBurnRisk, attachRiskCausingCalls } from '../src/burnGuard'
import { loadHookRuntimeConfig, saveHookRuntimeConfig } from '../src/hookRuntimeConfig'
import { ContextCompositionIndex } from '../src/contextCompositionIndex'
import { LogReader, claudeProjectsDirs, type OpenCodeSqlFactory } from '../src/logReader'
import { readScratchFile, scratchListingStats } from '../src/generatedFiles'
import { StatuslineUsageReader } from '../src/statuslineUsage'
import {
  loadBurnConfig, gatherConsumptionEvents, computeBurnStatus, computeSessionStatus,
  type BurnAlert, type BurnStatus,
} from '../src/burnMonitor'
import { calibrateFromStopFailure } from '../src/capacityCalibration'
import { getCurrentAccount } from '../src/accountInfo'
import { getTtlContext } from '../src/ttlContext'
// TRDD-YQZ9P8IL — the change-detected account-state timeline. Sampled on the burn tick (cheap: only a
// discrete-state change enqueues), flushed on its own 60s timer + on graceful shutdown.
import { AccountStateTimeline, buildAccountStateRecord } from '../src/accountStateTimeline'
import { classifyTtlRegime, type SessionTtlKind, type TtlContext } from '../src/shared/cacheTtl'
import { buildContextComposition, resolveLoggedAncestor } from '../src/contextComposition'
import { buildContextHistory } from '../src/contextHistory'
import { buildConversation } from '../src/conversation'
import { generateSuggestions } from '../src/instructionAdvisor'
import { detectInstructionFiles, appendSuggestion } from '../src/instructionFiles'
import { atomicWriteFileSync, heapPressure, RequestLog } from '../src/serverRuntime'
import { SegmentedSpanStore, migrateLegacySpansFile, spanTimestampMs } from '../src/segmentedSpanStore'
// appendToArchive is GONE: bodies now go into the content-addressed store, not a gzip .wad lump
// (TRDD-K3WDPR7M Phase 3). The read/purge helpers stay — the existing .wad volumes still hold real
// history that has not been migrated yet.
import { purgeArchiveVolumes, archiveDiskUsage, extractArchive } from '../src/bodyArchive'
import { openStore, allOf, type Store } from '../src/store/db'
import { DEFAULT_MAX_BYTES_PER_PASS, ingestPass } from '../src/store/ingestPass'
import { verifyVolumeInStore } from '../src/store/archiveVerify'
import { rawBodyCaptureEnabled, spoolDirConfigured } from '../src/captureConfig'
import { ensureRamDisk, ramDiskInfo, spoolSizeMb } from '../src/ramdisk'
import { exportBodiesFromStore } from '../src/store/bodyStore'
import {
  loadLogOffsets, loadPersistedCards,
  recordCollectorStart, recordCollectorHeartbeat, recordCollectorStop, computeCollectorGaps,
  LOG_INGEST_VERSION, type LifecycleStore, type PersistedFileState,
} from '../src/collectorState'
import { DeltaLog } from '../src/store/deltaLog'
import type { Span } from '../src/shared/telemetryTypes'
import type { SessionSummaryCard, CollectorGap, TimelineEntry } from '../src/shared/summarizerTypes'
import { CodexSessionNormalizer } from '../src/codexSessionNormalizer'
import { formatGenAiEventContent } from '../src/genAiContent'
import { ResourceMonitor } from '../src/resourceMonitor'
import { AdmissionController, admissionLimitsFromEnv, type AdmitResult } from '../src/admissionController'
import { resolveRetention } from '../src/retentionConfig'

const OTLP_PORT  = parseInt(process.env.OTLP_PORT  ?? '4318')
const UI_PORT    = parseInt(process.env.UI_PORT    ?? '3000')
const MCP_PORT   = parseInt(process.env.MCP_PORT   ?? '4316')
const BIND_HOST  = process.env.BIND_HOST ?? '127.0.0.1'

const mediaDir  = path.join(__dirname, '..', 'media')
const DATA_DIR  = agentlensDataDir()

// THE KILL-SWITCH, ENFORCED AT THE CHOKEPOINT (TRDD-K3WDPR7M). Guarding the CLI's spawn sites was
// not enough: on 2026-07-15 a server booted 3 minutes after `agentlenspro disable` through a spawn
// path that carried no guard (`setup` had none; a hook's revive raced the flag) — and a running
// writer during the store migration's atomic swap would have stranded fresh bodies in the renamed
// old dir, i.e. real data loss. Guarding N call sites always misses the N+1th; the ONE spawn path
// every future caller must pass through is this process's own boot, so the flag is honored HERE,
// before any port binds, any store opens, or any timer arms. `agentlenspro enable` removes the flag
// and the next hook revives the server normally.
if (fs.existsSync(path.join(DATA_DIR, 'DISABLED'))) {
  console.error(`[AgentLens] DISABLED flag present (${path.join(DATA_DIR, 'DISABLED')}) — server refusing to boot.`)
  console.error('Re-enable with:  agentlenspro enable')
  process.exit(78) // EX_CONFIG: a deliberate refusal, distinguishable from a crash
}
// Retention knobs resolved once at boot: env var > DATA_DIR/config.json > built-in default (min-floored
// inside resolveKnob). The config.json layer makes retention PERSISTENTLY settable — it survives a
// repo delete / uninstall / upgrade like the data it governs, and the launchd daemon (whose own env a
// shell export cannot reach) re-reads it every boot. See src/retentionConfig.ts (TRDD-ZAV74M8Q).
const RET = resolveRetention(DATA_DIR, process.env)
// TRDD-1ZH1D5EG — the shared HMAC key for the AgentlensPro#4 viewer-role contract. Created 0600
// on first boot; ai-maestro's proxy reads the same file (same user, same host) to sign the
// X-Agentlens-Viewer assertions this server verifies per request.
//
// FAIL-CLOSED BOOT (TRDD-F1VX3M7C, owner directive — reverses WYC4KB50 #1's soft-fail). The
// embed-key is a SHARED HMAC SECRET: ai-maestro's proxy signs viewer-role assertions with the same
// file. If it is unusable — corrupt hex, or wider than 0600 on POSIX — the safe posture is to
// REFUSE TO BOOT, not to run on with an undecidable or leaked key. A mode wider than 0600 means
// another local account can read the shared secret and mint 'maestro' assertions; refusing to boot
// forces the operator to protect (chmod 600) or remove the file before the server serves anything.
// We exit EX_CONFIG (78) — the same deliberate-refusal code the DISABLED kill-switch uses above —
// so the supervisor treats it as TERMINAL and does not respawn-loop (src/cli/serverControl.ts). The
// normal case (a well-formed 0600 key, auto-created on first boot) loads without incident; only an
// already-broken install reaches the catch. Past this point EMBED_KEY is always a valid key at
// runtime — the `| null` is kept only so resolveViewerRole's pure contract stays defensively total.
let EMBED_KEY: Buffer | null = null
try {
  EMBED_KEY = ensureEmbedKey(DATA_DIR)
} catch (e) {
  console.error(`[AgentLens] embed-key at ${DATA_DIR}/embed-key is unusable: ${(e as Error).message}`)
  console.error('[AgentLens] refusing to boot — chmod 600 the key file or delete it (a fresh 0600 key is created on next boot). See AgentlensPro#4.')
  process.exit(78) // EX_CONFIG: a deliberate refusal, distinguishable from a crash — the supervisor treats 78 as terminal
}
// P4 segmented span store: daily NDJSON segments under DATA_DIR/spans/ (src/segmentedSpanStore.ts).
// The old single-file spans.json exists only as a migration source — split into segments on the
// first boot and preserved as spans.json.bak, never deleted.
const SPANS_DIR = path.join(DATA_DIR, 'spans')
const LEGACY_SPANS_FILE = path.join(DATA_DIR, 'spans.json')
// TRDD-PJC8N1HO — durable-state sidecars (all under DATA_DIR, all written atomically):
const OFFSETS_FILE   = path.join(DATA_DIR, 'log-offsets.json')     // legacy whole-file sidecar — migration source only (see offsetsLog below)
const CARDS_FILE     = path.join(DATA_DIR, 'log-sessions.json')    // legacy whole-file sidecar — migration source only (see cardsLog below)
const LIFECYCLE_FILE = path.join(DATA_DIR, 'collector-lifecycle.json') // spec 2: start/stop/heartbeat log
const REQUEST_LOG    = path.join(DATA_DIR, 'requests.log')         // spec 6: one line per HTTP request

// Ensure DATA_DIR exists before any sidecar is written (lifecycle/offsets/crash all live here). The
// spans loader below also mkdir's it, but the lifecycle start marker fires first, so do it up front.
try { if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true }) } catch { /* best effort */ }

// TRDD-K3WDPR7M Phase 4: delta-log persistence for the two heaviest sidecars — append-only NDJSON
// (snapshot + delta) instead of rewriting the whole file every interval. Keyed by each record's own
// id, so save() diffs record-by-record and writes ONLY what changed (was: 31.6MB/300s + 3.1MB/60s
// unconditionally — ~9.4MB/min of pure SSD wear). OFFSETS_FILE/CARDS_FILE above are migration sources
// only from here on — never written again.
const cardsLog = new DeltaLog<SessionSummaryCard>(DATA_DIR, 'log-sessions')
const offsetsLog = new DeltaLog<PersistedFileState>(DATA_DIR, 'log-offsets')

// DeltaLog has no notion of LOG_INGEST_VERSION (unlike the old {v, cards}/{v, offsets} wrapper it
// replaces) — without an external stamp, a future semantics bump would silently keep serving
// stale-semantics records forever instead of forcing the cold rescan collectorState.ts documents.
// Written only after a successful save (saveCardsNow/saveOffsetsNow) or a version-confirmed migration,
// so a crash before the first post-bump save leaves the marker stale too and the NEXT boot correctly
// retries the cold rescan rather than trusting a half-migrated delta log.
const DELTA_VERSION_FILE = path.join(DATA_DIR, 'log-delta-version.json')
function deltaVersionIsCurrent(): boolean {
  try { return (JSON.parse(fs.readFileSync(DELTA_VERSION_FILE, 'utf8')) as { v?: unknown }).v === LOG_INGEST_VERSION } catch { return false }
}
function stampDeltaVersion(): void {
  try { atomicWriteFileSync(DELTA_VERSION_FILE, JSON.stringify({ v: LOG_INGEST_VERSION })) } catch { /* best effort, mirrors the lifecycle stamps elsewhere */ }
}

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

// ── Span store — segmented, append-only, NO eviction (P4) ────────────────────
// Disk: daily NDJSON segments under DATA_DIR/spans/ + a per-segment index (count/time-range/
// bytes). Append cost is O(record) — the store NEVER rewrites a file (the whole-store rewrite
// was the 420GB/4.4h SSD-wear incident; the MAX_SPANS eviction it fed was measured losing
// 1,700 spans in ONE restart: "Loaded 50000 spans (capped from 51700)"). Both diseases are
// gone at the root: no span-count cap, no compaction, retention deletes whole EXPIRED
// segments only — loudly. Full rationale + the no-native-deps decision live at the store:
// src/segmentedSpanStore.ts.

let spans: Span[] = []
let sseClients: http.ServerResponse[] = []

// TRDD-X2E6OSWK — the cache key for every DERIVED view of the ingested data.
//
// `spans` and `logSessions` are the ONLY inputs to the dashboard model (summary → stripped summary →
// sidebar → analytics). Rebuilding that model is expensive (a 120s profile of the live server
// measured the rebuild storm at ~19% of wall-clock CPU), and it was being rebuilt from scratch on
// every push, every burn tick and every API request. So: every mutation of either input bumps this
// counter, and each derived value is memoized against it (VersionedCache). Same version ⇒ the
// rebuild is provably redundant, so skipping it cannot serve stale data — only save the CPU.
//
// It is a plain counter and NOT a timestamp: two mutations inside the same millisecond must produce
// two distinct versions, or the second one's data would be invisible until a third arrived.
let dataVersion = 0
function markDataChanged(): void { dataVersion++ }

// The derived-view caches. They are the CPU fix's other half: the dashboard model was rebuilt from
// scratch by EVERY caller — the coalesced push, the 4s burn tick, and ~10 API/MCP routes — so one
// second of normal traffic could re-run summarizeSpans over the whole span window several times over
// IDENTICAL inputs. Memoizing on `dataVersion` makes them all share ONE rebuild per actual data
// change. Pure memos: same version in ⇒ identical value out.
//
// DECLARED HERE, not next to the builders that use them, and that placement is LOAD-BEARING: module
// init already calls buildSessionSummary() (the resident-blob scan → compositionProjectResolver runs
// during startup), and esbuild's CJS output hoists a later `const` to `undefined` instead of raising
// a TDZ error — so a declaration further down silently produced
// "TypeError: Cannot read properties of undefined (reading 'get')" inside a swallowed catch. Keep
// every cache above the first caller.
const summaryCache = new VersionedCache<ReturnType<typeof summarizeSpans> | null>()
const strippedCache = new VersionedCache<ReturnType<typeof summarizeSpans> | null>()
const sidebarCache = new VersionedCache<ReturnType<typeof computeSidebarData> | null>()
const analyticsCache = new VersionedCache<ReturnType<typeof computeAnalyticsData> | null>()

// In-memory model: `spans` is the rolling SUMMARIZATION WINDOW, bounded by TIME, never by a
// span count. The old MAX_SPANS=50k cap existed because the flat array grew unbounded under
// the full firehose and OOM-killed the process (~4GB heap in ~19 min ⇒ ~175 spans/sec, so the
// 50k cap amounted to ≈5 minutes of firehose anyway — it just ALSO destroyed the on-disk
// history). Now: memory holds only spans newer than the window (default 24h,
// AGENTLENS_SUMMARY_WINDOW_HOURS); under heap pressure the window halves down to a 5-minute
// floor (the live summarization window), logged loudly — while DISK keeps every span, and any
// range query reloads older segments on demand via spanStore.loadRange().
const SUMMARY_WINDOW_FLOOR_MS = 5 * 60_000
const SUMMARY_WINDOW_MS = Math.max(SUMMARY_WINDOW_FLOOR_MS, RET.summaryWindowHours * 3600e3)
let effectiveWindowMs = SUMMARY_WINDOW_MS

// Retention: whole expired segments only, on boot + daily, each deletion logged explicitly
// ("retention: deleted segment 2026-06-01.ndjson, N spans, age 39d"). Never a silent drop.
const SPANS_RETENTION_DAYS = RET.spansRetentionDays

const SAVE_INTERVAL_MS = Math.max(1000, Number(process.env.AGENTLENS_SAVE_INTERVAL_MS) || 5000)

// Persistence accounting — the observable that would have caught the 420GB incident on day one.
// Every byte this process writes to DATA_DIR is counted here and reported by /api/server-stats,
// so "how much is the collector writing?" is one CLI call instead of a kernel-counter hunt.
const SERVER_STARTED_AT = Date.now()
// Resolved ONCE at boot, not per request: an install that cannot identify its own build is
// broken, and failing at startup is a clearer signal than a 500 on the stats endpoint.
const SERVER_VERSION = packageVersion()
const persistStats = {
  spanAppendWrites: 0, spanAppendBytes: 0,
  offsetsWrites: 0, offsetsBytes: 0,
  cardsWrites: 0, cardsBytes: 0,
  hookEventWrites: 0, hookEventBytes: 0,
  logEventWrites: 0, logEventBytes: 0,
  gateChecks: 0, gateDenies: 0, gateWarns: 0, gateAdvisories: 0,
  bodiesLastPurge: { at: 0, removedFiles: 0, freedBytes: 0, keptFiles: 0, keptBytes: 0 },
}

const spanStore = new SegmentedSpanStore(SPANS_DIR)

// One-time migration: split the legacy single-file spans.json into daily segments; the original
// is preserved as spans.json.bak (never deleted). Logged inside migrateLegacySpansFile.
try {
  migrateLegacySpansFile(LEGACY_SPANS_FILE, spanStore)
} catch (e) {
  console.warn('[AgentLens] Could not migrate legacy spans.json:', e)
}

// Boot load: ONLY the segments overlapping the summarization window — never the whole store.
// Nothing is evicted: older spans stay on disk and remain loadable by range.
try {
  spans = spanStore.loadRange(Date.now() - SUMMARY_WINDOW_MS, Infinity)
  markDataChanged()
  const st = spanStore.stats()
  console.log(`[AgentLens] Loaded ${spans.length} span(s) (last ${Math.round(SUMMARY_WINDOW_MS / 3600e3)}h window) from ${SPANS_DIR} — store holds ${st.totalSpans} span(s) across ${st.segments} segment(s), nothing evicted`)
} catch (e) {
  console.warn('[AgentLens] Could not load persisted data:', e)
}

// Retention: on boot + daily. Deletes whole EXPIRED segments only; each deletion is logged by
// the store ("retention: deleted segment <name>, N spans, age Nd").
function runSpanRetention(): void {
  try { spanStore.runRetention(SPANS_RETENTION_DAYS) } catch (e) { console.warn('[AgentLens] span retention failed:', e) }
}
runSpanRetention()
const spanRetentionTimer = setInterval(runSpanRetention, 24 * 3600e3)
spanRetentionTimer.unref()

/** Flush buffered appends to their daily segments (O(pending), never a rewrite), then trim the
 *  in-memory summarization window by TIME. Trimming memory is not data loss — every trimmed
 *  span is already on disk and reloadable by range. */
function flushSpanAppends(): void {
  const r = spanStore.flush()
  if (r.appendedSpans > 0) {
    persistStats.spanAppendWrites++
    persistStats.spanAppendBytes += r.appendedBytes
  }
  // Heap-pressure valve: halve the window (never below the 5-minute live floor) instead of the
  // old cap's silent oldest-span eviction. Loud by design, and disk keeps everything.
  const hp = heapPressure()
  if (hp.over && effectiveWindowMs > SUMMARY_WINDOW_FLOOR_MS) {
    effectiveWindowMs = Math.max(SUMMARY_WINDOW_FLOOR_MS, Math.floor(effectiveWindowMs / 2))
    console.warn(`[AgentLens] heap pressure (${Math.round(hp.heapUsedMb)}/${Math.round(hp.limitMb)}MB): summary window shrunk to ${Math.round(effectiveWindowMs / 60_000)}m — disk store unaffected, no spans lost`)
  }
  const cutoff = Date.now() - effectiveWindowMs
  // Live appends keep `spans` roughly time-ordered, so only filter when the head has aged out.
  if (spans.length > 0 && spanTimestampMs(spans[0]) < cutoff) {
    spans = spans.filter(s => spanTimestampMs(s) >= cutoff)
    markDataChanged()   // the summarization window shrank — every derived view must be rebuilt
  }
}
const spanFlushTimer = setInterval(flushSpanAppends, SAVE_INTERVAL_MS)
spanFlushTimer.unref()

/** Reset the on-disk store + append pipeline (the /api/clear + clearAll paths). */
function clearPersistedSpans(): void {
  spanStore.clear()
}

function addSpan(span: Span) {
  if (span.receivedAt === undefined) span.receivedAt = Date.now()
  spans.push(span)
  markDataChanged()
  spanStore.append(span) // O(record): buffered, appended by the flush tick — never a rewrite
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
const LEGACY_BODIES_DIR = path.join(DATA_DIR, 'otel-bodies')
const BODIES_ARCHIVE_DIR = path.join(DATA_DIR, 'otel-bodies-archive')
const BODIES_MAX_AGE_MS = RET.bodiesMaxAgeHours * 3600e3
const BODIES_MAX_BYTES = RET.bodiesMaxGb * 1024 ** 3
const BODIES_RETENTION_DAYS = RET.bodiesRetentionDays

// ── RAM-disk spool resolution (TRDD-K3WDPR7M Phase 3) ─────────────────────────
// When raw-body capture is ON, Claude Code writes bodies to a RAM-disk spool so the ~30 GB/day of
// writes land in volatile memory, not the SSD. Resolve it HERE, at boot, re-creating the spool if a
// reboot cleared it — BEFORE the first drain. If it cannot be (re)created, we must NOT ingest from the
// configured spool path (its RAM disk is gone); we drain ONLY the legacy dir so leftovers from stale
// sessions are still reclaimed, and say so loudly rather than ingest from a wrong dir.
const CAPTURE_ON = rawBodyCaptureEnabled(DATA_DIR, process.env)
let SPOOL_MODE = false
let SPOOL_SIZE_BYTES = 0
let PRIMARY_BODIES_DIR = LEGACY_BODIES_DIR
if (CAPTURE_ON) {
  const configured = spoolDirConfigured(DATA_DIR)
  if (configured) {
    try {
      const info = ramDiskInfo()
      SPOOL_SIZE_BYTES = info.mounted
        ? (info.sizeBytes ?? 0)
        : ensureRamDisk(spoolSizeMb(process.env)).sizeBytes // reboot re-create, BEFORE the first pass
      PRIMARY_BODIES_DIR = configured
      SPOOL_MODE = true
    } catch (e) {
      console.error(`[AgentLens] capture is ON but the RAM-disk spool could not be (re)created — NOT ingesting from ${configured}; draining only the legacy dir. ${(e as Error).message}`)
    }
  }
}
// The live bodies dir the gate's activity tracker + the drain watch (spool in spool mode, else legacy).
const BODIES_DIR = PRIMARY_BODIES_DIR

// Drain targets, each with its own emergency size-cap. In spool mode the spool's cap is min(configured
// cap, 70% of the RAM disk) so a runaway producer can never fill volatile memory; the legacy dir is
// ALSO drained (leftovers from pre-spool / stale sessions) at the normal cap.
interface DrainTarget { dir: string; capBytes: number }
const drainTargets: DrainTarget[] = SPOOL_MODE
  ? [
      { dir: PRIMARY_BODIES_DIR, capBytes: SPOOL_SIZE_BYTES > 0 ? Math.min(BODIES_MAX_BYTES, Math.floor(SPOOL_SIZE_BYTES * 0.7)) : BODIES_MAX_BYTES },
      { dir: LEGACY_BODIES_DIR, capBytes: BODIES_MAX_BYTES },
    ]
  : [{ dir: LEGACY_BODIES_DIR, capBytes: BODIES_MAX_BYTES }]

// The bodies pass: ingest raw bodies into the content-addressed store, then reclaim their disk space
// (TRDD-K3WDPR7M Phase 3). This REPLACES the old .wad archiver, which gzipped each body into a
// monthly volume — it had no cross-body dedup (every turn re-stored the whole re-sent transcript AND
// an identical 268 KB tools array), and its boot pass was UNBOUNDED: measured at 694 MB/min of device
// writes, which made "restart the server" a disk-punishing event all by itself.
//
// The store gets the same corpus 167x smaller (measured on 4.00 GB of real bodies -> 24 MB of zstd
// Parquet, all 7,439 verified byte-identical), and ingestPass only deletes a body AFTER proving it
// reconstructs byte-for-byte from a DURABLE Parquet part.
//
// The legacy .wad volumes are still READ (extractArchive) and still age out on the retention window —
// they hold real history we have not migrated yet, and RULE 0 forbids destroying it on a guess.
const INGEST_MAX_BYTES_PER_PASS = Math.max(
  16 * 1024 ** 2,
  Number(process.env.AGENTLENS_INGEST_MAX_BYTES_PER_PASS) || DEFAULT_MAX_BYTES_PER_PASS,
)
let bodyStore: Store | null = null
let bodiesPassRunning = false
// Seeded ONCE per boot from the store's already-ingested src_name set, then MUTATED by ingestPass as
// names are ingested — so a 60s spool drain never re-reads+re-hashes a body that is already durable
// (TRDD-K3WDPR7M Phase 3, item 5).
let ingestSkipNames: Set<string> | null = null

async function seedIngestSkipNames(store: Store): Promise<Set<string>> {
  const set = new Set<string>()
  try {
    const rows = (await store.con.runAndReadAll(`SELECT DISTINCT src_name FROM ${allOf(store, 'body')}`)).getRowObjects()
    for (const row of rows) { if (row.src_name != null) set.add(String(row.src_name)) }
  } catch (e) {
    console.warn('[AgentLens] could not seed the ingest skip-set (will re-hash existing bodies once):', e)
  }
  return set
}

async function archiveOtelBodies(): Promise<void> {
  if (bodiesPassRunning) return // a tick must never overlap a still-running pass
  bodiesPassRunning = true
  try {
    const targets = drainTargets.filter((t) => fs.existsSync(t.dir))
    if (targets.length === 0) return
    bodyStore ??= await openStore({ dir: path.join(DATA_DIR, 'store') })
    const skip = (ingestSkipNames ??= await seedIngestSkipNames(bodyStore))

    let ingested = 0, deleted = 0, bytesIn = 0, bytesStored = 0, liveBytesTotal = 0, throttled = false
    const failed: string[] = []
    for (const target of targets) {
      // The size cap is the emergency valve: over it, ingest EVERYTHING (age 0) rather than only what
      // has aged out, so a runaway producer cannot outrun the drain (in spool mode: cannot fill RAM).
      let liveBytes = 0
      for (const f of fs.readdirSync(target.dir)) {
        if (!f.endsWith('.request.json') && !f.endsWith('.response.json')) continue
        try { liveBytes += fs.statSync(path.join(target.dir, f)).size } catch { /* raced */ }
      }
      liveBytesTotal += liveBytes
      const overCap = liveBytes > target.capBytes
      const r = await ingestPass({
        bodiesDir: target.dir,
        store: bodyStore,
        maxAgeMs: overCap ? 0 : BODIES_MAX_AGE_MS,
        maxBytesPerPass: INGEST_MAX_BYTES_PER_PASS, // THE THROTTLE — never an unbounded boot pass again
        deleteAfter: true,                          // safe: ingestPass verifies from the DURABLE store first
        skipNames: skip,                            // don't re-read+re-hash already-durable bodies
      })
      ingested += r.ingested; deleted += r.deleted; bytesIn += r.bytesIn; bytesStored += r.bytesStored
      throttled ||= r.throttled
      for (const f of r.failed) failed.push(f)
    }

    // Retention ageing of archive volumes — GATED (TRDD-K3WDPR7M, 2026-07-15 USER directive): a
    // volume dies only after EVERY lump in it is proven in the store (bytes + capture-ts row). A
    // volume the gate cannot bless is KEPT and named, no matter how old — ageing out is a schedule,
    // not a proof. The .idx sidecar always survives (capture-time provenance).
    const gate = bodyStore
    const purged = await purgeArchiveVolumes(BODIES_ARCHIVE_DIR, BODIES_RETENTION_DAYS, async (volumeName) => {
      const v = await verifyVolumeInStore(gate, BODIES_ARCHIVE_DIR, volumeName)
      if (!v.ok) {
        console.warn(`[AgentLens] archive volume ${volumeName} aged out but FAILED store verification ` +
          `(${v.verified}/${v.entries} proven) — KEPT: ${v.failed.slice(0, 3).join('; ')}`)
      }
      return v.ok
    })
    persistStats.bodiesLastPurge = {
      at: Date.now(), removedFiles: deleted, freedBytes: bytesIn,
      keptFiles: 0, keptBytes: Math.max(0, liveBytesTotal - bytesIn),
    }
    if (ingested > 0 || purged.removed.length > 0) {
      console.log(`[AgentLens] bodies → store: ingested ${ingested}, reclaimed ${deleted} file(s) ` +
        `(${(bytesIn / 1024 ** 3).toFixed(2)}GB read → ${(bytesStored / 1048576).toFixed(1)}MB new spans)` +
        `${SPOOL_MODE ? ' [spool]' : ''}${throttled ? ' [throttled — more next pass]' : ''}` +
        `${purged.removed.length > 0 ? `; purged legacy volume(s) ${purged.removed.join(', ')} (${(purged.freedBytes / 1024 ** 3).toFixed(2)}GB, verified in store first)` : ''}`)
    }
    // A body we could not PROVE we can return is a body we have no right to delete. Say so loudly —
    // a silent skip would look identical to success while the corpus quietly rotted.
    if (failed.length > 0) {
      console.warn(`[AgentLens] ${failed.length} body/bodies could NOT be verified and were KEPT on disk: ${failed.slice(0, 5).join('; ')}`)
    }
  } catch (e) {
    console.warn('[AgentLens] bodies ingest pass failed:', e)
  } finally {
    bodiesPassRunning = false
  }
}
// Lifecycle hook events (`agentlenspro hook` → POST /api/hook-events): append-only NDJSON daily
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

// Gated-out OTEL log events (user_prompt, assistant_response, tool_decision, hook_execution_*, ...)
// persisted instead of dropped (TRDD-AMEA4O4Z — USER 2026-07-16: lose no logged data). Same
// append-only daily-bucket model as hook-events; RET knob bounds how long the buckets live.
const LOG_EVENTS_DIR = path.join(DATA_DIR, 'log-events')
const LOG_EVENTS_RETENTION_DAYS = RET.logEventsRetentionDays
// A sink failure must never reject the whole OTLP payload (that would lose the spans too), but it
// must not be silent either — warn once per boot per error message, then keep counting drops.
const logSinkWarned = new Set<string>()
function persistDroppedLogEvent(name: string, bare: string, attrs: RawAttr[], rec: Record<string, unknown>): void {
  try {
    const { bytes } = appendDroppedLogEvent(LOG_EVENTS_DIR, buildDroppedLogEventRecord(name, bare, attrs, rec))
    persistStats.logEventWrites++
    persistStats.logEventBytes += bytes
  } catch (e) {
    const msg = (e as Error).message
    if (!logSinkWarned.has(msg)) {
      logSinkWarned.add(msg)
      console.warn(`[AgentLens] log-event sink append FAILED (event lost — disk problem?): ${msg}`)
    }
  }
}

function purgeLogEvents(): void {
  const r = purgeLogEventBuckets(LOG_EVENTS_DIR, LOG_EVENTS_RETENTION_DAYS)
  if (r.removed.length > 0) {
    console.log(`[AgentLens] log-events retention: purged ${r.removed.length} bucket(s), ${(r.freedBytes / 1048576).toFixed(1)}MB`)
  }
}

void archiveOtelBodies() // enforce on boot — a long-dead server must not leave the corpus unbounded
purgeHookEvents()
purgeLogEvents()
// Spool mode drains every 60s (the bodies sit in volatile RAM — reclaim them fast); otherwise the
// legacy hourly cadence is plenty for plain-file bodies on disk.
const BODIES_PASS_INTERVAL_MS = SPOOL_MODE ? 60_000 : 3600e3
const bodiesPurgeTimer = setInterval(() => { void archiveOtelBodies() }, BODIES_PASS_INTERVAL_MS)
bodiesPurgeTimer.unref()
const hookPurgeTimer = setInterval(() => { purgeHookEvents(); purgeLogEvents() }, 3600e3)
hookPurgeTimer.unref()

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

// Ingest ONE already-parsed hook payload. Shared by the POST /api/hook-events handler AND the
// boot-time hook-spool drain (D3K7QM2P/1a) so a spooled event is reingested through EXACTLY the
// same path (validate → append → ring → stats → StopFailure calibration). Returns an HTTP-shaped
// result; never throws on a bad payload (a 400 is returned) so the drain can proceed to the next
// file — only a genuine disk fault in appendHookEvent throws, which the drain treats as "retry".
function ingestHookEvent(payload: unknown): { status: number; body: Record<string, unknown>; pos?: AppendPosition; line?: string } {
  const p = payload as Record<string, unknown> | null
  if (!p || typeof p !== 'object' || typeof p.hook_event_name !== 'string' || p.hook_event_name === '') {
    return { status: 400, body: { error: 'payload must be a JSON object with hook_event_name' } }
  }
  if (!hookRuntime.captureEnabled) {
    // Switch off = accept and DROP (the hook script must stay a fire-and-forget dumb pipe; a
    // non-2xx here would make disabled capture look like a server outage).
    return { status: 200, body: { ok: true, dropped: 'captureEnabled=false' } }
  }
  const { rec, bytes, pos, line } = appendHookEvent(HOOK_EVENTS_DIR, p)
  pushRecentHookEvent(rec) // the in-memory ring the gate + check_burn_risk read
  persistStats.hookEventWrites++
  persistStats.hookEventBytes += bytes
  // P5 auto-calibration: a rate-limit StopFailure is the ONE moment the undisclosed window cap
  // is observable — snapshot the hot account's consumed figures into burn-config.json as observed
  // capacity. Wrapped so a calibration failure can never break hook ingestion, and run AFTER the
  // record is persisted/ringed (ingestion is the priority).
  if (rec.ev === 'StopFailure') {
    try {
      const { sessions, events } = gatherBurn(rec.ts)
      const outcome = calibrateFromStopFailure(rec, {
        events, sessions,
        currentAccountUuid: getCurrentAccount()?.accountUuid ?? null,
        env: process.env, homeDir: os.homedir(),
      })
      if (outcome.calibrated) {
        // Reload so the next 4s burn tick + every budget read projects against the new cap.
        burnConfig = loadBurnConfig(process.env, os.homedir())
        console.log(`[AgentLens] window capacity auto-calibrated: ${outcome.reason}`)
      } else {
        console.log(`[AgentLens] capacity calibration skipped: ${outcome.reason}`)
      }
    } catch (e) {
      console.warn('[AgentLens] capacity calibration error:', e)
    }
  }
  return { status: 200, body: { ok: true }, pos, line }
}

// D3K7QM2P/1a: drain the durable hook-spool on boot. When the server was DOWN (or shedding under
// load), `agentlenspro hook` writes each raw payload to DATA_DIR/hook-spool/<ts>-<rand>.json instead
// of losing it; on the next boot we reingest every spooled event through ingestHookEvent, then delete
// its file — but ONLY after proving the durable copy exists. TRDD-K3WDPR7M (2026-07-15 USER directive:
// a source file may be deleted ONLY after the durable destination is confirmed to hold ALL its data):
//   • a 200 ingest is NOT trusted — we read the appended line back from its bucket and compare it
//     byte-for-byte before unlinking the spool file; a mismatch KEEPS the file (counted + warned);
//   • an unparseable or 400 payload can never ingest, but it is still DATA — it is QUARANTINED into
//     hook-spool/rejected/ (never deleted), which keeps the spool unwedged WITHOUT destroying it;
//   • a genuine disk fault (ingest throws) keeps the file for the next boot's retry.
// Idempotent: a crash mid-drain leaves the remaining files for the next boot.
const HOOK_SPOOL_DIR = path.join(DATA_DIR, 'hook-spool')
/** Count of hook events waiting on disk for the drain (surfaced on /api/server-stats). */
function hookSpoolCount(): number {
  try { return fs.readdirSync(HOOK_SPOOL_DIR).filter((n) => n.endsWith('.json')).length } catch { return 0 }
}
function drainHookSpool(): void {
  let names: string[]
  try { names = fs.readdirSync(HOOK_SPOOL_DIR).filter((n) => n.endsWith('.json')).sort() } catch { return } // no spool dir — nothing to drain
  if (names.length === 0) return
  const rejectedDir = path.join(HOOK_SPOOL_DIR, 'rejected')
  let drained = 0, rejected = 0, unverified = 0, kept = 0
  for (const name of names) {
    const file = path.join(HOOK_SPOOL_DIR, name)
    let raw: string
    try { raw = fs.readFileSync(file, 'utf-8') } catch { continue } // vanished / unreadable — skip
    let payload: unknown
    try { payload = JSON.parse(raw) } catch {
      // Unparseable will NEVER ingest — quarantine it (NEVER delete: it is still data). TRDD-K3WDPR7M.
      try { quarantineSpoolFile(file, rejectedDir); rejected++ } catch { kept++ }
      continue
    }
    let r: { status: number; pos?: AppendPosition; line?: string }
    try {
      r = ingestHookEvent(payload)
    } catch {
      // A genuine disk fault in appendHookEvent — keep the file for the next boot's retry.
      kept++; continue
    }
    if (r.status !== 200) {
      // A 400 (bad payload) can never ingest either — quarantine, never delete. TRDD-K3WDPR7M.
      try { quarantineSpoolFile(file, rejectedDir); rejected++ } catch { kept++ }
      continue
    }
    if (!r.pos || !r.line) {
      // 200 with nothing appended (capture disabled by policy) — not an error and not bad data. Keep
      // it: a later boot with capture re-enabled ingests it. Deleting it would silently drop the event.
      kept++; continue
    }
    // 200 WITH an append — but do NOT trust the status. Read the bucket back and prove the exact line
    // is durable at the reported offset before deleting the only other copy (verify-before-delete).
    if (verifyAppendedLine(r.pos, r.line)) {
      try { fs.unlinkSync(file) } catch { /* raced */ } // durable copy proven → safe to drop the spool file
      drained++
    } else {
      // Ingest said 200 but the read-back did not match — the durable copy is NOT proven. Keep the spool
      // file so the next boot retries; never destroy the only guaranteed copy on an unproven write.
      unverified++
      console.warn(`[AgentLens] hook-spool: append NOT verified for ${name} — keeping spool file (durable copy unproven)`)
    }
  }
  if (drained || rejected || unverified || kept) {
    console.log(`[AgentLens] hook-spool: drained ${drained} event(s)${rejected ? `, quarantined ${rejected} bad` : ''}${unverified ? `, kept ${unverified} unverified` : ''}${kept ? `, kept ${kept} for retry` : ''}`)
  }
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

// ── TTL-regime resolution for the gate + status paths (TRDD-VY1IUVUM) ─────────
// The machine TtlContext (auth regime + prompt-caching env overrides). The usage-credit overflow
// signal needs the 5h window fill — read from the LAST computed burn status rather than
// recomputing (the gate sits on the PreToolUse hot path; the state drifts on minute scale, so a
// ≤4s-stale pct is fine). getTtlContext caches its own fs/account reads for ~60s.
function currentTtlContext(): TtlContext {
  return getTtlContext(lastBurnStatus?.window.fiveHour.pctConsumed ?? null)
}

/**
 * Best-effort TTL kind of the session CALLING the gate. Signals, strongest first:
 *   1. the hook-event ring — a SubagentStart whose agent_id matches the caller's session id
 *      proves it is a spawned agent, and its agent_type distinguishes fork (reads the PARENT's
 *      cache entry → parent-regime TTL) from every other subagent (own 5-min cache);
 *   2. the transcript path — subagent transcripts live at .../<parent>/subagents/agent-<id>.jsonl
 *      (and worktree fleets under a "-claude-worktrees" mangled dir), main transcripts directly
 *      under the project dir. These are the same path facts logReader's lineage linking uses.
 * No signal → null, so the classifier reports 'assumed' instead of guessing.
 */
function resolveCallerTtlKind(sessionId: string | null, transcriptPath: string | null): SessionTtlKind | null {
  if (sessionId && sessionId !== 'unknown') {
    const bare = sessionId.startsWith('agent-') ? sessionId.slice('agent-'.length) : sessionId
    // Newest match wins (a name/id can be reused across restarts — the latest launch is the caller).
    for (let i = recentHookEvents.length - 1; i >= 0; i--) {
      const r = recentHookEvents[i]
      if (r.ev !== 'SubagentStart' || r.payload?.agent_id !== bare) continue
      return r.payload?.agent_type === 'fork' ? 'fork' : 'subagent'
    }
  }
  if (transcriptPath) {
    const base = path.basename(transcriptPath)
    if (base.startsWith('agent-') || transcriptPath.includes(`${path.sep}subagents${path.sep}`) ||
        transcriptPath.includes('-claude-worktrees')) {
      // A spawned transcript whose SubagentStart already left the ring: kind is provably a child,
      // but fork-vs-fresh is no longer distinguishable — 'subagent' is the doc-certain floor
      // (5-min ALWAYS); calling it 'fork' would grant an unproven 1h tier.
      return 'subagent'
    }
    return 'main'
  }
  return null
}

function buildGateState(
  now: number,
  parent: { contextTokens: number | null; idleMs: number | null },
  caller?: { sessionId: string | null; transcriptPath: string | null },
): AgentGateState {
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
  // Evidence-based cold-resume disarm (2026-07-11): a warm post-stall response from the STALLED
  // session proves the stall is over — the fixed window alone kept denying for 6 measured minutes
  // after recovery. Fail-closed to `false` (the timer fallback) when the session is unknown.
  let stallRecovered = false
  if (lastStop?.session) {
    try { stallRecovered = bodiesActivity.sessionWarmSince(lastStop.session, lastStop.ts) } catch { /* keep the timer */ }
  }
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
    stallRecovered,
    thrash: act.available ? act.thrash : null,
    premiumShare: act.premium.sampled > 0 ? act.premium.share : null,
    premiumModel: act.premium.lastModel,
    // The CALLER's TTL regime (TRDD-VY1IUVUM): a fork reads the CALLER's cache entry, so the
    // fork cold checks must run against ITS tier — 1h on a subscription main session, not the
    // global 5-min the gate used to assume. Unresolvable kind → the classifier says 'assumed'.
    ttl: classifyTtlRegime(
      resolveCallerTtlKind(caller?.sessionId ?? null, caller?.transcriptPath ?? null),
      currentTtlContext(),
    ),
    thresholds: gateThresholds,
  }
}

// PostToolUse advisory dedupe: ONE in-band injection per session+risk per 10min — per-call
// injections that later get stripped in place are themselves a cache-break cause (#778).
const advisoryIssued = new Map<string, number>()

// ── Single-instance guard (canonical instance only) ──────────────────────────
// EADDRINUSE on any of the three listeners already makes a same-port double start exit(1); the
// pidfile adds (a) a discoverable PID for `agentlenspro-cli --status/--stop-server` without a lsof
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
        console.error(`[AgentlensPro] Another AgentlensPro server is already running (pid ${prior}). Use \`agentlenspro-cli --status\` / \`--stop-server\`, or set OTLP_PORT for an isolated instance.`)
        process.exit(1)
      } catch { /* stale pidfile — take over below */ }
    }
  } catch { /* no pidfile — first start */ }
  try { atomicWriteFileSync(PID_FILE, String(process.pid)) } catch (e) { console.warn('[AgentLens] Could not write pidfile:', e) }
}

// ── Log file sessions ─────────────────────────────────────────────────────────

// Indexed by sessionId; OTEL-derived sessions (from spans) take precedence —
// when the same session ID appears in both, the OTEL version is used.
//
// TRDD-X2E6OSWK: write through putLogSession/clearLogSessions, NEVER `logSessions.set(...)` directly.
// The derived-view caches are keyed on `dataVersion`, so a write that forgets to bump it would leave
// the dashboard showing the PREVIOUS state until some unrelated mutation happened to bump it. Routing
// every write through one funnel makes that class of bug impossible by construction rather than by
// discipline. (Reads — get/has/values/size — go straight to the map.)
let logSessions: Map<string, SessionSummaryCard> = new Map()

function putLogSession(card: SessionSummaryCard): void {
  logSessions.set(card.sessionId, card)
  markDataChanged()
}

function clearLogSessions(): void {
  logSessions.clear()
  markDataChanged()
}

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
    // P7 provenance — carried through ONLY when the export recorded a valid value; a legacy
    // export without it imports as undefined ("unknown"), never a fabricated stamp.
    tokensSource:      raw['tokensSource'] === 'log' || raw['tokensSource'] === 'otel' || raw['tokensSource'] === 'merged'
      ? raw['tokensSource'] : undefined,
    coverageNote:      typeof raw['coverageNote'] === 'string' ? raw['coverageNote'] : undefined,
  }
}

let logReader = new LogReader()
// P7: overlays authoritative context size + cost from the Claude Code statusline usage log onto each
// card before it is served. No-op for sessions/agents that wrote no statusline line.
const statuslineReader = new StatuslineUsageReader()
// TRDD-YQZ9P8IL — the account-state timeline writer (its own 60s flush timer, unref'd; flushed on
// shutdown below). Sampled by the burn tick; change-detection means writes happen only on a real state
// change (~a few/hour), never per request.
const accountStateTimeline = new AccountStateTimeline()

// ── Burn monitor (TRDD-OG9PARZQ) ───────────────────────────────────────────────
// Realtime "smoke detector": rolling burn rate + rate-limit window budget + threshold alerts, computed
// over the already-ingested live data (OTEL api_request timeline events + statusline billing deltas).
// `let`, not `const`: P5 auto-calibration reloads it after persisting an observed capacity so the very
// next burn tick projects against the freshly measured cap without a restart.
let burnConfig = loadBurnConfig(process.env, os.homedir())

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
  // TRDD-OCNHOHE9: a session's timeline, reparsing a disk-restored stripped card on demand (same
  // path /api/timeline uses). Without this the MCP tools fell back to the card's empty inline
  // timeline, so check_cache_expiry could not find the last api_request ts and returned 'unknown'.
  getTimeline: (id) => resolveSessionCard(id)?.timeline ?? [],
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
  // TRDD-B22NYTOY: the NARRATIVE conversation (verbatim ordered turns). Same fork/ancestor fallback.
  getConversation: (id) => {
    const sess = buildSessionSummary()?.sessions ?? []
    const parentOf = (sid: string): string | undefined => sess.find(s => s.sessionId === sid)?.parentSessionId
    return buildConversation(id, resolveLoggedAncestor(id, parentOf) ?? parentOf(id))
  },
  // TRDD-ICHAVFCS: resolve a call (sessionId + requestId/spanId) to its full literal context tree,
  // reconstructed from the raw OTEL request body indexed by the collector. Works for OTEL-only sessions.
  getCallContext: (sessionId, sel) => resolveCallContext(sessionId, sel),
  // TRDD-OG9PARZQ: realtime burn status + one-call session self-diagnostic for the fleet's Claudes.
  // TRDD-VY1IUVUM: pass the machine TtlContext so each session's keepWarm classifies against ITS
  // resolved regime (main/subagent/fork × auth) instead of silently defaulting to ASSUMED_TTL_REGIME
  // — without this the 5-min floor was applied even to subscription main sessions riding the 1h tier.
  getBurnStatus: () => { const { sessions, events, now } = gatherBurn(); return computeBurnStatus(events, sessions, burnConfig, now, currentTtlContext()) },
  getSessionStatus: (sel) => { const { sessions, events, now } = gatherBurn(); return computeSessionStatus(sessions, events, burnConfig, sel, now, currentTtlContext()) },
  // TRDD-BURNWDGT: the current live OAuth account (identity + plan) for get_account_status + window labels.
  getAccount: () => getCurrentAccount(),
  // TRDD-VY1IUVUM Part-5: the machine's TTL context (auth regime + env overrides) for the
  // get_account_status human-readable summary's cacheTtl field.
  getTtlContext: () => currentTtlContext(),
  // TRDD-VY1IUVUM Part-5: Claude Code's own rate_limits.{five_hour,seven_day}.utilization, when the
  // statusline build persists it into the usage log — the authoritative window-fill source for
  // get_account_status. null when absent (a statusline.py build that doesn't emit it yet, or no
  // recent-enough record) — the handler falls back to AgentlensPro's own calibrated pct.
  getRateLimits: () => statuslineReader.getLatestRateLimits(),
  // TRDD-GOD0108C: hot-path feeds for check_burn_risk — the in-memory event ring (zero disk)
  // and the incremental bodies tracker (CACHE_THRASH + huge-request burst without full stats).
  getRecentHookEvents: () => recentHookEvents,
  getBodiesActivity: () => bodiesActivityReport(),
  // TRDD-1FEIW17E: get_body_writers reads all-time per-session totals from the durable store —
  // same lazy-open the ingest pass uses, so the first call after boot pays the open, not every call.
  getStore: async () => (bodyStore ??= await openStore({ dir: path.join(DATA_DIR, 'store') })),
  // TRDD-1XM0YSWQ: get_account_burners ranks sessions inside one account's window — same deduped
  // event stream the burn tick consumes, gathered fresh so the answer reflects this instant.
  getConsumptionEvents: () => gatherBurn().events,
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

// macOS notification, strictly opt-in (AGENTLENS_NOTIFY=1). No-op off macOS or when notify is disabled.
// SECURITY: the script is handed to osascript via execFile (argv), NOT a shell string. A shell string
// (`osascript -e '…'`) wraps the AppleScript in a single-quoted shell arg, so an apostrophe in the
// alert detail — routine, e.g. a session prompt "fix the user's login" flowing through sessionLabel —
// closes the shell quote and lets /bin/sh parse the rest (a crafted prompt → arbitrary command
// execution). execFile runs osascript directly with no shell, so `esc` only needs to protect the
// AppleScript string literal (its `"`/`\`); a `'` is now inert.
function macNotify(alert: BurnAlert): void {
  if (!burnConfig.notify || process.platform !== 'darwin') return
  const esc = (s: string) => s.replace(/["\\]/g, '\\$&').slice(0, 240)
  const script = `display notification "${esc(alert.detail)}" with title "AgentLens: ${esc(alert.label)}"`
  execFile('osascript', ['-e', script], () => {})
}

// The tick's latest status, reused by hot request paths (/api/burn-risk): recomputing
// gatherBurn per request measured ~270ms; the cache is at most 4s stale — invisible against
// the 5-min burn window it feeds (TRDD-9CNHP8CN).
let lastBurnStatus: ReturnType<typeof computeBurnStatus> | null = null

function tickBurn(): void {
  let status
  try {
    const { sessions, events, now } = gatherBurn()
    // TRDD-VY1IUVUM: same TTL-aware wiring as the getBurnStatus accessor above — the SSE tick feeds
    // the dashboard AND seeds currentTtlContext()'s own usage-credit signal (lastBurnStatus), so
    // omitting it here would leave the ticked keepWarm data on the assumed 5-min floor forever.
    status = computeBurnStatus(events, sessions, burnConfig, now, currentTtlContext())
  } catch (e) {
    console.warn('[AgentLens] burn tick error:', e)
    return
  }
  lastBurnStatus = status
  // TRDD-YQZ9P8IL: sample the current subscription state onto the change-detected timeline. record()
  // only enqueues on a discrete change (account/mode/plan/ttl), so this 4s call is a cheap key compare
  // in the common case and a real write only a few times/hour. currentTtlContext() is 60s-cached.
  try { accountStateTimeline.record(buildAccountStateRecord(getCurrentAccount(), currentTtlContext(), Date.now())) } catch { /* never let timeline sampling break the burn tick */ }
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

// TRDD-X2E6OSWK — INCREMENTAL LOG SCANNING.
//
// The old design ran a FULL scan (recursive readdir of every log root + one statSync per file —
// ~12,508 files on this machine) on a flat 5s timer AND on every debounced fs.watch burst. Profiled
// on the live server it burned ~8.5% of wall-clock CPU forever, and it got WORSE the more agent
// sessions were running (more writes → more watch events → more full sweeps).
//
// Now: fs.watch already tells us WHICH file changed, so the steady-state scan stats only those paths
// (typically 1–3), and the full sweep is demoted to a slow correctness BACKSTOP. The backstop is not
// optional: recursive fs.watch on macOS (FSEvents) coalesces and can drop events under load, and a
// dir that did not exist at startup never got a watcher at all — so a periodic full sweep is the
// only thing that guarantees no file is missed. It just must not be the steady-state path.
const FULL_RESCAN_MS = 60_000
// Absolute paths named by fs.watch since the last scan. Drained by each targeted scan.
const pendingWatchPaths = new Set<string>()
// Set when a watch event arrives with NO filename (the platform coalesced it away). We cannot target
// what we cannot name, so the next scan is promoted to a full sweep instead of guessing — guessing
// would silently drop a session's new lines, and losing log lines is not a tradeoff we make.
let watchNeedsFullScan = false

function runLogScan(mode: 'full' | 'targeted' = 'full') {
  let results: ReturnType<typeof logReader.scan>
  if (mode === 'full') {
    pendingWatchPaths.clear()   // a full sweep subsumes every pending hint
    results = logReader.scan()
  } else {
    if (pendingWatchPaths.size === 0) return
    const paths = [...pendingWatchPaths]
    pendingWatchPaths.clear()
    results = logReader.scan(paths)
  }
  // logReader.scan() returns ONLY sessions whose byte offset advanced (incremental tail — unchanged
  // files return null), so `changedCards` is exactly the set that grew this scan. That set drives
  // the immediate targeted push below; the heavier full-summary rebuild stays coalesced.
  const changedCards: SessionSummaryCard[] = []
  for (const { card, childCards } of results) {
    statuslineReader.overlay(card)
    putLogSession(card)
    changedCards.push(card)
    for (const child of childCards ?? []) { putLogSession(child); changedCards.push(child) }
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

// Debounced scan triggered by fs.watch events — fires 300 ms after the last event. Events arrive in
// bursts (one JSONL append can emit several), so the debounce collapses a burst into ONE scan over
// the union of the paths it named.
let watchScanTimer: ReturnType<typeof setTimeout> | null = null
function scheduleWatchScan() {
  if (watchScanTimer) clearTimeout(watchScanTimer)
  watchScanTimer = setTimeout(() => {
    watchScanTimer = null
    const mode = watchNeedsFullScan ? 'full' : 'targeted'
    watchNeedsFullScan = false
    runLogScan(mode)
  }, 300)
}

/** Returns how many watchers actually attached, so a total failure can be reported instead of
 *  silently degrading log freshness to the slow backstop. */
function setupLogWatcher(): { attached: number; failed: string[] } {
  let attached = 0
  const failed: string[] = []
  for (const dir of logReader.getWatchDirs()) {
    try {
      fs.watch(dir, { recursive: true, persistent: false }, (_event, filename) => {
        // `filename` is relative to `dir` on every platform that supports recursive watching.
        if (filename) pendingWatchPaths.add(path.resolve(dir, filename.toString()))
        else watchNeedsFullScan = true
        scheduleWatchScan()
      })
      attached++
    } catch { failed.push(dir) }   // dir may not exist yet — the backstop sweep will still cover it
  }
  return { attached, failed }
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

  // TRDD-PJC8N1HO spec 3 / TRDD-K3WDPR7M Phase 4: FAST RESTART. Load the delta logs so the first scan
  // SKIPS every unchanged file (0 cold-start full reads) instead of re-parsing ~12k files from byte 0,
  // and restores the stripped log cards so the dashboard list + MCP are fresh in <5s. load() runs
  // UNCONDITIONALLY (even when the version stamp below is stale) so DeltaLog's internal `written`
  // hashes are seeded from whatever is on disk — otherwise the first post-rescan save() would re-append
  // every record instead of diffing against it. Only the RESTORE is gated on the version stamp.
  let cardsMap = cardsLog.load()
  let offsetsMap = offsetsLog.load()
  let deltaCurrent = deltaVersionIsCurrent()

  // One-time migration (TRDD-K3WDPR7M): the legacy whole-file sidecar still exists and the delta log
  // has never been seeded. loadPersistedCards/loadLogOffsets already refuse a version-stale legacy file
  // (return null), so migrated data is current-version by construction — stamp it immediately so the
  // restore check right below (on this SAME boot) doesn't discard what was just migrated. The legacy
  // file is deliberately NOT deleted (RULE 0 — a follow-up task reclaims it once the delta log has
  // proven itself).
  if (cardsMap.size === 0 && cardsLog.diskBytes() === 0 && fs.existsSync(CARDS_FILE)) {
    const legacyCards = loadPersistedCards(CARDS_FILE)
    if (legacyCards && legacyCards.length > 0) {
      cardsMap = new Map<string, SessionSummaryCard>(legacyCards.map((c): [string, SessionSummaryCard] => [c.sessionId, c]))
      cardsLog.save(cardsMap)
      stampDeltaVersion()
      deltaCurrent = true
      console.log(`[AgentLens] Migrated ${cardsMap.size} session card(s) from legacy ${path.basename(CARDS_FILE)} into the delta log`)
    }
  }
  if (offsetsMap.size === 0 && offsetsLog.diskBytes() === 0 && fs.existsSync(OFFSETS_FILE)) {
    const legacyOffsets = loadLogOffsets(OFFSETS_FILE)
    if (legacyOffsets) {
      offsetsMap = new Map<string, PersistedFileState>(Object.entries(legacyOffsets))
      offsetsLog.save(offsetsMap)
      stampDeltaVersion()
      deltaCurrent = true
      console.log(`[AgentLens] Migrated ${offsetsMap.size} log tail offset(s) from legacy ${path.basename(OFFSETS_FILE)} into the delta log`)
    }
  }

  let restoredFromDisk = false
  if (deltaCurrent && cardsMap.size > 0) {
    for (const card of cardsMap.values()) putLogSession(card)
    restoredFromDisk = true
  }
  if (deltaCurrent && offsetsMap.size > 0) {
    const { imported, skipped } = logReader.importFileState(Object.fromEntries(offsetsMap))
    console.log(`[AgentLens] Resumed ${imported} log tail offset${imported !== 1 ? 's' : ''} (${skipped} invalid/rotated → cold read)${restoredFromDisk ? `; restored ${cardsMap.size} session cards` : ''}`)
  } else if (!deltaCurrent && (cardsMap.size > 0 || offsetsMap.size > 0)) {
    console.log(`[AgentLens] Log-ingest semantics changed (v${LOG_INGEST_VERSION}) — cold-rescanning; stale delta-log entries will be tombstoned on the next durable save`)
  }

  // Watch log directories for file-system events: this is the STEADY-STATE path — an event names the
  // changed file, so the debounced scan stats only that file (TRDD-X2E6OSWK).
  const watch = setupLogWatcher()
  if (watch.failed.length > 0) {
    console.warn(`[AgentLens] No fs.watch on ${watch.failed.length} log dir(s) — they refresh only on the ${FULL_RESCAN_MS / 1000}s backstop sweep: ${watch.failed.join(', ')}`)
  }
  // The full sweep is the correctness BACKSTOP for what the watcher coalesces, drops, or never saw.
  // If NOT ONE watcher attached there is no steady-state path at all, so fall back to the old fast
  // full-poll cadence rather than silently degrading every session's freshness to 60s.
  const rescanMs = watch.attached > 0 ? FULL_RESCAN_MS : 5_000
  if (watch.attached === 0) console.warn(`[AgentLens] fs.watch unavailable on every log dir — falling back to a ${rescanMs / 1000}s full poll (higher CPU)`)
  setInterval(() => runLogScan('full'), rescanMs)
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
    putLogSession(card)
    countByKey.set('opencode', (countByKey.get('opencode') ?? 0) + 1)
  }

  // spec 3: when cards were restored from disk, the cold full-file batch below is UNNECESSARY (and is
  // exactly the minutes-long rescan we are eliminating) — the fs.watch hints + the backstop sweep
  // already registered above will incrementally pick up any file that changed while the collector was
  // down. Push the restored list to any connected browser and return.
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
        putLogSession(result.card)
        for (const child of result.childCards ?? []) putLogSession(child)
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

// S3-F3a: replace/append a string attribute on the standalone's RawAttr shape. Mirrors otlpParser's
// setStringAttr/withStringAttr semantics (set overwrites an existing key; with only adds when
// absent) — kept type-local because the standalone carries RawAttr, not SpanAttribute.
function setCodexStringAttr(attrs: RawAttr[], key: string, value: string): RawAttr[] {
  if (!value) return attrs
  let replaced = false
  const next = attrs.map((a) => {
    if (a.key !== key) return a
    replaced = true
    return { key, value: { stringValue: value } }
  })
  return replaced ? next : [...next, { key, value: { stringValue: value } }]
}
function withCodexStringAttr(attrs: RawAttr[], key: string, value: string): RawAttr[] {
  if (!value || attrs.some((a) => a.key === key)) return attrs
  return [...attrs, { key, value: { stringValue: value } }]
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

// S3-F3a: ONE long-lived Codex session normalizer for the SHIPPED log-ingest path. Module-level so
// its per-prompt grouping state persists across processLogs calls (each OTLP POST is a separate
// call) — exactly as the OtlpCollector's instance field does for the extension path.
const codexNorm = new CodexSessionNormalizer()

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
        let attrs = mergeAttrs(toAttrs(r.attributes), attrsFromBodyKv(r.body), scopeAttrs, resourceAttrs)
        // Name resolution + prefix normalization + gate sets shared with src/otlpCollector.ts via
        // src/otlpLogEvents.ts. This path DRIFTED once: it never gained the rich-event gate, so the
        // running server dropped every api_request/compaction/api_error event under BOTH naming
        // conventions while the unit-tested collector class passed (found 2026-07-10).
        const name = resolveLogEventName(attrStr(attrs, 'event.name', 'event_name', 'name', 'event'), r)
        const bare = bareLogEventName(name)
        // S3-F3b: gen_ai_latest_experimental (Codex/OpenAI) emits the assistant's RESPONSE TEXT as a
        // separate log event (gen_ai.choice / gen_ai.assistant.message), not as a span attribute — it
        // is correlated to its LLM span by traceId:spanId and can arrive before OR after that span, on
        // a different HTTP request. The rich-event gate below would DROP it (noteDroppedLogEvent), so
        // handle it FIRST: format it into the gen_ai.output.messages shape extractResponseText reads,
        // and record a read-time overlay on the store. The overlay merges into the matching span
        // whenever that span is next read (loadRange), so ordering does not matter and no persisted
        // segment is rewritten. Mirrors src/otlpCollector.ts (the extension-host path) via the shared
        // formatGenAiEventContent — the ONE formatter both ingest paths import.
        if (name === 'gen_ai.choice' || name === 'gen_ai.assistant.message') {
          const genTrace = typeof r.traceId === 'string' ? r.traceId : ''
          const genSpan = typeof r.spanId === 'string' ? r.spanId : ''
          if (genTrace && genSpan) {
            const raw = attrStr(attrs, 'gen_ai.event.content')
            const formatted = raw ? formatGenAiEventContent(raw, name) : ''
            if (formatted) { spanStore.injectSpanAttribute(genTrace, genSpan, 'gen_ai.output.messages', formatted) }
          }
          continue
        }
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
          // TRDD-AMEA4O4Z: not ingested as a span, but never discarded — persist the full event
          // (merged attrs + ids + body) to the append-only log-events sink. tool_decision,
          // mcp_server_connection, hook_registered etc. exist NOWHERE else.
          persistDroppedLogEvent(name, bare, attrs, r)
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
          // S3-F3a: group Codex per PROMPT (`codex:<conv>:prompt-N`) via the shared normalizer — the
          // SAME grouping the OtlpCollector/otlpParser paths use. The SHIPPED server previously keyed
          // the store traceId on the conversation id alone, DRIFTING from those two impls. This did
          // NOT change /api/summary output: the summarizer's own groupCodexSpansBySession
          // (src/summarizers/codex.ts) re-derives per-prompt sessions downstream regardless of the
          // store key. The value here is store-level CONSISTENCY (one grouping across every ingest
          // impl) AND stamping `codex.session.id` so the summarizer honors the explicit id instead of
          // re-deriving it — closing the drift so a future raw-store consumer can't be misled.
          // NB: groupCodexSpansBySession is a FOURTH copy of this ordinal logic (see TRDD-4AFOFVFD
          // §S3-F3a follow-up) — the true single-source unification should fold it in too.
          const otlpTraceId = (typeof r.traceId === 'string' && r.traceId) ? r.traceId : ''
          const convId = attrStr(attrs,
            'conversation.id', 'conversation_id',
            'codex.conversation.id',
            'thread.id', 'thread_id',
            'session.id', 'session_id',
            'trace_id', 'traceId',
          )
          const turnId = attrStr(attrs, 'turn.id', 'turn_id', 'codex.turn.id')
          const conversationKey = convId || otlpTraceId || fallback
          const sessionId = codexNorm.resolveSessionId({ conversationId: conversationKey, otlpTraceId, turnId, spanName: name })
          traceId = sessionId || otlpTraceId || conversationKey
          if (sessionId) {
            attrs = setCodexStringAttr(attrs, 'codex.session.id', sessionId)
            attrs = setCodexStringAttr(attrs, 'codex.conversation.id', conversationKey)
            if (turnId) { attrs = setCodexStringAttr(attrs, 'codex.turn.id', turnId) }
          }
          // Preserve the raw OTEL trace id when we remap the span onto its prompt session, so the
          // collector/summarizer trace-fold path can still reach it (mirrors otlpParser).
          if (otlpTraceId && sessionId && otlpTraceId !== traceId) {
            attrs = withCodexStringAttr(attrs, 'otel.trace_id', otlpTraceId)
          }
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

  // Per-turn CONTEXT size for the sidebar sparkline. Entries carry the four disjoint buckets
  // (inputTokens is only the raw uncached share since the 2026-07-10 entry normalization), so the
  // turn's prompt size is derived as input + cacheRead + cacheCreation via the shared helper.
  const turnInputTokens = latest
    ? (latest.timeline ?? [])
        .filter(e => e.type === 'llm' && contextTokens(e) > 0)
        .map(e => contextTokens(e))
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
    // inputTokens IS the raw uncached input since the 2026-07-10 one-convention fix (four
    // disjoint buckets) — the old subtraction here would zero the input component out.
    costUsd: calcTokenCostUsd(
      latest.inputTokens,
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
  return summaryCache.get(dataVersion, computeSessionSummary)
}

// Pre-merge side-map: sessionId → the OTEL card's `api_request` attribution entries. Captured
// BEFORE mergeOtelAndLogSessions drops the OTEL twin, so resolveSessionCard can graft the one
// timeline dimension only OTEL carries back onto the served log card (TRDD-5GFSFX0Q). Holds
// references (no copies) and is rebuilt together with the memoized summary, so it can never go
// stale relative to the cards it serves.
let otelAttributionBySession = new Map<string, TimelineEntry[]>()

function computeSessionSummary(): ReturnType<typeof summarizeSpans> | null {
  let summary: ReturnType<typeof summarizeSpans> | null = null
  try { summary = summarizeSpans(spans) } catch (e) { console.warn('[AgentLens] summarizeSpans error:', e) }

  otelAttributionBySession = new Map(
    (summary?.sessions ?? [])
      .filter(s => s.source === 'claude_code')
      .map(s => [s.sessionId, (s.timeline ?? []).filter(e => e.type === 'api_request')] as const)
      .filter(([, entries]) => entries.length > 0),
  )

  // Merge log-sourced sessions. On ID collision the source's PREFERRED feed wins
  // (src/feedMergePolicy.ts): for Claude the LOG transcript card wins — transcripts are durable
  // and call-complete while OTEL is a measured lossy lower bound (collector downtime + the
  // in-memory summarization window; the pre-P4 MAX_SPANS eviction was the third cause —
  // reports/token-discrepancy/20260710_141134+0200-otel-vs-jsonl.md §5.6) — and OTEL
  // wins for every other source. OTEL-only sessions (no transcript) still serve.
  if (logSessions.size > 0) {
    // P8: collapse each async/sync spawn placeholder with its subagents/*.jsonl transcript twin so a
    // child serves ONCE, with real parsed totals (spawnAsync clears → the rollup's
    // asyncUnreportedChildren decrements). Runs on the merged list because the placeholder (parent
    // transcript) and the twin (child transcript) come from different files/scans.
    const merged = linkSubagentTranscripts(mergeOtelAndLogSessions(summary?.sessions ?? [], [...logSessions.values()]))
      .sort((a, b) => Date.parse(b.startTime || '0') - Date.parse(a.startTime || '0'))
    summary = { ...(summary ?? { backgroundSpans: [], efficiency: { totalInputTokens: 0, totalOutputTokens: 0, totalLlmCalls: 0, avgInputPerCall: 0, avgTtft: 0, cacheHitRate: 0, toolDefWaste: 0, sysInstructionWaste: 0, topTokenConsumers: [] } }), sessions: merged }
  }
  return summary
}

// Resolve one session's card, reparsing a disk-restored card whose timeline was STRIPPED on startup
// (TRDD-PJC8N1HO spec 3: the offset resume skips the file, so the card carries an empty timeline until
// it is actually drilled). Shared by the lazy /api/timeline route AND the MCP getTimeline accessor, so
// both surfaces see the same reconstructed entries — check_cache_expiry (TRDD-OCNHOHE9) needs the last
// api_request/llm timestamp, which a stripped card lacks until this reparse runs.
function resolveSessionCard(sessionId: string): SessionSummaryCard | null {
  const summary = buildSessionSummary()
  let session = summary?.sessions.find(s => s.sessionId === sessionId) ?? null
  if (session && (session.timeline?.length ?? 0) === 0 && logSessions.has(sessionId)) {
    try {
      const reparsed = logReader.reparseSession(sessionId)
      if (reparsed) {
        statuslineReader.overlay(reparsed.card)
        putLogSession(reparsed.card)
        session = reparsed.card
      }
    } catch { /* on-demand rebuild is best-effort — fall back to the stripped card's empty timeline */ }
  }
  // TRDD-5GFSFX0Q: a log card that won the Phase B collision carries the transcript timeline,
  // which has NO api_request attribution entries (those live only on the displaced OTEL twin).
  // Graft them onto a SHALLOW COPY so the stored card stays pure (the reparse path re-stores the
  // untouched transcript card, keeping the graft idempotent per drill) and every drill consumer —
  // get_cost_by_cause, /api/timeline, the webview per-cause toggle — gets the attribution back.
  if (session && session.source === 'claude_code' && session.dataSource === 'log') {
    const otelEntries = otelAttributionBySession.get(sessionId)
    if (otelEntries !== undefined && otelEntries.length > 0) {
      session = { ...session, timeline: graftOtelAttribution(session.timeline ?? [], otelEntries) }
    }
  }
  return session
}

// Drop the heavy per-session detail (full timeline + per-file ops) from the inlined/broadcast
// payload — across thousands of sessions these add up to tens of MB and freeze the browser on
// first paint. Both are fetched lazily per session via /api/timeline/:id (loadSessionDetail).
function stripSessionDetail(summary: ReturnType<typeof summarizeSpans> | null): ReturnType<typeof summarizeSpans> | null {
  if (!summary) return null
  return { ...summary, sessions: summary.sessions.map(s => ({ ...s, timeline: [], fileOps: undefined, generatedFiles: undefined, generatedFilesTruncated: undefined })) }
}

// The three memoized derivations of the summary. Each is a PURE function of (spans, logSessions) —
// no clock, no request state — so caching them on `dataVersion` is sound. `computeSidebarPayload` is
// deliberately NOT here: it reads Date.now() (isActive / lastActivityMs / burnRate), so a cached copy
// would freeze the "session is live" indicator once the data stopped changing.
function buildStrippedSummary(): ReturnType<typeof summarizeSpans> | null {
  return strippedCache.get(dataVersion, () => stripSessionDetail(buildSessionSummary()))
}
function buildSidebarData(): ReturnType<typeof computeSidebarData> | null {
  return sidebarCache.get(dataVersion, () => {
    const s = buildSessionSummary()
    return s ? computeSidebarData(s, spans) : null
  })
}
function buildAnalyticsData(): ReturnType<typeof computeAnalyticsData> | null {
  return analyticsCache.get(dataVersion, () => {
    const s = buildSessionSummary()
    return s ? computeAnalyticsData(s.sessions) : null
  })
}

function buildUpdatePayload(): string {
  const sessionSummary = buildSessionSummary()
  const stripped = buildStrippedSummary()
  const sidebar = buildSidebarData()
  const sidebarLive = sessionSummary ? computeSidebarPayload(sessionSummary, spans) : null
  const analyticsData = buildAnalyticsData()
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
// summarizeSpans(the whole summarization window) + sidebar + analytics + JSON.stringify; calling it on EVERY
// incoming OTLP POST (firehose rate = many/sec once logs+metrics+traces+raw-bodies are all enabled)
// produced allocation churn faster than GC could reclaim → the heap filled and the process was
// OOM-killed (FATAL mark-compact) in ~40s. Debouncing to at most once per PUSH_COALESCE_MS turns N
// firehose POSTs into ONE rebuild, so the working set stays bounded and RSS plateaus. Trailing-edge
// (not leading) so a burst emits exactly one update after it settles.
//
// TRDD-X2E6OSWK — the floor was 1000 ms, and under the normal load of this machine (several agent
// sessions appending JSONL continuously) it was re-armed continuously and fired at that floor
// indefinitely: a FULL dashboard rebuild every second, forever, measured at ~19% of the process's
// wall-clock CPU. 4000 ms is the same cadence the burn tick already runs at, and it costs the
// dashboard NOTHING in liveness: the instant a session's log grows, pushSessionChanged() above sends
// the changed cards immediately (sub-second, untouched by this constant). What this timer coalesces
// is only the AGGREGATE view — sidebar counters, analytics roll-ups, the OTEL-wins re-merge — which
// no user can perceive updating 4× a second. It also lines up with tickBurn's 4s beat, so the two now
// usually share ONE memoized summary rebuild (same dataVersion) instead of forcing two.
const PUSH_COALESCE_MS = 4000
let pushTimer: ReturnType<typeof setTimeout> | null = null
function schedulePushUpdate() {
  if (pushTimer) return
  pushTimer = setTimeout(() => { pushTimer = null; pushUpdate() }, PUSH_COALESCE_MS)
}

// ── Dashboard HTML ────────────────────────────────────────────────────────────

// `restrictedViewer` is REQUIRED, not defaulted (WYC4KB50 #5): a `= false` default would fail OPEN —
// a future call site that forgot the arg would silently serve the full (unrestricted) settings chrome
// to a restricted viewer. Making it mandatory turns that omission into a compile error.
function getHtml(restrictedViewer: boolean): string {
  const sessionSummary = buildSessionSummary()
  // Strip full timeline + per-file ops before inlining — they can be many MB across sessions.
  // Both are loaded lazily via /api/timeline/:sessionId after first paint.
  const sessionSummaryJson = safeJson(buildStrippedSummary())
  const sidebarLive = sessionSummary ? computeSidebarPayload(sessionSummary, spans) : {
    isActive: false, lastActivityMs: 0, sessionCount: 0, agentSources: [], currentSession: null, burnRate: null,
  }
  const sidebarInitJson = safeJson(sidebarLive)

  // TRDD-1ZH1D5EG — the meta tag is how the RESTRICTED verdict (decided server-side from the
  // signed X-Agentlens-Viewer assertion) reaches the webview: the boot code reads it and hides
  // the settings chrome. UI-only convenience — the real enforcement is the server's method gate.
  const viewerMeta = restrictedViewer ? '\n  <meta name="agentlens-viewer" content="restricted">' : ''

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">${viewerMeta}
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

// Byte accounting: DeltaLog.save() returns exactly what it wrote to the device, so no statSync of a
// (now unused) whole file is needed. Writes/Bytes are only bumped when bytes > 0 — DeltaLog's whole
// point is that an unchanged save costs ZERO device writes, and counting one of those as "a write"
// would hide the very fix this delta log exists to prove.
function sizeOf(file: string): number {
  try { return fs.statSync(file).size } catch { return 0 }
}
function saveOffsetsNow(): void {
  try {
    const records = new Map<string, PersistedFileState>(Object.entries(logReader.exportFileState()))
    const r = offsetsLog.save(records)
    if (r.bytes > 0) {
      persistStats.offsetsWrites++
      persistStats.offsetsBytes += r.bytes
      stampDeltaVersion()
    }
  } catch (e) { console.warn('[AgentLens] Could not save log offsets:', e) }
}
function saveCardsNow(): void {
  try {
    const records = new Map<string, SessionSummaryCard>()
    for (const [id, card] of logSessions) records.set(id, stripCardForPersist(card))
    const r = cardsLog.save(records)
    if (r.bytes > 0) {
      persistStats.cardsWrites++
      persistStats.cardsBytes += r.bytes
      stampDeltaVersion()
    }
    lastCardsSave = Date.now()
  } catch (e) { console.warn('[AgentLens] Could not save log cards:', e) }
}
const durableSaveTimer = setInterval(() => {
  if (offsetsDirty) { offsetsDirty = false; saveOffsetsNow() }
  if (cardsDirty && Date.now() - lastCardsSave >= CARDS_SAVE_MS) { cardsDirty = false; saveCardsNow() }
}, OFFSETS_SAVE_MS)
durableSaveTimer.unref()

// ── UI server ─────────────────────────────────────────────────────────────────

// CSRF / cross-origin guard for STATE-CHANGING requests. The UI server binds to 127.0.0.1, but a page
// the user is browsing (evil.com) can still POST to http://localhost:<port> from the user's OWN browser
// — a "simple" text/plain POST needs no CORS preflight, and a write side-effect lands before any
// (blocked) response is read. Several handlers below turn request fields into filesystem writes
// (/api/instructions/apply → appendFileSync at a caller-supplied path, /api/bodies/export → archive
// extraction to a caller-supplied dir, /action → clearAll), so an unguarded cross-origin POST is an
// arbitrary-file-write → code-execution vector. A browser sets `Origin` on every cross-origin request
// (and on same-origin POSTs, where it equals the page origin); we refuse any request whose Origin is
// present and neither same-origin (Origin.host === Host — works on any BIND_HOST) nor loopback. The
// dashboard is same-origin (allowed); CLI/hook Node clients send no Origin (allowed). One gate closes
// the whole class regardless of the blanket ACAO:* header.
// The predicate lives in src/httpOrigin.ts — SHARED with the MCP endpoint (startMcpHttpServer),
// so "which origins are allowed" has exactly one definition for every locally-bound HTTP surface.

// Set Access-Control-Allow-Origin ONLY for an allowed origin (same-origin or loopback), never the
// wildcard. The UI read endpoints (/api/summary, /api/sessions, /api/session/*, /api/debug/*) carry
// the user's AI-session data — prompt text, costs, model names, project file paths — so a blanket
// ACAO:* let ANY page the user browses (evil.com) fetch http://localhost:<UI_PORT>/api/* and READ
// the JSON cross-origin (a drive-by localhost-exfil, the READ counterpart to the write vector the
// CSRF gate closes). The dashboard is same-origin (needs no ACAO); loopback tooling gets its origin
// echoed; a cross-origin page gets NO ACAO, so the browser blocks it from reading the body. Reuses
// isDisallowedCrossOrigin so "which origins are allowed" lives in ONE place (src/httpOrigin.ts).

// Accumulate a request body with a hard byte cap + an error listener, mirroring the guarded
// /api/hook-events and /api/agent-gate handlers. On overflow the socket is destroyed and onBody is NOT
// invoked (no response is possible after destroy); a transport error is swallowed so a mid-stream
// socket failure can never crash the collector. Consolidates the cap+error pattern that several POST
// handlers were missing — an uncapped body on a localhost server reachable cross-origin is an OOM/DoS
// surface (the exact class TRDD-PJC8N1HO hardened elsewhere).
function readBodyCapped(req: http.IncomingMessage, maxBytes: number, onBody: (buf: Buffer) => void): void {
  const chunks: Buffer[] = []
  let received = 0
  let overflowed = false
  req.on('data', (c: Buffer) => {
    received += c.length
    if (received > maxBytes) { overflowed = true; req.destroy() }
    else chunks.push(c)
  })
  req.on('error', () => { /* transport error — never crash the collector */ })
  req.on('end', () => { if (!overflowed) onBody(Buffer.concat(chunks)) })
}

// D3K7QM2P/1c — one resource monitor + one admission controller shared by BOTH HTTP servers (the
// process has ONE resource pool). Under 20+ concurrent Claude instances the controller bounds
// in-flight work, queues the overflow briefly, and sheds (503 + Retry-After) only at a hard wall —
// LOSS-FREE: a shed hook is spooled by the CLI (1a) + drained later, a shed OTLP export is retried
// by the exporter / backfilled by the next scan, and a shed gate fails OPEN (never blocks a launch).
const resourceMonitor = new ResourceMonitor(DATA_DIR)
const admission = new AdmissionController(admissionLimitsFromEnv(process.env, Math.max(1, os.cpus().length)), () => resourceMonitor.sample())

// These endpoints must ALWAYS answer, even at capacity: /events is a long-lived SSE stream (holding
// an admission slot for its whole lifetime would drain the pool), /api/server-stats is how monitors
// and the CLI read health under load, GET /api/hook-config is the kill-switch read (you must be able
// to turn capture/gate OFF when the box is on fire), and GET /api/embed-status is a header-only wiring
// probe the embedding proxy's health-check hits (WYC4KB50 #9 — the gate block returns it before
// admission today, but registering it here keeps it exempt if that block is ever reordered).
function isAdmissionExempt(method: string, url: string): boolean {
  return url === '/events'
    || url === '/api/server-stats'
    || (method === 'GET' && url === '/api/hook-config')
    || (method === 'GET' && url === '/api/embed-status')
}
function sendBusy(res: http.ServerResponse, adm: AdmitResult): void {
  res.writeHead(503, { 'Content-Type': 'application/json', 'Retry-After': String(adm.retryAfterSec ?? 1) })
  res.end(JSON.stringify({ error: 'server busy — backpressure', reason: adm.reason }))
}
// Release the admission slot exactly once, whether the response finished normally or the client
// aborted mid-flight — a 'finish' THEN 'close' must not double-decrement.
function admitLeaveOnDone(res: http.ServerResponse): void {
  let left = false
  const leaveOnce = (): void => { if (!left) { left = true; admission.leave() } }
  res.on('finish', leaveOnce)
  res.on('close', leaveOnce)
}

const uiServer = http.createServer(async (req, res) => {
  const url = (req.url ?? '/').split('?')[0]
  instrumentResponse(req, res, url)
  // ACAO only for allowed (same-origin/loopback) origins — never the wildcard (see setAllowedOriginCors:
  // the read endpoints carry the user's session data, so ACAO:* was a cross-origin read-exfil vector).
  setAllowedOriginCors(req, res)

  // Refuse cross-origin browser mutations (CSRF) before any handler runs. GET/HEAD are guarded from
  // READS by the scoped ACAO above (a disallowed origin gets no readable response); we additionally
  // refuse state-changing methods here because those carry a write side effect the browser cannot undo.
  if (req.method !== 'GET' && req.method !== 'HEAD' && isDisallowedCrossOrigin(req)) {
    res.writeHead(403, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'cross-origin request refused' }))
    return
  }

  // TRDD-1ZH1D5EG — the AgentlensPro#4 viewer-role contract (§B5 decision table). ai-maestro's
  // proxy deletes any inbound X-Agentlens-Viewer and re-stamps it from its server-side session:
  //   absent     → standalone (hooks, CLI, solo browsers — today's behavior, unchanged)
  //   maestro    → full access
  //   restricted → reads only (GET/HEAD/OPTIONS), minus the config read below
  //   invalid    → 403 EVERYTHING — never a downgrade to standalone: if a broken header fell
  //                back to full access, sending deliberate garbage would BE the attack.
  // ONE blanket method gate, not per-route checks — a hidden settings panel is not a restricted
  // one unless its endpoints are dead too, and a per-route list always misses the next route.
  // A duplicated header (string[]) is present-but-unverifiable → invalid.
  const rawViewerHeader = req.headers[VIEWER_HEADER]
  const viewerRole: ViewerRole = Array.isArray(rawViewerHeader)
    ? 'invalid'
    : resolveViewerRole(rawViewerHeader, EMBED_KEY, Date.now())
  if (viewerRole === 'invalid') {
    res.writeHead(403, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'unverifiable viewer assertion — rejected (AgentlensPro#4 §B5)' }))
    return
  }
  if (viewerRole === 'restricted'
      // GET /api/hook-config is the one read that LEAKS settings (capture paths, gate state) —
      // the panel a restricted viewer must not even open (#4 Q4). Local kill-switch consumers
      // (CLI, hooks) send no header, so they are standalone and unaffected.
      && ((req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'OPTIONS')
        || url === '/api/hook-config')) {
    res.writeHead(403, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'restricted viewer — this surface requires a maestro assertion (AgentlensPro#4)' }))
    return
  }

  // TRDD-1ZH1D5EG (#4 Q9) — the wiring probe: lets ai-maestro PROVE its proxy stamps assertions
  // and this gate consumes them, instead of assuming (a proxy that stamps nothing would
  // otherwise pass its tests while the gate never engages). keyLoaded is FALSE when the key file
  // was unusable at boot (WYC4KB50 #1) — the feature is disabled and the embedding side sees why
  // (a present header would 403) instead of guessing. Vary so a cache can't cross viewer roles.
  if (req.method === 'GET' && url === '/api/embed-status') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Vary': 'X-Agentlens-Viewer' })
    res.end(JSON.stringify({
      mode: viewerRole === 'standalone' ? 'standalone' : 'embedded',
      role: viewerRole === 'maestro' ? 'maestro' : viewerRole === 'restricted' ? 'user' : null,
      keyLoaded: EMBED_KEY !== null,
    }))
    return
  }

  // D3K7QM2P/1c — admission control: bound in-flight work under concurrent load, shed at a hard wall.
  // Exempt endpoints (SSE, stats, kill-switch reads) bypass it; everything else reserves a slot that
  // is released when the response finishes (or the client aborts).
  if (!isAdmissionExempt(req.method ?? 'GET', url)) {
    const adm = await admission.enter()
    if (!adm.ok) { sendBusy(res, adm); return }
    admitLeaveOnDone(res)
  }

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
    readBodyCapped(req, 64 * 1024 * 1024, (bodyBuf) => {
      try {
        const body = JSON.parse(bodyBuf.toString('utf-8')) as { sessions?: unknown[] }
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
          putLogSession(card)   // card.sessionId === id (buildImportCardStandalone reads the same field)
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
  // `agentlenspro-cli --status` and usable by any watchdog.
  if (req.method === 'GET' && url === '/api/server-stats') {
    const mem = process.memoryUsage()
    const heap = heapPressure()
    const p = persistStats
    const spanStoreStats = spanStore.stats()
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({
      pid: process.pid,
      // Which BUILD is answering. Without it, "is the running server current?" needs a process
      // table lookup + a bundle grep; a stale server otherwise looks identical to a fresh one.
      version: SERVER_VERSION,
      startedAt: new Date(SERVER_STARTED_AT).toISOString(),
      uptimeSec: Math.round((Date.now() - SERVER_STARTED_AT) / 1000),
      ports: { ui: UI_PORT, mcp: MCP_PORT, otlp: OTLP_PORT },
      canonical: IS_CANONICAL,
      dataDir: DATA_DIR,
      memory: { rssMb: Math.round(mem.rss / 1048576), heapUsedMb: Math.round(heap.heapUsedMb), heapLimitMb: Math.round(heap.limitMb) },
      // Segmented store (P4): no cap, no eviction — memory is the time window, disk is everything.
      spans: {
        inMemory: spans.length,
        windowMs: effectiveWindowMs,
        configuredWindowMs: SUMMARY_WINDOW_MS,
        retentionDays: SPANS_RETENTION_DAYS,
        pendingAppends: spanStoreStats.pendingAppends,
        store: { segments: spanStoreStats.segments, totalSpans: spanStoreStats.totalSpans, totalBytes: spanStoreStats.totalBytes },
      },
      logSessions: logSessions.size,
      persistence: {
        ...p,
        totalBytesWritten: p.spanAppendBytes + p.offsetsBytes + p.cardsBytes + p.hookEventBytes,
        // diskBytes(), not sizeOf(OFFSETS_FILE/CARDS_FILE): those legacy paths are migration sources
        // only now and are never written again, so statting them would report a stale (or eventually
        // absent) number forever instead of the real delta-log footprint.
        files: { spans: spanStoreStats.totalBytes, offsets: offsetsLog.diskBytes(), cards: cardsLog.diskBytes() },
      },
      bodies: { archive: archiveDiskUsage(BODIES_ARCHIVE_DIR), lastPass: p.bodiesLastPurge },
      hookEvents: { ...hookEventsDiskUsage(HOOK_EVENTS_DIR), receivedSinceBoot: p.hookEventWrites, spooled: hookSpoolCount() },
      // TRDD-AMEA4O4Z: gated-out OTEL log events persisted (not dropped) — sink disk usage + boot counters.
      logEvents: { ...logEventsDiskUsage(LOG_EVENTS_DIR), persistedSinceBoot: p.logEventWrites, persistedBytesSinceBoot: p.logEventBytes, retentionDays: LOG_EVENTS_RETENTION_DAYS },
      // D3K7QM2P/1c — live backpressure: in-flight/queued now, and admitted/shed since boot. A
      // rising shedTotal under a 20-instance burst is the controller doing its job (shed = spooled +
      // drained, never lost). `resources` is the same sample the controller admits/sheds on.
      admission: admission.stats(),
      resources: resourceMonitor.sample(),
      gate: {
        mode: hookRuntime.gateMode, enabled: hookRuntime.gateEnabled,
        captureEnabled: hookRuntime.captureEnabled, advisorEnabled: hookRuntime.advisorEnabled,
        checks: p.gateChecks, denies: p.gateDenies, warns: p.gateWarns, advisories: p.gateAdvisories,
      },
      // Log-event names rejected at the ingest gate since boot — a silent-drop bug (rich events
      // discarded for weeks) is exactly what this exists to make visible.
      otlpDroppedLogEvents: Object.fromEntries(droppedLogEvents),
      // P6 fallback counters: every silent catch-fallback in the ingest paths, named + counted
      // (src/shared/fallbackCounters.ts). Counters that never fired are absent, not zero.
      degradations: fallbackTotals(),
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
        // Parse here (a malformed body is a 400 for the caller); ingestHookEvent owns the rest —
        // the SAME path the boot-time hook-spool drain reingests through (D3K7QM2P/1a).
        const payload = JSON.parse(Buffer.concat(chunks).toString('utf-8'))
        const r = ingestHookEvent(payload)
        res.writeHead(r.status, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(r.body))
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

  // Lifecycle events (Lifecycle dashboard tab / get_lifecycle_events): typed session-boundary events
  // (/clear, /compact, resume, fork, startup, session-end, turn-death) mapped from the hook store.
  // TRDD-EYA3X5MQ. Per-turn STOP excluded by default; pass ?kinds=CLEAR,COMPACT to select an exact set.
  if (req.method === 'GET' && url === '/api/lifecycle-events') {
    const rawUrl = req.url ?? ''
    const qIdx = rawUrl.indexOf('?')
    const q = new URLSearchParams(qIdx >= 0 ? rawUrl.slice(qIdx + 1) : '')
    const limNum = Number(q.get('limit'))
    const kinds = q.get('kinds')?.split(',').map(s => s.trim()).filter(Boolean) as LifecycleKind[] | undefined
    const session = q.get('session') ?? undefined
    const records = readHookEvents(HOOK_EVENTS_DIR, { session, limit: 1000 })
    const events = extractLifecycleEvents(records, { session, kinds, limit: Number.isFinite(limNum) && limNum > 0 ? limNum : 200 })
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ hookEventsDir: HOOK_EVENTS_DIR, dirExists: fs.existsSync(HOOK_EVENTS_DIR), count: events.length, events }))
    return
  }

  // Cache-breaking slash commands, read straight from the Claude Code transcripts (TRDD-EYA3X5MQ).
  // Distinct from /api/lifecycle-events, which reports what the HOOK store saw: this needs no hook
  // at all and is retroactive over the whole history. DEFAULT WINDOW 7 DAYS — the scan is bounded by
  // file mtime, so a window keeps a page load ~1.4s instead of ~5s for all history.
  if (req.method === 'GET' && url === '/api/cache-risk-commands') {
    const rawUrl = req.url ?? ''
    const qIdx = rawUrl.indexOf('?')
    const q = new URLSearchParams(qIdx >= 0 ? rawUrl.slice(qIdx + 1) : '')
    const winNum = Number(q.get('window'))
    const windowHours = Number.isFinite(winNum) && winNum > 0 ? winNum : 24 * 7
    const limNum = Number(q.get('limit'))
    const kinds = q.get('kinds')?.split(',').map(s => s.trim()).filter(Boolean) as CacheRiskKind[] | undefined
    // Scan unlimited, then slice — the scan already collects the window before capping, so this
    // costs nothing extra and lets the response state the TRUE total. A capped list whose count
    // silently equals the cap reads as "that is all there was", which is how an undercount hides.
    const limit = Number.isFinite(limNum) && limNum > 0 ? limNum : 300
    const all = scanCacheRiskCommands({
      sinceMs: Date.now() - windowHours * 3_600_000,
      kinds: kinds?.length ? kinds : undefined,
    })
    const commands = all.slice(0, limit)
    // Per-kind counts come from the FULL window, not the capped page — a chip that counts only the
    // visible rows silently under-reports exactly the kinds that are most frequent.
    const byKind: Record<string, number> = {}
    for (const c of all) byKind[c.kind] = (byKind[c.kind] ?? 0) + 1
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ windowHours, total: all.length, count: commands.length, truncated: all.length > commands.length, byKind, commands }))
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
          // Pass the machine TtlContext so keepWarm classifies against the RESOLVED regime (1h main /
          // 5m subagent / usage-credit), not the assumed 5-min floor — matching the tick (line ~742)
          // and the getBurnStatus accessor. Omitting it mis-attributed cache-break cost on the first
          // /api/burn-risk call after boot (TRDD-VY1IUVUM cache-TTL model).
          lastBurnStatus = computeBurnStatus(events, sessions, burnConfig, now, currentTtlContext())
        } catch { /* stays null — checkBurnRisk reports the feed as absent */ }
      }
      const report = checkBurnRisk({
        burnStatus: lastBurnStatus,
        recentEvents: recentHookEvents,
        bodiesActivity: bodiesActivityReport(),
      })
      // Name the verbatim spawning call behind an active fan-out risk (reads the session JSONL —
      // always present, so it works with raw-body capture off — only when a risk actually fired).
      await attachRiskCausingCalls(report)
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(report))
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: String(e instanceof Error ? e.message : e) }))
    }
    return
  }

  // Agent-launch burn gate (TRDD-GOD0108C) — called by scripts/spy-agentlens-gate.sh from
  // PreToolUse/PostToolUse hooks matched on Agent|Task|Workflow|SendMessage. CONTRACT: the
  // response body IS the hook's stdout — 204/empty means "print nothing" (allow). Every failure
  // path returns an empty 204: a gate that can error a launch is worse than no gate (fail-open).
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
        const state = buildGateState(now, parent, { sessionId, transcriptPath })
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

        // PreToolUse (default): decide before the launch happens. SendMessage (P6) takes the
        // NARROWER evaluator — resuming a dead agent re-runs the request that killed it, so only
        // COLD_RESUME / CACHE_THRASH may deny; routine messaging is never gated by fan-out rules.
        // The deny further requires the TARGET to resolve dead (SubagentStart/Stop hook events):
        // delivery to a LIVE agent rides its existing run, so a live target always passes and an
        // unknown one gets a warning, never a hard deny (2026-07-11 field fix).
        if (!hookRuntime.gateEnabled) { res.writeHead(204); res.end(); return }
        let d
        if (p.tool_name === 'SendMessage') {
          const to = (p.tool_input as Record<string, unknown> | null | undefined)?.to
          state.messageTarget = typeof to === 'string' ? to : null
          state.targetLiveness = resolveMessageTargetLiveness(to, recentHookEvents)
          d = evaluateSendMessageGate(state)
        } else {
          d = evaluateAgentGate((p.tool_input ?? null) as Record<string, unknown> | null, state)
        }
        if (d.decision === 'deny') {
          persistStats.gateDenies++
          // Mirror onto the dashboard's SSE alert channel — the notification panel shows
          // gate interventions live, same surface as the burn alerts.
          pushBurnSse({ type: 'alert', label: `burn-gate DENY (${d.code})`, detail: d.reason ?? '', severity: 'error' })
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({
            hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: d.reason },
            systemMessage: `[agentlens burn-gate] blocked an agent launch (${d.code}). The reason went to the agent so it can adapt; disable/downgrade in realtime: agentlenspro-cli --hooks gate=off|warn.`,
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

  // Archive operations (agentlenspro-cli --export-bodies / --purge-bodies). They live on the server
  // so the WAD format has exactly ONE implementation (src/bodyArchive.ts) — no CLI-side reader
  // to drift out of sync with the writer.
  if (req.method === 'POST' && url === '/api/bodies/export') {
    readBodyCapped(req, 1024 * 1024, (bodyBuf) => {
      try {
        const body = JSON.parse(bodyBuf.toString('utf-8')) as { destDir?: string; sinceMs?: number; untilMs?: number }
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
        // The store half of the export (TRDD-K3WDPR7M): once ingestPass reclaims a source file, the
        // content-addressed store is the ONLY place that body exists. Without this, an export window
        // would return only what the legacy .wad happens to hold and the caller would read the gap as
        // "no traffic". Skip-existing makes the two halves compose (identical bytes either way).
        void (async () => {
          let storeFiles = 0
          let storeBytes = 0
          let storeFailed: string[] = []
          try {
            bodyStore ??= await openStore({ dir: path.join(DATA_DIR, 'store') })
            const s = await exportBodiesFromStore(bodyStore, destDir, since, until)
            storeFiles = s.files; storeBytes = s.bytes; storeFailed = s.failed
          } catch (e) {
            // The archive half already succeeded — report the store half's failure rather than
            // failing the whole export, but NEVER silently (a partial export must say so).
            storeFailed = [`store export failed: ${e instanceof Error ? e.message : String(e)}`]
          }
          console.log(`[AgentLens] bodies export: ${r.files} archive + ${storeFiles} store file(s), ${((r.bytes + storeBytes) / 1048576).toFixed(1)}MB → ${destDir}${storeFailed.length ? ` (${storeFailed.length} FAILED)` : ''}`)
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ files: r.files + storeFiles, bytes: r.bytes + storeBytes, fromArchive: r.files, fromStore: storeFiles, failed: storeFailed, destDir }))
        })()
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: String(e instanceof Error ? e.message : e) }))
      }
    })
    return
  }

  if (req.method === 'POST' && url === '/api/bodies/purge') {
    try {
      // Explicit destructive op from the CLI — but destruction is EARNED, never assumed
      // (TRDD-K3WDPR7M, 2026-07-15 USER directive): each volume is deleted ONLY after every one of
      // its lumps is proven in the store (exact bytes + the (src_name, capture-ts) row). A volume
      // that fails stays on disk with its failures named. The .idx sidecars are ALWAYS kept —
      // capture-time provenance at ~0.05% of the volume's size.
      void (async () => {
        try {
          bodyStore ??= await openStore({ dir: path.join(DATA_DIR, 'store') })
          const names = (fs.existsSync(BODIES_ARCHIVE_DIR) ? fs.readdirSync(BODIES_ARCHIVE_DIR) : [])
            .filter((f) => /^bodies-\d{4}-\d{2}\.wad$/.test(f))
          const removed: string[] = []
          const kept: Array<{ volume: string; verified: number; entries: number; failedSample: string[] }> = []
          let freedBytes = 0
          for (const v of names) {
            const proof = await verifyVolumeInStore(bodyStore, BODIES_ARCHIVE_DIR, v)
            if (!proof.ok) {
              kept.push({ volume: v, verified: proof.verified, entries: proof.entries, failedSample: proof.failed.slice(0, 5) })
              continue
            }
            const p = path.join(BODIES_ARCHIVE_DIR, v)
            try { freedBytes += fs.statSync(p).size; fs.unlinkSync(p); removed.push(v) } catch { /* raced */ }
          }
          console.log(`[AgentLens] bodies archive purge: removed ${removed.length} verified volume(s) ` +
            `(${(freedBytes / 1024 ** 3).toFixed(2)}GB), kept ${kept.length} unproven; .idx sidecars retained`)
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ removed, kept, freedBytes }))
        } catch (e) {
          res.writeHead(500, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: String(e instanceof Error ? e.message : e) }))
        }
      })()
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: String(e instanceof Error ? e.message : e) }))
    }
    return
  }

  if (req.method === 'POST' && url === '/api/clear') {
    spans = []
    markDataChanged()
    clearLogSessions()
    logReader.clearFileState()
    clearPersistedSpans()
    pushUpdate()          // send cleared state to clients immediately
    res.writeHead(200); res.end()
    // Re-ingest after the response is sent so the client sees the cleared state first. FULL: the tail
    // offsets were just wiped, so every file must be re-read — a targeted scan would only see the
    // handful of paths the watcher happened to name since the last scan.
    setImmediate(() => runLogScan('full'))
    return
  }

  if (req.method === 'POST' && url === '/api/write-prompts-file') {
    readBodyCapped(req, 4 * 1024 * 1024, (bodyBuf) => {
      try {
        const { agent, label, prompt } = JSON.parse(bodyBuf.toString('utf-8')) as { agent: string; label: string; prompt: string }
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

  // POST /api/branch-dump — write the over-threshold node outputs of a serialized branch to files
  // under the Claude projects tree, so the dashboard "copy branch" button (TRDD-4CH9QLAH) keeps the
  // clipboard payload small and hands Claude a grep-able path to the full output. WHY the destination
  // is pinned this tightly: the request is already CSRF-guarded (uiServer refuses a foreign Origin on
  // non-GET) and admission-controlled, but a filesystem WRITE is the highest-value target, so the
  // path is confined to <claudeProjectsDir>/<real-project-slug>/agentlens-branch-dumps/ — the slug
  // must be separator-free AND name an EXISTING project dir (proves it is a real project, never an
  // arbitrary mkdir), each filename is sanitized to a single safe segment, and a containment check
  // (resolved parent === resolved dump root) rejects anything that could escape. No traversal, no
  // foreign path — an unguarded write endpoint on a browser-reachable localhost port is the exact
  // arbitrary-file-write vector the CSRF gate exists to close.
  if (req.method === 'POST' && url === '/api/branch-dump') {
    readBodyCapped(req, 48 * 1024 * 1024, (bodyBuf) => {
      try {
        const body = JSON.parse(bodyBuf.toString('utf-8')) as {
          slug?: string; sessionId?: string; dumps?: { id?: string; name?: string; content?: string }[]
        }
        const slug = typeof body.slug === 'string' ? body.slug : ''
        const sessionId = typeof body.sessionId === 'string' ? body.sessionId : ''
        const dumps = Array.isArray(body.dumps) ? body.dumps : []
        // Claude project slugs are mangled dir basenames — already separator-free. Reject anything else
        // (a slug with '/' or '..' is either a bug or an attempted traversal).
        if (!/^[A-Za-z0-9._-]+$/.test(slug) || slug.includes('..')) {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'invalid project slug' })); return
        }
        // The slug MUST name a real, existing Claude project dir — this both validates the caller and
        // guarantees we never mkdir an arbitrary tree for an attacker-chosen name.
        const projRoot = claudeProjectsDirs()
          .map(r => path.join(r, slug))
          .find(p => { try { return fs.statSync(p).isDirectory() } catch { return false } })
        if (!projRoot) {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'unknown project slug (no matching Claude project dir)' })); return
        }
        const dumpRoot = path.join(projRoot, 'agentlens-branch-dumps')
        fs.mkdirSync(dumpRoot, { recursive: true })
        const dumpRootResolved = path.resolve(dumpRoot)
        const ts = new Date().toISOString().replace(/[:.]/g, '-')
        const safe = (s: string): string => s.replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 60) || 'x'
        const paths: Record<string, string> = {}
        for (const d of dumps) {
          const id = typeof d.id === 'string' ? d.id : ''
          if (!/^[A-Za-z0-9_-]+$/.test(id)) continue // skip a malformed placeholder id (must round-trip into text)
          const fileName = `${safe(sessionId)}-${ts}-${safe(d.name ?? 'output')}-${safe(id)}.txt`
          const target = path.join(dumpRoot, fileName)
          // Defense-in-depth: the sanitized single-segment name cannot contain a path separator, so the
          // file must sit DIRECTLY in the dump root. Assert that on the resolved path before writing.
          if (path.dirname(path.resolve(target)) !== dumpRootResolved) continue
          fs.writeFileSync(target, typeof d.content === 'string' ? d.content : '', 'utf-8')
          paths[id] = target
        }
        console.log(`[AgentLens] branch-dump: ${Object.keys(paths).length} file(s) → ${dumpRoot}`)
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ dir: dumpRoot, paths }))
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: String(e instanceof Error ? e.message : e) }))
      }
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
    readBodyCapped(req, 4 * 1024 * 1024, (bodyBuf) => {
      try {
        const { workspace, targetFile, appliedText, id } = JSON.parse(bodyBuf.toString('utf-8')) as {
          workspace: string; targetFile: string; appliedText: string; id: string
        }
        if (!workspace || !targetFile || !appliedText || !id) {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'workspace, targetFile, appliedText, and id are required' }))
          return
        }
        // SECURITY (defense-in-depth behind the cross-origin gate): targetFile becomes a filesystem
        // append path (appendSuggestion → fs.appendFileSync with no containment of its own), so restrict
        // it to the exact instruction files the advisor offers. Without this, a request could append
        // arbitrary text to ~/.zshrc or ~/.ssh/authorized_keys (→ code execution). These mirror
        // INSTRUCTION_FILE_DEFS in src/instructionFiles.ts (primary paths + the .claude alternate).
        const ALLOWED_INSTRUCTION_FILES = new Set(['CLAUDE.md', '.claude/CLAUDE.md', '.github/copilot-instructions.md', 'AGENTS.md'])
        if (!ALLOWED_INSTRUCTION_FILES.has(targetFile)) {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'targetFile must be a recognized instruction file' }))
          return
        }
        const absPath = path.join(workspace, targetFile)
        // Belt-and-suspenders: the allowlist has no `..`, but reject anything that still resolves
        // outside the workspace (e.g. a `workspace` that is itself a traversal string).
        if (!path.resolve(absPath).startsWith(path.resolve(workspace) + path.sep)) {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'resolved path escapes the workspace' }))
          return
        }
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
    readBodyCapped(req, 256 * 1024, (bodyBuf) => {
      try {
        const body = JSON.parse(bodyBuf.toString('utf-8')) as { type?: string }
        if (body.type === 'clearAll') {
          spans = []
          markDataChanged()
          clearPersistedSpans()
          pushUpdate()
        }
      } catch (e) { console.warn('[AgentLens] Malformed /action body:', e) }
      res.writeHead(200); res.end()
    })
    return
  }

  if (req.method === 'GET' && url === '/api/summary') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(buildStrippedSummary()))
    return
  }

  // TRDD-OG9PARZQ: realtime burn status (burn rate + window budget + alerts) for the dashboard and any
  // headless consumer. Same object get_burn_status returns over MCP.
  if (req.method === 'GET' && url === '/api/burn-status') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    try {
      const { sessions, events, now } = gatherBurn()
      // TTL-aware like the tick/accessor: pass currentTtlContext() so this pull path classifies the
      // same regime the SSE push does (TRDD-VY1IUVUM), instead of the assumed 5-min floor.
      res.end(JSON.stringify(enrichBurnStatus(computeBurnStatus(events, sessions, burnConfig, now, currentTtlContext()))))
    } catch (e) {
      res.end(JSON.stringify({ error: String(e) }))
    }
    return
  }

  // TRDD-U0UYC38A: live-tail proof. `incrementalReads` counts changed logs re-parsed by tailing
  // only their appended bytes; `fullReads` counts from-0 (cold-start/fallback) parses. Appending to
  // a live session must bump incrementalReads while fullReads stays put — the "no full-file rescans
  // on each append" acceptance check.
  // TRDD-X2E6OSWK adds the CPU-spin proof: `filesStatted` must grow by ~1 per changed file in steady
  // state (targeted scan), NOT by ~12.5k every scan (full sweep); and the derived-view caches must
  // show hits, meaning the dashboard model is rebuilt once per data change instead of per caller.
  if (req.method === 'GET' && url === '/api/debug/log-scan-stats') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({
      ...logReader.getLogScanStats(),
      dataVersion,
      derivedCaches: {
        summary: summaryCache.stats(),
        stripped: strippedCache.stats(),
        sidebar: sidebarCache.stats(),
        analytics: analyticsCache.stats(),
      },
      // The scratch indexer runs on every incremental parse; `readdirs` must stay ~flat while a
      // session is appended to (it re-walks the OS temp roots only when their listing really changed).
      scratchListing: scratchListingStats(),
    }))
    return
  }

  // spec 6: recent request log (ring buffer) — post-mortem attribution of a crash/pressure event.
  if (req.method === 'GET' && url === '/api/debug/requests') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ heap: heapPressure(), requests: requestLog.recent(200) }))
    return
  }

  // S3-F3a: the DISTINCT stored traceIds of the codex.* spans currently in the in-memory window.
  // This is the ONLY place the shipped log-ingest's STORE-level Codex grouping is directly
  // observable — the summarizer re-groups downstream, so /api/summary would mask whether processLogs
  // grouped per prompt (`codex:<conv>:prompt-N`) or by conversation id alone. Read-only, and the
  // server is localhost-only (same seam class as the other /api/debug/* endpoints).
  if (req.method === 'GET' && url === '/api/debug/codex-store-groups') {
    const codexTraceIds = [...new Set(spans.filter(s => s.name.startsWith('codex.')).map(s => s.traceId))].sort()
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ codexTraceIds }))
    return
  }

  // S3-F3b: read one attribute off ONE stored span, through a FRESH spanStore.loadRange — the only
  // place the store's read-time gen_ai overlay (injectSpanAttribute) is directly observable. A live
  // loadRange re-parses the span from disk and merges the overlay, so this proves the gen_ai response
  // content actually reaches the span on read (which /api/summary would fold away). Read-only, and the
  // server is localhost-only (same seam class as the other /api/debug/* endpoints).
  if (req.method === 'GET' && url?.startsWith('/api/debug/span-attr')) {
    const q = new URLSearchParams((req.url ?? '').split('?')[1] ?? '')
    const traceId = q.get('traceId') ?? ''
    const spanId = q.get('spanId') ?? ''
    const key = q.get('key') || 'gen_ai.output.messages'
    const span = spanStore.loadRange(0, Infinity).find(s => s.traceId === traceId && s.spanId === spanId)
    const attr = span?.attributes.find(a => a.key === key)
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ found: !!span, value: attr?.value.stringValue ?? null }))
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
    // Shared reparse-on-demand for a disk-restored stripped card (see resolveSessionCard).
    const session = resolveSessionCard(sessionId)
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

  if (req.method === 'GET' && url?.startsWith('/api/conversation/')) {
    // TRDD-B22NYTOY: the NARRATIVE conversation — verbatim ordered turns (prompts, replies, tool
    // in/out pairs, compaction dividers). Same ?parent= + nearest-logged-ancestor fallback as
    // /api/history; the client renders lazily (blocks collapsed), so the whole reconstruction ships.
    if (heavyGuard(res, url, 'conversation')) return
    const sessionId = decodeURIComponent(url.slice('/api/conversation/'.length))
    const rawUrl = req.url ?? ''
    const qIdx = rawUrl.indexOf('?')
    const parentHint = qIdx >= 0 ? new URLSearchParams(rawUrl.slice(qIdx + 1)).get('parent') ?? undefined : undefined
    const convSessions = buildSessionSummary()?.sessions ?? []
    const parentOf = (id: string): string | undefined => convSessions.find(s => s.sessionId === id)?.parentSessionId
    const parentSessionId = resolveLoggedAncestor(sessionId, parentOf) ?? parentOf(sessionId) ?? parentHint
    buildConversation(sessionId, parentSessionId)
      .then(conversation => {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ conversation }))
      })
      .catch(e => {
        console.warn('[AgentLens] conversation parse failed', e)
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ conversation: null }))
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
    res.writeHead(200, {
      'Content-Type': 'text/html',
      // TRDD-1ZH1D5EG (WYC4KB50 #4) — the served HTML differs by viewer role (the restricted meta
      // tag), so it MUST NOT be cached across roles: a shared cache keyed only on the URL could hand
      // a maestro the restricted page (or vice versa). Vary on the request header the verdict derives
      // from so any cache keys on it too.
      'Vary': 'X-Agentlens-Viewer',
      // TRDD-FMIZO8Y4 — the embed contract, made EXPLICIT instead of permission-by-omission:
      // loopback-served apps (the ai-maestro UI on localhost:23000, any local tool) MAY iframe the
      // dashboard — that is now guaranteed, so a future hardening pass cannot silently break the
      // integration — while a REMOTE page framing http://localhost:<UI_PORT> (drive-by clickjack of
      // the local dashboard) is refused by the browser. Framing counterpart of the F6BM1BDI
      // same-origin/loopback read hardening.
      'Content-Security-Policy':
        "frame-ancestors 'self' http://localhost:* http://127.0.0.1:* https://localhost:* https://127.0.0.1:*",
    })
    res.end(getHtml(viewerRole === 'restricted'))
    return
  }

  const filePath = path.join(mediaDir, url)
  const ext = path.extname(filePath)
  const mime = MIME[ext]
  // Containment via a SEPARATOR-terminated prefix: a bare `filePath.startsWith(mediaDir)` also accepts a
  // sibling like `<mediaDir>-assets/x.js` (reached through `/../media-assets/…`). Requiring `mediaDir +
  // sep` rejects sibling directories that merely share the prefix. path.join already normalizes `..`, so
  // a true escape resolves outside mediaDir and fails this check.
  if (mime && fs.existsSync(filePath) && filePath.startsWith(mediaDir + path.sep)) {
    res.writeHead(200, { 'Content-Type': mime })
    fs.createReadStream(filePath).pipe(res)
    return
  }

  res.writeHead(404); res.end('Not found')
})

// ── OTLP server ───────────────────────────────────────────────────────────────

const otlpServer = http.createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/agentlens/standalone') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ agentlens: true, kind: 'standalone' }))
    return
  }
  if (req.method !== 'POST') { res.writeHead(200); res.end(); return }
  // D3K7QM2P/1c — admission control on the heavy OTLP ingest POST (the health GET + non-POST above
  // are exempt). A shed export is safe: the exporter retries and the next JSONL scan backfills, so
  // no telemetry is lost — the server just refuses to melt under a 20-instance burst.
  const adm = await admission.enter()
  if (!adm.ok) { sendBusy(res, adm); return }
  admitLeaveOnDone(res)
  // 64MB cap: a legitimate OTLP export batch is well under this; a bigger body is a bug or an attack
  // and must not buffer unbounded into the collector's heap (the OtlpCollector class caps at 50MB).
  readBodyCapped(req, 64 * 1024 * 1024, (bodyBuf) => {
    try {
      const payload = JSON.parse(bodyBuf.toString('utf-8'))
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
      // Fail-open by design (an exporter must never error-loop on us), but counted (P6):
      // every payload swallowed here — protobuf, truncation, an ingest bug — is telemetry
      // that silently never reached processTraces/processLogs.
      countFallback('standalone.otlpIngestError')
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
    // bodiesDir = PRIMARY_BODIES_DIR: MOUNT truth, not config truth. When the spool failed to
    // (re)mount this boot, the config still names it — but pointing Claude Code at an unmounted
    // /Volumes path would materialize a plain SSD directory nothing drains. The key must name the
    // dir this server actually watches + drains.
    const r = await ensureTelemetryConfig({ otlpPort: OTLP_PORT, bodiesDir: PRIMARY_BODIES_DIR })
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

// D3K7QM2P/1a: reingest any hook events that `agentlenspro hook` spooled to disk while this server
// was down (or shedding under load) — so nothing fired by a live Claude instance is ever lost across
// the revive window. Runs once at boot, after every store + calibration dep above is initialized,
// then on a slow tick so a shed-then-spooled event (server UP but shedding under load — 1c) is
// picked up within the interval WITHOUT waiting for a restart. The tick is a no-op readdir on the
// (usually empty) spool dir in the healthy case.
drainHookSpool()
const HOOK_SPOOL_DRAIN_MS = Math.max(5_000, Number(process.env.AGENTLENS_HOOK_SPOOL_DRAIN_MS) || 30_000)
setInterval(() => { try { drainHookSpool() } catch (e) { console.warn('[AgentLens] hook-spool drain tick error:', e) } }, HOOK_SPOOL_DRAIN_MS).unref()

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

  // TRDD-X2E6OSWK: the event-loop watchdog backstop. Twice a drill handler starved the loop into
  // a permanent wedge where every request hung and SIGTERM was ignored — machine-wide
  // observability dead until a human SIGKILLed it hours later. The worker-thread watchdog
  // SIGKILLs + respawns this exact process (same argv/env) after a sustained stall; the 120s
  // min-uptime guard keeps a boot wedge from crash-looping. AGENTLENS_WATCHDOG=off disables;
  // AGENTLENS_WATCHDOG_STALL_S tunes the threshold (default 60s — drills are budget-bounded at
  // 20s, so a healthy server can never trip it).
  if ((process.env.AGENTLENS_WATCHDOG ?? 'on') !== 'off') {
    const stallEnv = Number(process.env.AGENTLENS_WATCHDOG_STALL_S)
    startLoopWatchdog({
      stallSeconds: Number.isFinite(stallEnv) && stallEnv > 0 ? stallEnv : 60,
      log: (m) => console.warn(m),
    })
  }
})

// ── Graceful shutdown — flush data before exit ────────────────────────────────

function shutdown() {
  clearInterval(spanFlushTimer)
  clearInterval(spanRetentionTimer)
  clearInterval(durableSaveTimer)
  // Segmented store: shutdown is a final O(pending) append flush — NEVER a whole-store rewrite
  // (the old shutdown rewrite was the last surviving instance of the 420GB SSD-wear pattern).
  // spec 3: flush offsets + stripped cards so the next start resumes instantly. spec 2: record
  // the graceful stop so the gap after it reads as a clean shutdown, not a crash. All
  // best-effort — a shutdown must never hang on a failed write.
  try {
    const r = spanStore.flush()
    const st = spanStore.stats()
    console.log(`\n[AgentLens] Flushed ${r.appendedSpans} pending span(s) — store holds ${st.totalSpans} span(s) across ${st.segments} segment(s) in ${SPANS_DIR}`)
  } catch { /* ignore */ }
  try { saveOffsetsNow() } catch { /* ignore */ }
  try { saveCardsNow() } catch { /* ignore */ }
  // TRDD-YQZ9P8IL: final flush of the account-state timeline so a graceful stop never loses a buffered
  // state change (matches the span-store's shutdown-flush discipline).
  try { accountStateTimeline.stop() } catch { /* ignore */ }
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
