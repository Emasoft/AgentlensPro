---
trdd-id: YILE6N3T
title: The span window reports a 5-minute window but holds the whole 24-hour boot replay and only grows
column: ai_review
created: 2026-09-05T22:06:10+0200
updated: 2026-09-23T13:00:51+0200
current-owner: main-session
task-type: bugfix
priority: critical
min-approval-requirement: none
scope: project
project-id: agentlenspro
parent-trdd: 7YPQWKPG
eht: [GR6WHHK5]
related: [7YPQWKPG, 768NEX6E, YU8QPU89, 7RM5YW2T, GR6WHHK5]
relevant-files: [rust-core/crates/agentlens-core/src/span_window.rs, rust-core/crates/agentlens-core/src/lib.rs, rust-core/crates/agentlens-core/src/chores.rs]
labels: [rust-core, memory, span-window]
implementation-commits: [f2572740, afcf8766181b052973c115778040a4a08d6ca1dd]
---

# The span window reports a 5-minute window but holds the whole 24-hour boot replay and only grows

## ⏵ STATE — READ THIS FIRST ON RESUME (authoritative; supersedes the body) — 2026-09-06T02:32:43+0200

Cause proven: 602 codex spans with `startTime`/`endTime` == `"0"` made `span_timestamp_ms`
return `now_ms`, and one such span at `spans[0]` froze the old `first_old`-gated prune forever.
Fix merged to `main` as `afcf8766181b052973c115778040a4a08d6ca1dd` (unconditional `retain` by
cutoff, `i64::MIN` fallback for unresolvable timestamps — no more dependency on `spans.first()`).
Isolated replay: 431,910 spans pruned to 0; RSS 1.13 GB → 36 MB. Review verdict NON-BLOCKING
(`reports/review-fork/20260906_023053+0200-f2572740-yile6n3t-prune.md`), one boot-path follow-up
filed as TRDD-GR6WHHK5 (receivedAt stamped after writer.append lets timestamp-less spans survive
to disk, then get evicted on the first tick after restart).

NEXT ACTION: release build + deploy together with 7RM5YW2T, then verify boxes 3–4 below by live
measurement (post-deploy `spans.inMemory` bound, RSS after 15 min live).

**2026-09-06T03:18:01+0200 — Boxes 3–4 verified live** (pid 93345, deployed 02:58; t15 report
`reports/7ypqwkpg/20260906_031515+0200-t15-after-deploy.md`). Box 3 PASS: `spans.inMemory` 432–553
across the 17–18 min window vs bound (ingest 22 spans/s × 300s windowMs) × 2 = 13,200 — ~4% of
bound. Box 4 recorded: RSS 10,479–11,326 MB (t15–t18) vs today's 13.1 GB baseline and 19.6 GB
pre-restart — both a clear reduction, still slowly rising; watch on the next long-uptime read.

USER directive 2026-09-05 22:00 (verbatim): *"why the hell alcore is using 17Gb of ram??? haven't i
told you to make duckdb the only memory of agentlenspro? why there are things kept in memory and not
written down in parquet files? why there are persistent data structures in ram instead of just the
small query results from duckdb??? why a rust process is using so much memory and it is so slow???
fix all this"* — this card is the first, measured, same-day slice of that; the architecture is
TRDD-7YPQWKPG.

## Measured on pid 574 (build `3b9018e0`), 2026-09-05 21:43–22:05 — all ✓ VERIFIED first-hand

| what | value | source |
|---|---|---|
| physical footprint | 13.1 GB, peak 21.3 GB | `vmmap --summary 574` |
| mimalloc heap (the Rust side; vmmap labels it `IOAccelerator`) | 8.7 GB resident | same; ATOM-WA0C-AO6Q |
| DuckDB / system malloc | 0.38 GB | same, `MALLOC_LARGE` |
| `spans.inMemory` | 541,623 → 560,721 → 564,265 → 570,550 (21:43 → 22:00 → 22:01 → 22:05) | `/api/server-stats` |
| `spans.windowMs` | 300,000 (5 min) — the floor, reached by four "memory pressure" narrowings in `server.log` | same + log |
| today's segment on disk | 411,471 lines / 526 MB (index: 416,299 spans), yesterday's 442,832 | `wc -l`, `spans/index.json` |
| timestamp resolvability on disk | 414,069 / 414,069 lines carry a digit `startTime`; 0 fall back to `now` | python over the segment |
| log-session cards resident | 32,607 (22,955 of them in the served summary) | `server status`, `/api/summary` |
| CPU | 84% of one core 20 min after boot | `ps` |

So: the 24-hour `boot_load` (`span_window.rs:66-69`) filled the window with ~540k spans, the RSS
valve (`apply_memory_pressure`, `lib.rs:667`) narrowed `effective_ms` to the 5-minute floor, and
`prune` (`span_window.rs:137-153`) has evicted NOTHING since — the count only grows at the live
ingest rate (~22 spans/s). A 5-minute window at that rate should hold ~6,600 spans, not 570,000.

## What is NOT yet established (the worker measures, does not guess)

`prune` gates the whole `retain` on `first_old` — the timestamp of `spans.first()` alone. Read on
paper the first span should be the oldest (`load_range` iterates days ascending, files sorted,
lines in order; `add` appends), and every on-disk span has a parseable `startTime`. Yet nothing is
evicted. Candidates, each falsifiable:

1. `spans.first()` resolves to `now_ms` (some in-memory shape `span_timestamp_ms` cannot read —
   the overlay applied at load? a live span stamped with a non-finite `receivedAt`?), so
   `first_old` is false forever.
2. The 5-s chores tick (`chores.rs:570-578`) never gets the lock: `lock_timed` times out under the
   25-ms rebuild loop and the `if let Ok` silently skips the prune.
3. `prune` runs and evicts, but something re-adds (a second `boot_load`, or `flush_spans` re-feeding
   the window).
4. The `inMemory` figure is not `spans.len()`.

The old log lines "prune_window held the state lock for 274 ms (293,573 spans, window 300000ms)"
with the count flat across three ticks are consistent with 1 or 2, not 3.

## NEXT ACTION

Decide between the candidates by measurement (add a one-line `eprintln!` of the first span's
resolved ts + `spans.len()` before/after `retain` behind an env flag if needed, run against an
ISOLATED instance whose store is a copy of today's segment — never the live one), then fix the
root cause. Whatever the cause, ALSO remove the `first_old` shortcut: a prune whose correctness
depends on one sentinel element is the bug class even if a different element is today's trigger
(`retain` over ≤1M `Arc`s every 5 s is milliseconds). Add a unit test: a window seeded with 1,000
old spans whose FIRST element has no resolvable timestamp must still prune the other 999.

## Acceptance

- [x] The cause is named from a measurement (which candidate, with the number that proved it).
- [x] `span_window.rs::prune` no longer depends on `spans.first()`; a unit test covers the
      unresolvable-first-element case.
- [x] Against the live server after deploy: `spans.inMemory` ≤ (ingest rate × `windowMs`) × 2 within
      one tick of boot-load completing, and it stays there over 15 min. Measured: 22 spans/s ×
      300 s × 2 = 13,200 bound; actual 432 (t15) → 553 (t18), ~4% of bound, no growth trend.
- [x] RSS after 15 min under normal load is recorded and compared with today's 13.1 GB. Measured:
      10,479 MB (t15) → 11,326 MB (t18), vs 13.1 GB baseline and 19.6 GB pre-restart — both lower.

## Notes and lessons learned

## Approval log

- 2026-09-05T22:06:10+0200 — Authored into `dev` (Tier 0 bugfix under the USER-approved parent
  7YPQWKPG; worker dispatched the same turn).

## ⏵ AI-REVIEW VERDICT 2026-09-23T13:00:09+0200 — APPROVE

Box 1 (cause named from measurement) met: 602 codex spans with startTime/endTime=="0" made span_timestamp_ms return now_ms; one landed at index 0 after the first narrow, freezing the old first_old-gated prune (commit f2572740 message, isolated replay 431,910->0).
Box 2 (prune no longer depends on spans.first(); unit test for unresolvable-first-element) met: rust-core/crates/agentlens-core/src/span_window.rs::prune (line 168) runs an unconditional retain keyed on span_timestamp_ms(o, i64::MIN) for every element; test prunes_past_a_first_element_with_no_resolvable_timestamp (span_window.rs:215-238) seeds 1,000 spans with the FIRST one unresolvable and asserts all 1,000 are evicted, then that an in-window add survives.
Box 3 (spans.inMemory bound after deploy, 15 min) met: STATE block + reports/7ypqwkpg/20260906_031515+0200-t15-after-deploy.md — inMemory 432-553 vs bound 13,200 (~4%).
Box 4 (RSS after 15 min recorded vs 13.1 GB baseline) met: same report — RSS 10,479-11,326 MB vs 13.1 GB baseline / 19.6 GB pre-restart, both lower; live spot-check today (2026-09-23) shows rssMb 2,449 on the current process, consistent with the fix holding.
Findings: mutation-verified review-fork report (reports/review-fork/20260906_023053+0200-f2572740-yile6n3t-prune.md) independently confirmed the diff, the test's RED-on-revert property, and non-coupling with 7RM5YW2T. No new defects found in this independent pass. eht GR6WHHK5 (boot-path follow-up) is filed and in testing, correctly left open rather than blocking this card.
Ready for human_review; the owner makes that move.
