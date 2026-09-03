---
trdd-id: 9SYRK6SW
title: api_call staging table writer at the bodies-pass ingest site
column: planned
created: 2026-09-03T04:47:31+0200
updated: 2026-09-03T04:59:59+0200
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

- **RE-SPEC per Fable advisor verdict (2026-09-03, orchestrator-verified on 80 captured bodies):**
  requests and responses do NOT share a filename stem (`req_<id>.response.json` vs
  `<uuid>.request.json`), so a single `call_id`-keyed row design was wrong. This card now writes
  TWO row kinds, each keyed by its OWN stem — see WHAT below. `cost_usd` is dropped (circular
  crate dependency, see WHY). See parent CAJ5RCP9 STATE for the full verdict text.
- Design source: `reports/trdd-caj5rcp9/20260903_044515+0200-api-calls-table-design.md` §1-2-3
  (superseded on the `call_id`/`cost_usd` points by the advisor verdict above — everything else
  in the design doc still applies).
- NEXT ACTION: add the `api_call` staging table (two row kinds) + writer, wired into the existing
  bodies-pass ingest and flush loop. First of 4 children (1→2→3→4); nothing else in the CAJ5RCP9
  split can start until this lands.

## WHY

The bodies pass (`chores.rs:208` `bodies_pass`) deletes response/request bodies after ingest for
names not in `skip_names` (`pass.rs:479-488`), over-cap files are deferred (`pass.rs:448-451`),
and GATE-1 failures stay on disk unrowed (`pass.rs:496-499`) — so per-call cache facts (miss
reason, token buckets, tier split) evaporate for the common case. `ingest_body`
(`agentlens-store/src/lib.rs:323`) already parses each body's JSON once via `extract_meta`
(`lib.rs:284-297`) before that delete — reached even on the content-dedup path, which still
appends a body row per new `src_name` (`lib.rs:327-333`, next to `append_body_row` at `lib.rs:330`
and `:359`) — so this is the one place to capture the facts durably, at zero extra I/O (reuse the
already-parsed `serde_json::Value`).

`cost_usd` is dropped from this table: `agentlens-store` cannot call `agentlens-core`'s pricing
module because `agentlens-core` depends on `agentlens-store` (`agentlens-core/Cargo.toml:17`) —
adding the reverse edge would be a cycle. OTEL's own harness-reported cost is preferred anyway
per CLAUDE.md doctrine 2 ("prefer a harness-reported `cost_usd` over recomputing"). The pure
extractor `compute_frontmatter_fp` (`forensics_index.rs:78`) moves into `agentlens-store` since it
has no crate-boundary dependency.

**OPEN QUESTION (not a child):** the ~907k bodies already ingested into the store before this
writer deploys never re-enter `ingest_body`, so this table's history starts at deploy time, not
retroactively. A backfill (one-time scan of any bodies still on disk, if any survive) is out of
scope for this card; raise it separately if a historical backfill is later wanted.

## WHAT

Two ROW KINDS, each keyed by its OWN filename stem (per advisor verdict — requests and responses
are NOT pairable by stem):

- **Request rows** — stem = the request file's own uuid (`<uuid>.request.json`). Columns:
  `stem, session_id, ts_ms, model, cc_version, cc_is_subagent, cc_prev_req,
  previous_message_id, system_fp, tools_fp, first_user_fp, breakpoint_positions,
  tool_choice, thinking_config, raw_bytes`. (`system_fp`/`tools_fp`/`first_user_fp` are the
  fingerprint fields per design doc §2; `breakpoint_positions` is a VARCHAR list, never a STRUCT —
  see TYPES below.)
- **Response rows** — stem = `request_id` (the OTLP-side id, `req_<id>.response.json`). Columns:
  `stem, msg_id, ts_ms, model, stop_reason, input_tokens, output_tokens, cache_read_tokens,
  cache_creation_tokens, tier_5m_tokens, tier_1h_tokens, cache_missed_input_tokens,
  cache_miss_reason, service_tier, raw_bytes`. No `cost_usd` (see WHY).

**TYPES (load-bearing):**
- `session_id` — VARCHAR, sealed the same way `body.session_id` already is (`lib.rs:145`); never
  let DuckDB infer it as a UUID type across parquet parts (per ATOM-KR07-9K0D, cited by GVA8TTJF).
- `ts_ms` — BIGINT milliseconds, matching the statusline store's own `ts` column
  (`statusline_store.rs:156`) so the join in GVA8TTJF needs no epoch-unit conversion.
- `breakpoint_positions` — VARCHAR list (e.g. comma-joined or DuckDB `LIST(VARCHAR)`), never a
  STRUCT — keeps `union_by_name := true` reads stable across schema growth.

Both kinds land in ONE `api_call` staging table (nullable columns for the fields the other kind
doesn't have) — union_by_name at read time (GVA8TTJF) coalesces them per call.

- `call_id`/`stem` = filename stem with the `.request.json`/`.response.json` suffix stripped
  (confirmed shared-suffix stripping only — stems themselves differ per kind, see STATE above).
- Add `extract_api_call_meta(raw, src_name) -> ApiCallRow` next to `extract_meta` (`lib.rs:284`),
  reusing the same parsed JSON value — do not re-parse `raw` a second time.
- Add `append_api_call_row(...)` next to `append_body_row` (`lib.rs:299-315`), called from the
  same site(s) `append_body_row` is called from (`lib.rs:330` and `:359`) so the content-dedup
  path is covered too.
- Wire the extraction call into `ingest_body` (`lib.rs:323`), reached for files not in
  `skip_names` (`pass.rs:479-488`) before the `settle!`/delete gate (`fs::remove_file` at
  `pass.rs:381`/`412`) — same ordering guarantee `body` rows already rely on.
- Add `("api_call", "api_calls")` to `flush_detailed`'s `for (table, sub) in [...]` list
  (`lib.rs:215`) so it flushes to `store/api_calls/part-<ms>-<pid>-<seq>.parquet` on the existing
  cadence.
- **Storage plumbing fixes (both required, both currently missing for a 5th table):**
  `open_store` creates only the three existing dirs (`lib.rs:133`) — add the `api_calls` dir
  there; the fsync barrier walks the same three dirs (`pass.rs:291`) — add `api_calls` there too,
  or the new parts are unprotected by the durability barrier.
- No `spawn_kind`/`account_uuid` column — resolved at read time via join, per design doc §1 last
  row (and per no-identities doctrine: `device_id`/`account_uuid` from `metadata.user_id` must
  NOT be persisted).

## ACCEPTANCE

- [ ] `api_call` table exists in the store schema; a new response body ingested during a normal
      bodies-pass tick produces one response-kind row with response-only fields populated and
      NULL request-only fields (no `cost_usd` column at all).
- [ ] A new request body produces one request-kind row with `cc_prev_req`/`previous_message_id`/
      fingerprint fields populated (where present in the source body) and NULL response-only
      fields.
- [ ] `flush_detailed` writes `store/api_calls/*.parquet` parts on the same cadence as `body`/`part`.
- [ ] `open_store` creates the `api_calls` directory and the fsync barrier covers it (verify both
      call sites were touched, not just the schema).
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
