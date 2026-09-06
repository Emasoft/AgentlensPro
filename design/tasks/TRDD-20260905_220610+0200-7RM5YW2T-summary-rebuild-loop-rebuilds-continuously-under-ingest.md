---
trdd-id: 7RM5YW2T
title: The 25 ms summary rebuild loop rebuilds the whole window continuously under ingest and is the mimalloc churn
column: testing
created: 2026-09-05T22:06:10+0200
updated: 2026-09-06T03:18:01+0200
current-owner: main-session
implementation-commits: [bd0d48e3, 6698af32, bb8d5f8e, 67e5478cc62f28a49e3877db3885ee3fd727d6ed]
task-type: bugfix
priority: critical
min-approval-requirement: none
scope: project
project-id: agentlenspro
parent-trdd: 7YPQWKPG
related: [7YPQWKPG, 768NEX6E, 2R36W8Q1, YILE6N3T]
relevant-files: [rust-core/crates/agentlens-core/src/ui.rs]
labels: [rust-core, memory, cpu, summary-rebuild]
---

# The 25 ms summary rebuild loop rebuilds the whole window continuously under ingest and is the mimalloc churn

## ⏵ STATE — READ THIS FIRST ON RESUME (authoritative; supersedes the body) — 2026-09-06T03:18:01+0200

Last acceptance box MISS on live measurement (pid 93345, deployed 02:58, uptime ~18 min; t15
report `reports/7ypqwkpg/20260906_031515+0200-t15-after-deploy.md`): CPU ~65.5% of a core
(cputime delta 39.29s / 60s wall — 12:44.22 → 13:23.51), threshold was ≤15%. mimalloc/malloc-zone
resident ~10.8 GB (`vmmap --summary`, TOTAL RESIDENT SIZE row), threshold was ≤2 GB — WORSE than
the 8.7 GB pre-fix baseline, though physical footprint (3.1 GB, peak 11.2 GB) is far lower than
the old 13.1 GB. NEXT ACTION: needs a follow-up investigation card (not created here — instructed
not to) into why the rebuild-loop fix did not cut CPU/mimalloc as the arithmetic predicted; check
whether ingest rate at measurement time was higher than the 22 spans/s assumption, and whether
`vmmap` TOTAL RESIDENT vs physical footprint is the right proxy for "mimalloc resident" here.

Same USER directive as TRDD-YILE6N3T (2026-09-05 22:00, "why is alcore using 17 GB … why is it so
slow … fix all this"). This is the second same-day slice; the architecture is TRDD-7YPQWKPG,
advisor step 1.

## Measured / read — ✓ VERIFIED

- `run_summary_rebuild` (`ui.rs:117-129`) ticks every **25 ms** and calls `rebuild_once`, which
  rebuilds whenever `data_version` moved since the cached summary. Ingest bumps `data_version` on
  every payload (~22 spans/s today, ~6.7 bumps/s measured by UTFVMVT8), so under any ingest the
  loop rebuilds **back-to-back**: each pass snapshots the whole window (570k `Arc<Value>` today,
  TRDD-YILE6N3T) plus a clone of `log_sessions` (32.6k cards), builds a full card summary, swaps it
  in, drops the previous one.
- The 768NEX6E box-4 sizing (`reports/trdd-768nex6e/20260902_220716+0200-box4-heap-by-structure.md`)
  found every bounded structure sums to < 1 GB and named this churn as the dominant holder of the
  7.5–8.8 GB mimalloc heap, which mimalloc never decommits. Today: 8.7 GB resident mimalloc,
  13.1 GB footprint, 21.3 GB peak, 84% of a core 20 min after boot.
- The read-your-writes contract that constrains any fix: `POST /v1/traces` then `GET /api/summary`
  within `STALE_BUDGET_MS` = 500 ms must see the write (`ui.rs:134`, the CI test cited at
  `ui.rs:289-300`). A reader that misses the cache waits up to 500 ms for an in-flight rebuild,
  else serves `cached_any`.

## The fix — as landed (supersedes the original design below)

**Landed rule** (`ui.rs`, `rebuild_once` + `summary_now`, branch `fix/7rm5yw2t`): the 25 ms loop
records what each pass cost (`d`, timed from BEFORE the snapshot — the snapshot clones the window's
spans and the log cards under the state lock and is part of the churn) in the existing single-flight
gate, and **skips while `now < finished + 4 × d`**, with **one override**: a reader waiting on the
loop (`READER_WAITING`, raised on entry to the `STALE_BUDGET_MS` wait, consumed at the start of the
pass that answers it) forces the pass **only while `d ≤ STALE_BUDGET_MS`**. No floor. The read path
carries no back-off; the inline reader rebuild (reached only without a rebuilder — tests/embedders)
is untouched.

**Why the override is budget-bounded — the deliberate trade.** With a rebuilder active a
cache-missing reader NEVER builds inline (TRDD-2R36W8Q1); it waits ≤ 500 ms for the loop and then
serves `cached_any`. So the loop is a waiting reader's only source of fresh data, and a blind `4d`
skip shrinks the RYW envelope from `d ≲ 475 ms` (≈237 ms when a pass is already in flight —
`2d + tick ≤ 500`; that phase is unchanged by this card) to `d ≲ 95 ms` — an ordinary 5k–25k-span
dev install (100–500 ms per rebuild) would land in the regressed band. The override restores the
pre-change envelope exactly where it existed, in both phases. Above the budget the reader was served
stale before this card too, and honouring the override there would rebuild once per dashboard poll
— the churn this card removes at precisely the sizes it exists for. **What remains is a larger
staleness ceiling at large `d`: a reader there sees a summary up to ≈5d old, not ≈d** (20 s rebuild
⇒ up to ~100 s behind, was ~20 s). Accepted: the alternative was the 84%-of-a-core / 8.7 GB plateau.

**Effective cadence while `d ≤ 500 ms` is `min(reader interval, 4d)`, not `4d`.** Every
cache-missing `summary_now` call under a rebuilder raises the flag, and the pass consumes it at
its start, so a reader arriving mid-pass re-raises it and the next tick rebuilds again. Internal
periodic callers (grep of `summary_now(` in `ui.rs`): `run_burn_tick` every **4 s** on every
install, `push_update` from the coalesced SSE timer only while a dashboard is connected, plus one
warm-up per GET/HEAD on `/`, `/events`, `/api/*`. So with no client the floor in that band is one
rebuild per 4 s (d = 300 ms ⇒ ≈7.5% of a core, was 100%); with a 1 s dashboard poll ≈1/s (≈30%,
vs 20% under a pure `4d` rule). Zero effect at the 20 s sizes this card targets, where
`took > budget` disables the override.

**Superseded design (2026-09-05, this card as authored): `max(250 ms, 4 × d)` back-off at the gate
+ a waiting-reader counter.** Dropped in two steps, both by review: (1) the floor and the counter
went — a floor at 250 ms eats half a waiting reader's budget for a window size with no churn left to
ration, and the gate already serializes so the record needs no second lock; (2) a first attempt
applied the back-off to readers too, which fails `an_uncontended_reader_gets_fresh_data_not_stale`
(a reader-side back-off has no version term and serves a reader its own write back stale), and a
second attempt made it loop-only with NO reader term, which mis-modelled production — readers never
rebuild inline there, so RYW broke for 95 ms < d < 475 ms (review
`reports/review-fork/20260906_022542+0200-bd0d48e3-7rm5yw2t-backoff.md`). The landed rule is the
original "unless a reader is waiting" term with the one condition that reconciles it with the
churn cut.

## Acceptance

- [x] `rebuild_once` is skipped while inside the cost-scaled back-off (`4 × d`, no floor), EXCEPT
      when a reader is waiting AND the last rebuild's cost is ≤ `STALE_BUDGET_MS`; unit-tested —
      arithmetic in `rebuild_backoff_tests` (6), the consumer half incl. both sides of the override
      bound in `the_rebuild_loop_skips_a_pass_inside_the_backoff_window`, the producer half (a
      reader entering the wait raises the flag) asserted in
      `a_reader_never_rebuilds_when_the_background_rebuilder_owns_it`. Three mutations, each shown
      red: back-off check disabled; override term disabled; flag producer disabled. 30/30 green at
      `--test-threads=8` on the landed source.
- [x] cargo RYW test (`tests/ui.rs::summary_serves_the_stripped_summarizer_output_over_ingested_spans`,
      `POST /v1/traces` → `GET /api/summary` ≤ 500 ms) green — 41/41 in `--test ui`, 10/10 repeats
      on the landed source. **Caveat (settled by grep): `tests/ui.rs` and `tests/helpers.rs` never
      spawn `run_summary_rebuild`, so this test exercises the INLINE reader path, not the
      production wait-for-the-loop path, and runs at `d ≈ 1 ms`.** The 95–475 ms band and the
      override are covered only by the unit tests above, not end-to-end.
- [ ] Live after deploy, 15 min: CPU of alcore ≤ 15% of a core at today's ingest rate (was 84%),
      mimalloc resident ≤ 2 GB (was 8.7 GB) — `vmmap --summary` and `ps`, numbers recorded here.
      **MISS: cpu ~65.5% (cputime delta 39.29s/60s wall, pid 93345), mimalloc ~10.8 GB (vmmap
      TOTAL RESIDENT SIZE) — needs a follow-up card (do not create it).**

## Notes and lessons learned

- **Model the path production takes before arguing about RYW.** Two review rounds (worker's first
  attempt, coordinator's correction) debated whether a reader "rebuilds inline or hands the rebuild
  to the next poll" — a path only tests and embedders take. On every real server `REBUILDER_ACTIVE`
  is set and a reader's ONLY source of fresh data is the loop. The invariant to check on any change
  to `rebuild_once` is therefore: *for every `d` where a reader was served fresh before, is the loop
  still guaranteed to land a pass inside that reader's 500 ms budget?*
- **A pure-arithmetic test is not evidence the arithmetic is consulted.** `REBUILD_COST_FACTOR 4→0`
  and disabling the check both had to be shown red at the WIRING level; the six arithmetic tests
  stay green under the second mutation.

## Approval log

- 2026-09-05T22:06:10+0200 — Authored into `dev` (Tier 0 bugfix under the USER-approved parent
  7YPQWKPG; worker dispatched the same turn).
