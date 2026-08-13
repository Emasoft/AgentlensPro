// TRDD-FB5RG4P1 — Forensics Analytics Layer (FAL) lazy/incremental indexer.
//
// Builds one FACT ROW per API call (a response body carrying a `usage` block) into forensics.db.
// EVIDENCE BASE (rewired, owner directive 2026-08-13): selection + loading go through
// store/bodiesEvidence.ts's listBodyEvidence/loadBodyTexts — the store∪spool union — not the raw
// spool alone. The spool-only scan silently lost every call the ingest drain had already flushed to
// the Parquet store (the delete gate runs the moment the store provably holds the bytes), so a fact
// row could vanish between two index runs over identical history. This module still reuses CCFORNSC's
// previous_message_id join semantics and never modifies cacheCreationForensics.ts (imports only).
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
import * as path from 'path'
import * as crypto from 'crypto'
import {
  defaultBodiesDir, RESPONSE_SCAN_CAP, REQUEST_INDEX_CAP, MAX_RESPONSE_BYTES, MAX_REQUEST_BYTES,
  type CacheCreationScanCoverage,
} from './cacheCreationForensics'
import { listBodyEvidence, loadBodyTexts, type EvidenceRow } from './store/bodiesEvidence'
import { dataPath } from './dataDir'
import { parseUserId } from './rawBodyContext'
import { buildCallComposition, type CallComposition } from './contextCompositionIndex'
import { calcTokenCostUsd } from './shared/pricing'
import {
  openForensicsDb, loadSqlJs, billableWeight, writeIndexState, readIndexState,
  defaultForensicsDb, defaultMainDb, type SqlDatabase,
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
interface RawContentBlock { type?: unknown; name?: unknown; input?: unknown }
interface RawMessage { role?: unknown; content?: unknown }
interface RawRequestBody {
  model?: unknown
  metadata?: { user_id?: unknown }
  diagnostics?: { previous_message_id?: unknown }
  thinking?: { type?: unknown; budget_tokens?: unknown }
  system?: unknown
  tools?: unknown
  messages?: unknown
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

// ── injection attribution (design §3.6) — parse system[] + tools[] + Skill tool_use ──────────────
export interface InjectionRow { kind: 'skill' | 'mcp' | 'rule' | 'claudemd'; name: string; tokens: number }

// rule/mcp/claudemd are EXACT; skill is a documented heuristic (actively-INVOKED Skill tool_use calls,
// NOT the whole "available skills" catalogue — recording every available skill on every call would bloat
// the junction table with a non-discriminating list). Token weight is left 0: the co-occurrence stats
// (§5) rank on the CALL's cache/output tokens joined by call_id, not on injection tokens, so a precise
// per-injection token split is not load-bearing (and cannot be cleanly attributed out of one shared
// system block). All matches across ALL system text are collected (the giant Claude Code system block
// concatenates many "Contents of …/rules/X.md" markers).
const RULE_GLOBAL_RE = /Contents of .*?[/\\]\.claude[/\\]rules[/\\]([^\n\r]+?\.md)/g
const CLAUDEMD_GLOBAL_RE = /Contents of ([^\n\r]*?CLAUDE\.md)/g
const MCP_TOOL_RE = /^(mcp__[^_]+(?:_[^_]+)*?)__/  // mcp__<server>__<tool> → mcp__<server>

function collectSystemText(body: RawRequestBody): string {
  const sys = body.system
  if (typeof sys === 'string') { return sys }
  if (Array.isArray(sys)) {
    return (sys as RawSystemBlock[]).map(b => (typeof b?.text === 'string' ? b.text : '')).join('\n')
  }
  return ''
}
export function extractInjections(body: RawRequestBody): InjectionRow[] {
  const rows: InjectionRow[] = []
  const seen = new Set<string>()
  const add = (kind: InjectionRow['kind'], name: string): void => {
    const key = `${kind}\x00${name}`
    if (name && !seen.has(key)) { seen.add(key); rows.push({ kind, name, tokens: 0 }) }
  }

  const sysText = collectSystemText(body)
  let m: RegExpExecArray | null
  RULE_GLOBAL_RE.lastIndex = 0
  while ((m = RULE_GLOBAL_RE.exec(sysText)) !== null) { add('rule', m[1].trim()) }
  CLAUDEMD_GLOBAL_RE.lastIndex = 0
  while ((m = CLAUDEMD_GLOBAL_RE.exec(sysText)) !== null) { add('claudemd', m[1].trim()) }

  if (Array.isArray(body.tools)) {
    for (const t of body.tools as RawTool[]) {
      const name = strOrUndef(t?.name)
      const mm = name ? MCP_TOOL_RE.exec(name) : null
      if (mm) { add('mcp', mm[1]) }
    }
  }

  // Skill tool_use invocations across message content (the actively-used skill signal).
  if (Array.isArray(body.messages)) {
    for (const msg of body.messages as RawMessage[]) {
      if (!Array.isArray(msg?.content)) { continue }
      for (const blk of msg.content as RawContentBlock[]) {
        if (blk?.type === 'tool_use' && strOrUndef(blk.name) === 'Skill' && blk.input && typeof blk.input === 'object') {
          const inp = blk.input as Record<string, unknown>
          const skill = strOrUndef(inp.skill) ?? strOrUndef(inp.command) ?? strOrUndef(inp.name)
          if (skill) { add('skill', skill) }
        }
      }
    }
  }
  return rows
}

// ── content taxonomy (design §3.5) — derived from buildCallComposition (reused, not reinvented) ───
export interface ContentTag { tag: string; tokens: number; count: number }
export const BIG_READ_TOKENS = 25_000
export const BIG_CATALOG_TOKENS = 10_000
export const BIG_THINKING_TOKENS = 20_000
const TOOL_RESULT_KINDS = new Set(['toolOutput', 'bashOutput'])

export function deriveContentTags(comp: CallComposition): ContentTag[] {
  const tags: ContentTag[] = []
  if (comp.images.count > 0) { tags.push({ tag: 'image', tokens: comp.images.tokens, count: comp.images.count }) }

  // binary = NON-image binary media (base64 with a non-image/* media type, e.g. application/pdf, audio).
  // Image media already has its own tag, so this stays a distinct, non-redundant signal.
  const binBlocks = comp.blocks.filter(b => typeof b.mediaType === 'string' && b.mediaType.length > 0 && !/^image\//.test(b.mediaType))
  if (binBlocks.length > 0) {
    tags.push({ tag: 'binary', tokens: binBlocks.reduce((s, b) => s + Math.round((b.bytes || 0) / 4), 0), count: binBlocks.length })
  }

  const bigReads = comp.blocks.filter(b => TOOL_RESULT_KINDS.has(b.kind) && b.tokens >= BIG_READ_TOKENS)
  if (bigReads.length > 0) {
    tags.push({ tag: 'big_file_read', tokens: bigReads.reduce((s, b) => s + b.tokens, 0), count: bigReads.length })
  }

  // tool_result:<Kind> — one row per distinct tool result source present (Bash, Read, MCP-<server>, …).
  const byKind = new Map<string, { tokens: number; count: number }>()
  for (const b of comp.blocks) {
    if (!TOOL_RESULT_KINDS.has(b.kind)) { continue }
    const key = b.toolName || b.kind
    const cur = byKind.get(key) ?? { tokens: 0, count: 0 }
    cur.tokens += b.tokens; cur.count += 1
    byKind.set(key, cur)
  }
  for (const [k, v] of byKind) { tags.push({ tag: `tool_result:${k}`, tokens: v.tokens, count: v.count }) }

  if (comp.toolCatalogTokens >= BIG_CATALOG_TOKENS) { tags.push({ tag: 'tool_catalog_large', tokens: comp.toolCatalogTokens, count: 1 }) }
  if (comp.thinkingTokens >= BIG_THINKING_TOKENS) { tags.push({ tag: 'thinking_heavy', tokens: comp.thinkingTokens, count: 1 }) }
  return tags
}

// ── the generalized bounded scan (ALL usage) ─────────────────────────────────────
export interface ApiCallEvent {
  callId: string
  // Spool rows: the absolute spool-file path (still a real read handle). Store-only rows: the
  // srcName the row was captured under — the file may no longer exist on disk (the drain deleted it
  // once the store provably held its bytes), so this is a POINTER, never re-opened as a path.
  responseRef: string
  requestRef?: string
  // Content tags derived EAGERLY in the join pass, while the request text was in its load chunk.
  // Never the raw text itself: retaining each request's body here measured 1.17MB × 1,515 requests
  // (~1.8GB) in one real 5h window — the exact silent-RSS-kill shape of TRDD-34B9JAZK. Present only
  // when a joined request was found AND withContent was on.
  requestContentTags?: ContentTag[]
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
  injections: InjectionRow[]
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
  injections: InjectionRow[]   // computed FREE during this single parse pass (no extra read)
  // Content tags, ALSO computed during this single parse pass — the raw text itself is deliberately
  // NOT retained. The header comment's invariant ("only scalars are retained… memory-flat") is
  // load-bearing: keeping rawText here held every indexed request's megabytes for the whole run
  // (measured ~1.8GB over one real 5h window; cap ceiling ~4.7GB) — the TRDD-34B9JAZK RSS-kill
  // shape. Tags are a few dozen bytes; the text dies with its load chunk.
  contentTags: ContentTag[]
}

// The chunk size loadBodyTexts materializes at once. Mirrors cacheBreakTimeline.ts's
// EVIDENCE_LOAD_CHUNK — the same ~176 MB single-result blowup (TRDD-KB17X5G2) applies here.
const EVIDENCE_LOAD_CHUNK = 32

// A row from the evidence union, paired with its resolved report timestamp (req 5 of the rewire
// spec): a store row's capture ts (a first-class Parquet column, better than mtime — it is when the
// call happened, not when this scan ran); a spool row's file mtime (its capture ts is unknown until
// the body is parsed, and by then the file may already be gone).
interface SelectedRow { row: EvidenceRow; ts: number }

// Store-only rows may no longer exist as a file (drained once the store proved it held the bytes);
// srcName is the only stable pointer for them. Spool rows still exist on disk — the absolute path is
// a real read handle, kept for parity with the pre-rewire callId/ref shape.
function refFor(row: EvidenceRow, spool: string | null): string {
  return row.location === 'spool' && spool ? path.join(spool, row.srcName) : row.srcName
}

// null = the ts is UNKNOWABLE (a spool row drained between listing and stat, with no store row in
// this snapshot). The earlier Date.now() fallback here FABRICATED a capture timestamp (review
// finding): a stale call drained mid-scan was stamped "now", sorted first in recency selection,
// and appeared inside live burn windows with wrong culprit attribution. A null row is dropped by
// selectRecent — the drain put its bytes in the store, so the next pass indexes it with its TRUE
// capture ts; skipping one pass is honest, back-dating history to the scan time is not.
function resolveTs(row: EvidenceRow, spool: string | null): number | null {
  if (row.tsMs !== null) { return row.tsMs }
  if (spool) {
    try { return fs.statSync(path.join(spool, row.srcName)).mtimeMs } catch { /* drained mid-scan */ }
  }
  return null
}

// Recency-first, capped selection over the evidence union. `tsFromMs` is already pushed down to the
// store via listBodyEvidence's SQL WHERE; a spool row's ts is unresolved at list time, so the window
// is applied HERE, after resolving its file mtime. (An earlier shape exempted spool rows from the
// window entirely on the assumption the drain keeps the spool young — false whenever the server is
// stopped or a file repeatedly fails verify, so a windowHours=5 scan indexed days-old calls while
// its coverage note claimed otherwise — review finding.) `matched` counts in-window rows pre-cap.
function selectRecent(rows: EvidenceRow[], spool: string | null, tsFromMs: number | undefined, cap: number): { rows: SelectedRow[]; matched: number } {
  const withTs: SelectedRow[] = []
  for (const row of rows) {
    const ts = resolveTs(row, spool)
    if (ts === null) { continue } // unknowable — indexed from the store next pass (see resolveTs)
    if (tsFromMs !== undefined && ts < tsFromMs) { continue }
    withTs.push({ row, ts })
  }
  withTs.sort((a, b) => b.ts - a.ts)
  return { rows: withTs.slice(0, cap), matched: withTs.length }
}

async function indexRequestsByPreviousMessageId(
  storeDir: string, spool: string | null, selected: SelectedRow[], deriveTags: boolean,
): Promise<Map<string, RequestLink>> {
  const index = new Map<string, RequestLink>()
  for (let i = 0; i < selected.length; i += EVIDENCE_LOAD_CHUNK) {
    // Preserve readJsonBounded's size-bound semantics (a row over the cap is skipped, never read) —
    // filtered BEFORE loadBodyTexts so an oversized body is never even fetched from the store.
    const chunk = selected.slice(i, i + EVIDENCE_LOAD_CHUNK).filter((c) => c.row.rawBytes <= MAX_REQUEST_BYTES)
    if (chunk.length === 0) { continue }
    const texts = await loadBodyTexts(storeDir, spool, chunk.map((c) => c.row), EVIDENCE_LOAD_CHUNK)
    for (const { row, ts } of chunk) {
      const raw = texts.get(row.srcName)
      if (raw === undefined) { continue }
      let q: RawRequestBody
      try { q = JSON.parse(raw) as RawRequestBody } catch { continue }
      const pmid = strOrUndef(q.diagnostics?.previous_message_id)
      if (!pmid) { continue }
      const uid = parseUserId(q.metadata?.user_id)
      const ref = refFor(row, spool)
      // Tags are derived HERE, inside the chunk, so `raw` never outlives its load window. The model
      // hint is the request's own model and the ts is the request row's capture ts — the joined
      // response's values differ at most cosmetically, and neither is load-bearing for tag shape.
      let contentTags: ContentTag[] = []
      if (deriveTags) {
        const comp = await buildCallComposition(ref, 0, ts, { modelHint: strOrUndef(q.model), rawText: raw }).catch(() => null)
        contentTags = comp ? deriveContentTags(comp) : []
      }
      index.set(pmid, {
        sessionId: uid.sessionId,
        accountUuid: uid.accountUuid,
        model: strOrUndef(q.model),
        path: ref,
        effort: classifyEffort(numOr0(q.thinking?.budget_tokens)),
        frontmatterFp: computeFrontmatterFp(q),
        injections: extractInjections(q),
        contentTags,
      })
    }
  }
  return index
}

export interface ScanApiCallOptions {
  bodiesDir?: string
  // The Parquet store the drain flushes into (bodiesDir stays the volatile spool). Same default as
  // cacheBreakTimeline.ts's buildCacheBreakTimeline: dataPath('store').
  storeDir?: string
  windowHours?: number
  scanCap?: number
  /** Derive call_content tags during the join pass (the only moment the request text is in memory —
   *  see RequestLink). Default on; indexApiCalls threads its own withContent through here. */
  withContent?: boolean
}

/** The generalized bounded scan every FAL fact row is built from: every response body with a usage
 *  block (NOT just cache_creation > 0), joined to its owning session/account/model/effort/frontmatter
 *  via the previous_message_id chain. Reads the COMPLETE evidence base — the raw spool UNION the
 *  Parquet store (see store/bodiesEvidence.ts) — so a call the ingest drain already flushed and
 *  deleted from the spool stays indexable; the spool-only scan lost it the moment the drain ran.
 *  Never reads more than `scanCap` response + request bodies. */
export async function scanApiCallEvents(
  opts: ScanApiCallOptions = {},
): Promise<{ events: ApiCallEvent[]; coverage: CacheCreationScanCoverage }> {
  const bodiesDir = opts.bodiesDir ?? defaultBodiesDir()
  const storeDir = opts.storeDir ?? dataPath('store')
  const scanCap = opts.scanCap ?? RESPONSE_SCAN_CAP
  const spool = fs.existsSync(bodiesDir) ? bodiesDir : null
  // The spool alone no longer decides whether evidence exists — drained history lives in the Parquet
  // store, and a missing spool with a populated store is a NORMAL state, not "no data".
  const storeExists = fs.existsSync(path.join(storeDir, 'bodies'))
  if (!spool && !storeExists) {
    return {
      events: [],
      coverage: {
        bodiesDir, dirExists: false, responseFilesTotal: 0, responseFilesScanned: 0,
        requestFilesTotal: 0, requestFilesIndexed: 0, scanCap, windowHours: opts.windowHours,
        complete: true,
        note: `No raw-body evidence: neither ${bodiesDir} nor the Parquet store at ${storeDir} exists — set OTEL_LOG_RAW_API_BODIES to capture bodies.`,
      },
    }
  }

  const tsFromMs = opts.windowHours !== undefined && opts.windowHours > 0 ? Date.now() - opts.windowHours * 3_600_000 : undefined
  const respAll = await listBodyEvidence(storeDir, spool, { kind: 'response', tsFromMs })
  const reqAll = await listBodyEvidence(storeDir, spool, { kind: 'request', tsFromMs })
  const { rows: respSelected, matched: responseMatched } = selectRecent(respAll, spool, tsFromMs, scanCap)
  const { rows: reqSelected } = selectRecent(reqAll, spool, tsFromMs, REQUEST_INDEX_CAP)

  const prevIndex = await indexRequestsByPreviousMessageId(storeDir, spool, reqSelected, opts.withContent ?? true)

  const events: ApiCallEvent[] = []
  for (let i = 0; i < respSelected.length; i += EVIDENCE_LOAD_CHUNK) {
    const chunk = respSelected.slice(i, i + EVIDENCE_LOAD_CHUNK).filter((c) => c.row.rawBytes <= MAX_RESPONSE_BYTES)
    if (chunk.length === 0) { continue }
    const texts = await loadBodyTexts(storeDir, spool, chunk.map((c) => c.row), EVIDENCE_LOAD_CHUNK)
    for (const { row, ts } of chunk) {
      const raw = texts.get(row.srcName)
      if (raw === undefined) { continue }
      let body: RawResponseBody
      try { body = JSON.parse(raw) as RawResponseBody } catch { continue }
      if (!body.usage) { continue }
      const responseId = strOrUndef(body.id)
      const link = responseId ? prevIndex.get(responseId) : undefined
      const model = link?.model ?? strOrUndef(body.model) ?? strOrUndef(body.message?.model)
      const tier = body.usage.cache_creation
      const ref = refFor(row, spool)
      // call_id is the response id (msg_…) when present; else a stable sha1 of the row's srcName —
      // NEVER of `ref`, which is LOCATION-DEPENDENT (absolute spool path before the drain, bare
      // srcName after): hashing ref gave one physical call two different primary keys across a
      // drain, so INSERT OR REPLACE kept both rows and every aggregate double-counted its tokens
      // and dollars (review finding). srcName survives the spool→store move unchanged.
      const callId = responseId ?? `sha1:${crypto.createHash('sha1').update(row.srcName).digest('hex')}`
      events.push({
        callId,
        responseRef: ref,
        requestRef: link?.path,
        requestContentTags: link?.contentTags,
        ts,
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
        injections: link?.injections ?? [],
        attributed: Boolean(link),
      })
    }
  }

  const complete = respSelected.length === responseMatched
  const fromStore = respSelected.filter((c) => c.row.location === 'store').length
  return {
    events,
    coverage: {
      bodiesDir, dirExists: spool !== null,
      responseFilesTotal: respAll.length,
      responseFilesScanned: respSelected.length,
      requestFilesTotal: reqAll.length,
      requestFilesIndexed: reqSelected.length,
      scanCap, windowHours: opts.windowHours, complete,
      note: complete
        ? `Scanned all ${responseMatched} response body(ies)${opts.windowHours ? ` in the last ${opts.windowHours}h` : ''} — ${fromStore} from the Parquet store, ${respSelected.length - fromStore} from the raw spool (drained history stays in evidence).`
        : `SAMPLE: ${respSelected.length} most-recent of ${responseMatched} matching response body(ies) (cap ${scanCap}; ${fromStore} store / ${respSelected.length - fromStore} spool). Not full history.`,
    },
  }
}

// ── spawn-config resolution (design §3.3) ────────────────────────────────────────
export interface SpawnRow {
  spawnKind?: string
  spawnModelOverride?: string
  spawnIsolation?: string
  subagentType?: string
  isSidechain: boolean
  parentSessionId?: string
  model?: string
}
export interface ResolvedSpawn {
  spawnKind: string | null
  spawnModelOverride: string | null
  spawnIsolation: string | null
  subagentType: string | null
  isSidechain: number
  parentSession: string | null
  spawnResolution: 'direct' | 'root' | 'unresolved'
}

function sessionsHasColumn(db: SqlDatabase, col: string): boolean {
  try {
    const info = db.exec('PRAGMA table_info(sessions)')[0]
    return Boolean(info && info.values.some(r => r[1] === col))
  } catch { return false }
}

/** Load a Map<session_id, SpawnRow> from the MAIN agentlens.db, read-only. Empty map when the DB is
 *  absent/unopenable — every call then resolves to 'unresolved' (honest, never guessed). The
 *  spawn_subagent_type column is read only when present (an un-migrated older DB lacks it — degrade to
 *  null rather than failing the whole load). */
export async function loadSpawnMap(mainDbPath: string = defaultMainDb()): Promise<Map<string, SpawnRow>> {
  const map = new Map<string, SpawnRow>()
  const SQL = await loadSqlJs()
  if (!SQL) { return map }
  let buf: Buffer
  try { buf = fs.readFileSync(mainDbPath) } catch { return map }
  let db: SqlDatabase
  try { db = new SQL.Database(buf) } catch { return map }
  try {
    const satCol = sessionsHasColumn(db, 'spawn_subagent_type') ? 'spawn_subagent_type' : "NULL AS spawn_subagent_type"
    const res = db.exec(`SELECT session_id, spawn_kind, spawn_model_override, spawn_isolation, is_sidechain, parent_session_id, model, ${satCol} FROM sessions`)
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
          subagentType: strOrUndef(row[7]),
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
const UNRESOLVED: ResolvedSpawn = { spawnKind: null, spawnModelOverride: null, spawnIsolation: null, subagentType: null, isSidechain: 0, parentSession: null, spawnResolution: 'unresolved' }
export function resolveSpawn(sessionId: string | undefined, spawnMap: Map<string, SpawnRow>): ResolvedSpawn {
  if (!sessionId) { return UNRESOLVED }
  const row = spawnMap.get(sessionId)
  if (!row) { return UNRESOLVED }
  if (row.spawnKind) {
    return {
      spawnKind: row.spawnKind,
      spawnModelOverride: row.spawnModelOverride ?? null,
      spawnIsolation: row.spawnIsolation ?? null,
      subagentType: row.subagentType ?? null,
      isSidechain: row.isSidechain ? 1 : 0,
      parentSession: row.parentSessionId ?? null,
      spawnResolution: 'direct',
    }
  }
  if (!row.parentSessionId) {
    return { spawnKind: 'root', spawnModelOverride: null, spawnIsolation: null, subagentType: null, isSidechain: row.isSidechain ? 1 : 0, parentSession: null, spawnResolution: 'root' }
  }
  // Matched a child row that carries no spawn_kind — matched directly but the kind is genuinely
  // unknown; leave it null rather than fabricating one.
  return { spawnKind: null, spawnModelOverride: row.spawnModelOverride ?? null, spawnIsolation: row.spawnIsolation ?? null, subagentType: row.subagentType ?? null, isSidechain: row.isSidechain ? 1 : 0, parentSession: row.parentSessionId, spawnResolution: 'direct' }
}

// ── the indexer ─────────────────────────────────────────────────────────────────
export interface IndexApiCallsOptions extends ScanApiCallOptions {
  forensicsDbPath?: string
  mainDbPath?: string
  // withContent is inherited from ScanApiCallOptions — tags are derived in the scan's join pass.
  /** Fill call_injections from the request's system[]/tools[] (computed FREE in the join pass). Default on. */
  withInjections?: boolean
}

const AC_INSERT_SQL = `INSERT OR REPLACE INTO api_calls (
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

function apiCallParams(ev: ApiCallEvent, spawn: ResolvedSpawn, now: number): Record<string, unknown> {
  const model = ev.model ?? null
  const costUsd = model ? calcTokenCostUsd(ev.inputTokens, ev.cacheReadTokens, ev.cacheCreationTokens, ev.outputTokens, model) : 0
  // billable_weight is built from the tier split (5m/1h), but a response can carry a flat
  // cache_creation total with NO tier sub-object (both tiers 0) — see cacheCreationForensics. In that
  // case attribute the flat total to the 5-min tier (its default weight) so the priciest bucket is
  // counted instead of dropped; otherwise billable_weight disagrees with cost_usd (which already uses
  // the flat total) and every "worst config" ranking undercounts cache-write-heavy configs. The stored
  // tier_5m_tokens column below is left as-is — only the weight computation gets the synthesized value.
  const weightTier5m = (ev.tier5mTokens === 0 && ev.tier1hTokens === 0 && ev.cacheCreationTokens > 0)
    ? ev.cacheCreationTokens : ev.tier5mTokens
  const weight = billableWeight(weightTier5m, ev.tier1hTokens, ev.cacheReadTokens, ev.outputTokens, ev.inputTokens, model)
  return {
    ':call_id': ev.callId, ':response_ref': ev.responseRef, ':request_ref': ev.requestRef ?? null, ':ts': ev.ts,
    ':session_id': ev.sessionId ?? null, ':account_uuid': ev.accountUuid ?? null, ':model': model, ':effort': ev.effort,
    ':spawn_kind': spawn.spawnKind, ':subagent_type': spawn.subagentType, ':spawn_model_override': spawn.spawnModelOverride,
    ':spawn_isolation': spawn.spawnIsolation, ':is_sidechain': spawn.isSidechain, ':parent_session': spawn.parentSession,
    ':spawn_resolution': spawn.spawnResolution,
    ':input_tokens': ev.inputTokens, ':output_tokens': ev.outputTokens, ':cache_read_tokens': ev.cacheReadTokens,
    ':cache_creation_tokens': ev.cacheCreationTokens, ':tier_5m_tokens': ev.tier5mTokens, ':tier_1h_tokens': ev.tier1hTokens,
    ':break_cause': null, ':culprit_fingerprint': null, ':gap_minutes': null, ':frontmatter_fp': ev.frontmatterFp ?? null,
    ':cost_usd': costUsd, ':billable_weight': weight, ':indexed_at': now,
  }
}

// Manual cascade (sql.js does not reliably honor ON DELETE CASCADE): clear a call's child rows before
// re-inserting, so a re-index never leaves stale content/injection rows behind (mirrors DatabaseWriter).
function writeInjections(db: SqlDatabase, callId: string, rows: InjectionRow[]): void {
  db.run('DELETE FROM call_injections WHERE call_id = :id', { ':id': callId })
  for (const r of rows) {
    db.run('INSERT OR REPLACE INTO call_injections (call_id, kind, name, tokens) VALUES (:id, :k, :n, :t)',
      { ':id': callId, ':k': r.kind, ':n': r.name, ':t': r.tokens })
  }
}
function writeContent(db: SqlDatabase, callId: string, tags: ContentTag[]): void {
  db.run('DELETE FROM call_content WHERE call_id = :id', { ':id': callId })
  for (const t of tags) {
    db.run('INSERT OR REPLACE INTO call_content (call_id, tag, tokens, count) VALUES (:id, :tag, :tok, :cnt)',
      { ':id': callId, ':tag': t.tag, ':tok': t.tokens, ':cnt': t.count })
  }
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
 *  sessions table catches up. Fills tokens+tiers+spawn-join+spawn_resolution+frontmatter_fp+cost+
 *  billable_weight on every call, plus call_injections (skill/mcp/rule/claudemd, default on) and
 *  call_content (image, binary, big_file_read, tool_result kinds, tool_catalog_large, thinking_heavy;
 *  default on). break_cause/culprit/gap stay NULL until the optional cacheBreakTimeline dependency lands.
 *  Returns { dbAvailable:false } (graceful) when sql.js is unavailable. */
export async function indexApiCalls(opts: IndexApiCallsOptions = {}): Promise<IndexApiCallsResult> {
  const forensicsDbPath = opts.forensicsDbPath ?? defaultForensicsDb()
  const withContent = opts.withContent ?? true
  const withInjections = opts.withInjections ?? true
  const { events, coverage } = await scanApiCallEvents(opts)

  const fdb = await openForensicsDb(forensicsDbPath)
  if (!fdb) {
    return { inserted: 0, coverage, forensicsDbPath, dbAvailable: false, highWaterMs: 0 }
  }
  const spawnMap = await loadSpawnMap(opts.mainDbPath ?? defaultMainDb())
  const db = fdb.raw
  const now = Date.now()
  let highWater = 0
  let inserted = 0

  // Content tags were derived during the scan's join pass (the only moment the request text is in
  // memory — see RequestLink); here they are only shuffled into the write map, no I/O.
  const contentByCall = new Map<string, ContentTag[]>()
  if (withContent) {
    for (const ev of events) { contentByCall.set(ev.callId, ev.requestContentTags ?? []) }
  }

  try {
    db.run('BEGIN')
    for (const ev of events) {
      const spawn = resolveSpawn(ev.sessionId, spawnMap)
      db.run(AC_INSERT_SQL, apiCallParams(ev, spawn, now))
      if (withInjections) { writeInjections(db, ev.callId, ev.injections) }
      if (withContent) { writeContent(db, ev.callId, contentByCall.get(ev.callId) ?? []) }
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

/** Re-index only when the fact DB is missing or its last run is older than `maxAgeMs` (default 5 min).
 *  This is what the MCP tools call before answering: the first query pays the index cost, later queries
 *  within the freshness window reuse the cached facts. `force` skips the freshness check. */
export async function ensureFreshIndex(opts: IndexApiCallsOptions & { maxAgeMs?: number; force?: boolean } = {}): Promise<{ indexed: boolean; result?: IndexApiCallsResult }> {
  const forensicsDbPath = opts.forensicsDbPath ?? defaultForensicsDb()
  const maxAgeMs = opts.maxAgeMs ?? 5 * 60_000
  if (!opts.force && fs.existsSync(forensicsDbPath)) {
    const fdb = await openForensicsDb(forensicsDbPath)
    if (fdb) {
      const last = Number(readIndexState(fdb.raw, 'last_run_ms') ?? '0')
      fdb.close()
      if (last > 0 && Date.now() - last < maxAgeMs) { return { indexed: false } }
    }
  }
  const result = await indexApiCalls(opts)
  return { indexed: true, result }
}
