---
trdd-id: 2R36W8Q1
title: The summary cache is keyed on a version that moves faster than a rebuild completes, so the UI path livelocks under fleet ingest
column: todo
pre-block-column: 
unblock-when: [trdd:UTFVMVT8 terminal]
created: 2026-08-29T10:44:23+0200
updated: 2026-10-15T07:12:18+0200
current-owner: main-session
task-type: bugfix
scope: project
project-id: agentlenspro
parent-trdd: YU8QPU89
relevant-rules: []
implementation-commits: [481c94e4]
blocked-by: []
status: tasked
---

# Summary cache livelocks under fleet ingest

## ⏵ STATE — READ THIS FIRST ON RESUME (authoritative; supersedes the body) — 2026-09-05T14:35:52+0200 (triage line added 2026-10-15)
**2026-10-15 triage (reports_dev/2r36w8q1-triage.md):** the frontmatter column `todo` is current; this block's 'blocked by UTFVMVT8' is superseded (UTFVMVT8 is complete; the unblock-when predicate is met). The fix (481c94e4) is on HEAD; later commits e867ad3a (summary patched in place), 13209791 (log_sessions deleted) and the 2048 MB RSS cap mean the 2026-09-05 numbers describe an older binary. NEXT: re-measure boxes 2, 3 and 5 passively on a running current-code collector (the live collector is stuck on old code since 2026-10-14 16:21 until the owner restarts it), run the box-4 test, rewrite this block, then move to ai_review.

SUPERSEDED 2026-10-15 (see the triage line above): **`blocked` (pre-block `ai_review`) — the 14:21 AI review REJECTED on process, not code:** `blocked-by:
[UTFVMVT8]` was set deliberately in `061d2ed2` and never cleared, and UTFVMVT8 is still `testing` with
one open box. The rule makes a non-empty `blocked-by` mean `blocked`, so the column now says what the
field says; `unblock-when: [trdd:UTFVMVT8 terminal]` matches the drift detector's predicate regex
(`_PRED_TRDD_RE = ^trdd:([0-9A-Za-z]{8})\s+terminal$`) and survives the list parser intact
(`trdd_common.parse_flow_list` splits on commas, not whitespace), so it restores `ai_review` once
UTFVMVT8 reaches a terminal column; the restore code (`_restore_column_text`, the `.sub` calls after
the `column:` substitution) rewrites `blocked-by: []` and deletes the `pre-block-column:` line, so
this card cannot re-block itself (the detector's other path, "satisfied but `blocked-by` still names a
live blocker" — seen only in its docstring lines 301–320 — should not fire here because the predicate
and the blocker are the same id). The board the predicate reads is built over every design folder,
archived included, so UTFVMVT8 being archived on completion does not strand it. The field was
deliberate and its blocker is still open: `061d2ed2`'s body says "2R36W8Q1's prose already waited on
UTFVMVT8's young-session probe", and that probe is exactly UTFVMVT8's one still-open box. That
establishes intent to wait, not that this card's own gate (server-stats p99 under fleet ingest) is
technically coupled to the probe — so hold here on the author's intent; a re-submitter who can show
the two gates are independent may clear the field with that one-line reason. The verdict downgraded boxes
2, 3 and 5 to INFERRED, and I confirmed the basis myself: the three 09-05 soak artifacts
(`reports_dev/2r36-soak{,-log,-sorted}.txt`) contain neither the string `dropped` nor `rss`
(case-insensitive), so those numbers
are carried from the 08-29 runs — re-measure them in the re-submission or state why the carry holds.
`implementation-commits` now names `481c94e4` (the `REBUILDER_ACTIVE` change), which was missing.

**Previous STATE (12:55) — LAST BOX MET — `ai_review`.** The 1/s × 260 s soak the NEXT ACTION below asked for ran on
2026-09-05 12:48–12:54 against the live alcore restarted at 11:51 (built from `7caad610`, which
carries this card's summary-cache change and QE114936's twenty handler rewrites), with no build
or test overlapping it: p50 0.524 s, p99 0.955 s, max 1.281 s, 1 of 260 samples over 1 s. No
`state lock held ≥ 1000 ms`; every `waited` line names the log scan (`log_reader.rs:1076`) or a
chore as holder, none the summary (lock census window 12:48–12:55, the log read at 12:55:19
runs 25 s past the last sample). "Fleet rate" is measured, not assumed, on two axes: the DuckDB
store holds **502 `api_calls` rows from ≥ 6 sessions** with `ts_ms` inside the soak window
(~77 calls/min; response rows carry NULL `session_id`, so 6 is a floor; whether the staging
writer's `ts_ms` is the body's own call time is INFERRED from the forensics rows' convention,
not read at 9SYRK6SW's writer), and the writer's parts landed once a minute right through it;
and the load the summary rebuild actually pays for, read from `/api/server-stats` 9 min after
the last sample: **`spans.inMemory` 420,541 over the CONFIGURED 24 h window** (`windowMs`
300000 is the report's row, `configuredWindowMs` 86,400,000 is what the window keeps). Two
feeders, both OTLP-origin, no log-scan rows: `SpanWindow::boot_load` rehydrated **401,648** spans
from the store at the 11:51 boot (`server.log`), and `state.window.add` on the ingest path
(`lib.rs`) grew it to 421,138 by 13:08 — **~19.5k live spans in 78 min, ~15k/h** — so the
rebuild walks a day of stored spans plus the live tail; "~17.5k/h" in an earlier wording was
420k/24 as if all ingested live, which the 78 min uptime rules out. And **`logSessions` 30,975** (the card map the
rebuild walks; it barely moves minute to minute, so it stands in for the soak's load even read
late, which `inMemory` does not — its 24 h window still overlaps the soak, but the read is one
point, not the series). The soak discarded its 260 response bodies; a repeat should keep them
and record `spans.inMemory` per sample. The bar is met
by 45 ms on ONE run with load rising 11 → 27 inside the window, so the measurement
is recorded as narrow, not comfortable — a repeat at sustained load ≥ 25 is the confirmation,
and the incremental summarizer named below stays the real upgrade. `human_review` is the
USER's move. Earlier state, kept:

## ⏵ STATE (earlier) — 2026-09-02

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
  guard. **Site proven, dominant call NOT yet isolated** (review-fork finding, settled by reading
  14:25): the guard runs `composition_project_map` → `build_session_summary` — which short-circuits on
  `summary_cache` only when the version matches; how often THIS caller matches is unresolved, because
  the live hit/miss counters (76,902 / 608 on pid 53886 at 14:24) also count the off-lock
  `rebuild_once` path, so inline rebuilds under this guard are ≤ 608 in 74 min and possibly every
  call — then `session_ids()` and `resolve_scope` over every id; which of the
  three holds is TRDD-UTFVMVT8 box 1's per-statement timing to answer. `ui.rs:534`
  (`composition_for`, the same shape minus the scope resolution) held 3,936 ms. Waiters: the log
  sweeper waited **72,944 ms** (`log_reader.rs:1052`), the OTLP ingest handler 8,842 ms
  (`lib.rs:918`), the span flush tick 8,842 ms (`chores.rs:561`), the summary rebuild 8,768 ms
  (`ui.rs:212`). This is the shared holder the STATE predicted: not the summary rebuild task, but a
  REQUEST route holding the lock across composition scope resolution — an inline summary rebuild on a
  cache miss being one of its three candidates. The `sample`-invisible fact the instrumentation
  existed to find. Since then, on pid 53886 alone (1h14m), the same site held ≥ 10 s sixteen times,
  the worst **273,893 ms**, with a 2.2–3.0 s floor on most of its 82 `held` lines.
- **Defect in the first build, fixed the same hour:** every `waited` line read "holder unknown" — the
  holder slot was read AFTER `lock()` returned, by which time the holder had released and cleared it.
  Fixed by snapshotting the slot before blocking (deployed 13:09 as pid 53886); the `held` lines were
  unaffected and are the ranking above.
- **Cosmetic, note when `lock_timed` is next touched:** `HOLDER_SITE` and `HOLDER_SINCE_NS` are two
  unsynchronised stores, so a waiter snapshotting between the two writes pairs the NEW site with the
  OLD since — right site, wrong "holding for N ms when we queued". Explains a "0 ms" on a long hold;
  never a wrong site. Put this in the code comment on the slot pair, not in a fix.
- **UTFVMVT8 LANDED AND MEASURED (2026-09-02 16:51):** the per-statement split proved the hold was
  the inline summary rebuild under the composition guard (19 of 19 traced holds, 100 %; the holder
  thread caught by stack as `composition_project_map → build_session_summary → summary_over`);
  commit 428a1dec moved it off the lock via `summary_now`; deployed as pid 18695 at 16:34:30. The
  15-min read after (16:36–16:51, sessions already running, no builds): **zero holds at ui.rs:534/560
  or their successors**, worst hold on the server **2,263 ms** (was 273,893), and the OTLP ingest
  handler's worst wait **2,361 ms** (was 145,456) — behind the 4 s burn tick's guard (`ui.rs:3698`,
  44 holds ≤ 2.3 s in 15 min), which is now the top holder, then the sweeper's `save_cards`
  (`log_reader.rs:1052`, 52 holds ≤ 1.6 s). This card's acceptance sentence — "disappearance of ≥ 1 s
  holds at 534/560 and of the MULTI-SECOND waits on the ingest and sweeper sites" — is met for the
  first half and met to within 2.4 s for the second: the remaining ingest waits are seconds, not
  minutes, and belong to the burn tick's card. The user-visible incident behind all of it is
  recorded on TRDD-N60JUWU3 (30 min of OTEL spans lost at the source while the handler was blocked).
- **NEXT ACTION:** the burn tick's guard is the next holder (carded separately — see UTFVMVT8's
  STATE for the numbers). This card moves to `ai_review` once UTFVMVT8's young-session probe passes;
  the fleet-soak acceptance box stays open under the USER's no-soak constraint.

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

**The payload size, measured 2026-09-04 on the live server (pid 37180) — recorded because it
existed nowhere on the board and the next session would have to rediscover it:**

`GET /api/summary` returns **91,687,199 bytes (91.7 MB)** carrying **21,179 sessions**, in one
response. Session rows are keyed `sessionId` / `workspace` (NOT `id` / `project` — a probe guessing
the latter reads `None` for every row and looks like empty data; that cost a wrong turn today).

Why it belongs on THIS card: the acceptance box measures `/api/server-stats` p99 (14.104 s, 6.2%
over 1 s). `/api/summary` is the fat endpoint and is built from the same summary the livelock is
about — a ~92 MB serialize on every cache miss is a plausible contributor to the p99 on any route
that waits behind a rebuild. **Not established as the cause** — it is one observation of a payload
size, with no attribution of the p99 to it. Treat it as the first thing to measure, not as the
answer.

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

- [x] `/api/server-stats` p99 under 1 s, sampled 1/s for a full ≥250 s soak at fleet rate
      (n≥130), with the over-1 s share reported. **Measured 2026-08-29: p50 0.503, p95 2.657,
      p99 14.104, max 16.292, over-1 s 6.2% — NOT met.** **Measured 2026-09-05 12:48–12:54 on the
      11:51 alcore (built from 7caad610), n=260 at 1/s, load 11 → 27: p50 0.524, p99 0.955, max
      1.281, over-1 s 1/260 = 0.4% — MET, narrowly (p99 is 45 ms under the bar). No `state lock
      held ≥ 1000 ms` in the window; the 13 `state lock waited` lines name `log_reader.rs:1076`
      as holder in 9, `chores.rs:573/619` in 3, `ui.rs:1109` in 1 — the log scan, not the summary.
      Raw: `reports_dev/2r36-soak.txt`, `2r36-soak-sorted.txt`, `2r36-soak-log.txt`.**
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

## AI review verdict — 2026-09-05T14:21:26+0200

| box | status | evidence |
|---|---|---|
| Box 1 — p99 <1s, n≥130 @1/s | ✓ VERIFIED (numbers), narrow (self-flagged) | Recomputed from raw `reports_dev/2r36-soak-sorted.txt` (n=260): p50=0.524197, p99 (ceil-rank)=0.954911, max=1.280966, exactly 1/260 >1.0s — matches the card's 0.524/0.955/1.281/0.4% to the decimal. Cross-checked `reports_dev/2r36-soak-log.txt`: 0 `held` lines ≥1000ms (max held 556ms, chores.rs:619); of 13 `waited` lines the holder is `log_reader.rs:1076` in exactly 9, `chores.rs:573/619` in exactly 3, `ui.rs:1109` in exactly 1 — matches the card's count precisely. `state.lock_timed()` call sites confirmed present in `ui.rs` at the cited line ranges. |
| Box 2 — ingest p99 unchanged, 0 regression | ? INFERRED | Numbers (24,069/24,093 2xx, p50 0.615ms/p99 164ms/max 7,571ms) are carried from the 2026-08-29 run's STATE, not re-measured in the 2026-09-05 soak whose own log/sorted files carry no OTLP-side data. Not re-verified this cycle; not contradicted either. |
| Box 3 — zero spans dropped | ? INFERRED | `grep -rn "dropped"` over `reports_dev/2r36-soak*.txt` and `2r36-soak-log.txt` returns nothing — the 2026-09-05 soak's saved artifacts do not record a `droppedOnFailure` reading for this run, despite the box's own wording "confirmed … on every run." Carried from earlier (2026-08-29) runs only. |
| Box 4 — mutation-verified test | ✓ VERIFIED (code presence) / ✗ UNVERIFIED (pass/fail) — test run deferred (CPU contention) | `REBUILDER_ACTIVE` flag and `a_reader_never_rebuilds_when_the_background_rebuilder_owns_it` (ui.rs:4204, guard at :150/:171/:258) exist exactly as described. Verify pass/fail with `cargo test -p agentlens-core ui:: -- --test-threads=1` once the machine is free. |
| Box 5 — RSS bounded | ? INFERRED | 10.29–11.78 GB figure is carried from the 2026-08-29 runs (per the card's own text); no RSS reading is recorded for the 2026-09-05 soak in the saved artifacts. |

**Defect found — frontmatter/process, not code.** `blocked-by: [UTFVMVT8]` is still set (line 14) while `column: ai_review`. Per `trdd-design-tasks.md`, "`blocked` applies whenever `blocked-by:` is non-empty" — a card carrying a live `blocked-by` has no business advancing columns without either clearing the field or being in `column: blocked`. Checked what it points at: `TRDD-...-UTFVMVT8-...md` is still `column: testing` with one un-ticked acceptance box (`[ ]` — the young-session `project` probe, box 4), i.e. the blocking TRDD's own gate for `testing → ai_review` ("Then `testing → ai_review`") has not fired. The commit history (`061d2ed2`) shows `blocked-by` was added deliberately, not left over from a template, so it was never cleared even though this card ticked over to `ai_review` in a later commit (`d6717988`). Two readings are both plausible — (a) 2R36W8Q1's own acceptance (server-stats p99) is genuinely independent of UTFVMVT8's leftover composition-index/project-tag box and the field is just stale housekeeping, or (b) the dependency was real and got skipped — but the card does not say which, and the rule does not grant a silent-independence exception. This must be resolved (either remove `blocked-by` with a one-line rationale, or hold this card at `blocked`) before `human_review`.

**Verdict: REJECT — `blocked-by: [UTFVMVT8]` is still set while `column: ai_review` and the named blocker (UTFVMVT8) is itself still `testing` with an open acceptance box; clear or justify the field before re-submitting.**

## Approval log

- 2026-10-05T02:17:39+0200 — column → ai_review by main-agent@agentlenspro. its only blocker TRDD-UTFVMVT8 was completed 2026-10-05; restored to its pre-block column Cleared blocked-by (--clear-blocker override).
- 2026-10-05T02:28:02+0200 — column → todo by main-agent@agentlenspro. unblocked by TRDD-UTFVMVT8 but not yet read; not ai_review, because nobody is reviewing it

## Review 2026-10-05 (in the owner's stead)

- Moved to ai_review earlier today by the main agent only because its blocker TRDD-UTFVMVT8 completed; the card was NOT read then. ai_review claims a review nobody is doing, so it is moved to todo until it is read. The directive card lists it as needing boxes 2, 3 and 5 re-measured on the live collector.
