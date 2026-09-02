---
trdd-id: 2R36W8Q1
title: The summary cache is keyed on a version that moves faster than a rebuild completes, so the UI path livelocks under fleet ingest
column: testing
created: 2026-08-29T10:44:23+0200
updated: 2026-09-02T13:10:29+0200
current-owner: main-session
task-type: bugfix
scope: project
project-id: agentlenspro
parent-trdd: YU8QPU89
relevant-rules: []
implementation-commits: []
---

# Summary cache livelocks under fleet ingest

## ⏵ STATE — READ THIS FIRST ON RESUME (authoritative; supersedes the body) — 2026-09-02

- **Measured, profile-confirmed.** Not a hypothesis. Evidence is in this card's
  "Measurement" section; the `sample` output is `/tmp/soak-sample.txt` (ephemeral —
  the numbers are transcribed below because that file will not survive).
- **Ingest is NOT affected and was verified separately**: `/v1/traces` answered
  HTTP 200 in 0.3 ms while `/api/server-stats` was timing out. Do not let a later
  reading of this card turn "the server wedges" into "ingestion is broken" — the
  two paths were measured independently and only the READ path fails.
- **FIXED AND SHIPPED in v2.32.0** (`8e4f6b25` then `02d25450`). No advisor verdict was
  obtained — that consult was killed by the USER because Fable's weekly window was
  spent, which is what TRDD-VNKPUAY4 (`agentlenspro model-headroom`) now makes
  checkable before spawning one.
- **The first fix was WRONG and CI caught it — keep this, it is the load-bearing
  lesson.** Making admission `try_lock` stopped readers blocking, but a reader that
  LOST the gate then returned stale data instantly, which broke READ-YOUR-WRITES:
  `POST /v1/traces` followed by `GET /api/summary` answered `sessions: []`
  (tests/ui.rs:112). The shipped design is a BOUNDED wait — `STALE_BUDGET_MS = 500`:
  wait for the in-flight rebuild (milliseconds at normal sizes, so callers see their
  own writes) and fall back to stale only when the rebuild is pathologically slow,
  which is the >20 s fleet case. Correct when it can be, live when it cannot.
- A pure staleness TOLERANCE was rejected and must not be retried: it controls how
  often a rebuild STARTS, not how long a reader WAITS, so a 1 s tolerance in front of
  a 20 s rebuild changes nothing a caller can observe.
- **FLEET RE-RUN DONE 2026-08-29, AND THE ACCEPTANCE BOX IS NOT MET.** Isolated alcore
  (own DATA_DIR + ports 4981/3981/4982, `--no-log-scan`), 100 sessions × 26 spans/s
  for 247 s. Six `/api/server-stats` probes spread through the run:

  | probe | 1 | 2 | 3 | 4 | 5 | 6 |
  |---|---|---|---|---|---|---|
  | seconds | 0.50 | 0.60 | 0.50 | **10.53** | 0.50 | **13.25** |

  Four of six are at ~0.5 s — that is `STALE_BUDGET_MS` doing exactly its job (budget
  expires, serve stale). **The two outliers are the remaining hole, and it is a
  DESIGN limit, not a regression: the fix protects the readers that LOSE the gate,
  and does nothing for the one that WINS it.** The winner still runs the whole
  rebuild synchronously and waits ~10-13 s for it. Every probe is one such winner
  eventually, so the criterion "under 1 s" cannot be met while any request can be
  elected to do a full O(window) rebuild on the request path.
- Also measured and NOT yet explained: **64 non-2xx of 16,285** requests (0.4%), and
  actual throughput **1,313 spans/s against the 2,600 target** — so the run did not
  reach fleet rate either. Do not close this card on the latency box alone; those two
  numbers are unexplained and may share a cause.
- **THE GATE-WINNER HOLE IS NOW CLOSED IN CODE (2026-08-29 16:45) — but NOT yet
  re-measured under a fleet soak, so this card stays in `testing`.** `ui.rs` gained
  `run_summary_rebuild`, a background task that owns rebuilds, spawned by
  `alcore.rs` next to `run_burn_tick`. With it running, `summary_now` never builds:
  a reader waits up to `STALE_BUDGET_MS` for the version it wants and otherwise
  serves the freshest cached value. The election that produced the 10.53 s and
  13.25 s probes cannot happen, because the winner is always the task.
- **Why a flag (`REBUILDER_ACTIVE`) and not an unconditional rule.** `summary_now`
  is a library function; the unit tests and any embedder call it with no task
  running. An unconditional "readers never build" would serve those callers the
  first summary forever, silently — a staleness bug strictly worse than the latency
  it fixes. The task sets the flag itself, so the contract is: rebuilder present ⇒
  readers only wait and serve; absent ⇒ the previous self-healing behaviour,
  byte-for-byte unchanged.
- **Mutation-verified, both directions.** `a_reader_never_rebuilds_when_the_background_rebuilder_owns_it`
  (in `ui.rs`) fails — and ONLY it, the other three still pass — when the early-return
  block is disabled. `cargo clippy -p agentlens-core --all-targets -- -D warnings`
  exits 0 with a `Finished` marker.
- **The three tests share a process-global flag, so they take a `serial()` mutex.**
  Without it `an_uncontended_reader_gets_fresh_data_not_stale` (whose whole assertion
  is that an uncontended reader BUILDS) fails whenever the new test happens to run
  beside it. That is a real hazard of the flag design, handled rather than hoped away.
- **RE-MEASURED FOUR TIMES 2026-08-29. ACCEPTANCE BOX 1 IS STILL NOT MET, and the
  headline number is now trustworthy for the first time.** Isolated alcore (own
  `DATA_DIR`, ports 4981/3981/4982, `--no-log-scan`), 100 sessions, ~260 s per run:

  | run | probes | result |
  |---|---|---|
  | 1 | 6 | 0.52 / 0.50 / 0.53 / 0.50 / **8.15** / 0.50 |
  | 2 | 6 | 0.52 / 0.53 / 0.52 / **6.90** / **12.64** / 0.50 |
  | 3 | 6 | 0.52 / 0.58 / 0.50 / 0.60 / 0.94 / 1.62 — **no outliers at all** |
  | 4 | **130** (1/s) | **p50 0.503 · p95 2.657 · p99 14.104 · max 16.292 · over-1 s 8 (6.2%) · all HTTP 200** |

  **SIX PROBES COULD NOT SCORE THIS CRITERION, and nearly did — twice.** Same binary,
  same script, same machine: run 2 said "worse than before", run 3 said "fixed". Either
  could have been written up as the answer. Only run 4, sampling every second for the
  whole soak, is decidable — and it says **6.2% of reads exceed 1 s with a 14 s p99**.
  **RETRACTED: the claim (from run 1) that the fix "removed one of two outliers and cut
  the worst from 13.25 s to 8.15 s".** That was one sample against one historical sample
  and it does not survive run 3 or run 4. The commit message `481c94e` carries the same
  over-read; this card is the correction.
- **The unit-level fix is real and is NOT what is being questioned here.** With a
  rebuilder active a reader provably never rebuilds — mutation-verified in `ui.rs`. What
  run 4 shows is that removing the gate winner did not, on its own, get the READ path
  under 1 s. Both things are true.
- **HYPOTHESIS FALSIFIED BY DIRECT MEASUREMENT — do not retry it.** I proposed that
  `prune_window` holds the state lock across the whole window (it runs `&mut self`, and a
  reader's poll loop calls `state.lock()`, so a long hold is latency `STALE_BUDGET_MS`
  cannot bound), because the run-2 outliers landed exactly on the memory-pressure burst
  (`window_shrinks_so_far` 2 → 9 between the fast probe and the slow one). Instrumented
  it — `prune_window held the state lock for N ms`, logged at ≥250 ms — and across two
  full soaks it printed **`(none)`**. The correlation was real and the mechanism was
  wrong. That instrumentation is KEPT (`lib.rs`): it is cheap, it is silent when healthy,
  and it now permanently rules out this explanation instead of leaving it to be
  re-proposed.
- **The other two open numbers, measured in the same runs.** Throughput **1,851 spans/s**
  against the 2,600 target (481,280 spans in 260 s). Non-2xx **24 of 24,093** here, but
  **64** in each of the two earlier runs — so it is NOT the deterministic constant those
  two identical counts suggested, and any explanation resting on that must be dropped.
- **Ingest spikes TOO, and that is the most useful clue on the card.** The flood's own
  OTLP latency reports p50 0.615 ms, p99 164 ms, **max 7,571 ms**. A read path and a
  write path that both stall for seconds are stalling on something they SHARE. `summary_now`
  is no longer on the write path at all, so the remaining suspect list is the state lock
  held by some third site, or an allocator/RSS effect at 10.5 GB — not the summary rebuild.
- **NEXT ACTION — a MEASUREMENT, and specifically NOT another fix.** Five inspection-derived
  fixes were falsified on the sibling card today and one more here; the pattern is the
  lesson. Time the `/api/server-stats` handler END TO END and separately time every
  `state.lock()` acquisition in it, so a 14 s response is attributed to a named holder
  rather than assumed to be the summary. Run it under the same 1/s × 260 s protocol —
  never six probes again.
- The incremental summarizer named in `ui.rs` remains the larger, separate upgrade:
  this change moves WHO pays the O(window) cost, it does not remove the cost.
- **DO NOT build/test while a soak is running** — `cargo build` contends for the
  same cores and invalidates the measurement in flight.
- **2026-09-02 — the NEXT ACTION's instrumentation is IN THE CODE (built, tested, committed this
  session):** `agentlens_core::LockTimed` (`lib.rs`, after `serve_otlp`) wraps `Mutex<CoreState>`
  in `lock_timed()`, a `#[track_caller]` drop-in for `lock()`. Every one of the 106 `state.lock()`
  sites in `ui.rs`, plus `chores.rs`, `log_reader.rs`, `bin/alcore.rs` and the OTLP handler in
  `lib.rs`, now goes through it. A waiter that blocks ≥ `AGENTLENS_LOCK_TRACE_MS` (default 250)
  prints `alcore: state lock waited N ms at file:line; holder file:line for M ms` — the holder is
  the site that last acquired (a global `HOLDER_SITE` slot), not a stack guess; a guard held ≥ the
  threshold prints `alcore: state lock held N ms by file:line` on drop. Two unit tests
  (`lock_timed_tests::*`) prove the record/clear and the poisoned-recovery path. Five `sample`
  captures on 2026-09-02 (TRDD-768NEX6E) showed handlers parked on the lock with NO holder in the
  stack — the profiler walks it after the holder returned — which is why the lock names itself.
- **THE MEASUREMENT (2026-09-02 12:53–13:08, pid 26060, commit 7a90fa1e deployed, sessions already
  running — no soak):** 33 `state lock held` lines and 84 `state lock waited` lines in 15 min. Ranked by
  hold: **ui.rs:560 held 74,709 ms, 34,793, 27,155, 17,944, 15,620, 14,919, 13,719, 13,362, 6,853,
  5,512, 5,336, 5,253 ms** — every one of the top twelve is the SAME site, `compositions_in_scope`'s
  guard, which calls `composition_project_map` → `build_session_summary` (the full O(window) summary)
  under the lock. `ui.rs:534` (`composition_for`, same call) held 3,936 ms. Waiters: the log sweeper
  waited **72,944 ms** (`log_reader.rs:1052`), the OTLP ingest handler 8,842 ms (`lib.rs:918`), the
  span flush tick 8,842 ms (`chores.rs:561`), the summary rebuild 8,768 ms (`ui.rs:212`). This is the
  shared holder the STATE predicted: not the summary rebuild task, but a REQUEST route rebuilding the
  summary inline under the lock. The one `sample`-invisible fact the instrumentation existed to find.
- **Defect in the first build, fixed the same hour:** every `waited` line read "holder unknown" — the
  holder slot was read AFTER `lock()` returned, by which time the holder had released and cleared it.
  Fixed by snapshotting the slot before blocking (deployed 13:09 as pid 53886); the `held` lines were
  unaffected and are the ranking above.
- **NEXT ACTION:** TRDD-UTFVMVT8 (the top holder, carded) — take `build_session_summary` out from
  under the lock in the composition routes. Then re-read `server.log` for 15 min; this card's own
  acceptance is the disappearance of ≥1 s holds at ui.rs:534/560 and of the multi-second waits on the
  ingest and sweeper sites.

## Symptom

Under a 100-session fleet soak (`scripts_dev/soak-fleet.sh`, 2,600 spans/s =
100 sessions x 26 spans/s, this machine's measured per-session peak):

| path | result |
| --- | --- |
| `POST /v1/traces` | HTTP 200 in **0.3 ms** — healthy |
| `GET /api/server-stats` | **no response at 20 s** — curl exit, zero bytes |
| process CPU | **101.9%** — exactly one core |
| process RSS | **17.9 GB** |
| spans dropped | **0** |

The soak's own per-minute sampler shows the same thing from the outside: minutes
1-2 carry `mem=`/`store=` columns, minutes 3-6 carry none, because its 10 s
`curl` to `/api/server-stats` timed out on four consecutive samples.

## Measurement

`/usr/bin/sample <pid> 6`, top-of-stack, all frames inside the summary rebuild:

```
IndexMap::get_index_of                      843
core::hash::sip::Hasher::write              500 + 208
summarize::claude::build_interaction_card   202
IndexMap::insert_full                       178
summarize::helpers::nano_to_ms              110
summarize::helpers::attr_value               92
summarize::summarizer::summarize_spans       55
summarize::helpers::parse_iso_ms             44
__psynch_mutexwait                          2540
```

(`__psynch_cvwait` 55,997 is the parked tokio worker pool, not work.)

## Mechanism (read from source, not inferred)

- `ui.rs::summary_now` fast path reads `st.data_version` and asks
  `st.summary_cache.current(version)`. A miss takes the process-global
  `rebuild_gate()`, re-checks, snapshots the window, runs
  `CoreState::summary_from` off-lock, and stores under `inputs.version`.
- `st.data_version += 1` fires on **every ingest** — `lib.rs:247`, `:554`,
  `:603`, `:737`.
- The window is capped at 1,000,000 spans (`span_window.rs::max_spans_default`).

So the cache KEY moves ~130x/second while ONE rebuild over ~1M spans takes over
20 s. The hit rate is approximately zero under sustained load: every request
misses, every rebuild is already stale when it stores, and the server rebuilds
continuously at 100% of one core forever.

**The single-flight gate (commit `463f4802`) is working exactly as designed** —
it is why only ONE core is pegged instead of N. It bounds rebuild CONCURRENCY.
It cannot bound rebuild COST, and cost is what fails here. Do not read this card
as evidence the gate was wrong.

**The span-count ceiling (commit `f106e493`) is also working** — RSS went flat at
17.05 GB across minutes 5 and 6, which is where the 1M cap binds (predicted 6.4).
It bounds MEMORY. It does not bound rebuild LATENCY, and at 1M spans that latency
is over 20 s.

`ui.rs` already names the intended upgrade in its own comment: *"a rebuild is
still the WHOLE window — and the upgrade is still an incremental summarizer, not
more locking."*

## Candidate fixes (ordering pending the advisor verdict)

1. **Bounded staleness** — keep the last-good summary with a `built_at_ms` and
   serve it from the fast path even when `data_version` moved, provided it is
   younger than N ms. Turns "rebuild per request" into "rebuild per N ms".
   Open question this card must not paper over: at 1M spans a rebuild takes
   over 20 s, so a 1-2 s tolerance may still leave a core pegged continuously
   and the summary >20 s stale. It may need a lower span cap to mean anything.
2. **Adaptive cadence** — rebuild at most once per previous-rebuild-duration, so
   the summarizer can never consume more than a fixed share of one core.
3. **Attack the per-span cost** — `IndexMap<String, Value>` attribute lookup with
   SipHash per key is the dominant leaf. Interning, or extracting the needed
   fields once at ingest, changes the constant rather than the cadence.
4. **Incremental summarizer** — the real fix named in the code, and the largest.

## Trap to check before shipping any of these

`summary_now` returns `(version, Arc<Value>)` and `stripped_cache` is keyed on
that same version. Returning a summary whose version is older than
`data_version` must not let a stale body be stored under, or served as, a newer
version.

## Acceptance

**Box 1 is restated as a percentile, because the original wording was not decidable.**
"Answers in under 1 s" over six samples is a coin flip on this machine — runs 2 and 3 gave
opposite verdicts from the same binary. A criterion that cannot distinguish a fix from luck
is not a criterion, so it now names the sample size and the statistic.

- [ ] `/api/server-stats` p99 under 1 s, sampled 1/s for a full ≥250 s soak at fleet rate
      (n≥130), with the over-1 s share reported. **Measured 2026-08-29: p50 0.503, p95 2.657,
      p99 14.104, max 16.292, over-1 s 6.2% — NOT met.**
- [x] `/v1/traces` stays at HTTP 200 with p99 unchanged (no ingest regression). Measured:
      24,069 of 24,093 2xx, OTLP p50 0.615 ms / p99 164 ms. **Recorded with its caveat: max
      7,571 ms.** The p99 is fine and the tail is not, and reporting only the p99 here would
      hide the one clue that read and write stall together.
- [x] Zero spans dropped (`droppedOnFailure: 0`) — confirmed in `/api/server-stats` on every run.
- [x] A mutation-verified test: revert the fix and the test must fail. `a_reader_never_rebuilds_when_the_background_rebuilder_owns_it`
      fails, and only it (3 passed / 1 failed), when the `REBUILDER_ACTIVE` early return is disabled.
- [x] RSS bounded — record the number, do not assert a target that was not measured.
      **10.29–11.78 GB** across the runs, at a 300,000 ms window the memory-pressure valve had
      narrowed from the configured 86,400,000 ms. Not comparable to the earlier 17.08 GB figure:
      different run length and a different effective window, so it is recorded, not claimed as
      an improvement.
