---
trdd-id: CCFORNSC
title: cache_creation forensic diagnostics — WHO burns it, WHAT is in it, TTL vs cache-break
column: completed
created: 2026-07-09T07:59:47+0200
updated: 2026-08-18T12:45:00+0200
current-owner: 777b8f52
assignee: null
priority: 1
severity: HIGH
effort: M
labels: [mcp, cache-creation, otel-raw-body, cost-forensics, ttl]
task-type: feature
parent-trdd: null
npt: []
eht: []
relevant-rules: []
release-via: none
delivery: direct-push
target-branch: main
feature-branch: fix/logreader-large-jsonl
test-requirements: [unit, typecheck, lint]
runtime-targets: [macos, linux]
impacts: [public-api]
attempts: 1
last-test-result: pass
implementation-commits: []
external-refs: []
---

## ⏵ STATE — READ THIS FIRST ON RESUME (authoritative; supersedes the body) — 2026-07-09

**DONE (2026-07-09):** three MCP tools shipped — `get_cache_creation_report`, `trace_expensive_writes`,
`get_cache_break_gap_report` — in `src/cacheCreationForensics.ts` (new module) + wired into
`src/mcpServer.ts`. 20 real unit tests in `src/test/cacheCreationForensics.test.ts` (all pass, including
one 🐌 slow test against the REAL `~/.agentlens/otel-bodies` directory on this machine — it exists here,
so that test actually ran, not skipped). Gates green: `check-types`, `lint` (0 errors), `node esbuild.js`,
full mocha suite (408 passing, 2 pre-existing pending, 0 failing).

**WHY:** three ad-hoc forensic Python scripts (`cc_scan.py`, `cc_trace.py`, `cc_ttl.py` — run by hand
against this machine's `~/.agentlens/otel-bodies`) found that `cache_creation_input_tokens` (billed at
~1.25x the base input rate — a cold PREFIX RE-WRITE, not a cache hit) is the single most expensive,
least-visible token bucket AgentLens tracks. The dashboard's aggregate "hit rate" hides WHICH sessions/
accounts/models are causing the writes, WHAT content is in the huge ones, and — critically — WHETHER a
write was caused by 5-minute TTL expiry (fixable with a heartbeat) or a genuine cache BREAK (a heartbeat
does nothing; the prefix itself is changing). Verified finding on this machine (via `cc_ttl.py`): 67% of
big (≥100k token) writes happen at <4.5-minute gaps (cache BREAKS, not TTL expiry); only ~1% land in the
4.5-6m TTL window; 70% of all cache_creation is the 5m ephemeral tier, 30% the 1h tier. Top writers:
ai-maestro, ANIME2SVG, janitor, agentlens (this project, dogfooding itself).

### THE CORRELATION (empirically discovered — reused from TRDD-ICHAVFCS's OTEL body export)
OTEL raw bodies are written as `<uuid>.request.json` + `req_<request_id>.response.json` — DIFFERENT ids,
no direct link. The join: a request's `diagnostics.previous_message_id` equals the PRIOR response's `id`
(`msg_…`) — every Claude Code turn's request carries the id of the response it replies to. So the request
that FOLLOWS a response shares that response's session (`metadata.user_id`, parsed by the existing
`parseUserId` in `src/rawBodyContext.ts`). The LAST turn of a session (or one still in flight) has no
following request — those responses are UNATTRIBUTABLE and are reported as an explicit bucket, never
hidden or silently dropped into an attributed group's totals.

### WHAT WAS BUILT
- **`src/cacheCreationForensics.ts`** (new module) — `scanCacheCreationEvents()`: the shared LAZY +
  BOUNDED disk scan (readdir + stat are metadata-only; JSON content is parsed only for a bounded,
  most-recent-first slice — `RESPONSE_SCAN_CAP` / `REQUEST_INDEX_CAP` = 4000 each — never the whole
  15k+-file directory). Three report builders on top of the shared scan:
  1. `buildCacheCreationReport()` → **`get_cache_creation_report`** MCP tool — ranks WHO (session /
     account / model / hourly time-bucket) is burning cache_creation, heaviest-first, with an explicit
     `unattributed` bucket + a `coverage` block stating exactly what was scanned.
  2. `buildExpensiveWritesTrace()` → **`trace_expensive_writes`** MCP tool — for the biggest single
     writes, resolves session/account via the join and reuses `contextCompositionIndex.buildCallComposition`
     on the owning request body to summarize WHAT is in it (image/tool_result/text/system/thinking token
     shares + tool-catalog size) — POINTER-ONLY (file-path refs, session/account identifiers; never base64
     bytes, raw block text, or the `metadata.user_id` token blob — see the pointer-only unit test).
  3. `buildCacheBreakGapReport()` → **`get_cache_break_gap_report`** MCP tool — splits cache_creation into
     the 5m/1h ephemeral tiers (`usage.cache_creation.ephemeral_{5m,1h}_input_tokens`) and buckets every
     big (≥`minCacheCreate`, default 100k) write by the time gap since the previous call in the SAME
     session: first-call / <4.5m / 4.5-6m (=5m TTL) / 6-15m / 15-65m / >65m (=1h TTL) — tells TTL expiry
     apart from a genuine cache break, which have opposite fixes.
- Reused, did NOT reinvent: `parseUserId` (rawBodyContext.ts) for the join's session/account extraction;
  `buildCallComposition` (contextCompositionIndex.ts) for the block-composition summary; `calcTokenCostUsd`
  (pricing.ts) for per-event cost. No new wiring needed in `standalone/server.ts` or `McpServerOptions` —
  like `compositionIndex`, the new module reads the OTEL bodies directory directly off disk, so it works
  identically in the extension host and the standalone server.
- Archived the three reference scripts (verbatim) at `scripts_dev/cache-forensics/{cc_scan,cc_trace,
  cc_ttl}.py` (gitignored — dev-only preservation of the forensic logic, not published).

### VERIFIED (real data, not just synthetic fixtures)
The 🐌 slow test in `cacheCreationForensics.test.ts` runs `buildCacheCreationReport({windowHours:5})`
against the REAL `~/.agentlens/otel-bodies` on this machine and asserts honest coverage + that the
unattributed total never exceeds the grand total. It ran (not skipped) during this session's gate run.

### NEXT ACTION (if resumed)
None outstanding — TRDD is `complete`. If extending: a dashboard panel surfacing
`get_cache_break_gap_report`'s tier-split + gap-bucket bars would be the natural next step (mirrors
TRDD-CTXQUERY's composition panel), but was NOT requested and is NOT built.

## Body

### Problem
`cache_creation_input_tokens` is the most expensive per-token bucket AgentLens tracks (short of raw
output) and was completely invisible as a per-event, attributable signal — only visible as an aggregate
"cache hit rate" on session cards, which cannot answer "who/what is causing this" or "is a heartbeat even
the right fix".

### Design decisions
- **Bounded, not exhaustive, by default.** The bodies directory holds 15k+ files on a long-lived
  install. Every scan caps at 4000 response files + 4000 request files (most-recent-first), and every
  report's `coverage` block states the sample size vs the total on disk — following the same honesty
  contract as `find_context_hogs` / `get_context_inflation_report` (`HOG_SCAN_CAP` / `CAUSE_SCAN_CAP`).
- **Unattributed is a first-class bucket, never a silent drop.** A response with no following request
  (last turn of a session, or a call still in flight when the scan ran) cannot be joined — it is reported
  explicitly (`unattributed: {events, cacheCreateTokens, costUsd, note}`) rather than excluded from
  totals or misattributed.
- **Pointer-only composition.** `trace_expensive_writes` never returns base64 image bytes or raw block
  text — only token-count summaries + file-path pointers (for a human/agent to `Read` if they choose) and
  the non-secret session_id/account_uuid identifiers. Verified by a dedicated unit test that greps the
  serialized response for a synthetic secret payload and asserts it never appears.
- **The gap-bucket pseudo-session caveat is documented, not hidden.** `get_cache_break_gap_report` groups
  unattributed responses into one shared `(unattributed)` pseudo-session for gap computation (mirroring
  the reference `cc_ttl.py` script's methodology exactly, to reproduce its verified percentages) — the
  module doc and the tool description both call out that gaps computed there mix unrelated calls and are
  indicative only.

### Test coverage (20 tests, `src/test/cacheCreationForensics.test.ts`)
Real files written to a tmp dir per test (no mocks): the previous_message_id join (attributed +
unattributed), cache_creation<=0 exclusion, unknown-model cost-safety, windowHours filtering, missing-
directory handling, report ranking + groupBy (session/account/model/time), the unattributed-bucket
invariant, topN capping, the block-composition breakdown, the pointer-only guarantee, null-composition on
unattributed events, minCacheCreate filtering (both tools), the 5m/1h tier split, TTL/break gap
classification (first-call / <4.5m / 4.5-6m / 6-15m / 15-65m / >65m), the 100k default floor, and the
unattributed pseudo-session grouping — plus the one 🐌 slow real-machine-data test.

## Approval log
- 2026-08-18T12:45:00+0200 — ARCHIVED by USER batch directive ("complete all TRDD"); validity re-verified: src/cacheCreationForensics.ts exists, src/mcpServer.ts:1005,1031,1064 register get_cache_creation_report/trace_expensive_writes/get_cache_break_gap_report.
