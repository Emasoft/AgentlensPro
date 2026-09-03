---
trdd-id: 9SYRK6SW
title: api_call staging table writer at the bodies-pass ingest site
column: planned
created: 2026-09-03T04:47:31+0200
updated: 2026-09-03T04:47:31+0200
current-owner: main-session
task-type: feature
priority: high
min-approval-requirement: none
parent-trdd: CAJ5RCP9
created-by: main-session
npt: []
eht: []
blocked-by: []
---

## ⏵ STATE — READ THIS FIRST ON RESUME (authoritative; supersedes the body) — 2026-09-03

- Design source: `reports/trdd-caj5rcp9/20260903_044515+0200-api-calls-table-design.md` §1-2-3.
- NEXT ACTION: add the `api_call` staging table + writer, wired into the existing bodies-pass
  ingest and flush loop. First of 4 children (1→2→3→4); nothing else in the CAJ5RCP9 split can
  start until this lands.

## WHY

The bodies pass (`chores.rs:208` `bodies_pass`) deletes response/request bodies after ingest
(`pass.rs:381`/`412`), so per-call cache facts (miss reason, token buckets, tier split) evaporate.
`ingest_body` (`agentlens-store/src/lib.rs:323`) already parses each body's JSON once via
`extract_meta` (`lib.rs:284-297`) before that delete — this is the one place to capture the facts
durably, at zero extra I/O (reuse the already-parsed `serde_json::Value`).

## WHAT

- Add `api_call` staging table next to `blob`/`body`/`part` (`lib.rs:143-150`), columns per the
  design doc §2: `call_id, kind, ts, session_id, model, effort, input_tokens, output_tokens,
  cache_read_tokens, cache_creation_tokens, tier_5m_tokens, tier_1h_tokens, cache_miss_reason,
  previous_message_id, frontmatter_fp, cost_usd, raw_bytes`. One row per ingested FILE (request
  or response), not per call — see design doc §2 for why (Parquet immutability, no UPDATE-in-place).
- `call_id` = filename stem with `.request.json`/`.response.json` suffix stripped (confirmed
  shared stem, `cache_event_log.rs:188`).
- Add `extract_api_call_meta(raw, src_name) -> ApiCallRow` next to `extract_meta` (`lib.rs:284`),
  reusing the same parsed JSON value — do not re-parse `raw` a second time.
- Add `append_api_call_row(...)` next to `append_body_row` (`lib.rs:299-315`).
- Wire the extraction call into `ingest_body` (`lib.rs:323`), called from `pass.rs:486` before the
  `settle!`/delete gate (`pass.rs:274-`, `fs::remove_file` at `pass.rs:381`/`412`) — same ordering
  guarantee `body` rows already rely on.
- Add `("api_call", "api_calls")` to `flush_detailed`'s `for (table, sub) in [...]` list
  (`lib.rs:215`) so it flushes to `store/api_calls/part-<ms>-<pid>-<seq>.parquet` on the existing
  cadence — no new lock, no new fsync barrier.
- `cost_usd` computed via `pricing.rs::calc_token_cost_usd` (tier-aware, per CLAUDE.md doctrine 2)
  on response rows only.
- No `spawn_kind`/`account_uuid` column — resolved at read time via join, per design doc §1 last row.

## ACCEPTANCE

- [ ] `api_call` table exists in the store schema; a new response body ingested during a normal
      bodies-pass tick produces one row with `cost_usd` populated and non-NULL response-only fields.
- [ ] A new request body produces one row with `effort`/`previous_message_id`/`frontmatter_fp`
      populated (where present in the source body) and NULL response-only fields.
- [ ] `flush_detailed` writes `store/api_calls/*.parquet` parts on the same cadence as `body`/`part`.
- [ ] No change in behavior/output for any existing consumer (`get_cache_event_log`,
      `get_cache_break_timeline`, `investigate_burn`) — this child is additive only.
- [ ] `raw = fs::read_to_string` is parsed as JSON exactly once per file (verify no second
      `serde_json::from_str` call was introduced for the new extraction).

## VERIFICATION

1. `cargo build -p agentlens-store` clean.
2. Drop a synthetic request+response pair into the bodies watch dir, let one bodies-pass tick run,
   query `SELECT * FROM api_call` (pre-flush) or the flushed parquet part — confirm both rows.
3. Restart the server, confirm the parquet part under `store/api_calls/` survives and is readable.

## Approval log

## Notes and lessons learned
