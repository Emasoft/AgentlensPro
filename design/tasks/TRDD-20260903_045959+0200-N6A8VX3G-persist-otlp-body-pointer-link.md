---
trdd-id: N6A8VX3G
title: Persist the OTLP body-pointer link so response rows gain a session_id
column: dev
created: 2026-09-03T04:59:59+0200
updated: 2026-10-08T18:54:41+0200
current-owner: main-session
task-type: feature
priority: high
min-approval-requirement: none
parent-trdd: CAJ5RCP9
created-by: main-session
npt: []
eht: []
blocked-by: []
status: tasked
---

## ⏵ STATE — READ THIS FIRST ON RESUME (authoritative; supersedes the body) — 2026-09-03

- Minted from the Fable advisor's design-verdict on CAJ5RCP9 (2026-09-03): the deterministic
  same-call pairing between a request and its response exists ONLY at the OTLP ingest layer
  (`agentlens-ingest`), in-memory, and is thrown away — `api_calls` (GVA8TTJF) cannot give a
  response row a `session_id` without it, so its join match rate would be 0 by construction.
- NEXT ACTION: add a small parquet writer at the point `call_body_registry.rs` already resolves
  the pairing, so the link becomes durable and readable by `agentlens-store`'s `api_calls` view.

## WHY

Requests are `<uuid>.request.json`; responses are `req_<id>.response.json`
(`src/rawBodyContext.ts:35`; `src/cli/ctxmapCli.ts:213`: "cannot be paired by name"). The ONLY
place the same-call pair is actually resolved is at OTLP ingest: `api_request_body` (keyed by
spanId+body_ref) and `api_response_body` (keyed by spanId+request_id) in
`agentlens-ingest/src/lib.rs:624-650` and `call_body_registry.rs:91-121` — both in-memory,
unpersisted. Without this link, a response row written by 9SYRK6SW carries no `session_id` (only
the request side has one), so GVA8TTJF's `cache_turns` join against the statusline feed (which
joins on `session_id`) would silently match nothing.

Chain context (informational, not required for this card): a request's own `cc_prev_req` links to
the *previous* request's `request_id` (`src/test/ctxVisual.test.ts:265`), and its
`previous_message_id` links to the *previous* response's `id` (`forensics_scan.rs:154,552`) — both
one-call-lagged, neither a same-call pair. This card is only about the same-call link.

## WHAT

- At the point `call_body_registry.rs:91-121` resolves a request↔response pair (spanId match), also
  append one row to a small durable table/parquet part: `(session_id, span_id, kind, stem,
  request_id, ts_ms)` — `kind` distinguishes which side of the pair this row's `stem` names
  (request stem = uuid; response stem = the OTLP `request_id`).
- Flush this table on whatever cadence `agentlens-ingest` already uses for durable writes (reuse
  existing flush plumbing — do not invent a new one).
- No new column added to `api_call` itself (9SYRK6SW) — this is a separate small link table that
  `api_calls` (GVA8TTJF) joins against to backfill `session_id` onto response rows.
- No `device_id`/`account_uuid` persisted (no-identities doctrine) — `session_id` only.

## ACCEPTANCE

- [ ] A resolved request↔response pair at `call_body_registry.rs` produces one durable link row
      with `session_id` populated from the request side.
- [ ] The link table survives a server restart (parquet, not in-memory).
- [ ] GVA8TTJF's `cache_turns` join, once wired to use this link, resolves a response row's
      `session_id` via the link (verify with a real pair, not a synthetic one).
- [ ] No `device_id`/`account_uuid` column exists anywhere in the new table.

## VERIFICATION

1. `cargo build -p agentlens-ingest` clean.
2. Drive one real request+response through the collector, confirm one link row is written and
   flushed.
3. Restart the server, confirm the link row is still queryable.

## Approval log
- 2026-10-08T18:51:39+0200 — column → dev by main-agent@agentlenspro.

## Notes and lessons learned

## Dispatched (2026-10-08)

Claimed to dev. Design re-based ON SOURCE READS: the card's 'parquet writer at call_body_registry.rs' becomes a DeltaLog (NDJSON delta+snapshot, the EXISTING durable plumbing — delta_log.rs) at the record_ingested site (lib.rs:1067), because call_body_registry.rs has no flush plumbing and the card says 'reuse existing flush plumbing — do not invent a new one'. Rows carry both sides' pairing keys (request_body_id/message_id from CC >=2.1.274) so GVA8TTJF resolves the pair in SQL; pair resolution itself stays in-memory. Each pointer event = one durable row (the card's 'one row per resolved pair' implemented as one row per pointer event carrying its side's keys — joinable by request_body_id/span_id). No device_id/account_uuid (no-identities doctrine) — they ARE on the wire in metadata.user_id and are dropped at row construction. Parquet-to-NDJSON substitution + the per-pointer reading recorded on GVA8TTJF next. Worker spec: docs_dev/20261008-N6A8VX3G-body-links-spec.md; lean-worker dispatched (load 15.75, under the card's 20 bar). Uncommitted — main session commits.
