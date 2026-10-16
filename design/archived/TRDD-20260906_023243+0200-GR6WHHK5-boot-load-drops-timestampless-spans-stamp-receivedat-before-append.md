---
trdd-id: GR6WHHK5
title: Boot load evicts timestamp-less codex spans within 5 s because receivedAt is stamped after writer.append
column: complete
created: 2026-09-06T02:32:43+0200
updated: 2026-10-16T11:13:00+0200
current-owner: agentlenspro-b2
task-type: bugfix
priority: normal
min-approval-requirement: none
scope: project
project-id: agentlenspro
npt: []
eht: []
implementation-commits: [58abca7f, c89148ce3eb20262480ddb6e652146902268b74c]
relevant-files: [rust-core/crates/agentlens-core/src/lib.rs, rust-core/crates/agentlens-core/src/span_window.rs, rust-core/crates/agentlens-spanstore/src/writer.rs, rust-core/crates/agentlens-core/src/summarize/codex.rs]
labels: [rust-core, memory, span-window, boot-load]
status: archived
---

# Boot load evicts timestamp-less codex spans within 5 s because receivedAt is stamped after writer.append

## ⏵ STATE — READ THIS FIRST ON RESUME (authoritative; supersedes the body) — 2026-09-06

- **Fixed and green on branch `worktree-agent-a8a594781552e41c7`** (branched from `main`
  42c70f07, which already carries the YILE6N3T prune fix afcf8766 — the fast-forward was needed
  for box 2 to mean anything: under the OLD `first_old`-gated prune the bug was invisible,
  because that prune resolved an unknown age to `now_ms`, not `i64::MIN`).
- **The fix is 2 lines of behaviour**: `ingest_parsed` stamps each span before
  `state.writer.append`, using a helper `span_window::stamp_received_at` extracted from
  `SpanWindow::add` — ONE stamping site, so the disk copy and the window copy can never disagree.
- **`state.writer.append` has exactly ONE caller in the whole workspace** (`lib.rs:880`), and both
  `ingest_parsed` callers (the HTTP handler and `ingest_post`) route through it — verified by
  grep. The hook-events path writes its own event files and never touches the span writer, so it
  has no equivalent ordering to fix.
- **PARITY, not invention**: the recovered TS (`standalone/server.ts` `addSpan`, 567fc5c2^:557-561)
  stamped `receivedAt` and THEN called `spanStore.append(span)`. The Rust port inverted it.
- **KNOWN CONSEQUENCE, deliberate**: `span_timestamp_ms` prefers `receivedAt`, so a span now
  buckets into the segment of its ARRIVAL day rather than the day its own `startTime` claims.
  That is the TS behaviour and it broke one existing assertion —
  `tests/otlp.rs::post_traces_lands_spans_in_the_store_and_answers_empty_200` asserted the
  filename `2025-08-18.ndjson` for a span posted today. The test now range-queries by arrival
  (what boot load actually does) instead of naming a file; the old assertion had encoded the
  port's inverted order.
- **NEXT ACTION**: review + merge. Nothing is deployed — `bin-native/` is untouched, so the
  running collector still has the old ordering.
- Not addressed, by design: the 602 records already on disk predate the stamp and stay
  unresolvable. Evicting them is the honest outcome, not a regression to chase.

## SYMPTOM

After the YILE6N3T prune fix (unconditional retain by cutoff, no longer gated on
`spans.first()`), a restart drops every span whose `startTime`/`endTime` is the literal string
`"0"` — 602 of 432,335 spans in today's segment (0.14%), all `codex.api_request` — from the
window on the very first 5 s chores tick after boot.

## CAUSE

`rust-core/crates/agentlens-core/src/lib.rs` ingest path (≈lines 875–889) calls
`state.writer.append(span, now)` in one loop BEFORE `state.window.add(span, now)` in a second
loop. `add` is what stamps `receivedAt` (`span_window.rs:74-77`); the disk copy written by
`append` predates that stamp and never carries it. `load_range` (`writer.rs:360`) then admits
these records on boot using the `now_ms` fallback for the missing timestamp — so on the very
next prune tick, `span_timestamp_ms(o, i64::MIN)` (post-YILE6N3T) resolves them to a value at or
before the cutoff and they are evicted. `summarize/codex.rs` (lines 48, 56) also reads
`receivedAt` downstream, so the same records were already silently mis-summarized before eviction.

## FIX

Stamp `receivedAt` (arrival ms, i.e. `now`) on each span BEFORE `writer.append` — a one-line
reorder on the shared ingest path in `lib.rs`, so the disk copy and the in-memory copy agree.
Once `receivedAt` is on disk, `load_range`, `prune`, and `summarize/codex.rs` all resolve these
spans honestly. The 602 existing on-disk records predate the fix and stay unresolvable —
evicting them is the honest outcome, not a regression to chase. This also retires the YILE6N3T
worker's noted load_range follow-up.

The stamping logic itself was inline in `SpanWindow::add`; it is now the free function
`span_window::stamp_received_at`, called from both sides. Duplicating the two-line insert at the
ingest site would have created a second place for "when did this span arrive" to be decided.

## ACCEPTANCE

- [x] New records written to disk carry a resolvable `receivedAt`.
      Proof: `tests/received_at_stamp.rs::a_timestampless_span_carries_its_arrival_time_on_disk`
      — ingests a `codex.api_request` span with `startTimeUnixNano`/`endTimeUnixNano` `"0"` through
      the real `ingest_parsed`, flushes, reads the NDJSON record back off disk, and asserts
      `receivedAt` is present, equals the in-memory window's stamp, and lies inside the
      `[before, after]` bracket of the ingest call. The wire values are asserted untouched
      (`startTime == "0"`) — this stamps arrival, it does not invent a start.
- [x] A span ingested with `startTime`/`endTime` == `"0"`, followed by a restart, is still
      present in the window after 10 s (not evicted on the first prune tick).
      Proof: `tests/received_at_stamp.rs::a_timestampless_span_survives_boot_load_and_the_first_prune_tick`
      — `SpanWindow::new(SUMMARY_WINDOW_FLOOR_MS).boot_load(...)` off disk, then asserts the loaded
      record resolves to its arrival time under `span_timestamp_ms(o, i64::MIN)` (the fallback
      `prune` passes), that `prune` evicts nothing on the first tick or anywhere inside the
      5-minute window, and that it DOES age out one ms past the cutoff — the fix restores honest
      timing, not immortality.
- [x] Existing tests green.
      `cargo test -p agentlens-core` → 599 passed / 0 failed across 103 test binaries (includes
      `span_window`, `span_window_memory_guard`, `codex_parity`, `summarize_parity`, `otlp`).
      `cargo test -p agentlens-spanstore -p agentlens-ingest` → 0 failed.
      `cargo clippy -p agentlens-core --all-targets -- -D warnings` → clean.
      One existing assertion was UPDATED, not merely re-run — see the STATE block's day-bucketing
      note.
- [x] Mutation-checked: with the `stamp_received_at` call removed from the ingest loop (the
      helper left in place, so only the ORDER changes), both new tests fail — `the DISK copy must
      carry receivedAt` and `resolves on its own, not through a now fallback` — and
      `otlp::post_traces_lands_spans_in_the_store_and_answers_empty_200` fails too (the
      arrival-range query returns `[]`). Restored; the suite is green again.

## Notes and lessons learned

- **The old prune hid this bug, and the new one exposes it.** Pre-YILE6N3T, `prune` resolved an
  unknown age to `now_ms`, so a record with no timestamp read as "just arrived" forever — the
  data was already wrong on disk, it simply never cost anything. A fix that makes an existing
  latent defect visible is not the fix's regression; but the two must land together, which is
  why this card exists rather than being folded into YILE6N3T.
- **A test that names a filename tests the implementation, not the behaviour.** The otlp
  assertion on `2025-08-18.ndjson` looked like it was testing persistence; it was pinning the
  day-bucketing rule, and it pinned the WRONG one. The replacement asks the question boot load
  asks (a range query over arrival time), so it stays true whatever the segment layout does next.

## Approval log

- 2026-09-06T02:32:43+0200 — Authored into `todo` (Tier 0 bugfix, derived from the YILE6N3T
  review's finding (1); no approval required).
- 2026-09-06T02:57:58+0200 — `todo` → `testing`; all four acceptance boxes proved on branch
  `worktree-agent-a8a594781552e41c7`. Not merged, not pushed, not deployed.
- 2026-09-06T03:08:36+0200 — Merged `worktree-agent-a8a594781552e41c7` into `main`
  (c89148ce3eb20262480ddb6e652146902268b74c). `column:` stays `testing` — merged, not deployed
  (`bin-native/` untouched).
- 2026-10-16T11:13:00+0200 — COMPLETE by main-agent@agentlenspro. 4/4 boxes ticked; fix c89148ce is on main (verified by the main agent with merge-base); no deploy step (release-via absent). Triage row 1..
