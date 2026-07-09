// TRDD-FB5RG4P1 — Forensics Analytics Layer (FAL) lazy/incremental indexer.
//
// Builds one FACT ROW per API call (a response body carrying a `usage` block) into forensics.db.
// It REUSES CCFORNSC's bounded-scan primitives (listBySuffix / boundedRecent / readJsonBounded) and
// its previous_message_id join semantics — this module never re-implements the disk-scan contract,
// and never modifies cacheCreationForensics.ts (imports only).
//
// GENERALIZED vs scanCacheCreationEvents: that scanner keeps only responses with cache_creation > 0;
// FAL keeps EVERY response with a usage block (cache-read-only calls and output-spike calls are facts
// the comparative/SQL tools need too).
//
// ONE-SOURCE-OF-TRUTH for spawn config: the child does NOT log its own spawn config — it lives on the
// child session's row in the MAIN agentlens.db (spawn_kind/override/isolation/is_sidechain/parent),
// authored by logReader._buildSubAgentCards -> DatabaseWriter. FAL reads a read-only DENORMALIZED copy
// at index time and stamps each row with an honest `spawn_resolution` (direct|root|unresolved); it
// NEVER re-parses the parent transcript and NEVER fabricates a spawn_kind.

import * as fs from 'fs'
import * as crypto from 'crypto'
import {
  listBySuffix, boundedRecent, readJsonBounded,
  DEFAULT_BODIES_DIR, RESPONSE_SCAN_CAP, REQUEST_INDEX_CAP, MAX_RESPONSE_BYTES, MAX_REQUEST_BYTES,
  type DirEntry, type CacheCreationScanCoverage,
} from './cacheCreationForensics'
import { parseUserId } from './rawBodyContext'
import { calcTokenCostUsd } from './pricing'
import {
  openForensicsDb, loadSqlJs, billableWeight, writeIndexState, readIndexState,
  DEFAULT_FORENSICS_DB, DEFAULT_MAIN_DB, type SqlDatabase,
} from './forensicsDb'

function numOr0(v: unknown): number { return typeof v === 'number' && isFinite(v) ? v : 0 }
function strOrUndef(v: unknown): string | undefined { return typeof v === 'string' && v.length > 0 ? v : undefined }

// ── Raw body shapes (only the fields FAL reads) ─────────────────────────────────
interface RawResponseBody {
  id?: unknown
  model?: unknown
  message?: { model?: unknown }
  usage?: {
    input_tokens?: unknown
    output_tokens?: unknown
    cache_read_input_tokens?: unknown
    cache_creation_input_tokens?: unknown
    cache_creation?: { ephemeral_5m_input_tokens?: unknown; ephemeral_1h_input_tokens?: unknown }
  }
}
interface RawSystemBlock { type?: unknown; text?: unknown }
interface RawTool { name?: unknown }
interface RawRequestBody {
  model?: unknown
  metadata?: { user_id?: unknown }
  diagnostics?: { previous_message_id?: unknown }
  thinking?: { type?: unknown; budget_tokens?: unknown }
  system?: unknown
  tools?: unknown
}

// ── effort (design §3.3 — read DIRECTLY from the request thinking budget, per-call) ──────────────
// The exact budget→level thresholds are a documented heuristic (Claude Code maps "think" ≈ 4k,
// "think hard" ≈ 10k, "ultrathink" ≈ 32k onto budget_tokens). Only the RELATIVE grouping matters for
// compare_configs, so precise cutoffs are not load-bearing.
export function classifyEffort(budgetTokens: number | undefined): 'none' | 'low' | 'medium' | 'high' {
  if (!budgetTokens || budgetTokens <= 0) { return 'none' }
  if (budgetTokens <= 8192) { return 'low' }
  if (budgetTokens <= 24576) { return 'medium' }
  return 'high'
}

// ── frontmatter fingerprint (the "stable prefix" = tools + system identities) ─────────────────────
// A sha1 of the tool-name list + each system block's IDENTITY (its classification, plus the rule
// filename for a .claude/rules injection, or a claudemd marker). This is the "frontmatter" group
// dimension: two calls with the same tools + same rule-set + same CLAUDE.md share a fingerprint.
// Pointer-only: NEVER hashes raw system text — only tool names + rule filenames + kind labels, which
// are non-secret identifiers. Returns undefined when the body carries neither tools nor system.
const RULE_FILE_RE = /Contents of .*[/\\]\.claude[/\\]rules[/\\]([^\n\r]+?\.md)/
function systemBlockIdentity(text: string): string {
  const rule = RULE_FILE_RE.exec(text)
  if (rule) { return `rule:${rule[1]}` }
  if (/Contents of .*CLAUDE\.md|^#\s*CLAUDE\.md/m.test(text)) { return 'claudemd' }
  return 'system'
}
export function computeFrontmatterFp(body: RawRequestBody): string | undefined {
  const toolNames: string[] = Array.isArray(body.tools)
    ? (body.tools as RawTool[]).map(t => strOrUndef(t?.name) ?? '').filter(Boolean)
    : []
  const sysIds: string[] = []
  const sys = body.system
  if (typeof sys === 'string') {
    sysIds.push(systemBlockIdentity(sys))
  } else if (Array.isArray(sys)) {
    for (const b of sys as RawSystemBlock[]) {
      const t = strOrUndef(b?.text)
      if (t) { sysIds.push(systemBlockIdentity(t)) }
    }
  }
  if (toolNames.length === 0 && sysIds.length === 0) { return undefined }
  const canonical = `tools:${toolNames.join(',')}||system:${sysIds.join(',')}`
  return crypto.createHash('sha1').update(canonical).digest('hex')
}

// ── the generalized bounded scan (ALL usage) ─────────────────────────────────────
export interface ApiCallEvent {
  callId: string
  responseRef: string
  requestRef?: string
  ts: number
  sessionId?: string
  accountUuid?: string
  model?: string
  effort: 'none' | 'low' | 'medium' | 'high'
  frontmatterFp?: string
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
  tier5mTokens: number
  tier1hTokens: number
  attributed: boolean
}

// A joined-request record: carries the SCALARS derived from the following request Q (the one whose
// previous_message_id == the response id). Q's stable prefix (tools/system/thinking) equals the
// producing request's prefix within a session (a changed prefix IS the cache break we measure), so it
// is the correct proxy for effort + frontmatter. Only scalars are retained — never the big
// system/tools arrays — so indexing 4000 requests stays memory-flat.
interface RequestLink {
  sessionId?: string
  accountUuid?: string
  model?: string
  path: string
  effort: 'none' | 'low' | 'medium' | 'high'
  frontmatterFp?: string
}

function indexRequestsByPreviousMessageId(entries: DirEntry[]): Map<string, RequestLink> {
  const index = new Map<string, RequestLink>()
  for (const e of entries) {
    const q = readJsonBounded<RawRequestBody>(e.path, MAX_REQUEST_BYTES)
    if (!q) { continue }
    const pmid = strOrUndef(q.diagnostics?.previous_message_id)
    if (!pmid) { continue }
    const uid = parseUserId(q.metadata?.user_id)
    index.set(pmid, {
      sessionId: uid.sessionId,
      accountUuid: uid.accountUuid,
      model: strOrUndef(q.model),
      path: e.path,
      effort: classifyEffort(numOr0(q.thinking?.budget_tokens)),
      frontmatterFp: computeFrontmatterFp(q),
    })
  }
  return index
}

export interface ScanApiCallOptions { bodiesDir?: string; windowHours?: number; scanCap?: number }

/** The generalized bounded scan every FAL fact row is built from: every response body with a usage
 *  block (NOT just cache_creation > 0), joined to its owning session/account/model/effort/frontmatter
 *  via the previous_message_id chain. Never reads more than `scanCap` response + request files. */
export async function scanApiCallEvents(
  opts: ScanApiCallOptions = {},
): Promise<{ events: ApiCallEvent[]; coverage: CacheCreationScanCoverage }> {
  const bodiesDir = opts.bodiesDir ?? DEFAULT_BODIES_DIR
  const scanCap = opts.scanCap ?? RESPONSE_SCAN_CAP
  const dirExists = fs.existsSync(bodiesDir)
  if (!dirExists) {
    return {
      events: [],
      coverage: {
        bodiesDir, dirExists: false, responseFilesTotal: 0, responseFilesScanned: 0,
        requestFilesTotal: 0, requestFilesIndexed: 0, scanCap, windowHours: opts.windowHours,
        complete: true,
        note: `No OTEL raw-body directory at ${bodiesDir} — set OTEL_LOG_RAW_API_BODIES to capture bodies.`,
      },
    }
  }

  const allResponses = listBySuffix(bodiesDir, '.response.json')
  const allRequests = listBySuffix(bodiesDir, '.request.json')
  const { slice: responseSlice, matched: responseMatched } = boundedRecent(allResponses, { windowHours: opts.windowHours, cap: scanCap })
  const { slice: requestSlice } = boundedRecent(allRequests, { windowHours: opts.windowHours, cap: REQUEST_INDEX_CAP })
  const prevIndex = indexRequestsByPreviousMessageId(requestSlice)

  const events: ApiCallEvent[] = []
  for (const r of responseSlice) {
    const body = readJsonBounded<RawResponseBody>(r.path, MAX_RESPONSE_BYTES)
    if (!body || !body.usage) { continue }
    const responseId = strOrUndef(body.id)
    const link = responseId ? prevIndex.get(responseId) : undefined
    const model = link?.model ?? strOrUndef(body.model) ?? strOrUndef(body.message?.model)
    const tier = body.usage.cache_creation
    // call_id is the response id (msg_…) when present; else a stable sha1 of the response file path so
    // the PRIMARY KEY / INSERT OR REPLACE idempotency holds even for a body missing its id.
    const callId = responseId ?? `sha1:${crypto.createHash('sha1').update(r.path).digest('hex')}`
    events.push({
      callId,
      responseRef: r.path,
      requestRef: link?.path,
      ts: r.mtimeMs,
      sessionId: link?.sessionId,
      accountUuid: link?.accountUuid,
      model,
      effort: link?.effort ?? 'none',
      frontmatterFp: link?.frontmatterFp,
      inputTokens: numOr0(body.usage.input_tokens),
      outputTokens: numOr0(body.usage.output_tokens),
      cacheReadTokens: numOr0(body.usage.cache_read_input_tokens),
      cacheCreationTokens: numOr0(body.usage.cache_creation_input_tokens),
      tier5mTokens: numOr0(tier?.ephemeral_5m_input_tokens),
      tier1hTokens: numOr0(tier?.ephemeral_1h_input_tokens),
      attributed: Boolean(link),
    })
  }

  const complete = responseSlice.length === responseMatched
  return {
    events,
    coverage: {
      bodiesDir, dirExists: true,
      responseFilesTotal: allResponses.length,
      responseFilesScanned: responseSlice.length,
      requestFilesTotal: allRequests.length,
      requestFilesIndexed: requestSlice.length,
      scanCap, windowHours: opts.windowHours, complete,
      note: complete
        ? `Scanned all ${responseMatched} response body file(s)${opts.windowHours ? ` in the last ${opts.windowHours}h` : ''} (${allResponses.length} total on disk).`
        : `SAMPLE: ${responseSlice.length} most-recent of ${responseMatched} matching response body file(s) scanned (cap ${scanCap}; ${allResponses.length} total on disk). Not full history.`,
    },
  }
}

// ── spawn-config resolution (design §3.3) ────────────────────────────────────────
export interface SpawnRow {
  spawnKind?: string
  spawnModelOverride?: string
  spawnIsolation?: string
  isSidechain: boolean
  parentSessionId?: string
  model?: string
}
export interface ResolvedSpawn {
  spawnKind: string | null
  spawnModelOverride: string | null
  spawnIsolation: string | null
  isSidechain: number
  parentSession: string | null
  spawnResolution: 'direct' | 'root' | 'unresolved'
}

/** Load a Map<session_id, SpawnRow> from the MAIN agentlens.db, read-only. Empty map when the DB is
 *  absent/unopenable — every call then resolves to 'unresolved' (honest, never guessed). */
export async function loadSpawnMap(mainDbPath: string = DEFAULT_MAIN_DB): Promise<Map<string, SpawnRow>> {
  const map = new Map<string, SpawnRow>()
  const SQL = await loadSqlJs()
  if (!SQL) { return map }
  let buf: Buffer
  try { buf = fs.readFileSync(mainDbPath) } catch { return map }
  let db: SqlDatabase
  try { db = new SQL.Database(buf) } catch { return map }
  try {
    const res = db.exec('SELECT session_id, spawn_kind, spawn_model_override, spawn_isolation, is_sidechain, parent_session_id, model FROM sessions')
    const table = res[0]
    if (table) {
      for (const row of table.values) {
        const sid = row[0]
        if (typeof sid !== 'string') { continue }
        map.set(sid, {
          spawnKind: strOrUndef(row[1]),
          spawnModelOverride: strOrUndef(row[2]),
          spawnIsolation: strOrUndef(row[3]),
          isSidechain: numOr0(row[4]) !== 0,
          parentSessionId: strOrUndef(row[5]),
          model: strOrUndef(row[6]),
        })
      }
    }
  } catch { /* schema drift / no sessions table — degrade to empty map */ } finally { db.close() }
  return map
}

/** Resolve one call's spawn config against the sessions map, recording spawn_resolution honestly.
 *  Ladder (design §3.3): direct match with a spawn_kind → 'direct'; a spawn_kind-less row with no
 *  parent → synthetic 'root'; a spawn_kind-less row WITH a parent → 'direct' (matched, kind unknown —
 *  never fabricated); no row / no session_id → 'unresolved' (still inserted as an honest bucket). */
export function resolveSpawn(sessionId: string | undefined, spawnMap: Map<string, SpawnRow>): ResolvedSpawn {
  if (!sessionId) {
    return { spawnKind: null, spawnModelOverride: null, spawnIsolation: null, isSidechain: 0, parentSession: null, spawnResolution: 'unresolved' }
  }
  const row = spawnMap.get(sessionId)
  if (!row) {
    return { spawnKind: null, spawnModelOverride: null, spawnIsolation: null, isSidechain: 0, parentSession: null, spawnResolution: 'unresolved' }
  }
  if (row.spawnKind) {
    return {
      spawnKind: row.spawnKind,
      spawnModelOverride: row.spawnModelOverride ?? null,
      spawnIsolation: row.spawnIsolation ?? null,
      isSidechain: row.isSidechain ? 1 : 0,
      parentSession: row.parentSessionId ?? null,
      spawnResolution: 'direct',
    }
  }
  if (!row.parentSessionId) {
    return { spawnKind: 'root', spawnModelOverride: null, spawnIsolation: null, isSidechain: row.isSidechain ? 1 : 0, parentSession: null, spawnResolution: 'root' }
  }
  // Matched a child row that carries no spawn_kind — matched directly but the kind is genuinely
  // unknown; leave it null rather than fabricating one.
  return { spawnKind: null, spawnModelOverride: row.spawnModelOverride ?? null, spawnIsolation: row.spawnIsolation ?? null, isSidechain: row.isSidechain ? 1 : 0, parentSession: row.parentSessionId, spawnResolution: 'direct' }
}

// ── the indexer ─────────────────────────────────────────────────────────────────
export interface IndexApiCallsOptions extends ScanApiCallOptions {
  forensicsDbPath?: string
  mainDbPath?: string
}
export interface IndexApiCallsResult {
  inserted: number
  coverage: CacheCreationScanCoverage
  forensicsDbPath: string
  dbAvailable: boolean
  highWaterMs: number
}

/** Index the bounded slice of API-call facts into forensics.db. Idempotent: keyed on call_id via
 *  INSERT OR REPLACE, so re-running is safe and a previously-unresolved spawn is re-resolved once the
 *  sessions table catches up. Phase 1 fills tokens+tiers+spawn-join+spawn_resolution+frontmatter_fp+
 *  cost+billable_weight; break_cause/culprit/gap and the content/injection junction tables stay
 *  empty until later phases. Returns { dbAvailable:false } (graceful) when sql.js is unavailable. */
export async function indexApiCalls(opts: IndexApiCallsOptions = {}): Promise<IndexApiCallsResult> {
  const forensicsDbPath = opts.forensicsDbPath ?? DEFAULT_FORENSICS_DB
  const { events, coverage } = await scanApiCallEvents(opts)

  const fdb = await openForensicsDb(forensicsDbPath)
  if (!fdb) {
    return { inserted: 0, coverage, forensicsDbPath, dbAvailable: false, highWaterMs: 0 }
  }
  const spawnMap = await loadSpawnMap(opts.mainDbPath ?? DEFAULT_MAIN_DB)
  const db = fdb.raw
  const now = Date.now()
  let highWater = 0
  let inserted = 0

  const insertSql = `INSERT OR REPLACE INTO api_calls (
    call_id, response_ref, request_ref, ts,
    session_id, account_uuid, model, effort,
    spawn_kind, subagent_type, spawn_model_override, spawn_isolation, is_sidechain, parent_session, spawn_resolution,
    input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, tier_5m_tokens, tier_1h_tokens,
    break_cause, culprit_fingerprint, gap_minutes, frontmatter_fp, cost_usd, billable_weight, indexed_at
  ) VALUES (
    :call_id, :response_ref, :request_ref, :ts,
    :session_id, :account_uuid, :model, :effort,
    :spawn_kind, :subagent_type, :spawn_model_override, :spawn_isolation, :is_sidechain, :parent_session, :spawn_resolution,
    :input_tokens, :output_tokens, :cache_read_tokens, :cache_creation_tokens, :tier_5m_tokens, :tier_1h_tokens,
    :break_cause, :culprit_fingerprint, :gap_minutes, :frontmatter_fp, :cost_usd, :billable_weight, :indexed_at
  )`

  try {
    db.run('BEGIN')
    for (const ev of events) {
      const spawn = resolveSpawn(ev.sessionId, spawnMap)
      const model = ev.model ?? null
      const costUsd = model
        ? calcTokenCostUsd(ev.inputTokens, ev.cacheReadTokens, ev.cacheCreationTokens, ev.outputTokens, model)
        : 0
      const weight = billableWeight(ev.tier5mTokens, ev.tier1hTokens, ev.cacheReadTokens, ev.outputTokens, ev.inputTokens, model)
      db.run(insertSql, {
        ':call_id': ev.callId,
        ':response_ref': ev.responseRef,
        ':request_ref': ev.requestRef ?? null,
        ':ts': ev.ts,
        ':session_id': ev.sessionId ?? null,
        ':account_uuid': ev.accountUuid ?? null,
        ':model': model,
        ':effort': ev.effort,
        ':spawn_kind': spawn.spawnKind,
        ':subagent_type': null,
        ':spawn_model_override': spawn.spawnModelOverride,
        ':spawn_isolation': spawn.spawnIsolation,
        ':is_sidechain': spawn.isSidechain,
        ':parent_session': spawn.parentSession,
        ':spawn_resolution': spawn.spawnResolution,
        ':input_tokens': ev.inputTokens,
        ':output_tokens': ev.outputTokens,
        ':cache_read_tokens': ev.cacheReadTokens,
        ':cache_creation_tokens': ev.cacheCreationTokens,
        ':tier_5m_tokens': ev.tier5mTokens,
        ':tier_1h_tokens': ev.tier1hTokens,
        ':break_cause': null,
        ':culprit_fingerprint': null,
        ':gap_minutes': null,
        ':frontmatter_fp': ev.frontmatterFp ?? null,
        ':cost_usd': costUsd,
        ':billable_weight': weight,
        ':indexed_at': now,
      })
      inserted++
      if (ev.ts > highWater) { highWater = ev.ts }
    }
    db.run('COMMIT')
  } catch (e) {
    try { db.run('ROLLBACK') } catch { /* ignore */ }
    fdb.close()
    throw e
  }

  // High-water mark advances monotonically toward the present; a prior deeper run is never rolled back.
  const prevHw = Number(readIndexState(db, 'high_water_mtime_ms') ?? '0')
  const newHw = Math.max(prevHw, highWater)
  writeIndexState(db, 'high_water_mtime_ms', String(newHw))
  writeIndexState(db, 'last_run_ms', String(now))
  writeIndexState(db, 'responses_indexed', String(coverage.responseFilesScanned))
  writeIndexState(db, 'responses_total', String(coverage.responseFilesTotal))
  writeIndexState(db, 'coverage_note', coverage.note)
  fdb.save()
  fdb.close()
  return { inserted, coverage, forensicsDbPath, dbAvailable: true, highWaterMs: newHw }
}
