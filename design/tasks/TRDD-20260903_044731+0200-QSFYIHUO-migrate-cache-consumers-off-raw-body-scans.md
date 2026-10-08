---
trdd-id: QSFYIHUO
title: Migrate cache-history consumers off raw-body scanning onto api_calls/cache_turns
column: todo
created: 2026-09-03T04:47:31+0200
updated: 2026-10-09T00:25:02+0200
current-owner: main-session
task-type: refactor
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

- **Per Fable advisor verdict on CAJ5RCP9 (2026-09-03):** step 1's `enrich_from_body`
  (`cache_event_log.rs:189-192`) must become a `request_id` lookup, not a `call_id` lookup — there
  is no shared `call_id` between request and response rows. This alone satisfies the parent's
  acceptance box 2 first-pass consumer.
- Design source: `reports/trdd-caj5rcp9/20260903_044515+0200-api-calls-table-design.md` §5.
- Blocked on 9SYRK6SW (writer) and GVA8TTJF (views) — schema + view must be stable and
  proven-matching before any consumer switches.
- NEXT ACTION: migrate the three call sites one file at a time, starting with replacing
  `enrich_from_body` (`cache_event_log.rs:189-192`) with a `request_id` lookup (simplest — direct
  SELECT, no body reconstruction needed).

## WHY

Three independent scanners re-read and re-parse raw OTEL bodies today, and two of them
(`get_cache_event_log`, `investigate_burn`) lose history the moment `bodies_pass` deletes the
files they depend on. Card CAJ5RCP9's core acceptance box 2 requires
`get_cache_break_timeline` to reconstruct "entirely from the durable table with ZERO response
bodies present on disk" — unreachable until this migration lands.

## WHAT (one file at a time — do not batch)

1. **`cache_event_log.rs` / `cache_creation_forensics.rs::scan_cache_creation_events`** — replace
   `enrich_from_body`'s raw-body evidence-store scan (`cache_event_log.rs:189-192`) with a direct
   `SELECT` off the `api_calls` relation keyed by `request_id` (not `call_id` — see STATE): `ts,
   session_id, model, cache_read_tokens, cache_creation_tokens, cache_miss_reason`. No `cost_usd`
   column exists (9SYRK6SW dropped it); prefer the harness-reported cost already carried elsewhere
   per CLAUDE.md doctrine 2 if this consumer needs a cost figure.
2. **`cache_break_timeline.rs`** (`extract_turn_prefix`) — replace body-derived prefix
   reconstruction with `frontmatter_fp`, `previous_message_id`, `ts`, `tier_5m_tokens`/
   `tier_1h_tokens` columns off `api_calls`. This is the one that satisfies acceptance box 2 —
   verify with zero response bodies on disk for the tested session.
3. **`burn/investigator_scan.rs::scan_window`** — replace its own independent raw-body directory
   walk (`list_window`, `scan_responses`, `scan_request`, lines 180-415) with a `SELECT` over
   `api_calls` filtered by window — removes a third redundant JSON parser entirely.
4. `get_cache_break_causes` shares `cache_break_timeline.rs`'s primitives — verify it still works
   after step 2, no separate migration needed (per design doc §5, out of scope to re-verify
   beyond this check).

Migrate and land each step separately so a parity-test regression in one consumer doesn't block
the others (design doc §6, "do this last, and one file at a time").

## ACCEPTANCE

- [ ] `get_cache_event_log` output is unchanged (parity test) after switching to `api_calls`,
      for a session with bodies still on disk (control) and one with bodies already deleted
      (the case this whole card exists to fix).
- [ ] `get_cache_break_timeline` reconstructs entirely from `api_calls` with ZERO response
      bodies present on disk for the tested session (card CAJ5RCP9 acceptance box 2, verified
      literally — delete the bodies, re-run, confirm identical output).
- [ ] `investigate_burn` results are unchanged (parity test) after switching `scan_window` off
      its own raw-body walk onto `api_calls`.
- [ ] `get_cache_break_causes` unaffected (smoke test only, per design doc scope note).
- [ ] All three raw-body scan code paths removed (not left dead) once their replacement is
      verified.

## VERIFICATION

Parity test each consumer: capture its output BEFORE migration on a fixed test session, migrate,
re-run, diff. For `cache_break_timeline`, additionally delete the session's response bodies
between capture and re-run to prove the ZERO-bodies claim.

## Approval log
- 2026-10-09T00:25:02+0200 — column → todo by main-agent@agentlenspro. both blockers' CODE landed (9SYRK6SW committed + was deployed 2026-09-05; GVA8TTJF fb09facf) — schema and views are stable and proven by tests; migration work needs no live collector, its acceptance does

## Notes and lessons learned
