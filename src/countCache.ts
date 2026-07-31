// src/countCache.ts — remember what count_tokens already answered, keyed by the EXACT bytes sent.
//
// WHY THIS EXISTS. Measuring one 252,562-token capture costs 57.7s wall but only 1.22s of CPU: 201
// count_tokens calls, each uploading a cumulative prefix, ~22M tokens of payload in total. Almost
// none of that content is new between runs — re-mapping the same request repeats every call, and
// ctxvis measures 8 captures whose prefixes are identical up to the point where they diverge.
//
// WHY THE KEY IS THE WIRE STRING, NOT A SEMANTIC SUMMARY. The key is sha256 of the very string
// countTokensExact posts. That reduces "is this hit the answer the API would give" to "were the
// bytes identical", which needs no argument about which fields matter. It also fails SAFE in the
// direction that matters: any change to countable()/buildPrefix()/stripCacheControl(), any edited
// CLAUDE.md, any disabled MCP server, changes the payload and therefore the key — producing a MISS
// and a fresh measurement, never a confident wrong number. A cache that cannot be stale for changed
// content is the only kind this tool may have, because its entire value is "measured, not estimated".
//
// WHY APPEND-ONLY NDJSON AND NOT DUCKDB. src/store/db.ts documents a MEASURED 300x write
// amplification for a persistent .duckdb file (5,018 KB/turn vs 15 KB for an append-only floor).
// This is a key->int map of ~100-byte rows; append-only is both the cheapest and the simplest thing
// that survives a crash mid-run.
import { createHash } from 'crypto'
import * as fs from 'fs'
import * as path from 'path'
import { resolveDataDir } from './dataDir'

/** Bump when the ROW SHAPE changes. Rows of another format are ignored, never guessed at. */
export const CACHE_FORMAT = 1

export const CACHE_DIR = 'countcache'
export const CACHE_FILE = 'counts.ndjson'

interface Row {
  v: number
  /** The anthropic-version the count was taken under — a different API version may tokenize differently. */
  api: string
  model: string
  key: string
  tokens: number
  /** ISO date of the measurement, so provenance is inspectable by eye in the file itself. */
  at: string
  /** Set only on a remembered HTTP 400; `tokens` is then meaningless and stored as -1. */
  err?: string
}

export interface CountCacheStats {
  hits: number
  misses: number
  writes: number
  entries: number
  path: string
}

export interface CountCache {
  /** `wireBody` is the exact string `key` hashes, retained ONLY for the current largest hit so the
   *  freshness sentinel can re-post it verbatim. A hash cannot be inverted, and re-deriving the body
   *  from a parsed copy would probe subtly different bytes than the ones that were cached. */
  get(key: string, wireBody: string): number | null
  put(key: string, model: string, tokens: number): void
  /** A remembered HTTP 400 for these exact bytes, or null. A 400 is the endpoint saying the request
   *  SHAPE is invalid (an intermediate prefix that cannot legally end a request) — deterministic for
   *  identical bytes, and ~1/3 of a large run. Re-uploading a 100k-token prefix each run just to be
   *  rejected again is the single biggest remaining cost on a warm run. Only 400 is ever remembered:
   *  401/403 (credential), 429 (rate limit) and 5xx are all transient or environmental. */
  getError(key: string): string | null
  putError(key: string, model: string, message: string): void
  /** The biggest entry served from cache this run — the sentinel the caller re-measures live. */
  largestHit(): { model: string; tokens: number; wireBody: string } | null
  /** Forget every entry for a model, after the sentinel proved they drifted. */
  dropModel(model: string): void
  stats(): CountCacheStats
}

/** sha256 of the exact request body string. */
export function cacheKey(wireBody: string): string {
  return createHash('sha256').update(Buffer.from(wireBody, 'utf8')).digest('hex')
}

/** Tombstone rows carry a reserved key instead of a hash. A real key is 64 hex chars, so the two can
 *  never collide. Returns the model the tombstone forgets, or null when the row is an ordinary entry. */
const DROP_PREFIX = '__drop-model__:'
export function dropMarker(key: string): string | null {
  return key.startsWith(DROP_PREFIX) ? key.slice(DROP_PREFIX.length) : null
}

/** A cache that never hits and never writes — used for `--refresh` and when the cache is disabled,
 *  so callers need no null checks and no branch can accidentally skip the sentinel logic. */
export function nullCountCache(): CountCache {
  let misses = 0
  return {
    get() { misses++; return null },
    put() { /* nothing is remembered */ },
    getError() { return null },
    putError() { /* nothing is remembered */ },
    largestHit() { return null },
    dropModel() { /* nothing to drop */ },
    stats() { return { hits: 0, misses, writes: 0, entries: 0, path: '(disabled)' } },
  }
}

export interface OpenCountCacheOptions {
  /** Override the data dir (tests). Defaults to resolveDataDir().dir. */
  dir?: string
  /** The anthropic-version rows must match to be usable. */
  apiVersion: string
  env?: NodeJS.ProcessEnv
  /** `--refresh`: never serve a stored count, but DO store what is measured. A flag named "refresh"
   *  that also refused to write would leave the cache stale forever — the user asking for fresh
   *  numbers is exactly the user whose cache should be brought up to date. */
  bypassReads?: boolean
}

/**
 * Load the cache into memory and return a handle. A corrupt or partial line is SKIPPED rather than
 * fatal: the file is appended to concurrently by any number of CLI invocations, so a torn last line
 * is an expected state, not damage. Skipping costs one re-measurement; refusing to start would make
 * a routine race look like a broken install.
 */
export function openCountCache(opts: OpenCountCacheOptions): CountCache {
  const env = opts.env ?? process.env
  if (env.AGENTLENS_COUNT_CACHE?.trim().toLowerCase() === 'off') return nullCountCache()

  const dir = path.join(opts.dir ?? resolveDataDir().dir, CACHE_DIR)
  const file = path.join(dir, CACHE_FILE)

  const map = new Map<string, { model: string; tokens: number; err?: string }>()
  try {
    const text = fs.readFileSync(file, 'utf8')
    for (const line of text.split('\n')) {
      if (!line) continue
      let row: Row
      try { row = JSON.parse(line) as Row } catch { continue }
      // A row from another format or another API version is not evidence about today's tokenizer.
      if (row.v !== CACHE_FORMAT || row.api !== opts.apiVersion) continue
      if (typeof row.key !== 'string' || typeof row.tokens !== 'number') continue
      // A tombstone forgets every entry for that model that was written BEFORE it. Lines are replayed
      // in file order and the file is append-only, so file order IS chronological — entries appended
      // after the drop are newer measurements and correctly survive. Handling this by key alone (the
      // first attempt) silently resurrected the drifted rows on the next open, which is precisely the
      // stale-hit this cache exists to make impossible.
      const dropped = dropMarker(row.key)
      if (dropped !== null) {
        for (const [k, v] of map) if (v.model === dropped) map.delete(k)
        continue
      }
      // Last write wins: a later row for the same key is a deliberate re-measurement (--refresh).
      map.set(row.key, { model: String(row.model ?? ''), tokens: row.tokens, ...(row.err ? { err: row.err } : {}) })
    }
  } catch { /* no cache yet — the first run creates it */ }

  let hits = 0, misses = 0, writes = 0
  let largest: { model: string; tokens: number; wireBody: string } | null = null
  const pending: string[] = []

  const appendPending = (): void => {
    if (pending.length === 0) return
    const chunk = pending.join('')
    pending.length = 0
    try {
      fs.mkdirSync(dir, { recursive: true })
      // Append, never rewrite. Concurrent writers interleave whole lines safely; a reader that sees
      // a torn tail skips it (above). Losing a line costs one re-measurement, so this is never worth
      // a lock.
      fs.appendFileSync(file, chunk)
    } catch { /* a cache that cannot be written is still a correct (slower) tool — never fatal */ }
  }

  return {
    get(key, wireBody) {
      if (opts.bypassReads) { misses++; return null }
      const found = map.get(key)
      if (!found) { misses++; return null }
      // An error row is not a count. Return null so the caller falls through to getError() — and do
      // NOT count a miss here, or the same lookup would be tallied twice (once as a miss, once as a
      // hit in getError) and the digest would report more calls than were made.
      if (found.err) return null
      hits++
      if (!largest || found.tokens > largest.tokens) {
        largest = { model: found.model, tokens: found.tokens, wireBody }
      }
      return found.tokens
    },
    put(key, model, tokens) {
      if (map.get(key)?.tokens === tokens) return
      map.set(key, { model, tokens })
      writes++
      const row: Row = { v: CACHE_FORMAT, api: opts.apiVersion, model, key, tokens, at: new Date().toISOString() }
      pending.push(JSON.stringify(row) + '\n')
      // Flush in batches so a 200-element run does not do 200 syscalls, but often enough that a
      // crash mid-run keeps most of the work.
      if (pending.length >= 32) appendPending()
    },
    getError(key) {
      if (opts.bypassReads) return null
      const found = map.get(key)
      if (!found?.err) return null
      hits++
      return found.err
    },
    putError(key, model, message) {
      if (map.get(key)?.err === message) return
      map.set(key, { model, tokens: -1, err: message })
      writes++
      pending.push(JSON.stringify({
        v: CACHE_FORMAT, api: opts.apiVersion, model, key, tokens: -1,
        at: new Date().toISOString(), err: message,
      } as Row) + '\n')
      if (pending.length >= 32) appendPending()
    },
    largestHit() { return largest },
    dropModel(model) {
      for (const [k, v] of map) if (v.model === model) map.delete(k)
      // The drifted rows stay in the FILE — it is append-only by design — so the forgetting has to be
      // recorded as a tombstone that the loader replays in order. Flush anything pending FIRST, or a
      // buffered entry would be appended after the tombstone and survive the drop it was part of.
      appendPending()
      const row: Row = {
        v: CACHE_FORMAT, api: opts.apiVersion, model, key: `${DROP_PREFIX}${model}`, tokens: -1,
        at: new Date().toISOString(),
      }
      try {
        fs.mkdirSync(dir, { recursive: true })
        fs.appendFileSync(file, JSON.stringify(row) + '\n')
      } catch { /* best effort — an unwritable tombstone still dropped the in-memory entries */ }
    },
    stats() {
      appendPending()
      return { hits, misses, writes, entries: map.size, path: file }
    },
  }
}
