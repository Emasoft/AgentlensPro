// src/basePath.ts — the mount-prefix rules (AgentlensPro#4).
//
// Its own module rather than living in standalone/server.ts because that file creates listening
// servers at import time: a unit test that imported it to reach these two pure functions would boot
// a second server on the machine's real ports and data dir, which the single-owner guard is there to
// refuse. Pure logic that needs testing does not belong behind a side effect.
//
// WHY A MOUNT PREFIX EXISTS AT ALL. The dashboard's assets and API calls are root-absolute. Served
// at the root that is correct; behind a proxy that mounts us under a path it is actively dangerous,
// because the browser resolves `/api/...` against the ORIGIN — so under `https://host/lens/` those
// requests reach the PROXY's `/api/...`, silently cross-wiring two different APIs. ai-maestro hit
// this and worked around it by root-mounting us on a separate port, which then forced them to
// rewrite our CSP `frame-ancestors`. A base path removes the need for both.

/**
 * Normalise a configured prefix to `''` (off) or `/x` — leading slash, no trailing slash — so every
 * consumer can concatenate without a separator check.
 *
 * `/` normalises to OFF, not to a prefix: mounting at the root is the default, and treating `/` as a
 * prefix would double every slash in the emitted URLs.
 */
export function normalizeBasePath(raw: string | undefined | null): string {
  const v = (raw ?? '').trim()
  if (!v || v === '/') return ''
  const withLead = v.startsWith('/') ? v : `/${v}`
  return withLead.replace(/\/+$/, '')
}

/**
 * Remove the mount prefix from an incoming request path.
 *
 * CONDITIONAL by design: a path that does not carry the prefix is returned untouched, because hooks
 * and the CLI talk to this server directly and know nothing about a prefix an operator configured
 * for a proxy. The base path is a serving concern, never an access gate — refusing unprefixed
 * requests would break every local client the moment someone set the variable.
 */
export function stripBasePath(pathname: string, base: string): string {
  if (!base) return pathname
  if (pathname === base) return '/'
  // The boundary check is load-bearing: with base `/lens`, the path `/lensing/x` is NOT under the
  // mount. Without it, a prefix-match would rewrite it to `ing/x` and 404 a legitimate route.
  return pathname.startsWith(`${base}/`) ? pathname.slice(base.length) : pathname
}
