/**
 * Browser-origin policy for every locally-bound HTTP surface (UI server, MCP endpoint).
 *
 * ONE source of truth (TRDD-F6BM1BDI): these servers return the user's session data (prompts,
 * costs, project paths), so a wildcard `Access-Control-Allow-Origin: *` is a cross-origin
 * read-exfiltration vector — any web page the user browses could fetch() the loopback port and
 * read the response. The policy: reflect the Origin ONLY when it is genuinely same-origin or a
 * loopback origin; otherwise send no ACAO header at all (the browser then blocks the read).
 * Non-browser clients (the CLI, curl) send no Origin header and are unaffected — CORS is a
 * browser-only mechanism.
 */
import type * as http from 'http'

/** True when the request carries a browser Origin that is neither same-origin nor loopback. */
export function isDisallowedCrossOrigin(req: http.IncomingMessage): boolean {
  const origin = req.headers.origin
  if (typeof origin !== 'string' || origin === '') return false // non-browser / same-origin-no-Origin → allow
  let u: URL
  try { u = new URL(origin) } catch { return true } // unparseable Origin → refuse
  if (req.headers.host && u.host === req.headers.host) return false // genuine same-origin → allow
  // WHATWG URL KEEPS the brackets on an IPv6 hostname ('http://[::1]' → hostname '[::1]'), so they
  // must be stripped or the '::1' comparison never matches (the pre-extraction copy of this
  // predicate assumed bracket-less hostnames and silently refused IPv6 loopback — fail-closed,
  // but wrong).
  const hn = u.hostname.replace(/^\[|\]$/g, '')
  return !(hn === 'localhost' || hn === '127.0.0.1' || hn === '::1')
}

/** Echo the Origin for allowed (same-origin/loopback) origins only — never the wildcard. */
export function setAllowedOriginCors(req: http.IncomingMessage, res: http.ServerResponse): void {
  const origin = req.headers.origin
  if (typeof origin === 'string' && origin !== '' && !isDisallowedCrossOrigin(req)) {
    res.setHeader('Access-Control-Allow-Origin', origin)
    res.setHeader('Vary', 'Origin')
  }
}
