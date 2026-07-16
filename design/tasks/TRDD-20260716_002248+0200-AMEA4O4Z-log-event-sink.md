---
trdd-id: AMEA4O4Z
title: Log-event sink — persist every gated-out OTEL log event instead of dropping it
column: ai_review
created: 2026-07-16T00:22:48+0200
updated: 2026-07-16T14:10:28+0200
current-owner: main
task-type: feature
severity: major
scope: project
parent-trdd: M36W16L0
npt: []
eht: []
---

# Log-event sink — persist every gated-out OTEL log event instead of dropping it

## ⏵ STATE — 2026-07-16 ~00:38 — LANDED + LIVE-VERIFIED, awaiting user review

Implemented, tested (suite 1236 green, +8: 6 sink + 2 collector-gate), bundled (esbuild OK,
symbols in bundle), deployed (server restart, pid 11951), LIVE-VERIFIED: within 20s of boot the
sink held 9 previously-dropped events (hook_execution_start/complete ×6, tool_decision ×2,
assistant_response ×1) in `~/.agentlens/log-events/2026-07-15.ndjsonl` with full attrs + session
ids; `server status` shows `log-events sink: 9 persisted since boot ... (retention 31d)`.

Landed pieces: `src/ndjsonBuckets.ts` (generic daily-bucket machinery, extracted from
hookEventStore — its tests stayed green unchanged), `src/logEventSink.ts` (shared record builder +
append/purge/usage), retention knob `logEventsRetentionDays` (env
`AGENTLENS_LOG_EVENTS_RETENTION_DAYS`, def 31) in RETENTION_META, both gate drop sites wired
(standalone processLogs — the live path — and OtlpCollector via optional constructor sinkDir),
hourly purge, `/api/server-stats.logEvents`, CLI status line, CHANGELOG [Unreleased].

**USER request (2026-07-16, verbatim):** "i do not want to loose any logged data or llm call
request raw from the OTEL telemetry or the hooks." → investigation found the collector's
rich-event gate DROPPING 10 event types on the floor (live counts since one 5h boot:
hook_execution_start/complete 637+637, tool_decision 393, assistant_response 210, user_prompt 81,
hook_registered 121, plugin_loaded 99, mcp_server_connection 33, skill_activated 5,
subagent_completed 2). USER picked fix option 1: persist them.

## Problem

Both OTLP ingest paths (`standalone/server.ts processLogs` — the LIVE one — and
`src/otlpCollector.ts` — test-only since the extension host was removed) accept only
`CLAUDE_RICH_LOG_EVENTS` {api_request, compaction, api_error, api_retries_exhausted} +
`tool_result` + body pointers + gen_ai content, and DISCARD every other log event after counting
it (`noteDroppedLogEvent`). The settings deliberately request `OTEL_LOG_USER_PROMPTS=1` /
`OTEL_LOG_ASSISTANT_RESPONSES=1` — CC emits the events, the collector rejects them.
`tool_decision` (permission grant/deny), `mcp_server_connection`, `hook_registered`,
`plugin_loaded`, `skill_activated`, `subagent_completed` exist NOWHERE else (not in transcripts).

## Design

1. **`src/ndjsonBuckets.ts`** — extract the generic daily-bucket machinery from
   `hookEventStore.ts` (bucketPath, bucketDayMs with the NaN/overflow-date trap, appendLine with
   pre-append offset capture, purgeBuckets, bucketsDiskUsage). hookEventStore refits onto it,
   behavior-identical (its tests must stay green unchanged). WHY extraction: the purge date logic
   is subtle and the two ingest paths already drifted once — duplicated subtle logic is how.
2. **`src/logEventSink.ts`** — `buildDroppedLogEventRecord(name, bare, attrs, rec, ts)` (pure:
   flat merged attrs + string body + record traceId/spanId/timeUnixNano + session extraction) and
   `appendDroppedLogEvent(dir, rec)` → `<data>/log-events/YYYY-MM-DD.ndjsonl`. Nothing meaningful
   on the wire record is discarded.
3. **Retention knob** — `logEventsRetentionDays` in RETENTION_META,
   env `AGENTLENS_LOG_EVENTS_RETENTION_DAYS`, def 31, min 1. Purged on the existing hourly timer.
4. **Wiring** — at BOTH gate drop sites: count (unchanged) + append to the sink. Sink append
   failures console.warn and never break span ingestion (a throwing side-channel would reject the
   whole OTLP payload = lose MORE). Server stats gain `logEventsSink {files, bytes, appended}`;
   CLI `server status` prints a log-events line.

## Non-goals

Re-ingesting sink buckets into spans/cards (read tooling can come later — the data is durable and
greppable NDJSON). Changing what IS ingested as spans. Raw-body capture policy (separate decision,
TRDD-BKF5NZD3).

## Verification

- TDD: sink module tests (append shape, session/body extraction, purge keeps-new/removes-old,
  foreign-file safety, NaN-date safety), retention knob test, gate-site test (dropped event →
  sink line + counter).
- hookEventStore tests green UNCHANGED after the refit.
- Full gate: check-types, lint, 1228+ unit tests, esbuild, deploy, live-verify: dropped events
  appear in `~/.agentlens/log-events/<today>.ndjsonl` within one export interval (~5s).

## Approval log

- 2026-07-16 USER: picked option 1 ("1") from the investigation's proposed fixes — persist the
  dropped log events. Direct USER authorization.
