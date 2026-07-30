// src/exactTokens.ts — EXACT input-token counts from Anthropic's `/v1/messages/count_tokens`.
//
// WHY THIS EXISTS. Every token number this repo produced before was an estimate: src/tokenEstimator
// approximates, and calibrating it needed a response whose pairing to its request is not knowable
// from disk. Both problems vanish here — count_tokens takes a request and returns the exact number
// the API would bill for it, so nothing has to be inferred and no response has to be found.
// Measured on a captured 553KB subagent request: estimator 161,685 vs count_tokens 226,910.
//
// WHAT THE RESPONSE `usage` GIVES INSTEAD. A response does carry a breakdown, but along the BILLING
// axis (uncached / cache-write-5m / cache-write-1h / cache-read), not the CONTENT axis. It cannot
// say which file or tool schema the tokens came from. That attribution exists nowhere in the API,
// which is why per-element numbers are built by differencing prefixes (see countPrefixSeries).
//
// FREE, BUT NOT UNLIMITED. count_tokens is not billed as inference; it has its own rate limit, so
// calls are bounded in concurrency and retried on 429.

import { execFileSync } from 'child_process'

const ENDPOINT = 'https://api.anthropic.com/v1/messages/count_tokens'
const API_VERSION = '2023-06-01'
const OAUTH_BETA = 'oauth-2025-04-20'

export interface AnthropicAuth {
  headers: Record<string, string>
  /** How the credential was found — reported to the user, never the credential itself. */
  source: 'ANTHROPIC_API_KEY' | 'claude-code-oauth'
}

/** Resolve a credential for count_tokens. An explicit API key wins; otherwise reuse the Claude Code
 *  OAuth token already on this machine, which is the same credential that produced the captures
 *  being analyzed. The token is never returned to callers, logged, or written anywhere. */
export function resolveAnthropicAuth(env: NodeJS.ProcessEnv = process.env): AnthropicAuth | null {
  const key = env.ANTHROPIC_API_KEY?.trim()
  if (key) {
    return { source: 'ANTHROPIC_API_KEY', headers: { 'x-api-key': key, 'anthropic-version': API_VERSION } }
  }
  if (process.platform !== 'darwin') return null
  try {
    // The Keychain is the only store Claude Code uses on macOS; a miss throws and we fall through.
    const raw = execFileSync('security', ['find-generic-password', '-s', 'Claude Code-credentials', '-w'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 1 << 20 })
    const tok = (JSON.parse(raw) as { claudeAiOauth?: { accessToken?: string } }).claudeAiOauth?.accessToken
    if (!tok) return null
    return {
      source: 'claude-code-oauth',
      headers: {
        authorization: `Bearer ${tok}`,
        'anthropic-version': API_VERSION,
        'anthropic-beta': OAUTH_BETA,
      },
    }
  } catch { return null }
}

/** The subset of a captured body that count_tokens accepts. A captured Claude Code request also
 *  carries betas/context_management/thinking/output_config/metadata; sending those is rejected, so
 *  the countable request is rebuilt from the four content-bearing fields. */
export interface CountableRequest {
  model: string
  messages: unknown[]
  system?: unknown
  tools?: unknown[]
}

export function countable(body: Record<string, unknown>): CountableRequest {
  return {
    model: String(body.model ?? ''),
    messages: (body.messages as unknown[]) ?? [],
    ...(body.system ? { system: body.system } : {}),
    ...(body.tools ? { tools: body.tools as unknown[] } : {}),
  }
}

/** Remove every `cache_control` marker before counting.
 *
 *  Claude Code sends a cache_control shape newer than count_tokens validates — a captured body
 *  carries `cache_control.ephemeral.scope`, which the endpoint rejects outright
 *  ("system.2.cache_control.ephemeral.scope: Extra inputs are not permitted"). Since cache_control
 *  selects a CACHING policy and changes no token, stripping it is lossless for counting and immunises
 *  this path against any future shape drift in that field. */
export function stripCacheControl<T>(value: T): T {
  if (Array.isArray(value)) return value.map(v => stripCacheControl(v)) as unknown as T
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (k === 'cache_control') continue
      out[k] = stripCacheControl(v)
    }
    return out as unknown as T
  }
  return value
}

export class CountTokensError extends Error {
  constructor(message: string, readonly status?: number) { super(message) }
}

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))

/** One exact count. Retries only what is worth retrying: 429 and 5xx. A 4xx other than 429 is a
 *  malformed request — retrying it just burns the rate limit and hides the real error. */
export async function countTokensExact(
  req: CountableRequest, auth: AnthropicAuth, opts: { retries?: number; timeoutMs?: number } = {},
): Promise<number> {
  const retries = opts.retries ?? 4
  // Strip here rather than at each call site: a caller that forgets would get a 400 on every request
  // and, worse, one that is easy to mistake for a per-element problem.
  const body = JSON.stringify(stripCacheControl(req))
  let lastErr: CountTokensError | undefined
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), opts.timeoutMs ?? 120_000)
    try {
      const res = await fetch(ENDPOINT, {
        method: 'POST',
        headers: { ...auth.headers, 'content-type': 'application/json' },
        body,
        signal: ac.signal,
      })
      if (res.ok) {
        const j = await res.json() as { input_tokens?: number }
        if (typeof j.input_tokens !== 'number') throw new CountTokensError('count_tokens returned no input_tokens')
        return j.input_tokens
      }
      const text = (await res.text()).slice(0, 300)
      lastErr = new CountTokensError(`count_tokens ${res.status}: ${text}`, res.status)
      if (res.status !== 429 && res.status < 500) throw lastErr
      // Honour Retry-After when the server sends one; otherwise back off exponentially.
      const ra = Number(res.headers.get('retry-after'))
      await sleep(Number.isFinite(ra) && ra > 0 ? ra * 1000 : 500 * 2 ** attempt)
    } catch (e) {
      if (e instanceof CountTokensError && e.status !== undefined && e.status !== 429 && e.status < 500) throw e
      lastErr = e instanceof CountTokensError ? e : new CountTokensError((e as Error).message)
      if (attempt === retries) break
      await sleep(500 * 2 ** attempt)
    } finally {
      clearTimeout(timer)
    }
  }
  throw lastErr ?? new CountTokensError('count_tokens failed')
}

/** Run `jobs` with bounded concurrency, preserving input order. count_tokens is rate-limited, and a
 *  fan-out of 50 uncapped requests trips it immediately. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T, i: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length)
  let next = 0
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const i = next++
      if (i >= items.length) return
      out[i] = await fn(items[i], i)
    }
  })
  await Promise.all(workers)
  return out
}

export interface PrefixCount { index: number; cumulative: number | null; error?: string }

/** Exact per-item attribution by DIFFERENCING PREFIXES: item k costs count(items[0..k]) −
 *  count(items[0..k-1]). This is the only decomposition consistent with how the model actually
 *  tokenizes — tokens are not independent of their neighbours, so a boundary that merges is charged
 *  to the item that introduced it, exactly as the cache prefix charges it.
 *
 *  A prefix that the API rejects (an invalid intermediate message sequence) yields a null for that
 *  step instead of failing the run; the caller marks those items estimated rather than inventing a
 *  number for them. */
export async function countPrefixSeries(
  build: (upTo: number) => CountableRequest,
  count: number,
  auth: AnthropicAuth,
  concurrency = 4,
): Promise<PrefixCount[]> {
  const idx = Array.from({ length: count }, (_, i) => i)
  return mapLimit(idx, concurrency, async i => {
    try {
      return { index: i, cumulative: await countTokensExact(build(i), auth) }
    } catch (e) {
      return { index: i, cumulative: null, error: (e as Error).message }
    }
  })
}
