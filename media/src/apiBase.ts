// media/src/apiBase.ts — resolve a root-absolute server path against the mount prefix.
//
// WHY (AgentlensPro#4). Every fetch in this dashboard is root-absolute (`/api/timeline/...`,
// `/dashboard.css`). That is correct when we are served at the root, and wrong the moment a reverse
// proxy mounts us under a prefix: the browser resolves `/api/...` against the ORIGIN, so under
// `https://host/lens/` those requests go to `https://host/api/...` — the PROXY's own API, not ours.
// ai-maestro hit exactly this and had to root-mount us on a separate port to avoid cross-wiring two
// different APIs, which in turn forced them to rewrite our CSP `frame-ancestors`.
//
// A `<base href>` tag cannot fix it: `<base>` rewrites RELATIVE urls and leaves root-absolute ones
// alone. So the prefix is injected by the server as `window.__AGENTLENS_BASE__` and applied here.
//
// Empty prefix (the default, and every standalone install) makes this the identity function, so
// nothing changes for anyone not behind a proxy.

declare global {
  interface Window { __AGENTLENS_BASE__?: string }
}

/** The mount prefix: `''` or `/x` (leading slash, no trailing slash). */
export function apiBase(): string {
  const raw = typeof window !== 'undefined' ? window.__AGENTLENS_BASE__ : ''
  if (!raw || raw === '/') return ''
  const withLead = raw.startsWith('/') ? raw : `/${raw}`
  return withLead.replace(/\/+$/, '')
}

/**
 * Resolve a root-absolute server path against the mount prefix.
 *
 * Only paths starting with `/` are prefixed. A caller passing an absolute URL or a relative path is
 * returned untouched — silently prefixing `https://…` would corrupt it, and this helper must be safe
 * to apply everywhere rather than needing a per-call judgement about what kind of URL it is.
 */
export function apiUrl(pathname: string): string {
  if (!pathname.startsWith('/')) return pathname
  return apiBase() + pathname
}

/**
 * Apply the mount prefix to every `fetch` this bundle issues, once, at boot.
 *
 * Installed from dashboard.tsx before the first request. Idempotent — a second call is a no-op, so
 * a hot reload cannot stack wrappers and double-prefix a path.
 *
 * It rewrites ONLY a string (or URL-with-relative-path) first argument beginning with `/`. A
 * `Request` object, an absolute URL, and a relative path all pass through untouched: prefixing
 * those would corrupt them, and the failure would be far more confusing than the one being fixed.
 */
let installed = false
export function installBasePathFetch(): void {
  if (installed || typeof window === 'undefined' || typeof window.fetch !== 'function') return
  installed = true
  const base = apiBase()
  if (!base) return // no prefix: leave the global entirely alone rather than wrap it for nothing
  const original = window.fetch.bind(window)
  window.fetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    if (typeof input === 'string' && input.startsWith('/')) return original(base + input, init)
    return original(input, init)
  }
}
