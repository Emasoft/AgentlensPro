---
trdd-id: N6A8VX3G
title: Persist the OTLP body-pointer link so response rows gain a session_id
column: testing
created: 2026-09-03T04:59:59+0200
updated: 2026-10-16T21:42:38+0200
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
implementation-commits: [34668285]
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

- [x] A resolved request↔response pair at `call_body_registry.rs` produces one durable link row [IMPLEMENTED AS: one durable row per POINTER event carrying both sides' pairing keys (request_body_id/span_id) — the pair is resolved by GVA8TTJF's SQL join, not at ingest; reading recorded on the card]
      with `session_id` populated from the request side.
- [x] The link table survives a server restart (parquet, not in-memory). [NDJSON DeltaLog — durable-on-disk, reloaded at boot, boot-compacted; demonstrated: kill -9 → restart → delta compacted into snapshot, verified-from-disk]
- [ ] GVA8TTJF's `cache_turns` join, once wired to use this link, resolves a response row's
      `session_id` via the link (verify with a real pair, not a synthetic one).
- [x] No `device_id`/`account_uuid` column exists anywhere in the new table. [confirmed: row construction drops them, grep 0 on live rows, unit test asserts absence]

## VERIFICATION

1. `cargo build -p agentlens-ingest` clean.
2. Drive one real request+response through the collector, confirm one link row is written and
   flushed.
3. Restart the server, confirm the link row is still queryable.

## Approval log
- 2026-10-08T18:51:39+0200 — column → dev by main-agent@agentlenspro.
- 2026-10-08T19:57:37+0200 — column → testing by main-agent@agentlenspro.

## Notes and lessons learned
2026-10-16: GVA8TTJF no longer lists this card in blocked-by (its code landed before GVA8TTJF entered dev). Box 3 stays unticked: review round 3 made the contract one-way, so its live real-pair proof is GVA8TTJF's box 5, but re-wording or delegating this box is an acceptance change left to the owner. Owed before complete: the restart-timing measurement (never run; no record on card or in commits). The torn-tail item is met in its round-3 form: tests/delta_log.rs torn-tail tests pass, 12/12. The STATE NEXT ACTION is stale, since the code landed in 34668285; the real next action is the restart-timing measurement, which needs a deployed binary.

## Dispatched (2026-10-08)

Claimed to dev. Design re-based ON SOURCE READS: the card's 'parquet writer at call_body_registry.rs' becomes a DeltaLog (NDJSON delta+snapshot, the EXISTING durable plumbing — delta_log.rs) at the record_ingested site (lib.rs:1067), because call_body_registry.rs has no flush plumbing and the card says 'reuse existing flush plumbing — do not invent a new one'. Rows carry both sides' pairing keys (request_body_id/message_id from CC >=2.1.274) so GVA8TTJF resolves the pair in SQL; pair resolution itself stays in-memory. Each pointer event = one durable row (the card's 'one row per resolved pair' implemented as one row per pointer event carrying its side's keys — joinable by request_body_id/span_id). No device_id/account_uuid (no-identities doctrine) — they ARE on the wire in metadata.user_id and are dropped at row construction. Parquet-to-NDJSON substitution + the per-pointer reading recorded on GVA8TTJF next. Worker spec: docs_dev/20261008-N6A8VX3G-body-links-spec.md; lean-worker dispatched (load 15.75, under the card's 20 bar). Uncommitted — main session commits.

## Design-review round 1 (2026-10-08) — three required amendments

The design fork accepted the DeltaLog re-base with three REQUIRED amendments, forwarded to the worker: (1) ERROR SEMANTICS pinned — the link append must never fail the ingest: on Err, one eprintln and continue (the sweeper's 'could not save (partial)' pattern), no ?/panic. (2) BOOT-COMPACT replaces never-compact — after load() at boot, save() once: bounds the delta to per-boot volume (~10k rows/2.2MB per DAY of live ingest makes never-compact ~800MB/year with boot parse costs, the 'trivial' claim was false) and heals a torn trailing line after kill -9 (read_lines tolerates one torn tail; DuckDB read_ndjson_auto does NOT — without this the SQL consumer errors after every hard crash). (3) The data_dir construction trap named (other DeltaLogs live in the sweeper which owns data_dir — thread it explicitly, no hacks) and the row constructor extracted as a pure fn body_link_row(p) -> (String, Value) so the unit test is reachable. Also recorded: pending-Vec loses rows forever on a kill (pointer events are transient, nothing re-delivers) — immediate-append preferred; a same-key-different-content row (spool rewrite) appends a later line that wins on replay, graceful. Durable rows outlive the registry's LRU eviction (200x400) — GVA8TTJF's join covers all history, not just the resident window: the real benefit, worth stating on GVA8TTJF with the NDJSON read path + torn-line note.

## Implemented (2026-10-08)

Immediate-append DeltaLog 'body-links' at the ingest site (lib.rs:1101-1111, after/beside record_ingested); pure fn body_link_row (lib.rs:1058); boot-compact via new DeltaLog::compact_now (delta_log.rs:234 — direct compact bypassing save()'s 256KiB size gate) called in DurableState::restore (log_reader.rs:945-950). Worker's isolated run: one real request+response pair through /v1/logs produced both link rows (verbatim in docs_dev/20261008_195338+0200-N6A8VX3G-impl-report.md) with request_body_id shared, session_id populated, zero identity fields; kill -9 → restart showed the delta compacted into body-links.snapshot.ndjson with the delta deleted — boot compaction demonstrated on an INTACT delta; the torn-tail heal itself is UNEXERCISED (correction per landed-work review). Gates: cargo build 0, clippy -D warnings 0 (core+store), 2 new unit tests + 4 callbodyregistry_parity tests pass, check-identities OK. MAIN-SESSION DIFF VERIFICATION (the standing four-part obligation from round-2 review): (1) NO ?/panic on the append — if let Err + eprintln, log-and-continue, confirmed at the call site; (2) boot-compact present via compact_now (direct compact, correct form per round-2's size-gate finding — save(same map) would have been a no-op below 256KiB); (3) body_link_row is an extracted pure fn with the unit test calling it; (4) data_dir threaded through CoreState::open (the constructor that already owns it) — no hack. All four PASS. Deliberate omissions recorded: server-stats bodyLinkBytes gauge dropped (optional, not trivial under the single-handle design); no compaction cadence beyond boot (ceiling: delta bounded to per-boot volume). Design-choice record: immediate-append over pending-Vec (transient OTLP records are lost forever on kill from a pending Vec). Deviation: rows use fixed-width fields with '' for absent Options (keeps read_ndjson_auto schema stable) — reasonable, recorded.

## Review round (landed work) 2026-10-08

Findings dispositioned: (1) 'TORN-TAIL HEAL DEMONSTRATED' DOWNGRADED — what the kill -9 restart demonstrated is boot-time compaction of an INTACT delta; no torn line was ever created (the tear window is the microseconds inside one write_all), so the healing boot-compact exists for is UNTESTED. Card wording corrected; the falsifier is one unwritten test (append a half line, load, compact, assert read_ndjson_auto reads clean). (2) MIDDLE-BOOT COVERAGE CORRECTED — the --no-log-scan boot (pid 17737) likely never ran DurableState::restore, so of three boots only ONE exercised load+compact; final state still proven, path-coverage story corrected. (3) BOOT-REWRITE CEILING NAMED — compact_now bypasses the size gate deliberately, so every boot with new links rewrites and verifies the ENTIRE link history (read+replay+re-serialize+read-back+rename): linear write amplification per restart on a machine with 13+ guard-exit restarts/day, ~2 MB/day of rows. Fix when it matters: a delta:snapshot ratio gate on compact_now mirroring COMPACT_RATIO. (4) '' DEFAULTS CREATE FALSE JOIN KEYS — a REAL consumer risk owned by GVA8TTJF: on pre-2.1.274 traffic lacking request_body_id, a request row and a response row of DIFFERENT calls both carry '' and cross-match in an equality join (NULL would have been join-safe). GVA8TTJF's SQL MUST guard request_body_id <> '' (and any other key column) — to be recorded there before its acceptance SQL is written. (5) WIRE-PATH TEST GAP NAMED — unit tests construct BodyPointers directly; the real OTLP→ingest→row path is exercised once manually. A synthetic /v1/logs #[cfg(test)] through process_logs+ingest_parsed would close it; non-blocking, recorded as the named gap. (6) Full-disk noise: the eprintln fires per pointer event on a full disk — log noise at flood rates, not failure, acceptable.

## Review round 2 (dispositions) 2026-10-08

Four follow-ups, all accepted: (1) BOX-1 CONTRACT CLARIFIED: the ticked per-pointer reading is join-safe ONLY with GVA8TTJF's <> '' guards treated as part of this card's contract — a consumer-side obligation this card now references (its GVA8TTJF entry is part of this card's acceptance surface, contingent until both cards are terminal). (2) NULL-vs-GUARD TRADE STATED: NULL at the source was the better contract (own the burden once; <> '' owns it forever and punishes omission silently — the repo's own api_call schema comments call VARCHAR-sealing 'load-bearing' for the same reason). The landed+live-verified schema makes guard-forever the pragmatic fix; GVA8TTJF's entry was corrected to name the guard a NAMED DEFECT OF THE ROW FORMAT (debt note), not a neutral requirement, so a future schema revision knows the debt exists. (3) THE TORN-TAIL FALSIFIER IS OWED BEFORE complete: ~5 lines (write_all a half line, load, compact_now, assert the snapshot parses and intact rows survive) — converts the remaining 'probably' into evidence; the card cannot reach complete without it. Also: the ~2 MB/day ceiling figure is a LOWER BOUND (inherits CEAZZHHO's visibility-rate floor). (4) ONE RESTART-TIMING MEASUREMENT owed before the boot-rewrite deferral is honest (even extrapolated from the 501-byte corpus): under ~1s year-scale → the ceiling sleeps; tens of seconds → the ratio gate becomes near-term. Both owed items are recorded here and block complete, not testing.

## Review round 3 — loop exit + two amendments (2026-10-08)

The round-3 fork found the loop's own exit condition and two amendments, all applied: (1) TORN-TAIL TEST DOWNGRADED from complete-blocker to test-and-document — the trace shows read_lines drops the torn tail, compaction rewrites from the parsed map, so the falsifier would guard an ALREADY-GUARDED path (delta_log's own compaction-verify + the sweeper's daily production exercise); write the 5-line test when the card is next touched, but a passing test of an already-tolerated path is not a gate; the gate is 'test exists and passes, or the guarded failure mode is documented as unreachable'. (2) CONTRACT LINKAGE MADE ONE-WAY: this card's acceptance ends at 'rows carry both sides' keys, faithfully' — whether the join guards them is GVA8TTJF's acceptance, not this card's; the cross-reference stands as a note, removed as a contract term. (3) RESTART-TIMING MEASUREMENT, now executable: corpus = ~700k synthetic link rows (1 year at the measured rate, ~140MB delta); metric = wall-clock of restore's body-links block (load+compact_now); baseline = same boot with an empty delta; verdict — under ~1s the ceiling sleeps, tens of seconds the ratio gate becomes near-term. (4) THE LOOP ENDS HERE per its own criterion: a round is value-positive iff a finding changes code, evidence, or a falsifiable claim; round 4 was wording-only (value-negative), and no further round on this chain fires without a named code/evidence change. The meta-verdict precedent (record-review loop ended as value-negative) applies.

## GVA8TTJF wired the link (2026-10-09)

GVA8TTJF's api_calls_relation resolves a response row's session_id via the link table in real DuckDB tests (unpaired-half survival test asserts session from the response's OWN link row; paired test asserts the request-side session through the pair) — acceptance box 3's synthetic-form is now proven at the SQL level; the real-pair live form stays pending-deploy with GVA8TTJF.
