---
trdd-id: F6BM1BDI
title: Scope the UI server ACAO from wildcard to same-origin/loopback (close cross-origin read exfil)
column: dev
created: 2026-07-11T16:33:42+0200
updated: 2026-07-16T11:26:00+0200
current-owner: claude-code-review
assignee: claude-code-review
priority: 3
severity: MEDIUM
effort: S
labels: [security, cors, csrf, standalone, exfiltration]
task-type: security
parent-trdd: null
npt: []
eht: []
blocked-by: []
supersedes: []
superseded-by: []
relevant-rules: []
release-via: publish
delivery: direct-push
target-branch: main
merge-strategy: merge
must-pass-tests-before-merge: true
publish-target: npm
publish-channel: stable
test-requirements: [unit, lint, typecheck]
audit-requirements: [security-scan]
review-requirements: [code-review]
runtime-targets: [macos, linux]
impacts: [public-api]
attempts: 0
test-failures: 0
last-test-result: pass
last-test-at: 2026-07-11T16:38:06+0200
implementation-commits: []
pr-url: null
---

## ⏵ STATE — READ THIS FIRST ON RESUME (authoritative) — 2026-07-16

**✅ DONE + verified (2026-07-11).** `setAllowedOriginCors` (reuses `isDisallowedCrossOrigin`)
replaces the blanket `ACAO: *`; evil.com gets no ACAO, loopback origin echoed, same-origin
needs none. TDD `src/test/standaloneCors.test.ts` (real boot, 3 cases). Gate GREEN
**876 passing / 0 failing**, tsc 0-error. RED provable by inspection (blanket `*` fails all
3 assertions). Committed + merged to main (see git log). Not pushed (npm pkg, not a plugin).

**2026-07-16 addendum — the MCP endpoint sibling is CLOSED (branch review sweep).** The
standalone MCP HTTP server (`startMcpHttpServer`) carried the SAME `ACAO: *` this TRDD removed
from the UI server. Fixed on `feat/cache-expiry-probe`: the predicate + echo helper moved to
**`src/httpOrigin.ts`** (ONE source of truth; `standalone/server.ts` and `src/mcpServer.ts` both
import it), `/mcp` gets scoped ACAO + a 403 CSRF gate on cross-origin POST (POST executes a tool)
+ a 4 MB body cap + leak-proof per-request transport close. Extracting the predicate surfaced a
latent bug in THIS TRDD's original implementation: WHATWG `URL.hostname` keeps the brackets on
IPv6 (`'[::1]'`), so the `hn === '::1'` comparison never matched and IPv6-loopback origins were
silently refused (fail-closed, but wrong) — now stripped and unit-tested. Coverage:
`src/test/httpOrigin.test.ts` (unit) + 5 MCP cases in `standaloneCors.test.ts` (real boot).

**What this is:** a security hardening surfaced during the /go-on-yourself broader
eval after the code-review remediation (TRDD-4AFOFVFD). The round-1 sweep closed the
cross-origin WRITE vector with a CSRF gate (`isDisallowedCrossOrigin`, guards non-GET/HEAD
only). This closes the READ counterpart.

**The gap (verified 2026-07-11):** `standalone/server.ts` `uiServer` sets
`res.setHeader('Access-Control-Allow-Origin', '*')` unconditionally (@2139). The CSRF
gate (@2143) only guards state-changing methods; GET/HEAD are ungated on the theory
(comment @2142) that "the read endpoints are non-sensitive." But the read endpoints
(`/api/summary`, `/api/sessions`, `/api/session/*`, `/api/debug/*`) return the user's
AI-session data — prompt text, costs, model names, project file paths — which reveals
what the user is working on. With `ACAO: *`, ANY web page the user is browsing (evil.com)
can `fetch('http://localhost:<UI_PORT>/api/summary')` and READ the JSON cross-origin
(the browser permits the read because `ACAO: *` allows it). The server binds 127.0.0.1
so a remote attacker can't reach it, but the user's OWN browser can — a drive-by
localhost-scraping / DNS-rebinding-class exfiltration of local AI-session data.

**Why the wildcard is safe to remove:** the dashboard is SAME-ORIGIN with the UI API
(one server), so same-origin reads need NO ACAO header at all. OTLP ingestion is on a
SEPARATE server (`otlpServer`, different port) reached server-to-server by agent SDK
exporters (no browser, no CORS). There is NO legitimate cross-origin browser consumer
of the UI API, so `ACAO: *` serves nothing and only enables the exfil.

## NEXT ACTION / design (integrate, don't relax — per /go-on-yourself)

Replace the unconditional `res.setHeader('Access-Control-Allow-Origin', '*')` with a
helper that ECHOES the request Origin as ACAO ONLY when it is allowed (same-origin or
loopback — reusing the existing `isDisallowedCrossOrigin` predicate), plus `Vary: Origin`.
No Origin (same-origin / non-browser Node clients) → no ACAO needed. Disallowed
cross-origin (evil.com) → no ACAO → the browser blocks the read. This preserves the
same-origin dashboard AND any loopback tooling while closing the exfil; it strictly
tightens (never relaxes) and reuses the round-1 predicate (single source of truth for
"is this origin allowed").

```ts
function setAllowedOriginCors(req: http.IncomingMessage, res: http.ServerResponse): void {
  const origin = req.headers.origin
  if (typeof origin === 'string' && origin !== '' && !isDisallowedCrossOrigin(req)) {
    res.setHeader('Access-Control-Allow-Origin', origin) // loopback / same-origin only
    res.setHeader('Vary', 'Origin')
  }
}
```

Also correct the @2142 comment ("read endpoints are non-sensitive" is false — they carry
prompts/costs/paths; the reason GET is CSRF-ungated is that reads have no write side
effect, NOT that the data is non-sensitive — and the ACAO scoping is what protects the
read data now).

## TDD

Extend the standalone real-boot test harness (`src/test/standaloneCodexIngest.test.ts`
pattern): (a) a GET with `Origin: https://evil.com` → response has NO
`Access-Control-Allow-Origin` header (browser would block the read); (b) a GET with a
loopback `Origin: http://localhost:9999` → ACAO echoes that origin; (c) a GET with no
Origin (same-origin/Node) → no ACAO, still 200. Must fail before the fix (blanket `*`
would echo `*` for evil.com).

## Load-bearing facts / gotchas

- Only `uiServer` sets ACAO (@2139); `otlpServer` sets none (correct — server-to-server).
- Reuse `isDisallowedCrossOrigin` (@2107) — do NOT re-encode the allowed-origin rule.
- The API is designed around "simple" requests (no preflight) — no OPTIONS handler
  needed; scoping ACAO does not require adding preflight handling.
- Same gate/Node split as the parent: `bash scripts/safe-deploy.sh --dry-run`.
- Not a plugin → do NOT push; owner triggers deploy.

## Approval log
- 2026-07-11 — surfaced during /go-on-yourself broader eval; security hardening (Tier-0
  in-scope security fix, direct continuation of the round-1 CSRF/exfil work).
