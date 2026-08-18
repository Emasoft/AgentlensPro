---
trdd-id: KDGJ0R38
title: Base-path option — serve the dashboard and /api under a prefix so ai-maestro can mount it same-origin (AgentlensPro#4)
column: completed
created: 2026-07-17T06:58:54+0200
updated: 2026-08-18T13:35:00+0200
current-owner: main
task-type: feature
severity: minor
scope: project
npt: []
eht: []
labels: [ai-maestro, dashboard, embed]
implementation-commits: [ad86dc5]
test-requirements: [unit, typecheck, lint]
---

# Base-path option (`AGENTLENS_BASE_PATH`) — the named need from AgentlensPro#4 §2

## Why (their words, verified reasoning)

ai-maestro's remote (Tailscale) access reverse-proxies the dashboard on its own PORT+1 origin
and must DROP + re-issue our `frame-ancestors` CSP, because our assets and API calls are all
root-absolute (`/dashboard.js`, `fetch("/api/...")`, `/action`) — mounting us under a path on
their EXISTING port would cross-wire our `/api/*` with theirs. A base-path option lets them
serve us same-origin on one port; `frame-ancestors 'self'` is then satisfied as written and
their CSP rewrite disappears. Explicitly "no rush" on their side — the PORT+1 proxy works today.

## Scope sketch (design when picked up)

- `AGENTLENS_BASE_PATH=/x` env (server-wide; a URL param cannot govern asset resolution).
- Server: strip/serve routes under the prefix; getHtml() emits prefixed asset URLs (or a
  `<base href>`), and injects the prefix as a boot global.
- Webview: ONE fetch wrapper reading the boot global — never per-call-site prefixing
  (one source of truth; the standalone shim in server.ts and media/src/App.tsx both route
  through the message protocol, so the touch points are bounded).
- Default (unset) = today's root mount, byte-identical behavior.

## Acceptance

- With the env set: document + every asset + every /api call resolve under the prefix
  (live curl + iframe proof); without it: no behavior change (full suite green).
- Contract note posted on AgentlensPro#4 when shipped.

## Approval log

- 2026-08-18T13:35:00+0200 — CLOSED as ALREADY DONE during the USER "complete all TRDD" sweep. The
  deliverable shipped in ad86dc5 ("feat: AGENTLENS_BASE_PATH (#4)", released v2.19.0) with exactly
  this card's design: `normalizeBasePath(process.env.AGENTLENS_BASE_PATH)` in standalone/server.ts,
  prefixed asset URLs + the `window.__AGENTLENS_BASE__` boot global, and media/src/apiBase.ts as
  the ONE webview fetch wrapper. Pinned by src/test/basePath.test.ts; the changelog entry closed
  issue #4 (f8668dc). The card simply was never closed when the work landed. Column → completed,
  archived.
