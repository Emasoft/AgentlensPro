---
trdd-id: YU8QPU89
title: Verify alcore ingest keeps up with many parallel Claude Code sessions without filling the spool or growing memory
column: todo
created: 2026-08-28T22:05:59+0200
updated: 2026-08-29T07:37:08+0200
current-owner: claude-agentlenspro
task-type: audit
project-id: agentlenspro
parent-trdd: DMWOBWFH
blocked-by: []
eht: []
---

# Ingest throughput vs spool and memory under parallel sessions

## ⏵ STATE — READ THIS FIRST ON RESUME (authoritative) — 2026-08-29

> **SINGLE-FLIGHT HYPOTHESIS FALSIFIED, AND THE 26 GB WAS THE WRONG NUMBER TO CHASE.**
>
> `463f4802` gated `summary_now` to one rebuild at a time. Re-ran the identical concurrency-16
> flood with `MIMALLOC_SHOW_STATS=1`: **committed 26.4 GiB against a 26.3 GiB baseline** — no change.
> Concurrent rebuilds were NOT the holder. The fix is still correct (it removes duplicate whole-window
> passes) but it does not touch memory, and this card should stop crediting it with that.
>
> **The number that actually answers the USER's question is 5 GB, not 26.** The live server, on
> REAL traffic:
>
> | | live (real) | synthetic flood |
> |---|---:|---:|
> | RSS | **5.00 GB** | 26.4 GB |
> | spans resident | 62,970 | 200,000 (at the cap) |
> | store | 3,980,903 | — |
> | ingest rate | ~26 spans/s | **162,549 spans/s = 6,250x real** |
>
> The 26 GB appears only at ~6,250x this machine's measured peak. Every memory conclusion on this
> card — including three of my own hypotheses — was drawn from that synthetic figure, which is an
> allocator arena high-water mark under extreme churn, not a steady-state cost.
>
> **THE REMAINING, REAL GAP IS 5.0 GB vs the TS server's ~1.5 GB — about 3.3x, at 63k resident
> spans.** That is the number worth investigating, and it has never been measured directly. Do NOT
> keep optimising against the flood: it produced three plausible, testable, and WRONG diagnoses
> (allocator retention, GPU/IOAccelerator, concurrent rebuilds) at the cost of most of a session.
> Measure the 5 GB instead, at real load, where a 3.3x regression against the thing being replaced
> is both credible and actionable.

> **MEMORY — HOLDER IDENTIFIED IN CODE: `summary_now` has NO SINGLE-FLIGHT.** Bounded structures
> eliminated by reading them: `summary_cache` / `stripped_cache` are `VersionedCache<T>` = one
> `Option<Arc<T>>` slot each (`derived_cache.rs:10-15`), and `otel_attribution` is REPLACED wholesale
> on each rebuild (`lib.rs:324,383`), never accumulated. Neither can hold 26 GB.
>
> `ui.rs:99-111` is the shape that can:
>
> ```
> lock → check cache → UNLOCK → CoreState::summary_from(&inputs) → lock → store_summary
> ```
>
> The lock is released between the miss and the rebuild, so **every concurrent caller misses and
> rebuilds simultaneously**. Each in-flight rebuild holds its own `SummaryInputs` snapshot (a
> `Vec<Arc<Value>>` of the whole window plus a clone of `log_sessions`) AND the full per-session card
> set it is building — so N concurrent readers hold N complete copies at once, on top of the previous
> summary still alive until `store_summary` swaps it. `grep -n "single.flight\|in_flight" ui.rs`
> returns nothing.
>
> **This fix was written and never landed.** Single-flight for `summary_now` was review F1 of
> `5e7f455` and one of the three items handed to the rc3 agent (`aaa93e1d302fbdefb`), which stalled
> at 01:26 with a non-compiling tree — preserved as `stash@{0}`. The other two items of that batch
> were re-done directly (`bba537c0`, `58070386`); this one was not.
>
> **NEXT — this is now a bounded code change, not an investigation:** gate `summary_now` so one
> rebuild runs at a time and late arrivals wait for its result instead of starting their own. Then
> re-run the concurrency-16 flood with `MIMALLOC_SHOW_STATS=1` and compare `committed` against the
> 26.3 GiB baseline recorded above. That single number is the pass/fail.

> **MEMORY DIAGNOSED — IT IS THE RUST HEAP, AND THE PREVIOUS ENTRY SAYING OTHERWISE IS WRONG.**
> `MIMALLOC_SHOW_STATS=1` on the same concurrency-16 flood, mimalloc's own accounting:
>
> ```
> reserved (17 events, 1-4 GB arenas)   28.00 GB
> committed                             26.3 GiB
> purged                                65.1 GiB
> resets                                0
> elapsed                               52.6 s
> ```
>
> **`vmmap`'s `IOAccelerator` attribution was a MISLABEL** of mimalloc's large anonymous arenas on
> this macOS version — the exact possibility the previous entry listed third and did not test before
> concluding. `/usr/bin/heap` agreed only because mimalloc bypasses the system malloc zone it
> inspects. Two tools, both blind in the same direction, and I believed them.
>
> **The number is LIVE, not retained.** mimalloc purged 65.1 GiB during the run and still holds
> 26.3 GiB committed — which is also why the eager-purge experiment moved nothing (28.30 vs
> 28.66 GB). Something holds real references to ~26 GB while the span window is capped at 200,000
> (~300 MB) and the writer buffer is empty.
>
> **So the open question is finally the right one:** what in the Rust heap holds ~26 GB during
> sustained ingest? Candidates, none yet measured — the derived structures the off-lock rebuild
> creates (`summary_cache`, `otel_attribution`, `stripped_cache`), each of which holds a full
> per-session card set and is versioned rather than bounded; and the transient 2-3 copies a rebuild
> makes while the OLD summary is still alive. At 162k spans/s a rebuild's inputs are enormous even
> with a small window, because the rebuild is triggered per version bump rather than per unit of
> time.
>
> **The measurement that would settle it:** cap or instrument those three caches and re-run. If RSS
> tracks cache count, they are the holder. Do NOT reach for the window again — it is already bounded
> on two axes and neither moved this number.

> **MEMORY — TWO HYPOTHESES KILLED, AND THE REAL LOCATION IS A SURPRISE. 2026-08-29.**
>
> 1. **Allocator retention: RULED OUT.** Re-ran the identical concurrency-16 flood with
>    `MIMALLOC_PURGE_DELAY=0 MIMALLOC_RESET_DELAY=0 MIMALLOC_ABANDONED_PAGE_PURGE=1`. RSS came out
>    **28.30 GB against 28.66 GB** without them — a 1.3% difference. mimalloc holding freed pages
>    does not explain this, so the memory is held by real references or by something that is not the
>    Rust heap at all.
> 2. **The Rust heap: RULED OUT, and this is the surprise.** `vmmap` on the live process (verified
>    by pid against `ps`: alcore, RSS 25.6 GB) attributes the memory as:
>
>    | region type | virtual | **resident** | regions |
>    |---|---:|---:|---:|
>    | **IOAccelerator** | 38.5 G | **26.5 G** | 387 |
>    | all MALLOC zones | 12.8 M | **320 K** | 6 |
>
>    **`IOAccelerator` is the GPU/Metal allocator.** The entire malloc surface is 320 KB. So the
>    27-28 GB is NOT the span window, NOT derived caches, NOT a leak in any structure this card has
>    been blaming, and NOT the Rust heap — `/usr/bin/heap` also reported only 120 KB, because
>    mimalloc bypasses the system malloc zone.
>
> **DO NOT act on this yet — it is an OBSERVATION, not a diagnosis.** Nothing in alcore's code
> obviously uses the GPU. The plausible sources, none verified: DuckDB (`duckdb 1.10505.0`,
> `features = ["bundled"]`) doing something Metal-backed, a transitive dependency, or `vmmap`
> mislabelling large anonymous mmap regions on this macOS version. That last possibility matters —
> it would mean the label is wrong rather than the memory being GPU-resident — and it is exactly the
> proxy-for-the-thing trap, so the label must be corroborated before anyone optimises against it.
>
> **NEXT (cheap, in order):** (a) run with `MIMALLOC_SHOW_STATS=1` and read mimalloc's own accounting
> — if it claims ~27 GB the label is wrong and it IS the heap; (b) if it claims little, check whether
> a DuckDB connection is open during ingest and whether RSS tracks connection count; (c) only then
> decide. **Every previous memory conclusion on this card was drawn before this measurement and
> should be treated as unverified.**

> **VERIFIED 2026-08-29 WITH ALL FIXES ACTIVE — throughput and responsiveness PASS; memory does
> NOT, and for a reason that falsifies this card's own earlier premise.**
>
> Isolated instance, `AGENTLENS_MAX_WINDOW_SPANS=200000`, release build carrying `bba537c0`
> (back-pressure), `65d3018c` (RSS guard) and `f106e493` (count ceiling):
>
> | concurrency | result | spans/s | nonOk | p50 | p99 | `/api/server-stats` |
> |---|---|---:|---:|---:|---:|---|
> | 4 | **completed** (was: never finished) | **173,930** | **0** | 0.25 ms | 0.67 ms | 200 in 6.1 s |
> | 16 | **completed** | **162,389** | **0** | 0.91 ms | 3.03 ms | 200 in 3.7 s |
>
> **Responsiveness is FIXED.** `__psynch_mutexwait` fell from 33,000–39,000 samples to **32**. The
> window pinned at exactly 200,000, `dropped_on_failure` stayed 0, and 14,179,940 spans landed
> durably in the store. Ingest is 162–174k spans/s against a real peak of 26 — the rate question is
> answered several times over.
>
> **MEMORY IS NOT FIXED, and the window was the wrong suspect.** After the run: RSS **27.91 GB**,
> still held 20 s after load stopped, with `inMemory` 200,000 (~300 MB), `pendingAppends` 0, and
> `windowMs` already cut to the **5-minute floor** by the RSS guard. So the guard fired as designed,
> shrank the window as far as it can go, and RSS did not move — because ~27 GB is not in the window,
> the writer buffer, or any structure this card previously blamed. A `/usr/bin/sample` shows the
> process IDLE (46,478 in `__psynch_cvwait`, 32 in mutexwait): the memory is RETAINED, not in use.
>
> **Leading hypothesis, NOT yet verified:** allocator retention — mimalloc holding freed pages after
> 14.2M spans churned through, which `span_window.rs` and this card have both noted macOS does. The
> alternative is a real leak in a derived structure (`otel_attribution` / `stripped_cache` /
> `summary_cache`). These are distinguishable and the discriminator is cheap: run the same flood
> with `MIMALLOC_PURGE_DELAY=0` (or the build's equivalent eager-purge knob) and re-read RSS. If it
> falls, it is retention and the fix is an allocator setting; if it stays, something holds real
> references and the fix is in the code. **Do not add another window guard for this — two axes
> already bound the window and neither touched this number.**

> **ANSWERED 2026-08-29 — THE RATE QUESTION IS SETTLED, AND THE BOTTLENECK IS ELSEWHERE.**
> Report (gitignored): `reports/bench/20260829_094332+0200-ingest-ceiling-is-window-size-not-rate.md`
>
> | concurrency | req/s | spans/s | p50 | p99 | `/api/server-stats` after |
> |---|---:|---:|---:|---:|---|
> | 1 | 3,041 | **60,829** | 0.182 ms | 0.366 ms | 200 in **0.68 ms** |
> | 4 | — | — | — | — | **never completed** (25 s bench killed at 8 min) |
>
> **Ingestion is fast enough, by ~2,300x.** 60,829 spans/s against this machine's real measured
> peak of 26 spans/s. The USER's "speed of ingestion … even when running many sessions in
> parallel" half is answered YES.
>
> **What breaks is the in-memory WINDOW, and the variable is span COUNT, not arrival RATE.**
> Concurrency 4 failed because the concurrency-1 run had already left ~1.5M spans in the window
> and every summary rebuild is O(window). Two `/usr/bin/sample` captures of wedged processes
> agree: 33,804–39,192 samples in `__psynch_mutexwait`, holder in `IndexMap::get_index_of` /
> `clone` / `build_interaction_card` / `attr_value`, and **ZERO writer/flush/fsync frames** — so
> neither `bba537c0` (span back-pressure) nor `58070386` (bodies drain) is implicated.
> `ui::summary_now` genuinely rebuilds off-lock (`ui.rs:99-111`); the residual under-lock cost is
> the SNAPSHOT — a `Vec<Arc<Value>>` clone plus one atomic per span. HFV4AIT7 called that
> "negligible against append" at 480k spans; at 5.26M it is ~42 MB memcpy + 5.26M atomics per
> rebuild miss, and the 4 s SSE push triggers rebuilds on its own.
>
> **NOT purely synthetic.** At 26 spans/s a 24 h window holds **~2.25M spans** — the same order
> where these runs wedge. A busy production day reaches it with no unusual load.
>
> **The memory guard works and is NOT sufficient.** Re-measured under the same flood with a
> 1500 MB budget: window cut 24h→12h→6h→3h→1.5h (each logged), RSS **declining under sustained
> load** 18.2→8.2→4.7→3.6 GB, versus 10.25 GB and climbing unguarded. Memory is bounded;
> responsiveness is not — the guard cuts by TIME while the rebuild cost follows SPAN COUNT.
>
> **NEXT (decision, not measurement):** bound what the cost actually follows. The smallest change
> is a span-COUNT ceiling on the window beside the existing time ceiling; the alternatives are
> incremental summarization or rebuilding on elapsed time rather than every version bump. Do not
> re-measure first — the evidence above is sufficient to choose.

> **THE 42% SPAN LOSS IS FIXED IN `bba537c0`** — committed, not deployed. `append` now FLUSHES at
> `PENDING_HIGH_WATER` (50k) instead of evicting the oldest span, with the check INSIDE `append`
> (a between-payloads check would leave a 180k-span hole, since one 64 MB body holds ~180,400
> realistic spans). The 100k failsafe STAYS and now means what its name says — `flush()` retains a
> bucket whose append errored, so a buffer still growing past the bound can only be a disk fault.
> `dropped_on_failure` is now exposed via `/api/server-stats`; it had been written and read
> nowhere, so the "counted, never silently" contract was false as shipped.
> Mutation-verified: removing the high-water flush drops exactly 50,000 of 150,000 spans.
>
> **Every throughput figure below was measured while 42% of the work was being discarded and must
> be RE-TAKEN against `bba537c0`.** The re-measurement is the next action for this card, together
> with the `POST /api/hook-events` p99 (the generator now reports per-kind p50/p95/p99/max, and
> excludes non-2xx so a fast-failing server cannot flatter the percentile).

> **THERE ARE TWO SPOOLS, AND THIS CARD ANSWERED THE WRONG ONE — see TRDD-ZW4APOPI.**
> `<dataDir>/hook-spool` (undeliverable hook events, 20k-file cap) is what the reframing below
> analyses, correctly. The other is the **2 GB RAM disk** `/Volumes/AgentLensSpool/otel-bodies`
> holding raw OTEL bodies — and *that* is the one whose fill rate is governed by ingestion speed,
> which makes it the one the USER's words name. Measured first-hand 2026-08-29 07:37: **100% full,
> 0 bytes free, 4,271 files, 117 of them ZERO BYTES** — live silent loss, because `bodies_pass`
> (`chores.rs:208`) drains only the legacy SSD dir while the TS drained both in `SPOOL_MODE`.
> A `POST /api/hook-events` p99 cannot observe any of it. Keep the reframing; it is right about the
> hook-spool. Read ZW4APOPI before quoting this card's spool conclusions.
>
> Two further limits on the p99 as a *sufficient* answer, even for the hook-spool: the boot-time
> hook-spool drain was never ported either (`hook_events.rs:10-11`), so under alcore that spool is
> monotonic — 2,400 files and growing — and at the 20k cap `spoolHookEvent` deletes the oldest
> (`hookHandlers.ts:79-84`), which a latency percentile cannot see. The honest minimum is the p99
> **plus** depth samples (`hookEvents.spooled`, `df /Volumes/AgentLensSpool`) either side of the
> load. Still minutes, so this card's rejection of the 1-hour soak stands; only its sufficiency
> claim does not.

**Measured so far (HFV4AIT7's benches, isolated instances, 14 cores):** ingest 131 → **949 req/s**;
hook events 17k req/s. Spool behaviour under N parallel sessions is still UNMEASURED.
**Memory is the open half:** RSS 15,034 MB at 481k spans — ~31 KB/span if that MB is decimal
(10^6), ~33 KB/span if it is MiB; the bench's own unit is unverified, so treat the figure as
"~30 KB/span, order of magnitude". The TS server sits at ~1.5 GB on the same data.

> **SETTLED 2026-08-29, and the answer is the bad one: REAL DATA LOSS.** A 20 s re-run with a
> drain posted **863,520** spans, appended **500,000**, on disk 500,000 — **42.1% dropped, with
> HTTP 200 returned for every one of them** (`reports/bench/20260829_072821+0200-span-gap.md`).
> Cause, verified in code: `agentlens-spanstore/src/writer.rs`, in **`pub fn append`** (`:436` at
> HEAD, with the eviction at `:457`). Cite it that way: the original `:475` matched only a dirty
> working tree, and the first "correction" to `append_line` was itself wrong — that function does
> not exist at HEAD, so it paired a dirty-tree name with a HEAD line number and reproduced the very
> error it was fixing.
> evicts the OLDEST buffered span whenever `pending_count > PENDING_FAILSAFE_MAX` (100k). That guard
> exists for a FAILING DISK. **`ae513a4` made the 5 s tick the only flush, so any burst above 100k
> spans per tick now evicts real data.** Precision the review forced (F2): the failsafe was not
> *absolutely* unreachable before — the pre-image appended a whole payload before flushing, and one
> 64 MB body holds ~180,400 realistic spans — so what `ae513a4` changed is PRACTICAL reachability,
> from "only via an oversized payload real telemetry never sends" to "routinely, under ordinary
> burst". Consequence for the fix, not pedantry: a high-water flush placed only AFTER the append
> loop leaves that 180k-span hole open. A regression introduced by
> this card's own sibling (HFV4AIT7 root cause 1), not a pre-existing defect.
> Fix in flight with the rc3 agent: back-pressure (flush at a high-water mark under the same lock)
> instead of eviction; the failsafe stays reachable only when a flush actually failed;
> `dropped_on_failure == 0` becomes the assertion. **Every throughput figure measured before that
> fix was measured while 42% of the work was being thrown away and must be re-taken.**
>
> **There is currently NO stated headroom figure, because neither axis has a valid denominator.**
> The spans axis is blocked on the gap above. The request axis has no measured comparand at all:
> dividing 949 req/s by the 26 spans/s peak (TRDD-DMWOBWFH) is req/s ÷ spans/s — a category error,
> and its implicit premise (one POST per span) is false, since `src/telemetryConfig.ts:156` sets
> `OTEL_TRACES_EXPORT_INTERVAL: '1000'`, i.e. ~one POST per second per exporting session. The
> honest denominator is observed OTLP POSTs/s on this machine; `counters.traces_payloads` already
> counts them (`lib.rs:116,698`) but `/api/server-stats` does not expose it — one line of exposure
> plus two samples over a known interval settles it. Do not quote a multiple until then.

**Advisor verdict (Fable 5) — do NOT refactor the span representation on that number:**
1. **The 31 KB/span figure conflates window and derived state.** Per rebuild, `lib.rs` produces a
   full summary with per-session `timeline` arrays, clones those entries again into
   `otel_attribution`, keeps a third derivative in `stripped_cache`, and the off-lock rebuild holds
   the OLD summary alive while building the NEW one — 3-4 span-sized copies plus a transient 2×, on
   top of the window. macOS malloc also rarely returns freed pages.
2. **Ship the guard the port DROPPED, first.** `span_window.rs:9-11` records that the TS's
   `effectiveWindowMs` halving under memory pressure was deliberately not ported — so alcore has
   LESS protection than the TS it replaced. ~20 lines: sample `server_stats::rss_bytes()` (already
   exists, and it is PORTABLE — proc_pidinfo on macOS, /proc on Linux — which matters because the
   package ships Linux binaries) on the 5 s tick, halve `effective_ms` over budget, step back under
   it; `prune()` already evicts, and `windowMs` is already in `/api/server-stats`, so the cut is
   visible rather than silent.
3. **The ONE measurement before any Value/struct refactor** (macOS-native, no heaptrack): run
   `alsummarize` under `/usr/bin/time -l` twice on the same 481k-span file — once stopping right
   after the `Vec<Arc<Value>>` is built, once after `summarize_spans`. Run 1 minus file size =
   window cost; the delta = derived-state cost. If run 1 is ~3-5 KB/span, shrinking the span
   representation is dead on arrival.
   **`alsummarize` cannot do this as it stands** (`src/bin/alsummarize.rs`, one straight path, no
   flag and no early return) — the measurement needs a small `--stop-after-load` flag added first.
   THREE confounds to state in the result: the file is read into a `String` that stays in scope for
   all of `main`; mimalloc rarely returns freed pages, so run 2's max-RSS is a high-water mark, not
   a steady state; and the load path materialises a full `Vec<Value>` and THEN collects a second
   `Vec<Arc<Value>>`, so run 1's peak includes a transient copy the server never holds — the one
   that moves the decision number.

**THE SPOOL QUESTION IS NOT A THROUGHPUT RATIO — it is one latency percentile, and it is cheap.**
The spool is not a backlog queue: `src/cli/hookHandlers.ts:70-73` calls it an *undeliverable*-event
sink, and its only caller `forwardHookEvent` (`:200-226`) spools **only** when the POST fails —
`res.ok` returns without spooling, and the binding threshold is the per-request timeout
(`AGENTLENS_HOOK_TIMEOUT`, default 1000 ms, floor 200 ms), a connection failure, or a non-2xx. So
the USER's "fast enough to avoid filling the spool" is exactly: **does `POST /api/hook-events` p99
stay under 1 s with N sessions posting?** Measured at 17,081 req/s single-client, the answer is
almost certainly yes — but it is unmeasured at the percentile that matters, and it is one bench run
(the generator already exists; add a p99 to its output), not the 1-hour 32× soak this card's Method
describes.

**NEXT ACTION (reordered — the goal's own question first):**
1. the hook-events p99 under N sessions (above) — answers the USER's spool half directly;
2. the span-loss fix (in flight with the rc3 agent) and the re-measurement it invalidates;
3. the memory-pressure guard;
4. the two-run memory measurement (after adding `--stop-after-load`).

USER goal (2026-08-28): *"verify that the speed of ingestion in rust even when running many
claude code sessions in parallel is enough to avoid filling the spool and using too much memory."*

## Two numbers, both already suspicious

- **Spool**: `<dataDir>/hook-spool` is where hook events wait when the server is behind. The
  question is drain rate vs arrival rate at N sessions, and what happens at the boundary — a
  spool that grows without bound is the failure the USER names.
- **Memory**: VHH7FXGC measured `alcore` at **~8.0 GB RSS** steady state (5.33 → 7.72 → 7.92 →
  7.99 GB over 16 min, flattening) against ~1.5 GB for the TS server, on the same data. Nobody has
  measured where it plateaus over hours or what it is (the 24 h span window resident in memory is
  the guess, not a finding).

## Method

Isolated instance (own `DATA_DIR`/ports). A generator replays this machine's real hook + OTLP
traffic shape at 1×, 4×, 16× and 32× concurrent-session rates (derive the per-session rate from
the live statusline/hook-events history, not from a guess). Sample every 10 s for ≥ 1 h at the
highest rate: spool file count + bytes, RSS, spans/s ingested, `/api/summary` latency.

## Acceptance

- [ ] at 32× the spool stays bounded (steady-state file count does not trend up over the hour)
- [ ] RSS plateaus and the plateau is EXPLAINED (which structure holds it, measured — heap profile
      or a size accounting of the span window), with a cap or eviction if it is not the window
- [ ] the numbers and the generator are committed (report path recorded here); any fix is an NPT

## Notes and lessons learned
