---
trdd-id: QSFYIHUO
title: Migrate cache-history consumers off raw-body scanning onto api_calls/cache_turns
column: todo
created: 2026-09-03T04:47:31+0200
updated: 2026-10-09T01:48:26+0200
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

## Step 1 landed (2026-10-09) — cache_event_log.rs

cc49a819. Durable-first enrichment: LedgerEnv gains store_dir (ui.rs threads data_dir/store); load_store_facts = ONE windowed DuckDB scan of the api_call parts (kind='response', ts_ms >= ledger window since) keyed by response stem == OTEL request_id (otelCallEvents.ts:11-13 measured basis); enrich_durable_then_body falls back to the untouched enrich_from_body only when the store has no row (pre-store traffic / capture off). Acceptance test: store seeded through the REAL writer, NO body file, whole ledger driven through a real span segment (numeric ns startTime — the ISO-string parse path returns ts=0, a fixture trap measured here); asserts miss reason + missed tokens + 1-hour TTL all from the DURABLE row. Gates: build 0, clippy -D warnings 0, ccevent_parity 6/6 UNCHANGED (store_dir None == old path), new test 1/1, identities 0. Review round 1 dispositions ALL applied: (1) window filter on the scan; (2) or_insert first-wins note recorded (unique API stems make collisions theoretical); (3) TTL assertion restored. Steps 2 (cache_break_timeline) and 3 (investigator_scan) NOT started — one file at a time per the card.
Step-1 record review (fork, 2026-10-09): no blockers — transcription of cc49a819 verified faithful; 'dispositions applied before commit' confirmed strictly stronger than claimed; no acceptance box ticked by 'landed'. Caveat per review finding 1 (matches GVA8TTJF round 3's standard): the fork reviewed BLIND, zero tool calls — epistemic footing transcript-bound, not file-bound; every mechanical claim independently covered by the in-session gate runs.

## Step 2 design (2026-10-09) — revised per review + measure

Step 2 CANNOT be done as the card's WHAT names it: frontmatter_fp was deliberately rejected by 9SYRK6SW deviation 3 (hashes identity, not bytes), and classify_cache_break consumes 13 TurnPrefix fields ApiCallRow does not carry (10 missing + 3 partial) — feeding the classifier from today's schema regresses 27 of 34 causes to UNCLASSIFIED and violates the card's own parity bar (MEASURE A3, field-by-field table in reports_dev/20261009-step2-measure.md). Revised design: (1) persist the serialized TurnPrefix at ingest as one nullable request-row column prefix_json (version key v:1 inside the JSON); extractor injected from agentlens-core as a callback because the store cannot call the core extractor (crate cycle, api_call.rs:178), threaded chores.rs::bodies_pass → ingest_pass_observed → ingest_body_with; ingest_body keeps its 4-arg signature delegating with None so the 15 test sites stay untouched; alstore CLI passes None (NULL rows → body fallback).
(2) Read path: scan_sessions_and_responses gains a windowed-in-SQL api_calls pass (ts_ms >= since; deserialize prefix_json only for the capped slice, mirroring step-1 review round 1's windowing lesson); NULL-prefix_json rows and pre-writer history fall back to the existing spool∪store body scan; dedup by request stem across the two sources; three consecutive store-fed prefixes supply prev2 for SubagentInterleave. (3) Review findings applied: NO 512KB cap (MEASURE A4: real corpus largest = 116KB serialized, ~130B/block — never hit); full-struct round-trip test (from_value(prefix_json) deep-equals extract_turn_prefix(body)); per-cause verdict matrix test (34-cause body pairs through BOTH paths, diff full events arrays); v version key for mixed-shape detection. (4) Owned limitations on this card: store now carries core's TurnPrefix struct (fixed extraction bugs fossilize in old rows — mixed-provenance sessions classify from two extractor versions); accountUuid DEGRADES on store-fed turns (live wire field at cache_break_timeline.rs:2782 but no-identities doctrine forbids persisting it — report-facing loss accepted, USER may overrule); boundary-turn clock mixing (mtime vs capture ts) named, tolerable per COMPACTION_HOOK_SLACK precedent. (5) cache_turns_sql.rs:98 SELECT * narrowed to named columns (A5). Alternatives declined: store-held body blobs as prefix source (satisfies box 2's letter, defeats the card's WHY — the 176MB re-parse hazard); migrating classifier onto today's schema (regresses 27/34 causes). Gates planned: build 0, clippy -D 0, parity suites unchanged, new tests green.
ROUND-2 REVIEW (fork): direction confirmed, 0 blockers; all 8 round-1 findings verified genuinely absorbed. SIX SPECS MANDATORY BEFORE IMPLEMENTATION: (S1) v-key reader policy — missing or unknown v in prefix_json routes THAT ROW to the body-scan fallback, never fails the query; a TurnPrefix shape change bumps v and old-v rows fall back (this is the only cross-upgrade defense — the matrix test proves same-version parity only, it structurally cannot catch version skew); no shape-tolerance across versions (that is the forbidden compat shim). (S2) Unwindowed SQL shape: when window_hours is None, ORDER BY ts_ms DESC LIMIT scan_cap BEFORE projecting prefix_json — top-K must precede wide-column projection or pushdown may read prefix_json for all rows. (S3) from_value is the EXACT inverse of to_value — round-trip test is EXHAUSTIVE over every enum variant (GitAnchor, BlockContentKind, Layer), not representative; F2 is the load-bearing invariant that makes mixed-provenance classification sound, not just a test. (S4) Matrix test shape: 31 causes from body pairs, SubagentInterleave needs a TRIPLE (A→B→A), TtlExpiry needs a controlled ts/gap channel (gap_ms is metadata, not body-derived), Compaction = hook-events fixture or explicit inference-path-only note. (S5) Response side also builds store-first with spool-union fallback (a response present only in the spool must still join). (S6) Wiring test: the production path (chores→ingest_pass_observed→ingest) provably threads the extractor — asserting wiring at the call site per the fsync-barrier precedent; closes the silent-NULL future-caller failure mode. (N6 ruling) accountUuid degradation: PROCEED — project already ruled account ids out of the store (no-identities doctrine), degradation touches one diagnostic field only and is reversible.
